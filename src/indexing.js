import {createHash} from 'node:crypto';
import {hash,dataset,chunkText,boundedText,embed,ownerKey,namespace,vectorId} from './search.js';
import {readStoredObject} from './storage.js';
import {startFastPdf} from './rag-rebuild/pdf-fast.js';
export const indexingConfigured=env=>Boolean(env.AI&&env.FILES);
export async function ensureCatalog(env){
 if(!indexingConfigured(env))return;
 const rows=await env.DB.prepare(`SELECT m.*,i.message_timestamp,i.payload_json FROM media_files m
  JOIN inbound_messages i ON i.message_id=m.message_id LEFT JOIN file_catalog c ON c.message_id=m.message_id
  WHERE m.state='ready' AND m.sender=? AND c.file_id IS NULL ORDER BY m.created_at LIMIT 10`).bind(env.ALLOWED_SENDER).all();
 for(const row of rows.results){
  const message=JSON.parse(row.payload_json);const value=message[row.message_type];
  const epoch=Number(row.message_timestamp),sent=Number.isSafeInteger(epoch)&&epoch>0?epoch:Math.floor(Date.parse(row.created_at)/1000);
  const label=row.is_voice_note?'Voice note':row.message_type[0].toUpperCase()+row.message_type.slice(1);
  const filename=row.filename || label+' '+new Date((sent+19800)*1000).toISOString().slice(0,10)+'.'+row.object_key.split('.').at(-1);
  const caption=typeof value?.caption==='string'?value.caption.slice(0,1024):'';
  const id=hash('file:'+row.sender+':'+row.message_id).slice(0,16);
  await env.DB.prepare(`INSERT INTO file_catalog (file_id,owner,dataset,message_id,kind,voice_note,filename,mime_type,byte_size,
   sha256,bucket,object_key,source_epoch,extracted_text,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
   ON CONFLICT(message_id) DO NOTHING`).bind(id,row.sender,dataset(env),row.message_id,row.message_type,row.is_voice_note,
    filename,row.mime_type,row.byte_size,row.sha256,row.bucket,row.object_key,sent,caption,row.created_at,row.updated_at).run();
 }
}
async function extract(env,file){
 const limit=Number(env.MAX_EXTRACTION_BYTES || 8388608);
 if(file.kind==='video')return {text:file.extracted_text,method:'metadata',status:'metadata_only',reason:'video_content_not_extracted'};
 if(file.byte_size>limit)return {text:file.extracted_text,method:'metadata',status:'metadata_only',reason:'extraction_size_limit'};
 const response=await readStoredObject(env,file.bucket,file.object_key);
 if(!response.ok||!response.body)throw new Error('stored_read_failed');
 const reader=response.body.getReader(),chunks=[];let size=0;const digest=createHash('sha256');
 try{while(true){const next=await reader.read();if(next.done)break;size+=next.value.length;
   if(size>limit||size>file.byte_size){await reader.cancel();throw new Error('extraction_size_mismatch');}
   digest.update(next.value);chunks.push(next.value);}}
 finally{reader.releaseLock();}
 if(size!==file.byte_size||digest.digest('hex')!==file.sha256)throw new Error('stored_integrity_failed');
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 let text,method;
 if(file.kind==='audio'){
  const result=await env.AI.run('@cf/openai/whisper-large-v3-turbo',{audio:Buffer.from(bytes).toString('base64'),
   task:'transcribe',vad_filter:true,condition_on_previous_text:false});text=result.text;method='transcript';
 }else if(file.mime_type==='application/json'){const doc=JSON.parse(new TextDecoder().decode(bytes));text=doc.transcript?.text;method='call_transcript';}
 else if(file.mime_type.startsWith('text/')){text=new TextDecoder().decode(bytes);method='text';}
 else{
  const result=await env.AI.toMarkdown({name:file.filename,blob:new Blob([bytes],{type:file.mime_type})},
   {conversionOptions:{pdf:{images:{convert:false}},docx:{images:{convert:false}}}});
  if(result.format==='error')return {text:file.extracted_text,method:'metadata',status:'metadata_only',reason:'unsupported_conversion'};
  text=result.data;method=file.kind==='image'?'image_description':'document';
 }
 if(typeof text!=='string'||!text.trim())return {text:file.extracted_text,method:'metadata',status:'metadata_only',reason:'no_extracted_content'};
 // ponytail: cap extracted text at 60k characters; add paging for larger documents when needed.
 return {text:text.slice(0,60000),method,status:'ready',reason:text.length>60000?'text_truncated':null};
}
export async function processIndex(env,fileId){
 if(!indexingConfigured(env))return;
 const token=crypto.randomUUID(),time=Date.now();
 const claim=await env.DB.prepare(`UPDATE file_catalog SET index_state='processing',lease_token=?,lease_until=?,
  index_attempts=index_attempts+1 WHERE file_id=? AND owner=? AND dataset=? AND index_attempts<3
  AND ((index_state='pending' AND next_attempt_at<=?) OR (index_state='processing' AND lease_until<=?))`)
  .bind(token,time+180000,fileId,env.ALLOWED_SENDER,dataset(env),time,time).run();
 if(claim.meta.changes!==1)return;
 try{
  let file=await env.DB.prepare('SELECT * FROM file_catalog WHERE file_id=? AND lease_token=?').bind(fileId,token).first();
  if(env.RAG_PDF_BATCHES_ENABLED==='true'&&file.mime_type==='application/pdf'&&file.extraction_status==='pending'){
   await env.DB.prepare("UPDATE file_catalog SET extraction_method='pdf_text:paged',reason='pdf_page_batches_pending',index_state='ready',index_attempts=0,index_cursor=0,vector_count=0,lease_token=NULL,lease_until=0,updated_at=? WHERE file_id=? AND owner=? AND dataset=? AND lease_token=?").bind(new Date().toISOString(),fileId,env.ALLOWED_SENDER,dataset(env),token).run();
   await startFastPdf(env,fileId);
   return;
  }
  if(file.extraction_status==='pending'){
   const output=await extract(env,file);const chunks=chunkText(output.text || file.filename);
   await env.DB.batch([
    env.DB.prepare('DELETE FROM file_chunks WHERE file_id=?').bind(fileId),
    env.DB.prepare(`INSERT INTO file_chunks (file_id,position,content)
     SELECT ?,CAST(key AS INTEGER),value FROM json_each(?)`).bind(fileId,JSON.stringify(chunks)),
    env.DB.prepare(`UPDATE file_catalog SET extracted_text=?,extraction_method=?,extraction_status=?,reason=?,vector_count=?
     WHERE file_id=? AND lease_token=?`).bind(output.text,output.method,output.status,output.reason??null,chunks.length,fileId,token)
   ]);file={...file,extracted_text:output.text,extraction_status:output.status,vector_count:chunks.length};
  }
  const result=await env.DB.prepare('SELECT position,content FROM file_chunks WHERE file_id=? AND position>=? ORDER BY position LIMIT 16')
   .bind(fileId,file.index_cursor).all();
  if(result.results.length){
   const texts=result.results.map(chunk=>boundedText(file.filename,80)+'\n'+chunk.content);
   const embeddings=await embed(env,texts);
   await env.FILES.upsert(embeddings.map((values,index)=>({id:vectorId(env,file.owner,fileId,result.results[index].position),
    values,namespace:namespace(env,file.owner),metadata:{owner:ownerKey(file.owner),file_id:fileId,sent_at:file.source_epoch,kind:file.kind}})));
  }
  const cursor=file.index_cursor+result.results.length,done=cursor>=file.vector_count;
  await env.DB.prepare(`UPDATE file_catalog SET index_cursor=?,index_state=?,index_attempts=0,lease_until=0,
   lease_token=NULL,updated_at=? WHERE file_id=? AND lease_token=?`)
   .bind(cursor,done?'ready':'pending',new Date().toISOString(),fileId,token).run();
  console.log(JSON.stringify({event:'file_index',kind:file.kind,state:done?'ready':'pending',extraction:file.extraction_status,vectors:cursor}));
 }catch{
  const row=await env.DB.prepare('SELECT index_attempts FROM file_catalog WHERE file_id=? AND lease_token=?').bind(fileId,token).first();
  if(!row)return;
  await env.DB.prepare(`UPDATE file_catalog SET index_state=?,next_attempt_at=?,lease_until=0,lease_token=NULL,
   reason='indexing_failed',updated_at=? WHERE file_id=? AND lease_token=?`)
   .bind(row.index_attempts<3?'pending':'failed',Date.now()+60000,new Date().toISOString(),fileId,token).run();
  console.error(JSON.stringify({event:'file_index',state:'retry_or_failed'}));
 }
}
export async function runPendingIndex(env,{discover=true}={}){
 if(!indexingConfigured(env))return;
 if(discover)await ensureCatalog(env);
 await env.DB.prepare(`UPDATE file_catalog SET index_state='failed',reason='attempts_exhausted',lease_token=NULL,
  lease_until=0 WHERE owner=? AND dataset=? AND index_state='processing' AND index_attempts>=3 AND lease_until<=?`)
  .bind(env.ALLOWED_SENDER,dataset(env),Date.now()).run();
 const file=await env.DB.prepare(`SELECT file_id FROM file_catalog WHERE owner=? AND dataset=? AND index_attempts<3
  AND ((index_state='pending' AND next_attempt_at<=?) OR (index_state='processing' AND lease_until<=?))
  ORDER BY CASE WHEN EXISTS (SELECT 1 FROM command_jobs c WHERE c.message_id=file_catalog.message_id AND c.kind='voice_assistant' AND c.state!='done') THEN 0 ELSE 1 END,created_at LIMIT 1`).bind(env.ALLOWED_SENDER,dataset(env),Date.now(),Date.now()).first();
 if(file)await processIndex(env,file.file_id);
}
