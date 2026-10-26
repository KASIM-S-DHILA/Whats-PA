import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const {Miniflare,convertV4MiniflareOptions}=createRequire(import.meta.url)('miniflare');
const owner='15550000001',fileId='1111111111111111',foreignId='2222222222222222';
const hash=x=>createHash('sha256').update(x).digest('hex');
const env={META_APP_SECRET:'secret',META_ACCESS_TOKEN:'access',META_PHONE_NUMBER_ID:'phone',META_WABA_ID:'waba',ALLOWED_SENDER:owner,CALL_BRIDGE_ENABLED:'true',VOICE_CALL_TOOLS_ENABLED:'true',CALL_RECORDING_ENABLED:'true',SUPABASE_URL:'https://test.supabase.co',SUPABASE_BUCKET:'whats-files',SUPABASE_KEY:'storage',MAX_MEDIA_BYTES:52428800};
const fake=`import {WorkerEntrypoint} from 'cloudflare:workers';
export default class extends WorkerEntrypoint{
 async run(model,input){
  if(model.includes('bge-small')){if(input.text[0].includes('slow'))await new Promise(r=>setTimeout(r,250));return {data:input.text.map(()=>Array.from({length:384},(_,i)=>i===0?1:0))};}
  if(input.messages)return {tool_calls:[{name:'log_note',arguments:{text:input.messages[1].content.includes('invented planner')?'invented words':'सिल्वर मैंगो'}}]};
  if(model.includes('whisper'))return {text:'Synthetic call recording transcript'};
  throw new Error('Clef must never run for live call tools');
 }
 async query(){return {matches:[{id:'fixture',score:.9,metadata:{owner:'${hash(owner)}',file_id:'${fileId}'}},{id:'foreign',score:1,metadata:{owner:'${hash('15550000002')}',file_id:'${foreignId}'}}]};}
 async upsert(){return {mutationId:'fixture'};}
}`;
const sends=[],uploads=[],stored=new Map();let ambiguousSend=false;
const recording=Buffer.from('Synthetic call recording'),transcript=Buffer.from(JSON.stringify({transcript:{text:'[Business] Hello. [Customer] Buy coffee beans.'}}));
const assets={'777':{bytes:recording,mime:'audio/ogg; codecs=opus'},'778':{bytes:transcript,mime:'application/json'}};
const modules=['worker.js','acknowledge.js','media.js','storage.js','search.js','indexing.js','delivery.js','commands.js','assistant.js','chat.js','calls.js','call-tools.js','livekit.js'].map(name=>({type:'ESModule',path:fileURLToPath(new URL('../src/'+name,import.meta.url))}));
const options={workers:[{name:'app',modules,compatibilityDate:'2026-10-11',compatibilityFlags:['nodejs_compat'],bindings:env,d1Databases:['DB'],serviceBindings:{AI:'fake',FILES:'fake'},outboundService:async request=>{
 const url=new URL(request.url);
 if(url.hostname==='lookaside.fbsbx.com'){assert.equal(request.headers.get('Authorization'),'Bearer access');return new Response(assets[url.searchParams.get('mid')].bytes);}
 if(url.hostname==='test.supabase.co'){
  assert.equal(request.headers.get('apikey'),'storage');
  if(request.method==='POST'){const bytes=Buffer.from(await request.arrayBuffer());stored.set(url.pathname.replace('/storage/v1/object/',''),bytes);return new Response('{}');}
  return new Response(stored.get(url.pathname.replace('/storage/v1/object/authenticated/','')));
 }
 assert.equal(url.hostname,'graph.facebook.com');assert.equal(request.headers.get('Authorization'),'Bearer access');
 if(assets[url.pathname.split('/').at(-1)]){const id=url.pathname.split('/').at(-1),asset=assets[id];return Response.json({id,mime_type:asset.mime,file_size:asset.bytes.length,sha256:hash(asset.bytes),url:'https://lookaside.fbsbx.com/attachments/?mid='+id});}
 if(url.pathname.endsWith('/media')){uploads.push(Buffer.from(await request.arrayBuffer()));return Response.json({id:'900'});}
 if(url.pathname.endsWith('/messages')){const body=await request.json();assert.equal(body.to,owner);sends.push(body);if(ambiguousSend){ambiguousSend=false;return Response.json({});}return Response.json({messages:[{id:'reply-'+sends.length}]});}
 assert.fail('Unexpected outbound request '+url.pathname);
}},{name:'fake',modules:true,script:fake,compatibilityDate:'2026-10-11'}]};
const mf=new Miniflare(convertV4MiniflareOptions?convertV4MiniflareOptions(options):options);after(()=>mf.dispose());
const db=await mf.getD1Database('DB','app');
for(const name of ['0001_inbound_messages.sql','0002_media_files.sql','0003_search_and_commands.sql','0004_assistant.sql','0008_chat_context.sql','0005_calls.sql','0006_voice_tools.sql','0007_delivery_cache.sql'])for(const sql of (await readFile(new URL('../migrations/'+name,import.meta.url),'utf8')).split(';').filter(s=>s.trim()))await db.prepare(sql).run();
for(const [id,who] of [[fileId,owner],[foreignId,'15550000002']])await db.prepare(`INSERT INTO file_catalog(file_id,owner,message_id,kind,filename,mime_type,byte_size,sha256,source_epoch,extracted_text,created_at,updated_at) VALUES(?,?,?,'note','Security checklist.txt','text/plain',?,?,?,?,?,?)`).bind(id,who,'fixture-'+id,7,hash('Fixture'),Math.floor(Date.now()/1000),'Fixture',new Date().toISOString(),new Date().toISOString()).run();
async function session(name,state='offered',who=owner){const id='wacid.'+name;await db.prepare('INSERT INTO call_sessions(call_id,owner,state,updated_at) VALUES(?,?,?,?)').bind(id,who,state,new Date().toISOString()).run();return id;}
async function endpoint(data,{bad=false,time=String(Math.floor(Date.now()/1000))}={}){
 const body=JSON.stringify(data),signature=createHmac('sha256',env.META_APP_SECRET).update('whats-tools:v1:'+time+':'+body).digest('hex');
 const response=await mf.dispatchFetch('https://test.invalid/bridge/tools',{method:'POST',body,headers:{'X-Bridge-Time':time,'X-Bridge-Signature':bad?'0'.repeat(64):signature}});return {status:response.status,data:await response.json(),dbCalls:Number(response.headers.get('X-Tool-Db-Calls')),timing:response.headers.get('Server-Timing')};
}
const request=(callId,name,args,userText,revision=1)=>({callId,name,args,userText,revision,action:'prepare'});

