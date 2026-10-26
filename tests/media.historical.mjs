import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const env = {
  META_VERIFY_TOKEN:'test-verify',META_APP_SECRET:'test-secret',META_ACCESS_TOKEN:'test-access',
  ALLOWED_SENDER:'15550000001',META_PHONE_NUMBER_ID:'test-phone',META_WABA_ID:'test-waba',
  SUPABASE_URL:'https://test.supabase.co',SUPABASE_BUCKET:'whats-files',SUPABASE_KEY:'test-storage-key',MAX_MEDIA_BYTES:52428800
};
const fixtures = new Map(), objects = new Map(), sends = [];
let sequence = 100;
const options = {
  modules:['worker.js','acknowledge.js','media.js','storage.js','search.js','indexing.js','delivery.js','commands.js','assistant.js','chat.js','calls.js','call-tools.js','livekit.js'].map(name => ({type:'ESModule',path:fileURLToPath(new URL('../src/'+name,import.meta.url))})),
  compatibilityDate:'2026-10-11',compatibilityFlags:['nodejs_compat'],bindings:env,d1Databases:['DB'],
  outboundService:async request => {
    const url = new URL(request.url);
    if (url.hostname === 'graph.facebook.com' && url.pathname.endsWith('/messages')) {
      assert.equal(request.headers.get('Authorization'),'Bearer test-access');
      const body=await request.json(); assert.equal(body.to,env.ALLOWED_SENDER);
      sends.push(body); return Response.json({messages:[{id:'reply-'+sends.length}]});
    }
    if (url.hostname === 'graph.facebook.com') {
      assert.equal(request.headers.get('Authorization'),'Bearer test-access');
      assert.equal(url.searchParams.get('phone_number_id'),env.META_PHONE_NUMBER_ID);
      const f=fixtures.get(url.pathname.split('/').at(-1)); assert.ok(f);
      f.metadataCalls++;
      if(f.redirect)return new Response(null,{status:302,headers:{Location:"https://untrusted.test/redirect"}});
      return Response.json({id:f.mediaId,mime_type:f.mime,file_size:f.declaredSize ?? f.size,sha256:f.sha,
        url:f.unsafeURL ?? `https://lookaside.fbsbx.com/media/${f.mediaId}/${f.metadataCalls}`});
    }
    if (url.hostname === 'lookaside.fbsbx.com') {
      assert.equal(request.headers.get('Authorization'),'Bearer test-access');
      const f=fixtures.get(url.pathname.split('/')[2]); f.downloadCalls++;
      if(f.expired && f.downloadCalls === 1)return new Response('expired',{status:404});
      if(f.hold)await f.hold;
      if(f.large){
        let remaining=f.size;
        return new Response(new ReadableStream({pull(controller){
          if(!remaining){controller.close();return;}
          const chunk=Buffer.alloc(Math.min(65536,remaining),7);remaining-=chunk.length;controller.enqueue(chunk);
        }}),{headers:{'Content-Type':f.mime}});
      }
      return new Response(f.corrupt ? Buffer.alloc(f.size,42) : f.bytes,{headers:{'Content-Type':f.mime}});
    }
    assert.equal(url.hostname,'test.supabase.co');
    assert.equal(request.headers.get('apikey'),'test-storage-key');
    assert.equal(request.headers.get('Authorization'),null);
    if(request.method==='DELETE'){
      for(const key of (await request.json()).prefixes)objects.delete(key);
      return Response.json([]);
    }
    assert.equal(request.method,'POST'); assert.equal(request.headers.get('x-upsert'),'true');
    const key=url.pathname.split('/').slice(5).join('/');
    const f=[...fixtures.values()].find(f=>key.includes(createHash('sha256').update(f.messageId).digest('hex')));
    assert.ok(f); f.uploadCalls++;
    if(f.storageFailures>0){f.storageFailures--;return new Response('unavailable',{status:503});}
    const hash=createHash('sha256');let length=0;const chunks=[];
    const reader=request.body.getReader();
    try{while(true){const next=await reader.read();if(next.done)break;length+=next.value.byteLength;hash.update(next.value);if(!f.large)chunks.push(Buffer.from(next.value));}}
    catch{return new Response('incomplete',{status:400});}
    objects.set(key,{size:length,sha:hash.digest('hex'),bytes:f.large ? null : Buffer.concat(chunks)});
    return Response.json({Key:'whats-files/'+key});
  }
};
const mf = new Miniflare(convertV4MiniflareOptions ? convertV4MiniflareOptions(options):options);
after(()=>mf.dispose());
const db=await mf.getD1Database('DB');
for(const migration of ['0001_inbound_messages.sql','0002_media_files.sql']){
  const sql=await readFile(new URL('../migrations/'+migration,import.meta.url),'utf8');
  for(const statement of sql.split(';').filter(x=>x.trim()))await db.prepare(statement).run();
}
const api=await mf.getWorker();
function fixture(type='audio', extras={}){
  const mediaId=String(++sequence), messageId='wamid.media-'+mediaId;
  const mime={audio:'audio/ogg; codecs=opus',image:'image/png',video:'video/mp4',document:'application/pdf'}[type];
  const bytes=Buffer.from('Synthetic '+type+' fixture.');
  const f={mediaId,messageId,type,mime,bytes,size:bytes.length,sha:createHash('sha256').update(bytes).digest('base64'),
    metadataCalls:0,downloadCalls:0,uploadCalls:0,storageFailures:0,...extras};
  fixtures.set(mediaId,f);return f;
}
function payload(f,from=env.ALLOWED_SENDER){return {object:'whatsapp_business_account',entry:[{id:env.META_WABA_ID,changes:[{
  field:'messages',value:{metadata:{phone_number_id:env.META_PHONE_NUMBER_ID},messages:[{
    id:f.messageId,from,type:f.type,timestamp:'1791780000',[f.type]:{id:f.mediaId,sha256:f.sha,mime_type:f.mime,
      voice:f.voice ?? true,filename:'../../sample.pdf',url:'https://untrusted.test/ignore-this-url'}
  }]}
}]}]};}
async function post(f,from,invalid=false){
  const body=JSON.stringify(payload(f,from));
  const signature='sha256='+createHmac('sha256',env.META_APP_SECRET).update(body).digest('hex');
  return mf.dispatchFetch('https://test.invalid/webhook',{method:'POST',body,headers:{'X-Hub-Signature-256':invalid?'sha256='+ '0'.repeat(64):signature}});
}
const row = id => db.prepare('SELECT m.*,i.ack_state FROM media_files m JOIN inbound_messages i ON i.message_id=m.message_id WHERE m.message_id=?').bind(id).first();
async function waitFor(id, predicate){
  for(let i=0;i<100;i++){const r=await row(id);if(r&&predicate(r))return r;await new Promise(resolve=>setTimeout(resolve,20));}
  assert.fail('Media job did not reach expected state');
}
const finished=id=>waitFor(id,r=>['ready','rejected','failed'].includes(r.state)&&r.ack_state==='sent');

