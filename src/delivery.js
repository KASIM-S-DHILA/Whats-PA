import {createHash} from 'node:crypto';
import {get_file,dataset,ToolError} from './search.js';
import {readStoredObject} from './storage.js';

const caps={image:5*1024*1024,audio:16*1024*1024,video:16*1024*1024,document:100*1024*1024};
const timeout=(env,maximum)=>Math.max(1,Math.min(maximum,env.CHAT_DEADLINE?env.CHAT_DEADLINE-Date.now():maximum));
function filename(value){return value.split(/[\\/]/).at(-1).replace(/[\x00-\x1f\x7f]/g,'').slice(0,180) || 'file';}
function mediaPayload(file,id){
 const type=file.kind;
 return {type,[type]:{id,...(type==='document'?{filename:filename(file.filename)}:{})}};
}
async function reusableMedia(env,file,timing){
 const lookupStart=performance.now();
 let id=null;
 if(file.meta_media_phone===env.META_PHONE_NUMBER_ID&&file.meta_media_sha256===file.sha256&&file.meta_media_expires_at>Date.now()+60000)id=file.meta_media_id;
 else id=file.incoming_media_id; // Already joined under owner/phone/hash/size/time constraints.
 timing.cacheLookupMs=Math.round(performance.now()-lookupStart);
 if(!/^\d{1,40}$/.test(id??''))return null;
 // Media can be deleted before expiry. Validate the phone, hash, MIME and size
 // without downloading its bytes; unavailable IDs fall back to verified storage.
 const checkStart=performance.now();
 try{
  const response=await fetch(`https://graph.facebook.com/v26.0/${id}?phone_number_id=${encodeURIComponent(env.META_PHONE_NUMBER_ID)}`,{
   headers:{Authorization:`Bearer ${env.META_ACCESS_TOKEN}`},redirect:'manual',signal:AbortSignal.timeout(timeout(env,3000))});
  if(!response.ok){await response.body?.cancel();return null;}
  const info=await response.json(),sha=typeof info.sha256==='string'&&/^[A-Za-z0-9+/]{43}=$/.test(info.sha256)?Buffer.from(info.sha256,'base64').toString('hex'):info.sha256;
  if(String(info.id)!==id||Number(info.file_size)!==file.byte_size||String(sha).toLowerCase()!==file.sha256||
   info.mime_type?.split(';')[0].trim().toLowerCase()!==file.mime_type.split(';')[0].trim().toLowerCase())return null;
  return id;
 }catch{return null;}finally{timing.metaCheckMs=Math.round(performance.now()-checkStart);}
}
async function signedLink(env,file,description=`This file is larger than WhatsApp's native ${file.kind} limit. Download it using this private link, which expires in 5 minutes:`){
 const path='/storage/v1/object/sign/'+encodeURIComponent(file.bucket)+'/'+file.object_key.split('/').map(encodeURIComponent).join('/');
 const response=await fetch(new URL(path,env.SUPABASE_URL),{method:'POST',redirect:'manual',
  headers:{apikey:env.SUPABASE_KEY,'Content-Type':'application/json'},body:JSON.stringify({expiresIn:300}),signal:AbortSignal.timeout(timeout(env,10000))});
 if(!response.ok){await response.body?.cancel();throw new ToolError('link_failed');}
 const data=await response.json(),raw=data.signedURL ?? data.signedUrl;
 if(typeof raw!=='string')throw new ToolError('link_failed');
 const url=new URL(raw.startsWith('/object/')?'/storage/v1'+raw:raw,env.SUPABASE_URL);
 if(url.origin!==new URL(env.SUPABASE_URL).origin||!url.pathname.startsWith('/storage/v1/object/sign/'))throw new ToolError('unsafe_link');
 return {type:'text',text:{body:description+'\n'+url,preview_url:false}};
}
export async function prepare_file_delivery(env,owner,fileId,{expectedHash=null,expectedKind=null}={}){
 const file=await get_file(env,owner,fileId,{delivery:true});
 if(expectedKind&&file.kind!==expectedKind)throw new ToolError('file_not_found');
 if(expectedHash&&file.sha256!==expectedHash)throw new ToolError('file_changed');
 if(file.mime_type==='application/json')return signedLink(env,file,'Download this call transcript using this private link, which expires in 5 minutes:');
 if(file.byte_size>(caps[file.kind]??0))return signedLink(env,file);
 const started=performance.now(),timing={cacheLookupMs:0,metaCheckMs:0},reused=await reusableMedia(env,file,timing);
 if(reused){console.log(JSON.stringify({event:'file_delivery_prepare',path:'meta_reuse',elapsedMs:Math.round(performance.now()-started),...timing}));return mediaPayload(file,reused);}
 const storageStart=performance.now();
 const source=await readStoredObject(env,file.bucket,file.object_key);
 timing.storageHeadersMs=Math.round(performance.now()-storageStart);
 if(!source.ok||!source.body)throw new ToolError('file_unavailable');
 const name=filename(file.filename),boundary='whats-'+crypto.randomUUID();
 const safeHeader=name.replace(/[^a-zA-Z0-9 ._-]/g,'_');
 const prefix=new TextEncoder().encode(`--${boundary}\r\nContent-Disposition: form-data; name="messaging_product"\r\n\r\nwhatsapp\r\n--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\n${file.mime_type}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeHeader}"\r\nContent-Type: ${file.mime_type}\r\n\r\n`);
 const suffix=new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
 const digest=createHash('sha256');let size=0;const reader=source.body.getReader();let begun=false,ended=false;
 const body=new ReadableStream({
  async pull(output){
   if(!begun){begun=true;output.enqueue(prefix);return;}
   const next=await reader.read();
   if(next.done){
    if(size!==file.byte_size||digest.digest('hex')!==file.sha256)throw new ToolError('file_integrity_failed');
    if(!ended){ended=true;output.enqueue(suffix);}output.close();return;
   }
   size+=next.value.byteLength;if(size>file.byte_size)throw new ToolError('file_integrity_failed');
   digest.update(next.value);output.enqueue(next.value);
  },cancel(reason){return reader.cancel(reason);}
 });
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout(env,20000));
 const fixed=new FixedLengthStream(prefix.length+file.byte_size+suffix.length);
 const pump=body.pipeTo(fixed.writable,{signal:controller.signal});
 const upload=fetch(`https://graph.facebook.com/v26.0/${env.META_PHONE_NUMBER_ID}/media`,{
  method:'POST',headers:{Authorization:`Bearer ${env.META_ACCESS_TOKEN}`,'Content-Type':`multipart/form-data; boundary=${boundary}`},
  body:fixed.readable,redirect:'manual',signal:controller.signal
 }).then(async response=>{if(!response.ok){await response.body?.cancel();throw new ToolError('media_upload_failed');}return response.json();});
 let result;const uploadStart=performance.now();
 try{[,result]=await Promise.all([pump,upload]);}
 catch{controller.abort();throw new ToolError('media_upload_failed');}
 finally{clearTimeout(timer);timing.uploadPipelineMs=Math.round(performance.now()-uploadStart);}
 if(typeof result.id!=='string'||!/^\d+$/.test(result.id))throw new ToolError('media_upload_failed');
 // Leave a one-day safety margin on Meta's uploaded-media lifetime. Cache only
 // after the complete source stream passed its size and SHA256 checks.
 const cacheStart=performance.now();
 await env.DB.prepare(`UPDATE file_catalog SET meta_media_id=?,meta_media_phone=?,meta_media_sha256=?,meta_media_expires_at=?
  WHERE file_id=? AND owner=? AND dataset=? AND sha256=?`).bind(result.id,env.META_PHONE_NUMBER_ID,file.sha256,Date.now()+29*86400000,
   file.file_id,owner,dataset(env),file.sha256).run();
 timing.cacheWriteMs=Math.round(performance.now()-cacheStart);
 console.log(JSON.stringify({event:'file_delivery_prepare',path:'storage_upload',elapsedMs:Math.round(performance.now()-started),...timing}));
 return mediaPayload(file,result.id);
}