test('atomic admission keeps the 30-job limit when two new tools race for the final slot',async()=>{
 const callId=await session('tool-limit');
 for(let i=0;i<29;i++)await db.prepare("INSERT INTO call_tool_jobs(operation_id,call_id,revision,name,request_hash,arguments_json,state,created_at,updated_at) VALUES(?,?,0,'log_note','fixture','{}','done',?,?)").bind(hash('limit-'+i),callId,Date.now(),Date.now()).run();
 const results=await Promise.all([
  endpoint(request(callId,'search_files',{query:'security'},'Find security')),
  endpoint(request(callId,'log_note',{text:'coffee'},'Save a note: coffee'))
 ]);
 assert.deepEqual(results.map(r=>r.status).sort(),[200,429]);
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM call_tool_jobs WHERE call_id=?').bind(callId).first()).n,30);
});
test('bad signatures, old signatures, unknown and foreign calls create no tool work',async()=>{
 const own=await session('auth'),foreign=await session('foreign','offered','15550000002');
 for(const [data,options,status] of [[request(own,'search_files',{query:'security'},'Find security'),{bad:true},403],[request(own,'search_files',{query:'security'},'Find security'),{time:'1'},403],[request(foreign,'search_files',{query:'security'},'Find security'),{},409],[request('wacid.unknown','search_files',{query:'security'},'Find security'),{},409]])assert.equal((await endpoint(data,options)).status,status);
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM call_tool_jobs WHERE call_id IN (?,?,?)').bind(own,foreign,'wacid.unknown').first()).n,0);
});
test('search results are owned and a selected file is sent once across concurrent commits and replays',async()=>{
 const callId=await session('delivery');const found=await endpoint(request(callId,'search_files',{query:'security'},'Find security'));
 assert.deepEqual(found.data.files.map(f=>f.fileId),[fileId]);
 assert.equal(found.dbCalls,4);assert.match(found.timing,/total;dur=\d+,db;dur=\d+,ai;dur=\d+,vector;dur=\d+/);
 const prepared=await endpoint(request(callId,'get_file',{fileId},'send the first one',2));assert.equal(prepared.data.prepared,true);
 const before=sends.length;await Promise.all([endpoint({callId,name:'get_file',revision:2,action:'commit'}),endpoint({callId,name:'get_file',revision:2,action:'commit'})]);
 assert.equal(sends.length,before+1);assert.equal((await endpoint({callId,name:'get_file',revision:2,action:'commit'})).data.confirmed,true);assert.equal(sends.length,before+1);
});