test('voice note streams to private storage with correct bytes/hash and replies only after storage',async()=>{
  let release;const held=new Promise(resolve=>{release=resolve;});const f=fixture('audio',{hold:held});
  const before=sends.length, start=performance.now();
  assert.equal((await post(f)).status,200);assert.ok(performance.now()-start<1000);
  assert.equal(sends.length,before);release();
  const r=await finished(f.messageId);assert.equal(r.state,'ready');assert.equal(r.is_voice_note,1);
  assert.equal(r.sha256,createHash('sha256').update(f.bytes).digest('hex'));
  assert.equal(r.byte_size,f.bytes.length);assert.equal(r.storage_provider,'supabase');
  assert.deepEqual(objects.get(r.object_key).bytes,f.bytes);
  assert.equal(sends.at(-1).text.body,'Voice note saved.');assert.ok(!r.object_key.includes('sample.pdf'));
});

test('image, PDF, video and regular audio use the shared pipeline',async()=>{
  for(const type of ['image','document','video','audio']){
    const f=fixture(type,{voice:false});assert.equal((await post(f)).status,200);
    const r=await finished(f.messageId);assert.equal(r.state,'ready');assert.equal(r.is_voice_note,0);
    assert.equal(r.mime_type,f.mime);assert.equal(objects.get(r.object_key).size,f.size);
  }
});

test('simultaneous media replays produce one object, row and saved reply',async()=>{
  const f=fixture(),before=sends.length;
  assert.deepEqual((await Promise.all(Array.from({length:4},()=>post(f)))).map(r=>r.status),[200,200,200,200]);
  const r=await finished(f.messageId);
  for(let i=0;i<3;i++)assert.equal((await post(f)).status,200);
  assert.equal(f.uploadCalls,1);assert.equal(sends.length-before,1);
  assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM media_files WHERE message_id=?').bind(f.messageId).first('n'),1);
  assert.ok(objects.has(r.object_key));
});

test('bad signature and other sender cause no media download or storage',async()=>{
  const f=fixture(),before=sends.length;
  assert.equal((await post(f,env.ALLOWED_SENDER,true)).status,403);
  assert.equal((await post(f,'15550000002')).status,200);
  assert.equal(await row(f.messageId),null);assert.equal(f.metadataCalls,0);assert.equal(sends.length,before);
});

