import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const {Miniflare,convertV4MiniflareOptions}=createRequire(import.meta.url)('miniflare');
const env={META_VERIFY_TOKEN:'verify',META_APP_SECRET:'meta-secret',META_ACCESS_TOKEN:'access',VOICE_BRIDGE_SECRET:'voice-secret',ALLOWED_SENDER:'15550000001',META_PHONE_NUMBER_ID:'phone',META_WABA_ID:'waba',CALL_BRIDGE_ENABLED:'true',CALL_BRIDGE_BACKEND:'livekit',VOICE_CALL_TOOLS_ENABLED:'true',LIVEKIT_URL:'wss://whats-test.livekit.cloud',LIVEKIT_API_KEY:'test-key',LIVEKIT_API_SECRET:'test-secret'};
const requests=[],rejections=[];let failures=0,hold=null,entered=null;
const options={modules:['worker.js','acknowledge.js','media.js','storage.js','search.js','indexing.js','delivery.js','commands.js','assistant.js','chat.js','calls.js','call-tools.js','livekit.js'].map(name=>({type:'ESModule',path:fileURLToPath(new URL('../src/'+name,import.meta.url))})),compatibilityDate:'2026-10-11',compatibilityFlags:['nodejs_compat'],bindings:env,d1Databases:['DB'],outboundService:async request=>{
 const data=await request.json(),url=new URL(request.url);
 if(url.hostname==='graph.facebook.com'){rejections.push(data);return Response.json({success:true});}
 assert.equal(url.hostname,'whats-test.livekit.cloud');assert.equal(url.protocol,'https:');
 const jwt=request.headers.get('Authorization').slice(7),[head,body,signature]=jwt.split('.');
 assert.equal(signature,createHmac('sha256',env.LIVEKIT_API_SECRET).update(head+'.'+body).digest('base64url'));
 const claims=JSON.parse(Buffer.from(body,'base64url'));assert.equal(claims.iss,env.LIVEKIT_API_KEY);assert.deepEqual(claims.video,{roomCreate:true});assert.ok(claims.exp*1000>Date.now());
 const method=url.pathname.split('/').at(-1);requests.push({method,data,key:request.headers.get('X-Livekit-Request-Id')});
 if(failures-->0)return Response.json({code:'unavailable',msg:'private vendor message'},{status:503});
 if(hold&&method==='AcceptWhatsAppCall'){entered();await hold;}
 if(method==='DisconnectWhatsAppCall')return Response.json({code:'not_found'},{status:404});
 return Response.json({roomName:data.roomName});
}};
const mf=new Miniflare(convertV4MiniflareOptions?convertV4MiniflareOptions(options):options);after(()=>mf.dispose());const db=await mf.getD1Database('DB');
for(const name of ['0001_inbound_messages.sql','0002_media_files.sql','0003_search_and_commands.sql','0004_assistant.sql','0008_chat_context.sql','0005_calls.sql','0006_voice_tools.sql'])for(const sql of (await readFile(new URL('../migrations/'+name,import.meta.url),'utf8')).split(';').filter(s=>s.trim()))await db.prepare(sql).run();
const offer=id=>({id:'wacid.'+id,from:env.ALLOWED_SENDER,event:'connect',timestamp:String(Math.floor(Date.now()/1000)),session:{sdp_type:'offer',sdp:'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'}});
async function post(call){const body=JSON.stringify({object:'whatsapp_business_account',entry:[{id:env.META_WABA_ID,changes:[{field:'calls',value:{metadata:{phone_number_id:env.META_PHONE_NUMBER_ID},calls:[call]}}]}]});return mf.dispatchFetch('https://test.invalid/webhook',{method:'POST',body,headers:{'X-Hub-Signature-256':'sha256='+createHmac('sha256',env.META_APP_SECRET).update(body).digest('hex')}});}
async function wait(id,state='forwarded'){for(let i=0;i<150;i++){const rows=await db.prepare('SELECT state FROM call_events WHERE call_id=?').bind(id).all();if(rows.results.some(r=>r.state===state))return;await new Promise(r=>setTimeout(r,20));}assert.fail('call state did not complete');}
async function end(id,secret=env.VOICE_BRIDGE_SECRET){const body=JSON.stringify({callId:id,revision:1,action:'end'}),stamp=String(Math.floor(Date.now()/1000));return mf.dispatchFetch('https://test.invalid/bridge/tools',{method:'POST',body,headers:{'X-Bridge-Time':stamp,'X-Bridge-Signature':createHmac('sha256',secret).update('whats-tools:v1:'+stamp+':'+body).digest('hex')}});}

