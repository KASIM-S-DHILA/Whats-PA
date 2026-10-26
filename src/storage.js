import { createHash, createHmac } from 'node:crypto';

export class MediaError extends Error {
  constructor(code, retryable = false) { super(code); this.code = code; this.retryable = retryable; }
}

function storageURL(env, suffix) {
  const base = new URL(env.SUPABASE_URL);
  if (base.protocol !== 'https:' || !base.hostname.endsWith('.supabase.co') || base.pathname !== '/') {
    throw new MediaError('storage_configuration');
  }
  return new URL('/storage/v1/' + suffix, base);
}
const objectPath = (env, key) => encodeURIComponent(env.SUPABASE_BUCKET) + '/' + key.split('/').map(encodeURIComponent).join('/');

export async function uploadVerifiedMedia(env, download, info, key, controller) {
  if(env.RAG_PDF_BATCHES_ENABLED==='true'&&info.mime_type.split(';')[0].trim()==='application/pdf'&&info.file_size>8388608)return uploadNativeVerifiedPdf(env,download,info,key,controller);
  const digest = createHash('sha256');
  let length = 0;
  let actualHash;
  const checked = download.body.pipeThrough(new TransformStream({
    transform(chunk, output) {
      length += chunk.byteLength;
      if (length > info.file_size || length > Number(env.MAX_MEDIA_BYTES)) throw new MediaError('size_mismatch');
      digest.update(chunk);
      output.enqueue(chunk);
    },
    flush() {
      actualHash = digest.digest('hex');
      if (length !== info.file_size) throw new MediaError('size_mismatch');
      if (actualHash !== info.sha256) throw new MediaError('hash_mismatch');
    }
  }));
  const fixed = new FixedLengthStream(info.file_size);
  const pump = checked.pipeTo(fixed.writable, { signal: controller.signal });
  const upload = fetch(storageURL(env, 'object/' + objectPath(env, key)), {
    method: 'POST', redirect: 'manual',
    headers: { apikey: env.SUPABASE_KEY, 'Content-Type': info.mime_type, 'x-upsert': 'true' },
    body: fixed.readable, signal: controller.signal
  }).then(async response => {
    if (!response.ok) {
      await response.body?.cancel();
      throw new MediaError('storage_upload', response.status === 429 || response.status >= 500);
    }
    await response.body?.cancel();
  });
  try { await Promise.all([pump, upload]); }
  catch (error) { controller.abort(); throw error; }
  return { byteSize: length, sha256: actualHash };
}

async function uploadNativeVerifiedPdf(env,download,info,key,controller){
  const base=new URL(env.RAG_FAISS_URL);
  if(base.protocol!=='https:'||base.username||base.password||base.pathname!=='/'||!env.RAG_INDEX_SECRET)throw new MediaError('storage_configuration');
  const path='/pdf-upload',stamp=String(Math.floor(Date.now()/1000));
  const sig=createHmac('sha256',env.RAG_INDEX_SECRET).update(`whats-pdf-tools:v1:${path}:${stamp}:${info.sha256}:${info.file_size}`).digest('hex');
  const streams=[new FixedLengthStream(info.file_size),new FixedLengthStream(info.file_size)];
  const reader=download.body.getReader(),writers=streams.map(s=>s.writable.getWriter());let length=0;
  // Await both writers for every chunk: a slow destination cannot cause an unbounded tee buffer.
  const pump=(async()=>{
    try{
      for(;;){const next=await reader.read();if(next.done)break;length+=next.value.byteLength;if(length>info.file_size||length>Number(env.MAX_MEDIA_BYTES))throw new MediaError('size_mismatch');await Promise.all(writers.map(w=>w.write(next.value)));}
      if(length!==info.file_size)throw new MediaError('size_mismatch');
      await Promise.all(writers.map(w=>w.close()));
    }catch(error){controller.abort();await Promise.allSettled(writers.map(w=>w.abort(error)));throw error;}
    finally{reader.releaseLock();for(const w of writers)w.releaseLock();}
  })();
  const upload=fetch(storageURL(env,'object/'+objectPath(env,key)),{method:'POST',redirect:'manual',headers:{apikey:env.SUPABASE_KEY,'Content-Type':info.mime_type,'x-upsert':'true'},body:streams[0].readable,signal:controller.signal}).then(async response=>{await response.body?.cancel();if(!response.ok)throw new MediaError('storage_upload',response.status===429||response.status>=500);});
  const verified=fetch(new URL(path,base),{method:'POST',redirect:'manual',headers:{'Content-Type':'application/octet-stream','X-Bridge-Time':stamp,'X-Bridge-Signature':sig,'X-Content-Sha256':info.sha256},body:streams[1].readable,signal:controller.signal}).then(async response=>{
    if(!response.ok){await response.body?.cancel();throw new MediaError('native_integrity',response.status===429||response.status>=500);}
    const source=response.body.getReader(),parts=[];let size=0;
    try{for(;;){const next=await source.read();if(next.done)break;size+=next.value.length;if(size>1024){await source.cancel();throw new MediaError('native_integrity');}parts.push(next.value);}}finally{source.releaseLock();}
    const result=JSON.parse(new TextDecoder().decode(Buffer.concat(parts)));
    if(result.sourceHash!==info.sha256||result.stored!==true)throw new MediaError('hash_mismatch');
  });
  try{await Promise.all([pump,upload,verified]);}catch(error){controller.abort();throw error;}
  return {byteSize:length,sha256:info.sha256};
}

export async function deleteObject(env, key) {
  try {
    const response = await fetch(storageURL(env, 'object/' + encodeURIComponent(env.SUPABASE_BUCKET)), {
      method: 'DELETE', redirect: 'manual',
      headers: { apikey: env.SUPABASE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: [key] }), signal: AbortSignal.timeout(3000)
    });
    await response.body?.cancel();
    return response.ok;
  } catch { return false; }
}

export function readStoredObject(env,bucket,key,{timeout=20000}={}){
 if(!Number.isInteger(timeout)||timeout<1||timeout>60000)throw new MediaError('invalid_timeout');
 return fetch(storageURL(env,'object/authenticated/'+encodeURIComponent(bucket)+'/'+key.split('/').map(encodeURIComponent).join('/')),{
  headers:{apikey:env.SUPABASE_KEY},redirect:'manual',signal:AbortSignal.timeout(Math.max(1,Math.min(timeout,env.CHAT_DEADLINE?env.CHAT_DEADLINE-Date.now():timeout)))});
}