test('expired download URL is reacquired from media ID',async()=>{
  const f=fixture('audio',{expired:true});assert.equal((await post(f)).status,200);
  assert.equal((await finished(f.messageId)).state,'ready');assert.equal(f.metadataCalls,2);assert.equal(f.downloadCalls,2);
});

test('file above Supabase limit is rejected before download, with a friendly reply',async()=>{
  const f=fixture('document',{declaredSize:100*1024*1024+1});assert.equal((await post(f)).status,200);
  const r=await finished(f.messageId);assert.equal(r.state,'rejected');assert.equal(r.error_code,'too_large');
  assert.equal(f.downloadCalls,0);assert.equal(f.uploadCalls,0);assert.match(sends.at(-1).text.body,/50 MB/);
});

test('wrong hashes cannot become ready and uploaded corrupt data is cleaned up',async()=>{
  const f=fixture('audio',{corrupt:true});assert.equal((await post(f)).status,200);
  const r=await finished(f.messageId);assert.equal(r.state,'rejected');assert.equal(r.error_code,'hash_mismatch');
  assert.equal(objects.has(r.object_key),false);assert.ok(!sends.at(-1).text.body.includes('saved'));
});

test('unsafe download URLs cannot receive Meta tokens',async()=>{
  const f=fixture('audio',{unsafeURL:'https://untrusted.test/steal-token'});
  assert.equal((await post(f)).status,200);const r=await finished(f.messageId);
  assert.equal(r.state,'rejected');assert.equal(r.error_code,'unsafe_media_url');assert.equal(f.downloadCalls,0);
});

test('transient upload failure is persisted and scheduled retry saves the file once',async()=>{
  const f=fixture('audio',{storageFailures:1}),before=sends.length;
  assert.equal((await post(f)).status,200);const pending=await waitFor(f.messageId,r=>r.state==='pending'&&r.attempts===1);
  assert.equal(pending.ack_state,'pending');assert.equal(sends.length,before);
  await db.prepare('UPDATE media_files SET next_attempt_at=0 WHERE message_id=?').bind(f.messageId).run();
  await api.scheduled({cron:'* * * * *'});
  const r=await finished(f.messageId);assert.equal(r.state,'ready');assert.equal(r.attempts,2);
  assert.equal(sends.length-before,1);assert.ok(objects.has(r.object_key));
});

test('expired processing lease is recovered through the scheduled handler',async()=>{
  const f=fixture('audio',{storageFailures:1});await post(f);
  await waitFor(f.messageId,r=>r.state==='pending');
  await db.prepare("UPDATE media_files SET state='processing', lease_until=0 WHERE message_id=?").bind(f.messageId).run();
  await api.scheduled({cron:'* * * * *'});assert.equal((await finished(f.messageId)).state,'ready');
});

test('50 MiB file is streamed without buffering the complete file in the Worker',async()=>{
  const size=50*1024*1024;const digest=createHash('sha256');const chunk=Buffer.alloc(65536,7);
  for(let offset=0;offset<size;offset+=chunk.length)digest.update(chunk);
  const f=fixture('document',{large:true,size,sha:digest.digest('base64')});
  assert.equal((await post(f)).status,200);const r=await finished(f.messageId);
  assert.equal(r.state,'ready');assert.equal(r.byte_size,size);assert.equal(objects.get(r.object_key).size,size);
  assert.equal(objects.get(r.object_key).sha,r.sha256);
});


test('credential-bearing redirects are rejected without following the foreign host',async()=>{
  const f=fixture('audio',{redirect:true});assert.equal((await post(f)).status,200);
  const r=await finished(f.messageId);assert.equal(r.state,'rejected');assert.equal(r.error_code,'media_metadata');
  assert.equal(f.downloadCalls,0);assert.equal(f.uploadCalls,0);
});

test('a crash on the last lease terminates retries and sends one failure reply',async()=>{
  const f=fixture('audio',{storageFailures:5}),before=sends.length;await post(f);
  await waitFor(f.messageId,r=>r.state==='pending'&&r.attempts===1);
  await db.prepare("UPDATE media_files SET state='processing', attempts=3, lease_until=0 WHERE message_id=?").bind(f.messageId).run();
  await api.scheduled({cron:'* * * * *'});const r=await finished(f.messageId);
  assert.equal(r.state,'failed');assert.equal(r.error_code,'attempts_exhausted');assert.equal(f.uploadCalls,1);
  await post(f);assert.equal(sends.length-before,1);assert.equal(f.uploadCalls,1);
});