test('signed incoming call dispatches one authenticated agent with private scoped metadata',async()=>{
 const call=offer('deduplicate'),before=requests.length;await Promise.all([post(call),post(call)]);await wait(call.id);await post(call);await new Promise(r=>setTimeout(r,30));
 assert.equal(requests.length,before+1);const {data}=requests.at(-1);assert.equal(data.whatsappApiKey,'access');assert.equal(data.whatsappCloudApiVersion,'26.0');assert.deepEqual(data.sdp,{type:'offer',sdp:call.session.sdp});assert.equal(data.waitUntilAnswered,false);
 const room='whats-'+createHash('sha256').update(call.id).digest('hex').slice(0,32);assert.equal(data.roomName,room);assert.equal(data.agents[0].agentName,'whats-voice');
 const metadata=JSON.parse(data.agents[0].metadata);assert.equal(metadata.callId,call.id);assert.equal(metadata.signature,createHmac('sha256',env.VOICE_BRIDGE_SECRET).update('whats-livekit:v1:'+call.id+':'+room).digest('hex'));assert.ok(!data.agents[0].metadata.includes(env.ALLOWED_SENDER));assert.ok(!data.agents[0].metadata.includes('access'));
});
test('temporary connector failure retries with the same vendor idempotency key',async()=>{
 const call=offer('retry');failures=1;await post(call);await wait(call.id,'pending');await post(call);await wait(call.id);const sent=requests.filter(r=>r.data.whatsappCallId===call.id);assert.equal(sent.length,2);assert.equal(sent[0].key,sent[1].key);
});
test('user hangup supplies the key required by the live connector and treats already-ended as success',async()=>{
 const call=offer('hangup');await post(call);await wait(call.id);await post({...call,event:'terminate',session:undefined});await new Promise(r=>setTimeout(r,80));const sent=requests.filter(r=>r.data.whatsappCallId===call.id).at(-1);assert.equal(sent.method,'DisconnectWhatsAppCall');assert.equal(sent.data.disconnectReason,'USER_INITIATED');assert.equal(sent.data.whatsappApiKey,'access');
});
test('terminate-before-connect suppresses a late offer',async()=>{
 const call=offer('tombstone');await post({...call,event:'terminate',session:undefined});await wait(call.id);await post(call);await wait(call.id,'discarded');assert.equal(requests.filter(r=>r.data.whatsappCallId===call.id&&r.method==='AcceptWhatsAppCall').length,0);
});
test('agent timeout closes call through durable business-disconnect job once',async()=>{
 const call=offer('deadline');await post(call);await wait(call.id);assert.equal((await end(call.id)).status,200);assert.equal((await end(call.id)).status,200);
 const sent=requests.filter(r=>r.data.whatsappCallId===call.id&&r.method==='DisconnectWhatsAppCall');assert.equal(sent.length,1);assert.equal(sent[0].data.disconnectReason,'BUSINESS_INITIATED');assert.equal(sent[0].data.whatsappApiKey,'access');
});
test('Meta signing secret alone cannot authorize hosted-agent tools',async()=>{
 const call=offer('dedicated-secret');await post(call);await wait(call.id);assert.equal((await end(call.id,env.META_APP_SECRET)).status,403);assert.notEqual((await db.prepare('SELECT state FROM call_sessions WHERE call_id=?').bind(call.id).first()).state,'terminated');
});
test('foreign caller never dispatches an agent',async()=>{
 const call={...offer('foreign'),from:'15550000002'},before=requests.length;await post(call);await new Promise(r=>setTimeout(r,80));assert.equal(requests.length,before);assert.ok(rejections.some(r=>r.call_id===call.id&&r.action==='reject'));
});
test('hangup racing slow accept closes the late-created connector',async()=>{
 const call=offer('race');let release;hold=new Promise(r=>{release=r});const arrived=new Promise(r=>{entered=r});await post(call);await arrived;
 await post({...call,event:'terminate',session:undefined});await new Promise(r=>setTimeout(r,50));release();hold=null;await wait(call.id);
 for(let i=0;i<100&&!requests.some(r=>r.data.whatsappCallId===call.id&&r.data.disconnectReason==='BUSINESS_INITIATED');i++)await new Promise(r=>setTimeout(r,20));
 assert.ok(requests.some(r=>r.data.whatsappCallId===call.id&&r.data.disconnectReason==='BUSINESS_INITIATED'));
});
