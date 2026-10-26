import {enqueueCallTranscript} from './call-summary.js';
import {ownerEnv,resolveOwner} from '../owners.js';
// Post-call artifacts only. No inference, outbound message or memory learning.
import {createHmac,timingSafeEqual} from 'node:crypto';
import {hash,dataset,checkOwner} from '../search.js';
import {uploadVerifiedMedia,deleteObject} from '../storage.js';
const fail=(error,status)=>Response.json({error,confirmed:false},{status});
const DAY=86400000;

export async function handleCallArchive(request,env){
 if(env.CALL_ARCHIVE_ENABLED!=='true'||!env.VOICE_BRIDGE_SECRET)return fail('disabled',503);
 const stamp=request.headers.get('X-Bridge-Time')??'',sig=request.headers.get('X-Bridge-Signature')??'';
 const callId=request.headers.get('X-Call-Id')??'',kind=request.headers.get('X-Archive-Kind')??'';
 const digest=request.headers.get('X-Content-Sha256')??'',sizeText=request.headers.get('X-Content-Bytes')??'';
 if(!/^\d{10}$/.test(stamp)||Math.abs(Date.now()/1000-Number(stamp))>60||!/^[a-f0-9]{64}$/.test(sig)
  ||!/^wacid\.[A-Za-z0-9_.=-]{1,490}$/.test(callId)||!['recording','transcript'].includes(kind)
  ||!/^[a-f0-9]{64}$/.test(digest)||!/^\d{1,8}$/.test(sizeText))return fail('forbidden',403);
 const expected=createHmac('sha256',env.VOICE_BRIDGE_SECRET).update(`whats-archive:v1:${stamp}:${callId}:${kind}:${digest}:${sizeText}`).digest();
 if(!timingSafeEqual(expected,Buffer.from(sig,'hex')))return fail('forbidden',403);
 const size=Number(sizeText),now=Date.now(),limit=kind==='recording'?16777216:262144;
 if(!request.body||size<1||size>limit||size>Number(env.MAX_MEDIA_BYTES))return fail('archive_size_limit',413);
 if(request.headers.has('Content-Length')&&Number(request.headers.get('Content-Length'))!==size)return fail('size_mismatch',400);
 const session=await env.DB.prepare('SELECT owner,updated_at FROM call_sessions WHERE call_id=?').bind(callId).first();
 if(!session||!resolveOwner(env,session.owner))return fail('unknown_or_old_call',409);
 env=ownerEnv(env,session.owner);
 const updated=Date.parse(session?.updated_at);
 if(!Number.isFinite(updated)||now-updated>30*60000)return fail('unknown_or_old_call',409);
 if(env.CALL_SUMMARY_ENABLED==='true'){
  if(kind!=='transcript')return fail('raw_recording_not_retained',410);
  return enqueueCallTranscript(request,env,{callId,digest,size});
 }
 const messageId='call-archive:'+hash(callId)+':'+kind,fileId=hash('file:'+env.ALLOWED_SENDER+':'+messageId).slice(0,16);
 const mime=kind==='recording'?'audio/ogg':'text/plain',ext=kind==='recording'?'ogg':'txt';
 const key=`owners/${hash(env.ALLOWED_SENDER)}/calls/${hash(callId)}/${kind}.${ext}`;
 const filename=`Call ${kind} ${new Date(now).toISOString().replace(/[:.]/g,'-')} ${hash(callId).slice(0,8)}.${ext}`;
 const token=crypto.randomUUID();
 const rows=await env.DB.batch([
  env.DB.prepare(`INSERT INTO call_archives(call_id,kind,sha256,byte_size,bucket,object_key,filename,file_id,created_at,expires_at)
   VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(call_id,kind) DO NOTHING`).bind(callId,kind,digest,size,env.SUPABASE_BUCKET,key,filename,fileId,now,now+7*DAY),
  env.DB.prepare(`UPDATE call_archives SET state='uploading',attempts=attempts+1,lease_token=?,lease_until=?
   WHERE call_id=? AND kind=? AND sha256=? AND byte_size=? AND expires_at>? AND attempts<3
   AND (state='pending' OR (state='uploading' AND lease_until<=?))`).bind(token,now+30000,callId,kind,digest,size,now,now),
  env.DB.prepare('SELECT * FROM call_archives WHERE call_id=? AND kind=?').bind(callId,kind)
 ]);
 const job=rows[2].results[0];
 if(job.sha256!==digest||job.byte_size!==size)return fail('archive_conflict',409);
 if(job.expires_at<=now||job.state==='expired')return fail('archive_expired',410);
 if(job.state==='stored')return Response.json({state:'stored',confirmed:true,fileId:job.file_id});
 if(rows[1].meta.changes!==1)return fail('archive_busy_or_failed',409);
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
 try{
  let source=request,transcript='';
  if(kind==='transcript'){
   const reader=request.body.getReader(),chunks=[];let length=0;
   const cancel=()=>{void reader.cancel().catch(()=>{});};controller.signal.addEventListener('abort',cancel,{once:true});
   try{while(true){const next=await reader.read();if(next.done)break;length+=next.value.byteLength;
    if(length>size){await reader.cancel();throw new Error('size_mismatch');}chunks.push(next.value);}}
   finally{controller.signal.removeEventListener('abort',cancel);reader.releaseLock();}
   if(length!==size)throw new Error('size_mismatch');
   const bytes=Buffer.concat(chunks);
   if(hash(bytes)!==digest)throw new Error('hash_mismatch');
   transcript=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
   if(transcript.length>60000||!transcript.trim())throw new Error('transcript_limit');
   source=new Response(bytes);
  }
  await uploadVerifiedMedia({...env,SUPABASE_BUCKET:job.bucket},source,{file_size:size,sha256:digest,mime_type:mime},job.object_key,controller);
  const finishAt=Date.now(),live=`EXISTS(SELECT 1 FROM call_archives WHERE call_id=? AND kind=? AND state='uploading' AND lease_token=? AND lease_until>? AND expires_at>?)`;
  const saved=await env.DB.batch([
   env.DB.prepare(`INSERT INTO file_catalog(file_id,owner,dataset,message_id,kind,filename,mime_type,byte_size,sha256,bucket,object_key,source_epoch,extracted_text,extraction_status,extraction_method,index_state,created_at,updated_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'ready',?,? WHERE ${live} ON CONFLICT(message_id) DO NOTHING`)
    .bind(job.file_id,env.ALLOWED_SENDER,dataset(env),messageId,kind==='recording'?'audio':'document',job.filename,mime,size,digest,job.bucket,job.object_key,Math.floor(job.created_at/1000),transcript,
     kind==='transcript'?'ready':'metadata_only','livekit_archive',new Date(job.created_at).toISOString(),new Date(finishAt).toISOString(),callId,kind,token,finishAt,finishAt),
   env.DB.prepare(`UPDATE call_archives SET state='stored',lease_token=NULL,lease_until=0 WHERE call_id=? AND kind=? AND state='uploading' AND lease_token=? AND lease_until>? AND expires_at>?
    AND EXISTS(SELECT 1 FROM file_catalog WHERE file_id=? AND owner=? AND message_id=? AND sha256=?)`)
    .bind(callId,kind,token,finishAt,finishAt,job.file_id,env.ALLOWED_SENDER,messageId,digest)
  ]);
  if(saved[1].meta.changes!==1)return fail('archive_claim_lost',409);
  console.log(JSON.stringify({event:'call_archive',kind,state:'stored',bytes:size}));
  return Response.json({state:'stored',confirmed:true,fileId:job.file_id});
 }catch{
  await env.DB.prepare(`UPDATE call_archives SET state=CASE WHEN attempts>=3 THEN 'failed' ELSE 'pending' END,lease_token=NULL,lease_until=0 WHERE call_id=? AND kind=? AND lease_token=?`).bind(callId,kind,token).run();
  console.warn(JSON.stringify({event:'call_archive',kind,state:'failed'}));
  return fail('archive_upload_failed',503);
 }finally{clearTimeout(timer);}
}

