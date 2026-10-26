import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const {Miniflare,convertV4MiniflareOptions}=createRequire(import.meta.url)('miniflare');
const owner='15550000001',bytes=Buffer.from('%PDF synthetic latency fixture'),sha=createHash('sha256').update(bytes).digest('hex');
let reads=0,uploads=0,metadata=0,corrupt=false;
const media=new Map();
const env={ALLOWED_SENDER:owner,META_PHONE_NUMBER_ID:'phone',META_ACCESS_TOKEN:'access',SUPABASE_URL:'https://test.supabase.co',SUPABASE_KEY:'storage'};
const entry=`import {prepare_file_delivery} from '../src/delivery.js';export default {async fetch(request,env){const p=await request.json();try{return Response.json(await prepare_file_delivery(env,p.owner,p.id));}catch(e){return Response.json({error:e.code??e.message},{status:400});}}};`;
const options={workers:[{name:'app',modules:[{type:'ESModule',path:fileURLToPath(new URL('delivery-entry.js',import.meta.url)),contents:entry},...['delivery.js','storage.js','search.js'].map(name=>({type:'ESModule',path:fileURLToPath(new URL('../src/'+name,import.meta.url))}))],bindings:env,d1Databases:['DB'],compatibilityDate:'2026-10-11',compatibilityFlags:['nodejs_compat'],outboundService:async request=>{
 const url=new URL(request.url);
 if(url.hostname==='test.supabase.co'){assert.equal(request.headers.get('apikey'),'storage');reads++;return new Response(corrupt?Buffer.from('bad'):bytes);}
 assert.equal(url.hostname,'graph.facebook.com');assert.equal(request.headers.get('Authorization'),'Bearer access');
 if(url.pathname.endsWith('/media')){uploads++;try{await request.arrayBuffer();}catch{return new Response('',{status:400});}const id=String(9000+uploads);media.set(id,{id,sha256:sha,file_size:bytes.length,mime_type:'application/pdf'});return Response.json({id});}
 assert.equal(request.method,'GET');assert.equal(url.searchParams.get('phone_number_id'),'phone');metadata++;
 const info=media.get(url.pathname.split('/').at(-1));return info?Response.json(info):new Response('',{status:404});
}}]};
const mf=new Miniflare(convertV4MiniflareOptions?convertV4MiniflareOptions(options):options);after(()=>mf.dispose());
const db=await mf.getD1Database('DB','app');
for(const name of ['0001_inbound_messages.sql','0002_media_files.sql','0003_search_and_commands.sql','0004_assistant.sql','0008_chat_context.sql','0007_delivery_cache.sql'])for(const sql of (await readFile(new URL('../migrations/'+name,import.meta.url),'utf8')).split(';').filter(x=>x.trim()))await db.prepare(sql).run();
async function fixture(n,who=owner){const id=n.toString(16).padStart(16,'0');await db.prepare(`INSERT INTO file_catalog(file_id,owner,message_id,kind,filename,mime_type,byte_size,sha256,bucket,object_key,source_epoch,created_at,updated_at) VALUES(?,?,?,'document','security.pdf','application/pdf',?,?,'whats-files','fixture.pdf',?,?,?)`).bind(id,who,'fixture-'+id,bytes.length,sha,Math.floor(Date.now()/1000),new Date().toISOString(),new Date().toISOString()).run();return id;}
async function prepare(id,who=owner){const r=await mf.dispatchFetch('https://test.invalid/',{method:'POST',body:JSON.stringify({id,owner:who})});return {status:r.status,data:await r.json()};}
async function cache(id,{phone='phone',hash=sha,expiry=Date.now()+86400000,mediaId='777'}={}){await db.prepare('UPDATE file_catalog SET meta_media_id=?,meta_media_phone=?,meta_media_sha256=?,meta_media_expires_at=? WHERE file_id=?').bind(mediaId,phone,hash,expiry,id).run();}
test('a verified upload is cached; repeat delivery verifies Meta metadata without storage download or upload',async()=>{
 const id=await fixture(1),before={reads,uploads,metadata};const first=await prepare(id);assert.equal(first.status,200);assert.equal(uploads,before.uploads+1);assert.equal(reads,before.reads+1);
 const second=await prepare(id);assert.deepEqual(second.data,first.data);assert.equal(uploads,before.uploads+1);assert.equal(reads,before.reads+1);assert.equal(metadata,before.metadata+1);
});
test('expired, wrong-phone and changed-hash cache entries are not reused',async()=>{
 media.set('777',{id:'777',sha256:sha,file_size:bytes.length,mime_type:'application/pdf'});
 for(const [n,options] of [[2,{expiry:Date.now()-1}],[3,{phone:'another-phone'}],[4,{hash:'0'.repeat(64)}]]){const id=await fixture(n);await cache(id,options);const before=uploads;const result=await prepare(id);assert.equal(result.status,200);assert.notEqual(result.data.document.id,'777');assert.equal(uploads,before+1);}
});
test('deleted IDs and inconsistent Meta size/hash/MIME fall back to integrity-checked storage',async()=>{
 for(const [n,info] of [[5,null],[6,{sha256:'0'.repeat(64)}],[7,{file_size:1}],[8,{mime_type:'image/jpeg'}]]){const id=await fixture(n),mediaId=String(700+n);if(info)media.set(mediaId,{id:mediaId,sha256:sha,file_size:bytes.length,mime_type:'application/pdf',...info});await cache(id,{mediaId});const before=uploads;const result=await prepare(id);assert.equal(result.status,200);assert.equal(uploads,before+1);assert.notEqual(result.data.document.id,mediaId);}
});
test('recent incoming media is reused only for matching owner, phone, hash and ready state',async()=>{
 for(const [n,phone,hash,state,age,sender,reuse] of [[9,'phone',sha,'ready',0,owner,true],[10,'wrong',sha,'ready',0,owner,false],[11,'phone','0'.repeat(64),'ready',0,owner,false],[12,'phone',sha,'pending',0,owner,false],[13,'phone',sha,'ready',8,owner,false],[14,'phone',sha,'ready',0,'15550000002',false]]){
  const id=await fixture(n),message='fixture-'+id,created=new Date(Date.now()-age*86400000).toISOString(),mid=String(800+n);media.set(mid,{id:mid,sha256:Buffer.from(sha,'hex').toString('base64'),file_size:bytes.length,mime_type:'application/pdf'});
  await db.prepare("INSERT INTO inbound_messages(message_id,sender,phone_number_id,message_type,payload_json,received_at) VALUES(?,?,?,'document','{}',?)").bind(message,sender,phone,created).run();
  await db.prepare("INSERT INTO media_files(message_id,sender,media_id,message_type,bucket,object_key,created_at,updated_at,state,sha256,byte_size) VALUES(?,?,?,'document','whats-files',?,?,?,?,?,?)").bind(message,sender,mid,'source-'+id,created,created,state,hash,bytes.length).run();
  const before=uploads,result=await prepare(id);assert.equal(result.status,200);assert.equal(result.data.document.id===mid,reuse);assert.equal(uploads,before+(reuse?0:1));
 }
});
test('a foreign file cannot access a cached ID or initiate any outbound request',async()=>{const id=await fixture(15,'15550000002');await cache(id);const before={reads,uploads,metadata};assert.equal((await prepare(id)).data.error,'file_not_found');assert.equal((await prepare(id,'15550000002')).data.error,'forbidden');assert.deepEqual({reads,uploads,metadata},before);});
test('failed integrity verification never populates the media cache',async()=>{const id=await fixture(16);corrupt=true;try{assert.equal((await prepare(id)).status,400);}finally{corrupt=false;}assert.equal((await db.prepare('SELECT meta_media_id FROM file_catalog WHERE file_id=?').bind(id).first()).meta_media_id,null);});