test('dependent search/send and save/share steps can share one action revision without duplicate delivery',async()=>{
 const callId=await session('compound');
 const spoken='Find and send my security checklist';
 await endpoint(request(callId,'search_files',{query:'security'},spoken));
 assert.equal((await endpoint(request(callId,'get_file',{fileId},spoken))).data.prepared,true);
 const before=sends.length;
 assert.equal((await endpoint({callId,name:'get_file',revision:1,action:'commit'})).data.confirmed,true);
 assert.equal(sends.length,before+1);
 const noteSpoken='Save and send a note: buy coffee beans';
 await endpoint(request(callId,'log_note',{text:'buy coffee beans'},noteSpoken,2));
 const saved=await endpoint({callId,name:'log_note',revision:2,action:'commit'});
 assert.equal((await endpoint(request(callId,'get_file',{fileId:saved.data.fileId},noteSpoken,2))).data.prepared,true);
 assert.equal((await endpoint({callId,name:'get_file',revision:2,action:'commit'})).data.confirmed,true);
 assert.equal(sends.at(-1).text.body,'buy coffee beans');
 await endpoint({callId,name:'get_file',revision:2,action:'commit'});
 assert.equal(sends.length,before+2);
});
test('new revision cancels a prepared note and stale commit cannot save it',async()=>{
 const callId=await session('cancel-note');assert.equal((await endpoint(request(callId,'log_note',{text:'buy coffee beans'},'Save a note: buy coffee beans'))).data.prepared,true);
 await endpoint({callId,revision:2,action:'advance'});assert.equal((await endpoint({callId,revision:1,name:'log_note',action:'commit'})).status,409);
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM file_catalog WHERE message_id=?').bind('call-note:'+hash('call-tool:'+callId+':1:log_note')).first()).n,0);
});
test('cancel-before-prepare tombstone blocks late mutation work',async()=>{
 const callId=await session('cancel-early');await endpoint({callId,revision:1,name:'log_note',action:'cancel'});
 assert.equal((await endpoint(request(callId,'log_note',{text:'buy coffee'},'Save a note: buy coffee'))).data.state,'cancelled');
});
test('slow search result is discarded when a newer request arrives',async()=>{
 const callId=await session('slow');const work=endpoint(request(callId,'search_files',{query:'slow security'},'Find slow security'));
 await new Promise(r=>setTimeout(r,100));await endpoint({callId,revision:2,action:'advance'});assert.equal((await work).status,409);
 assert.deepEqual(JSON.parse((await db.prepare('SELECT candidates_json FROM call_sessions WHERE call_id=?').bind(callId).first()).candidates_json),[]);
});
test('note commit is idempotent and changed arguments cannot reuse its operation',async()=>{
 const callId=await session('note');const prepared=request(callId,'log_note',{text:'buy coffee'},'Save a note: buy coffee');await endpoint(prepared);
 const first=await endpoint({callId,revision:1,name:'log_note',action:'commit'});const again=await endpoint({callId,revision:1,name:'log_note',action:'commit'});assert.equal(first.data.fileId,again.data.fileId);
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM file_catalog WHERE file_id=?').bind(first.data.fileId).first()).n,1);
 assert.equal((await endpoint({...prepared,args:{text:'changed'}})).status,409);
});
test('newly saved note can be shared as exact WhatsApp text without a media upload',async()=>{
 const callId=await session('share-note'),text='buy coffee beans';
 await endpoint(request(callId,'log_note',{text},'Save a note: '+text));
 const saved=await endpoint({callId,revision:1,name:'log_note',action:'commit'});
 const before=sends.length,uploaded=uploads.length;
 const prepared=await endpoint(request(callId,'get_file',{fileId:saved.data.fileId},'send that note to me',2));assert.equal(prepared.data.prepared,true);
 await endpoint({callId,revision:2,name:'get_file',action:'commit'});
 assert.equal(sends.length,before+1);assert.equal(sends.at(-1).type,'text');assert.equal(sends.at(-1).text.body,text);assert.equal(uploads.length,uploaded);
});
test('ASR word spacing can differ while invented words and changed signs stay rejected',async()=>{
 const callId=await session('note-spacing');assert.equal((await endpoint(request(callId,'log_note',{text:'LiveKit coffee test'},'Save a note: Live Kit coffee test'))).data.prepared,true);
 assert.equal((await endpoint(request(callId,'log_note',{text:'pay 1000'},'Save a note: pay -1000',2))).data.error,'not_authorized');
 assert.equal((await endpoint(request(callId,'log_note',{text:'buy tea'},'Save a note: buy coffee',3))).data.error,'not_authorized');
});
test('numbered and unique type references select a file; ambiguous and contradictory requests cannot send',async()=>{
 const pdfId='3333333333333333',bytes=Buffer.from('%PDF Fixture'),now=new Date().toISOString();
 stored.set('whats-files/security.pdf',bytes);
 await db.prepare(`INSERT INTO file_catalog(file_id,owner,message_id,kind,filename,mime_type,byte_size,sha256,bucket,object_key,source_epoch,created_at,updated_at) VALUES(?,?,?,'document','Security checklist.pdf','application/pdf',?,?,'whats-files','security.pdf',?,?,?)`).bind(pdfId,owner,'selection-fixture',bytes.length,hash(bytes),Math.floor(Date.now()/1000),now,now).run();
 const choices=[{fileId:pdfId,filename:'Security checklist.pdf',kind:'document',mimeType:'application/pdf',bestMatch:false},{fileId,filename:'Note.txt',kind:'note',bestMatch:false}];
 for(const [i,spoken] of ['send number one','send option 1','send the 1st one','send the PDF','send the security checklist'].entries()){
  const callId=await session('selection-'+i);await db.prepare('UPDATE call_sessions SET candidates_json=? WHERE call_id=?').bind(JSON.stringify(choices),callId).run();
  assert.equal((await endpoint(request(callId,'get_file',{fileId:pdfId},spoken))).data.prepared,true,spoken);
 }
 const callId=await session('ambiguous-selection');await db.prepare('UPDATE call_sessions SET candidates_json=? WHERE call_id=?').bind(JSON.stringify(choices),callId).run();
 assert.equal((await endpoint(request(callId,'get_file',{fileId:pdfId},'send it'))).data.error,'choose_a_file');
 assert.equal((await endpoint(request(callId,'get_file',{fileId},'send the PDF',2))).data.error,'file_not_selected');
 assert.equal((await endpoint(request(callId,'get_file',{fileId:pdfId},'send anything except the PDF',3))).data.error,'file_not_selected');
});
test('corrupt note bytes never prepare a text delivery',async()=>{
 const callId=await session('corrupt-note'),text='original note';await endpoint(request(callId,'log_note',{text},'Save a note: '+text));
 const saved=await endpoint({callId,revision:1,name:'log_note',action:'commit'});
 await db.prepare('UPDATE file_catalog SET extracted_text=? WHERE file_id=?').bind('changed content',saved.data.fileId).run();
 assert.equal((await endpoint(request(callId,'get_file',{fileId:saved.data.fileId},'send the note',2))).data.error,'file_integrity_failed');
});
test('invented note text and owner or recipient overrides are rejected',async()=>{
 const callId=await session('guard');assert.equal((await endpoint(request(callId,'get_file',{fileId,to:'outsider'},'send '+fileId))).status,400);
 assert.equal((await endpoint(request(callId,'log_note',{text:'invented'},'Save a note: actual words',2))).data.confirmed,false);
 assert.equal((await endpoint(request(callId,'search_files',{query:'security',owner:'outsider'},'Find security',3))).status,400);
 assert.equal((await endpoint(request(callId,'get_file',{fileId:foreignId},'send '+foreignId,4))).data.confirmed,false);
});
test('an ambiguous external send is cached and never automatically repeated',async()=>{
 const callId=await session('uncertain');await endpoint(request(callId,'get_file',{fileId},'send '+fileId));const before=sends.length;ambiguousSend=true;
 assert.equal((await endpoint({callId,revision:1,name:'get_file',action:'commit'})).data.state,'uncertain');await endpoint({callId,revision:1,name:'get_file',action:'commit'});assert.equal(sends.length,before+1);
});
test('a terminated call cannot commit a prepared file',async()=>{
 const callId=await session('hangup');await endpoint(request(callId,'get_file',{fileId},'send '+fileId));await db.prepare("UPDATE call_sessions SET state='terminated' WHERE call_id=?").bind(callId).run();const before=sends.length;
 assert.equal((await endpoint({callId,revision:1,name:'get_file',action:'commit'})).status,409);assert.equal(sends.length,before);
});
test('bridge end closes server call state and cancels pending work without relying on a Meta webhook',async()=>{
 const callId=await session('bridge-end');await endpoint(request(callId,'log_note',{text:'buy tea'},'Save a note: buy tea'));
 assert.equal((await endpoint({callId,revision:1,action:'end'})).data.ended,true);
 assert.equal((await db.prepare('SELECT state FROM call_sessions WHERE call_id=?').bind(callId).first()).state,'terminated');
 assert.equal((await db.prepare('SELECT state FROM call_tool_jobs WHERE call_id=?').bind(callId).first()).state,'cancelled');
});
async function artifact(callId,kind,{from=owner,signature=true}={}){
 const mediaId=kind==='recording'?'777':'778',asset=assets[mediaId],call={id:callId,from,timestamp:String(Math.floor(Date.now()/1000)),event:kind==='recording'?'call_recording_available':'call_transcription_available',
  [kind==='recording'?'call_recording':'call_transcript']:{...(kind==='recording'?{type:'audio'}:{}),[kind==='recording'?'audio':'document']:{id:mediaId,mime_type:asset.mime,sha256:createHash('sha256').update(asset.bytes).digest('base64'),url:'https://evil.invalid/ignored'}}};
 const body=JSON.stringify({object:'whatsapp_business_account',entry:[{id:'waba',changes:[{field:'calls',value:{metadata:{phone_number_id:'phone'},calls:[call]}}]}]});
 return mf.dispatchFetch('https://test.invalid/webhook',{method:'POST',body,headers:{'X-Hub-Signature-256':signature?'sha256='+createHmac('sha256','secret').update(body).digest('hex'):'sha256='+'0'.repeat(64)}});
}
test('signed recording and JSON transcript webhooks save verified private artifacts and link the call once',async()=>{
 const callId=await session('artifacts','terminated');await Promise.all([artifact(callId,'recording'),artifact(callId,'transcript')]);await artifact(callId,'recording');
 for(let i=0;i<12;i++){const rows=(await db.prepare('SELECT m.state,c.extraction_method FROM call_artifacts a JOIN media_files m ON m.message_id=a.message_id LEFT JOIN file_catalog c ON c.message_id=a.message_id WHERE a.call_id=?').bind(callId).all()).results;if(rows.length===2&&rows.every(r=>r.state==='ready')&&rows.some(r=>r.extraction_method==='call_transcript'))break;await mf.getWorker('app').then(w=>w.scheduled());await new Promise(r=>setTimeout(r,30));}
 const rows=(await db.prepare('SELECT a.kind,m.state,m.sha256,m.object_key FROM call_artifacts a JOIN media_files m ON m.message_id=a.message_id WHERE a.call_id=?').bind(callId).all()).results;
 assert.equal(rows.length,2);for(const row of rows){assert.equal(row.state,'ready');const expected=row.kind==='recording'?recording:transcript;assert.equal(row.sha256,hash(expected));assert.deepEqual(stored.get('whats-files/'+row.object_key),expected);}
 const extracted=await db.prepare("SELECT c.extracted_text,c.extraction_method FROM file_catalog c JOIN call_artifacts a ON a.message_id=c.message_id WHERE a.call_id=? AND a.kind='transcript'").bind(callId).first();assert.equal(extracted.extraction_method,'call_transcript');assert.equal(extracted.extracted_text,JSON.parse(transcript).transcript.text);
});
test('unknown, foreign and unsigned recording events do not create artifacts',async()=>{
 const before=(await db.prepare('SELECT COUNT(*) AS n FROM call_artifacts').first()).n;const callId=await session('artifact-guards','terminated');await artifact('wacid.unknown-artifact','recording');await artifact(callId,'recording',{from:'15550000002'});assert.equal((await artifact(callId,'recording',{signature:false})).status,403);
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM call_artifacts').first()).n,before);
});