export async function latestCallArchive(env,owner,kind){
 checkOwner(env,owner);
 if(env.CALL_ARCHIVE_ENABLED!=='true'||env.CALL_SUMMARY_ENABLED==='true')return {files:[],dateRule:'latest_call_archive'};
 const file=await env.DB.prepare(`SELECT f.*
  FROM call_archives a JOIN file_catalog f ON f.file_id=a.file_id JOIN call_sessions c ON c.call_id=a.call_id
  WHERE c.owner=? AND f.owner=? AND f.dataset=? AND a.kind=? AND a.state='stored' AND a.expires_at>?
  ORDER BY a.created_at DESC,a.file_id DESC LIMIT 1`).bind(owner,owner,dataset(env),kind,Date.now()).first();
 return {files:file?[{...file,score:1}]:[],dateRule:'latest_call_archive'};
}

export async function purgeCallArchives(env){
 const rows=await env.DB.prepare(`SELECT a.call_id,a.kind,a.file_id,a.bucket,a.object_key FROM call_archives a JOIN call_sessions c ON c.call_id=a.call_id
  WHERE c.owner=? AND (a.expires_at<=? OR (a.kind='recording' AND ?=1)) ORDER BY a.expires_at LIMIT 4`).bind(env.ALLOWED_SENDER,Date.now(),env.CALL_SUMMARY_ENABLED==='true'?1:0).all();
 for(const row of rows.results){
  // Hide from catalog before object deletion; keep failed deletions for a later tick.
  await env.DB.batch([
   env.DB.prepare("UPDATE call_archives SET state='expired',lease_token=NULL,lease_until=0 WHERE call_id=? AND kind=?").bind(row.call_id,row.kind),
   env.DB.prepare('DELETE FROM file_chunks WHERE file_id=?').bind(row.file_id),
   env.DB.prepare('DELETE FROM file_catalog WHERE file_id=? AND owner=?').bind(row.file_id,env.ALLOWED_SENDER)
  ]);
  if(await deleteObject({...env,SUPABASE_BUCKET:row.bucket},row.object_key))await env.DB.prepare("DELETE FROM call_archives WHERE call_id=? AND kind=? AND state='expired'").bind(row.call_id,row.kind).run();
 }
}
