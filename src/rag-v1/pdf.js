// Native parsing is offloaded to the authenticated Python host; free Workers have a 10ms CPU budget.
import {createHmac} from 'node:crypto';
import {hash,chunkText,dataset} from '../search.js';
import {readStoredObject} from '../storage.js';
import {fail,only} from './core.js';
async function pdfText(env,file,bytes){
 const url=new URL(env.RAG_FAISS_URL);if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/')fail('rag_pdf_host');
 const stamp=String(Math.floor(Date.now()/1000)),sig=createHmac('sha256',env.RAG_INDEX_SECRET).update('whats-rag-pdf:v1:'+stamp+':'+file.sha256+':'+bytes.length).digest('hex');
 const response=await fetch(new URL('extract-pdf',url),{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Bridge-Time':stamp,'X-Bridge-Signature':sig,'X-Content-Sha256':file.sha256},body:bytes,redirect:'manual',signal:AbortSignal.timeout(18000)});
 if(!response.ok)fail('rag_pdf_http_'+response.status);if(Number(response.headers.get('Content-Length')??0)>1048576)fail('rag_pdf_host');
 const reader=response.body.getReader();let size=0,parts=[];try{while(true){const item=await reader.read();if(item.done)break;size+=item.value.length;if(size>1048576){await reader.cancel();fail('rag_pdf_output');}parts.push(item.value);}}finally{reader.releaseLock();}
 const output=JSON.parse(new TextDecoder().decode(Buffer.concat(parts)));
 if(!only(output,['sourceHash','text','pageMap','warnings','method','status','reason'])||output.sourceHash!==file.sha256||typeof output.text!=='string'||output.text.length>60000||!Array.isArray(output.pageMap)||output.pageMap.length>64||!Array.isArray(output.warnings)||output.warnings.some(x=>!['pdf_text_layer_only','pdf_layout_not_verified','pdf_pages_without_text','pdf_character_limit'].includes(x))||output.method!=='pdf_text:pypdf'||!['ready','metadata_only'].includes(output.status)||!['pdf_text_layer_only','pdf_no_text_layer'].includes(output.reason))fail('rag_pdf_output');
 let end=0;for(const p of output.pageMap){if(!only(p,['page','start','end'])||!Number.isInteger(p.page)||p.page<1||p.page>64||!Number.isInteger(p.start)||!Number.isInteger(p.end)||p.start!==end||p.end<=p.start||p.end>output.text.length)fail('rag_pdf_map');end=p.end;}
 if(output.text&&end!==output.text.length)fail('rag_pdf_map');return output;
}
export async function runPdfBackfill(env){
 if(env.RAG_ENABLED!=='true'||!env.RAG_FAISS_URL||!env.RAG_INDEX_SECRET)return;
 const file=await env.DB.prepare(`SELECT c.* FROM file_catalog c LEFT JOIN rag_documents d ON d.file_id=c.file_id AND d.owner=c.owner
 WHERE c.owner=? AND c.dataset=? AND c.mime_type='application/pdf' AND c.extraction_method IS NOT 'pdf_text:paged' AND c.index_state!='processing' AND c.byte_size<=8388608 AND (d.file_id IS NULL OR d.source_hash!=c.sha256 OR (d.attempts<3 AND d.state!='ready' AND d.lease_until<?)) ORDER BY c.created_at LIMIT 1`).bind(env.ALLOWED_SENDER,dataset(env),Date.now()).first();
 if(!file)return;const token=crypto.randomUUID(),now=Date.now();
 const claim=await env.DB.prepare(`INSERT INTO rag_documents(file_id,owner,source_hash,state,attempts,lease_token,lease_until,updated_at) VALUES(?,?,?,'processing',1,?,?,?)
 ON CONFLICT(file_id) DO UPDATE SET source_hash=excluded.source_hash,state='processing',attempts=CASE WHEN rag_documents.source_hash=excluded.source_hash THEN rag_documents.attempts+1 ELSE 1 END,lease_token=excluded.lease_token,lease_until=excluded.lease_until,updated_at=excluded.updated_at
 WHERE rag_documents.owner=excluded.owner AND (rag_documents.source_hash!=excluded.source_hash OR (rag_documents.state!='ready' AND rag_documents.attempts<3 AND rag_documents.lease_until<?))`).bind(file.file_id,file.owner,file.sha256,token,now+90000,now,now).run();
 if(claim.meta.changes!==1)return;
 try{
  const response=await readStoredObject(env,file.bucket,file.object_key);if(!response.ok||!response.body)fail('rag_pdf_read');
  const reader=response.body.getReader();let size=0,parts=[];try{while(true){const item=await reader.read();if(item.done)break;size+=item.value.length;if(size>8388608||size>file.byte_size){await reader.cancel();fail('rag_pdf_size');}parts.push(item.value);}}finally{reader.releaseLock();}
  const bytes=Buffer.concat(parts);if(bytes.length!==file.byte_size||hash(bytes)!==file.sha256)fail('rag_pdf_integrity');
  const output=await pdfText(env,file,bytes),chunks=output.text?chunkText(output.text):[],at=Date.now();
  await env.DB.batch([
   env.DB.prepare(`INSERT INTO rag_guards(nonce,valid) SELECT ?,0 WHERE NOT EXISTS(SELECT 1 FROM file_catalog c JOIN rag_documents d ON d.file_id=c.file_id AND d.owner=c.owner WHERE c.file_id=? AND c.owner=? AND c.sha256=? AND c.updated_at=? AND c.index_state!='processing' AND d.lease_token=? AND d.lease_until>?)`).bind(crypto.randomUUID(),file.file_id,file.owner,file.sha256,file.updated_at,token,at),
   env.DB.prepare('DELETE FROM file_chunks WHERE file_id=?').bind(file.file_id),
   env.DB.prepare('INSERT INTO file_chunks(file_id,position,content) SELECT ?,CAST(key AS INTEGER),value FROM json_each(?)').bind(file.file_id,JSON.stringify(chunks)),
   env.DB.prepare("UPDATE file_catalog SET extracted_text=?,extraction_status=?,extraction_method=?,reason=?,index_state='pending',index_attempts=0,index_cursor=0,vector_count=?,updated_at=? WHERE file_id=? AND owner=?").bind(output.text,output.status,output.method,output.reason,chunks.length,new Date(at).toISOString(),file.file_id,file.owner),
   env.DB.prepare("UPDATE rag_documents SET state='ready',page_map_json=?,warnings_json=?,lease_token=NULL,lease_until=0,updated_at=? WHERE file_id=? AND owner=? AND lease_token=?").bind(JSON.stringify(output.pageMap),JSON.stringify(output.warnings),at,file.file_id,file.owner,token)
  ]);
 }catch(error){await env.DB.prepare("UPDATE rag_documents SET state='failed',lease_token=NULL,lease_until=0,updated_at=? WHERE file_id=? AND owner=? AND lease_token=?").bind(Date.now(),file.file_id,file.owner,token).run();console.warn(JSON.stringify({event:'rag_pdf',state:'retry_or_failed',code:typeof error?.code==='string'&&/^rag_pdf_[a-z_0-9]{1,40}$/.test(error.code)?error.code:'rag_pdf_service_error'}));}
}
