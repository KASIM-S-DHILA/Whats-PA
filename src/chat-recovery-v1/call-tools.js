import {ragFailure} from '../rag-v1/answer.js';
import {ownerEnv,resolveOwner} from '../owners.js';
import {answerLibrary} from '../rag-rebuild/library.js';
import {latestCallSummary} from './call-summary.js';
import {latestCallArchive} from './call-archive.js';
import {handleReminder} from './reminders.js';
import {createHmac,timingSafeEqual} from 'node:crypto';
import {hash,search_files,dataset,ToolError} from '../search.js';
import {validateToolCall} from './assistant.js';
import {forwardCall} from '../calls.js';
import {prepare_file_delivery} from '../delivery.js';
import {groundedSearchQuery,filterWeakSearchMatches,literalFilenameQuery,filterCallIdentifiers} from './search-query.js';

const fail=(code,status=400)=>Response.json({error:code},{status});
const live=`EXISTS(SELECT 1 FROM call_sessions c WHERE c.call_id=call_tool_jobs.call_id AND c.state!='terminated' AND c.tool_revision=call_tool_jobs.revision)`;
const normalize=s=>s.normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase();
function selectedCandidate(text,candidates){
 const words=['first','second','third','fourth','fifth'],numbers=['one','two','three','four','five'];
 const spoken=normalize(text),ordinal=spoken.match(/\b(first|second|third|fourth|fifth|[1-5](?:st|nd|rd|th))\b|\b(?:number|option|item|file)\s+(one|two|three|four|five|[1-5])\b/);
 if(/\b(?:not|don't|dont|except|instead|rather)\b/.test(spoken))return {explicit:true};
 if(ordinal){const token=ordinal[1]??ordinal[2],index=words.includes(token)?words.indexOf(token):numbers.includes(token)?numbers.indexOf(token):Number.parseInt(token)-1;return {explicit:true,fileId:candidates[index]?.fileId};}
 const kinds=[];
 if(/\bpdf\b/.test(spoken))kinds.push(f=>/\.pdf$/i.test(f.filename)||f.mimeType==='application/pdf');
 if(/\bvideo\b/.test(spoken))kinds.push(f=>f.kind==='video');
 if(/\b(?:photo|image|picture)\b/.test(spoken))kinds.push(f=>f.kind==='image');
 const named=candidates.filter(f=>{
  if(kinds.length)return kinds.some(match=>match(f));
  const tokens=(f.filename??'').normalize('NFKC').toLowerCase().replace(/\.[a-z0-9]+$/,'').match(/[a-z]{5,}/g)??[];
  return tokens.filter(t=>!['audio','video','image','photo','voice','document'].includes(t)).some(t=>new RegExp('\\b'+t+'\\b').test(spoken));
 });
 return named.length===1?{explicit:true,fileId:named[0].fileId}:{explicit:false};
}
function validateVoiceRagArgs(args){
 if(!args||typeof args!=='object'||Array.isArray(args))throw new ToolError('invalid_tool_arguments');
 if(Object.keys(args).some(key=>!['question','followup'].includes(key)))throw new ToolError('invalid_tool_arguments');
 if(typeof args.question!=='string'||!args.question.trim()||args.question.length>300)throw new ToolError('invalid_tool_arguments');
 if(args.followup!==undefined&&typeof args.followup!=='boolean')throw new ToolError('invalid_tool_arguments');
 return {question:args.question.trim(),followup:args.followup===true};
}
async function previousLibraryAnswer(env,callId,revision){
 const job=await env.DB.prepare(`SELECT result_json FROM call_tool_jobs
  WHERE call_id=? AND name='answer_documents' AND state='done' AND revision<? AND result_json IS NOT NULL
  ORDER BY revision DESC LIMIT 1`).bind(callId,revision).first();
 if(!job?.result_json)return null;
 let result;try{result=JSON.parse(job.result_json);}catch{return null;}
 const topic=result?.ragSource?.topic;
 if(result?.state!=='answered'||typeof result.answer!=='string'||!result.answer.trim()||typeof topic!=='string'||!topic.trim()||topic.length>1000)return null;
 return {topic,answer:result.answer.slice(0,5000)};
}
// Emit numeric timings only: no caller, file IDs, spoken text or credentials.
export async function handleCallTool(request,env,body){
 const timing={dbMs:0,dbCalls:0,aiMs:0,vectorMs:0},start=performance.now();
 const measure=async(key,fn)=>{const began=performance.now();try{return await fn();}finally{timing[key]+=performance.now()-began;}};
 const db={prepare(sql){const statement=env.DB.prepare(sql);return {bind(...args){return wrap(statement.bind(...args));},...wrap(statement)};},
  batch(statements){timing.dbCalls++;return measure('dbMs',()=>env.DB.batch(statements.map(s=>s.raw)));}};
 function wrap(statement){return {raw:statement,bind(...args){return wrap(statement.bind(...args));},...Object.fromEntries(['first','all','run'].map(name=>[name,(...args)=>{timing.dbCalls++;return measure('dbMs',()=>statement[name](...args));}]))};}
 const measured={...env,DB:db,AI:{run:(...args)=>measure('aiMs',()=>env.AI.run(...args))},FILES:{query:(...args)=>measure('vectorMs',()=>env.FILES.query(...args))}};
 let response;
 try{response=await runCallTool(request,measured,body);return response;}
 finally{
  const totalMs=Math.round(performance.now()-start);
  if(response){response.headers.set('Server-Timing',`total;dur=${totalMs},db;dur=${Math.round(timing.dbMs)},ai;dur=${Math.round(timing.aiMs)},vector;dur=${Math.round(timing.vectorMs)}`);response.headers.set('X-Tool-Db-Calls',String(timing.dbCalls));}
  let label={};try{const data=JSON.parse(new TextDecoder().decode(body));if(['search_files','get_file','manage_reminders','send_text'].includes(data.name))label.tool=data.name;if(['prepare','commit','cancel','advance','end'].includes(data.action))label.phase=data.action;}catch{}
  console.log(JSON.stringify({event:'call_tool_timing',...label,httpStatus:response?.status??500,totalMs,...Object.fromEntries(Object.entries(timing).map(([k,v])=>[k,Math.round(v)]))}));
 }
}
async function runCallTool(request,env,body){
 if(env.VOICE_CALL_TOOLS_ENABLED!=='true'||!(env.VOICE_BRIDGE_SECRET||env.META_APP_SECRET))return fail('disabled',503);
 const stamp=request.headers.get('X-Bridge-Time')??'',sig=request.headers.get('X-Bridge-Signature')??'';
 if(!/^\d{10}$/.test(stamp)||Math.abs(Date.now()/1000-Number(stamp))>60||!/^[a-f0-9]{64}$/.test(sig))return fail('forbidden',403);
 const expected=createHmac('sha256',env.VOICE_BRIDGE_SECRET||env.META_APP_SECRET).update('whats-tools:v1:'+stamp+':').update(body).digest();
 if(!timingSafeEqual(expected,Buffer.from(sig,'hex')))return fail('forbidden',403);
 let data;try{data=JSON.parse(new TextDecoder().decode(body));}catch{return fail('invalid_request');}
 const {callId,revision,action}=data;
 if(typeof callId!=='string'||!/^wacid\.[A-Za-z0-9_.=-]{1,490}$/.test(callId)||!Number.isSafeInteger(revision)||revision<1||revision>1000||!['prepare','commit','cancel','advance','end'].includes(action))return fail('invalid_request');
 if(!['advance','end'].includes(action)&&!['search_files','get_file','answer_documents','manage_reminders','send_text'].includes(data.name))return fail('invalid_tool_call');
 // Authenticate the transport first, then derive the tenant from the immutable call.
 const stored=await env.DB.prepare('SELECT owner FROM call_sessions WHERE call_id=?').bind(callId).first();
 if(!stored||!resolveOwner(env,stored.owner))return fail('call_not_active',409);
 env=ownerEnv(env,stored.owner);
 const operationId=hash('call-tool:'+callId+':'+revision+':'+data.name);
 const observedAt=Date.now(),activeSince=new Date(observedAt-20*60000).toISOString();
 const sessionStatement=env.DB.prepare('SELECT call_id,state,updated_at,tool_revision,candidates_json FROM call_sessions WHERE call_id=? AND owner=?').bind(callId,env.ALLOWED_SENDER);
 const claimStatement=()=>env.DB.prepare(`UPDATE call_tool_jobs SET state='committing',updated_at=?
  WHERE operation_id=? AND call_id=? AND revision=? AND state='prepared'
  AND EXISTS(SELECT 1 FROM call_sessions c WHERE c.call_id=call_tool_jobs.call_id AND c.owner=?
   AND c.state!='terminated' AND c.tool_revision=call_tool_jobs.revision AND julianday(c.updated_at)>=julianday(?))`)
  .bind(observedAt,operationId,callId,revision,env.ALLOWED_SENDER,activeSince);
 let session,job,claim;
 if(['advance','end'].includes(action))session=await sessionStatement.first();
 else{
  const statements=[sessionStatement,env.DB.prepare('SELECT * FROM call_tool_jobs WHERE operation_id=?').bind(operationId)];
  // D1 executes the snapshot reads and guarded claim in one atomic batch.
  // The pre-claim job state retains replay/cancel replies; only one claim can win.
  if(action==='commit')statements.push(claimStatement());
  const rows=await env.DB.batch(statements);
  session=rows[0].results[0];job=rows[1].results[0];claim=rows[2];
 }
 if(action==='end'&&session){
  await env.DB.batch([
   env.DB.prepare("UPDATE call_sessions SET state='terminated',updated_at=? WHERE call_id=? AND owner=?").bind(new Date().toISOString(),callId,env.ALLOWED_SENDER),
   env.DB.prepare("UPDATE call_tool_jobs SET state='cancelled',updated_at=? WHERE call_id=? AND state IN ('preparing','prepared')").bind(Date.now(),callId)
  ]);
  if(env.CALL_BRIDGE_BACKEND==='livekit'&&session.state!=='terminated'){
   const eventId=callId+':bridge-end';
   await env.DB.prepare("INSERT INTO call_events(event_id,call_id,event,payload_json,created_at) VALUES(?,?,'terminate',?,?) ON CONFLICT(event_id) DO NOTHING").bind(eventId,callId,JSON.stringify({id:callId,business:true}),new Date().toISOString()).run();
   await forwardCall(env,eventId);
  }
  return Response.json({ended:true});
 }
 // Use the same expiry instant as the SQL claim, including near the 20-minute boundary.
 if(!session||session.state==='terminated'||observedAt-Date.parse(session.updated_at)>20*60000)return fail('call_not_active',409);
 if(revision<session.tool_revision)return fail('stale_request',409);
 const revisionStatements=()=>[
  env.DB.prepare("UPDATE call_sessions SET tool_revision=? WHERE call_id=? AND owner=? AND tool_revision<?").bind(revision,callId,env.ALLOWED_SENDER,revision),
  env.DB.prepare("UPDATE call_tool_jobs SET state='cancelled',updated_at=? WHERE call_id=? AND revision<? AND state IN ('preparing','prepared')").bind(Date.now(),callId,revision)
 ];
 const advance=revision>session.tool_revision;
 // New prepare jobs advance and insert in one atomic batch below. Existing-job
 // replays and control requests still advance immediately when required.
 if(advance&&!(action==='prepare'&&!job))await env.DB.batch(revisionStatements());
 if(action==='advance')return Response.json({advanced:true});
 if(action==='cancel'){
  await env.DB.prepare("INSERT INTO call_tool_jobs(operation_id,call_id,revision,name,request_hash,arguments_json,state,created_at,updated_at) VALUES(?,?,?,?,?,'{}','cancelled',?,?) ON CONFLICT(operation_id) DO NOTHING").bind(operationId,callId,revision,data.name,'',Date.now(),Date.now()).run();
  await env.DB.prepare("UPDATE call_tool_jobs SET state='cancelled',updated_at=? WHERE operation_id=? AND state IN ('preparing','prepared')").bind(Date.now(),operationId).run();
  return Response.json({cancelled:true});
 }
 if(action==='commit'){
  if(!job)return fail('not_prepared',409);
  if(job.state==='done')return Response.json(JSON.parse(job.result_json));
  if(job.state!=='prepared')return Response.json({state:job.state,confirmed:false});
  // An advancing revision was not eligible in the initial batch; recheck after advancement.
  if(advance)claim=await claimStatement().run();
  if(claim.meta.changes!==1)return fail('stale_request',409);
  let result;
  {
   let state='uncertain';
   try{
    const response=await fetch(`https://graph.facebook.com/v26.0/${env.META_PHONE_NUMBER_ID}/messages`,{method:'POST',headers:{Authorization:`Bearer ${env.META_ACCESS_TOKEN}`,'Content-Type':'application/json'},
     body:JSON.stringify({...JSON.parse(job.prepared_json),messaging_product:'whatsapp',recipient_type:'individual',to:env.ALLOWED_SENDER}),redirect:'manual',signal:AbortSignal.timeout(10000)});
    if(!response.ok){state='failed';await response.body?.cancel();}
    else{const sent=await response.json();if(typeof sent.messages?.[0]?.id==='string'&&sent.messages[0].id)state='sent';}
   }catch{} // An ambiguous external send is never automatically repeated.
   result={state,confirmed:state==='sent',fileId:JSON.parse(job.arguments_json).fileId};
  }
  await env.DB.prepare("UPDATE call_tool_jobs SET state='done',result_json=?,updated_at=? WHERE operation_id=? AND state='committing'").bind(JSON.stringify(result),Date.now(),operationId).run();
  return Response.json(result);
 }
 if(typeof data.userText!=='string'||!data.userText.trim()||data.userText.length>2000)return fail('missing_spoken_request');
 let call;try{call=data.name==='manage_reminders'?{name:data.name,args:{}}:data.name==='send_text'?{name:data.name,args:{text:String(data.args?.text??'').trim()}}:data.name==='answer_documents'?{name:data.name,args:validateVoiceRagArgs(data.args)}:validateToolCall({tool_calls:[{name:data.name,arguments:data.args}]},['search_files','get_file']);}catch{return fail('invalid_tool_arguments');}
 if(call.name==='send_text'&&(!call.args.text||call.args.text.length>3500))return fail('invalid_tool_arguments');
 if(data.previousReply!==undefined&&(typeof data.previousReply!=='string'||data.previousReply.length>1200))return fail('invalid_request');
 const fingerprint=hash(JSON.stringify({name:call.name,args:call.args,userText:data.userText,previousReply:data.previousReply??''}));
 if(job){
  if(job.state==='cancelled')return Response.json({state:'cancelled',confirmed:false});
  if(job.request_hash!==fingerprint)return fail('operation_conflict',409);
  return Response.json(job.state==='done'?JSON.parse(job.result_json):job.state==='prepared'?{prepared:true}: {state:job.state,confirmed:false});
 }
 const insert=env.DB.prepare(`INSERT INTO call_tool_jobs(operation_id,call_id,revision,name,request_hash,arguments_json,state,created_at,updated_at)
  SELECT ?,?,?,?,?,?,'preparing',?,? WHERE (SELECT COUNT(*) FROM call_tool_jobs WHERE call_id=?)<30
  AND EXISTS(SELECT 1 FROM call_sessions WHERE call_id=? AND owner=? AND state!='terminated' AND tool_revision=?)
  ON CONFLICT(operation_id) DO NOTHING`).bind(operationId,callId,revision,call.name,fingerprint,JSON.stringify(call.args),Date.now(),Date.now(),callId,callId,env.ALLOWED_SENDER,revision);
 const inserted=advance?(await env.DB.batch([...revisionStatements(),insert])).at(-1):await insert.run();
 if(inserted.meta.changes!==1){
  const count=await env.DB.prepare('SELECT COUNT(*) AS n FROM call_tool_jobs WHERE call_id=?').bind(callId).first();
  return count.n>=30?fail('call_tool_limit',429):fail('operation_in_progress',409);
 }
 const authorization={spokenRequest:data.userText,source:'gemini_live',tool:call.name};
 try{
  const candidates=JSON.parse(session.candidates_json);
  // The signed Gemini Live function call supplies intent; chat retains Clef routing.
  let result,prepared;
  if(call.name==='answer_documents'){
   let previous=null;
   if(call.args.followup){
    previous=await previousLibraryAnswer(env,callId,revision);
    if(!previous)result={state:'clarification',answer:"I don't have a previous document answer in this call. Please ask the full question.",sources:[],confirmed:false,toolName:'answer_document_source',ragSource:null};
   }
   if(!result){
    try{result=await answerLibrary(env,env.ALLOWED_SENDER,data.userText,{previous});}
    catch(error){result={state:'unavailable',answer:ragFailure(error),sources:[],confirmed:false};}
   }
   result={...result,followupDepth:result.retrieval?.followup?.depth??null};
   if(result.state==='answered'&&result.answer){
    let sentToChat=false;
    try{
     const sent=await fetch(`https://graph.facebook.com/v26.0/${env.META_PHONE_NUMBER_ID}/messages`,{method:'POST',headers:{Authorization:`Bearer ${env.META_ACCESS_TOKEN}`,'Content-Type':'application/json'},
      body:JSON.stringify({messaging_product:'whatsapp',recipient_type:'individual',to:env.ALLOWED_SENDER,type:'text',text:{body:String(result.answer).slice(0,3500),preview_url:false}}),redirect:'manual',signal:AbortSignal.timeout(10000)});
     if(sent.ok){sentToChat=true;await sent.json();}else await sent.body?.cancel();
    }catch{}
    result={...result,sentToChat};
   }
   console.log(JSON.stringify({event:'voice_document_followup',requested:call.args.followup,previous:Boolean(previous),state:result.state,depth:result.followupDepth}));
   const saved=await env.DB.prepare(`UPDATE call_tool_jobs SET state='done',result_json=?,updated_at=? WHERE operation_id=? AND state='preparing' AND ${live}`).bind(JSON.stringify(result),Date.now(),operationId).run();
   return saved.meta.changes===1?Response.json(result):fail('stale_request',409);
  }else if(call.name==='send_text'){
   let state='failed';
   try{
    const sent=await fetch(`https://graph.facebook.com/v26.0/${env.META_PHONE_NUMBER_ID}/messages`,{method:'POST',headers:{Authorization:`Bearer ${env.META_ACCESS_TOKEN}`,'Content-Type':'application/json'},
     body:JSON.stringify({messaging_product:'whatsapp',recipient_type:'individual',to:env.ALLOWED_SENDER,type:'text',text:{body:call.args.text,preview_url:false}}),redirect:'manual',signal:AbortSignal.timeout(10000)});
    if(sent.ok){state='sent';await sent.json();}else await sent.body?.cancel();
   }catch{}
   const result={state,confirmed:state==='sent'};
   const stored=await env.DB.prepare(`UPDATE call_tool_jobs SET state='done',result_json=?,updated_at=? WHERE operation_id=? AND state='preparing' AND ${live}`).bind(JSON.stringify(result),Date.now(),operationId).run();
   return stored.meta.changes===1?Response.json(result):fail('stale_request',409);
  }else if(call.name==='manage_reminders'){
   let result;
   try{
    const payload=await handleReminder(env,{owner:env.ALLOWED_SENDER},data.userText);
    const replyText=payload?.type==='text'?payload.text?.body:payload?.interactive?.body?.text;
    result={state:'ok',reply:String(replyText||'Sorry, I could not handle that reminder request.').slice(0,1200),confirmed:Boolean(replyText)};
   }catch{
    result={state:'error',reply:'Sorry, I could not handle that reminder request.',confirmed:false};
   }
   const stored=await env.DB.prepare(`UPDATE call_tool_jobs SET state='done',result_json=?,updated_at=? WHERE operation_id=? AND state='preparing' AND ${live}`).bind(JSON.stringify(result),Date.now(),operationId).run();
   return stored.meta.changes===1?Response.json(result):fail('stale_request',409);
  }else if(call.name==='search_files'){

   let search;
   if(call.args.query==='latest call summary'){
    search=await latestCallSummary(env,env.ALLOWED_SENDER);
   }else if(['latest call recording','latest call transcript'].includes(call.args.query)){
    search=await latestCallArchive(env,env.ALLOWED_SENDER,call.args.query.split(' ').at(-1));
   }else{
    const filename=literalFilenameQuery(call.args.query);
    if(filename){
     const rows=await env.DB.prepare(`SELECT file_id,filename,kind,mime_type,source_epoch,sha256 FROM file_catalog
      WHERE owner=? AND dataset=? AND lower(filename)=? AND (?=0 OR mime_type='application/pdf')
      ORDER BY source_epoch DESC,created_at DESC,file_id DESC LIMIT 5`)
      .bind(env.ALLOWED_SENDER,dataset(env),filename,filename.endsWith('.pdf')?1:0).all();
     search={files:rows.results.map(file=>({...file,score:1})),dateRule:'exact_filename'};
    }else search=await search_files(env,env.ALLOWED_SENDER,groundedSearchQuery(call.args.query,data.userText),{metadataOnly:true});
    search=await filterWeakSearchMatches(env,env.ALLOWED_SENDER,data.userText,search);
    search=await filterCallIdentifiers(env,env.ALLOWED_SENDER,data.userText,call.args.query,search);
   }
   const ambiguous=Boolean(search.files[1]&&search.files[0].score-search.files[1].score<0.05);
   result={files:search.files.map((f,i)=>({fileId:f.file_id,filename:f.filename.slice(0,180),kind:f.kind,mimeType:f.mime_type,bestMatch:i===0&&f.score>=0.55&&!ambiguous})),ambiguous,dateRule:search.dateRule};
   if(typeof search.callSummary==='string')Object.assign(result,{callSummary:search.callSummary,sourceKind:'derived_call_summary',verbatim:false});
   const saved=await env.DB.batch([
    env.DB.prepare(`UPDATE call_tool_jobs SET state='done',result_json=?,updated_at=? WHERE operation_id=? AND state='preparing' AND ${live}`).bind(JSON.stringify(result),Date.now(),operationId),
    env.DB.prepare(`UPDATE call_sessions SET candidates_json=? WHERE call_id=? AND tool_revision=? AND state!='terminated'
     AND EXISTS(SELECT 1 FROM call_tool_jobs WHERE operation_id=? AND state='done')`).bind(JSON.stringify(result.files),callId,revision,operationId)
   ]);
   if(saved[0].meta.changes!==1)return fail('stale_request',409);
   return Response.json(result);
  }
  if(call.name==='get_file'){
   if(!data.userText.includes(call.args.fileId)&&!candidates.some(f=>f.fileId===call.args.fileId))throw new ToolError('file_not_selected');
   const selected=selectedCandidate(data.userText,candidates);
   if(selected.explicit&&selected.fileId!==call.args.fileId)throw new ToolError('file_not_selected');
   if(!selected.explicit&&!data.userText.includes(call.args.fileId)&&candidates.length>1&&!candidates.some(f=>f.fileId===call.args.fileId&&f.bestMatch))throw new ToolError('choose_a_file');
   if(!data.userText.includes(call.args.fileId)){
    const matched=await filterCallIdentifiers(env,env.ALLOWED_SENDER,data.userText,'',{files:[{file_id:call.args.fileId}]});
    if(!matched.files.length)throw new ToolError('file_not_found');
   }
   // Delivery performs the owner/dataset lookup once.
   prepared=await prepare_file_delivery(env,env.ALLOWED_SENDER,call.args.fileId);
  }else throw new ToolError('invalid_tool_call');
  const saved=await env.DB.prepare(`UPDATE call_tool_jobs SET state='prepared',prepared_json=?,updated_at=? WHERE operation_id=? AND state='preparing' AND ${live}`).bind(prepared?JSON.stringify(prepared):null,Date.now(),operationId).run();
  return saved.meta.changes===1?Response.json({prepared:true}):fail('stale_request',409);
 }catch(error){
  const result={error:error instanceof ToolError?error.code:'tool_failed',confirmed:false,...(error.code==='not_authorized'?{reason:error.reason,authorization}:{})};
  await env.DB.prepare("UPDATE call_tool_jobs SET state='done',result_json=?,updated_at=? WHERE operation_id=? AND state='preparing'").bind(JSON.stringify(result),Date.now(),operationId).run();
  return Response.json(result);
 }
}

export async function recoverCallTools(env){
 if(env.VOICE_CALL_TOOLS_ENABLED!=='true')return;
 await env.DB.prepare("UPDATE call_sessions SET state='terminated' WHERE state!='terminated' AND updated_at<?").bind(new Date(Date.now()-20*60000).toISOString()).run();
 await env.DB.prepare("UPDATE call_tool_jobs SET state='cancelled',updated_at=? WHERE state IN ('preparing','prepared') AND (updated_at<? OR EXISTS(SELECT 1 FROM call_sessions c WHERE c.call_id=call_tool_jobs.call_id AND c.state='terminated'))").bind(Date.now(),Date.now()-60000).run();
 await env.DB.prepare("UPDATE call_tool_jobs SET state='done',result_json=?,updated_at=? WHERE state='committing' AND updated_at<?").bind(JSON.stringify({state:'uncertain',confirmed:false}),Date.now(),Date.now()-60000).run();
}