test('Gemini tools bypass Clef while note content failures retain the exact ASR request',async()=>{
 const callId=await session('gemini-intent');
 const mismatch=await endpoint(request(callId,'log_note',{text:'silver mango'},'Save a note: buy coffee beans'));
 assert.equal(mismatch.data.error,'not_authorized');
 assert.equal(mismatch.data.reason,'note_text_mismatch');
 assert.deepEqual(mismatch.data.authorization,{spokenRequest:'Save a note: buy coffee beans',source:'gemini_live',tool:'log_note'});
 const search=await endpoint(request(callId,'search_files',{query:'security'},'मेरी सिक्योरिटी फ़ाइल ढूँढिए',2));
 assert.equal(search.data.files[0].fileId,fileId);
 const send=await endpoint(request(callId,'get_file',{fileId},'हाँ, भेज दीजिए',3));
 assert.equal(send.data.prepared,true);
 const sent=await endpoint({callId,name:'get_file',revision:3,action:'commit'});
 assert.equal(sent.data.confirmed,true);
 const note=await endpoint(request(callId,'log_note',{text:'buy coffee beans'},'Save a note: buy coffee beans',4));
 assert.equal(note.data.prepared,true);
 assert.equal((await endpoint({callId,name:'log_note',revision:4,action:'commit'})).data.confirmed,true);
 const stored=JSON.parse((await db.prepare("SELECT result_json FROM call_tool_jobs WHERE call_id=? AND name='log_note' AND revision=1").bind(callId).first()).result_json);
 assert.deepEqual(stored,mismatch.data);
});

test('Hindi Gemini selection needs no second intent classifier; note extraction preserves the ASR script and blocks invented planner content',async()=>{
 const callId=await session('hindi');
 await endpoint(request(callId,'search_files',{query:'security'},'Find security'));
 const send={...request(callId,'get_file',{fileId},'हां, भेज दूंगा।',2),previousReply:'I found one PDF. Would you like me to send it to your WhatsApp?'};
 assert.equal((await endpoint(send)).data.prepared,true);
 assert.equal((await endpoint({...send,previousReply:'Changed offer'})).status,409);
 const note=request(callId,'log_note',{text:'Silver mango'},'सिल्वर मैंगो याद रख सकते हैं आप।',3);
 assert.equal((await endpoint(note)).data.prepared,true);
 const stored=JSON.parse((await db.prepare("SELECT arguments_json FROM call_tool_jobs WHERE call_id=? AND name='log_note' AND revision=3").bind(callId).first()).arguments_json);
 assert.equal(stored.text,'सिल्वर मैंगो');
 const saved=await endpoint({callId,name:'log_note',revision:3,action:'commit'});
 assert.equal(saved.data.text,'सिल्वर मैंगो');
 assert.equal((await endpoint({...note,revision:4,userText:'सिल्वर मैंगो याद रखो invented planner'})).data.error,'unverified_note_text');
 assert.equal((await endpoint({...note,revision:5,userText:'सिल्वर मैंगो 10 याद रख सकते हैं आप।'})).data.reason,'note_text_mismatch');
 const noContext=await endpoint(request(callId,'get_file',{fileId},'हां, भेज दूंगा।',6));
 assert.equal(noContext.data.error,'choose_a_file'); // Selection remains ambiguous after saving a newer note.
});
