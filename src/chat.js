import {checkOwner,dataset,hash,ToolError} from './search.js';
import {prepare_file_delivery} from './delivery.js';

export const textReply=body=>({type:'text',text:{body:String(body).slice(0,4096),preview_url:false}});
const lifetime=30*60000;
export async function chatState(env,owner,contextMessageId){
 checkOwner(env,owner);
 if(contextMessageId){
  const row=await env.DB.prepare(`SELECT c.prepared_reply_json,i.ack_updated_at FROM command_jobs c JOIN inbound_messages i ON i.message_id=c.message_id
   WHERE c.owner=? AND i.ack_message_id=? AND i.ack_state='sent'`).bind(owner,contextMessageId).first();
  const saved=row?.prepared_reply_json?JSON.parse(row.prepared_reply_json):null,content=saved?.content??saved;
  return row&&Date.now()-Date.parse(row.ack_updated_at)<lifetime?{candidates:content?._chat?.candidates??[],context:{...content?._chat,selectionContext:Boolean(content?._chat?.candidates),previousReply:content?.text?.body??content?.interactive?.body?.text??'',sourceReplyId:contextMessageId}}:{candidates:[],context:{}};
 }
 const row=await env.DB.prepare('SELECT candidates_json,context_json,updated_at FROM assistant_state WHERE owner=?').bind(owner).first();
 const context=row?JSON.parse(row.context_json):{};
 const candidates=row&&Date.now()-Date.parse(context.candidatesAt??row.updated_at)<lifetime?JSON.parse(row.candidates_json):[];
 if(!row||Date.now()-Date.parse(row.updated_at)>=lifetime)return {candidates,context:{}};
 return {candidates,context};
}
export function withChat(content,metadata){return {...content,_chat:{...content._chat,...metadata}};}
export async function prepareChatDelivery(env,owner,fileId,options={}){
 checkOwner(env,owner);
 let expectedHash=options.expectedHash??null;
 if(env.CHAT_JOB&&!options.proposalClaimed){
  // Text/ordinal selections and button taps must consume the same proposal.
  const rows=await env.DB.prepare(`UPDATE chat_proposals SET state='executing',executing_message_id=?
   WHERE owner=? AND dataset=? AND action='send' AND state='pending' AND expires_at>? AND json_extract(payload_json,'$.fileId')=?
   AND EXISTS(SELECT 1 FROM command_jobs WHERE message_id=? AND owner=? AND lease_token=? AND state='processing' AND lease_until>?) RETURNING payload_json`)
   .bind(env.CHAT_JOB.messageId,owner,dataset(env),Date.now(),fileId,env.CHAT_JOB.messageId,owner,env.CHAT_JOB.leaseToken,Date.now()).all();
  if(rows.results.length)expectedHash??=JSON.parse(rows.results[0].payload_json).sha256;
 }
 return withChat(await prepare_file_delivery(env,owner,fileId,{expectedHash,expectedKind:options.expectedKind}),{excludeReply:true,deliveredFileId:fileId});
}
export function publicationStatements(env,job,content,result){
 if(result.state!=='sent')return [];
 const meta=content._chat??{},now=new Date().toISOString();
 // Only publish reply-bound choices after Meta has accepted their actual message.
 const context={previousReply:content.type==='text'?content.text.body.slice(0,1200):content.type==='interactive'?content.interactive.body.text.slice(0,1200):'[A file attachment was sent.]',sourceReplyId:result.replyId,offerIds:meta.offerIds??[],selectionContext:Boolean(meta.candidates||meta.deliveredFileId),...(meta.candidates?{candidatesAt:now}:{})};
 if(job.kind==='transcript'||meta.excludeReply)context.previousReply='[File contents, a private download link or a summary were provided. Their content is excluded from action planning.]';
 const statements=[env.DB.prepare(`INSERT INTO assistant_state(owner,candidates_json,context_json,updated_at) VALUES(?,?,?,?)
  ON CONFLICT(owner) DO UPDATE SET candidates_json=CASE WHEN ? THEN excluded.candidates_json ELSE assistant_state.candidates_json END,
  context_json=json_patch(assistant_state.context_json,excluded.context_json),updated_at=excluded.updated_at`)
  .bind(job.owner,JSON.stringify(meta.candidates??[]),JSON.stringify(context),now,meta.candidates?1:0)];
 if(meta.offerIds?.length){
  statements.push(env.DB.prepare(`UPDATE chat_proposals SET state='superseded' WHERE owner=? AND state IN ('pending','editing') AND proposal_id NOT IN (${meta.offerIds.map(()=>'?').join(',')})`).bind(job.owner,...meta.offerIds));
  statements.push(env.DB.prepare(`UPDATE chat_proposals SET state=CASE WHEN state='draft' THEN 'pending' ELSE state END,source_reply_id=? WHERE owner=? AND proposal_id IN (${meta.offerIds.map(()=>'?').join(',')}) AND state IN ('draft','pending','editing')`).bind(result.replyId,job.owner,...meta.offerIds));
 }
 return statements;
}
function draftStatement(env,job,action,payload){
 const id=hash('chat:'+job.owner+':'+job.message_id+':'+action+':'+JSON.stringify(payload)).slice(0,32);
 const statement=env.DB.prepare(`INSERT INTO chat_proposals(proposal_id,owner,dataset,origin_message_id,action,payload_json,expires_at,created_at)
  VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(proposal_id) DO NOTHING`).bind(id,job.owner,dataset(env),job.message_id,action,JSON.stringify(payload),Date.now()+lifetime,new Date().toISOString());
 return {id,statement};
}
export async function fileChoices(env,job,files,body){
 const candidates=files.slice(0,5).map(f=>({fileId:f.file_id,kind:f.kind,filename:f.filename.slice(0,180),sha256:f.sha256??null}));
 if(env.CHAT_CHOICES_ENABLED!=='true'||env.ASSISTANT_ENABLED!=='true')return withChat(textReply(body),{candidates});
 const drafts=files.slice(0,5).map(file=>draftStatement(env,job,'send',{fileId:file.file_id,filename:file.filename,sha256:file.sha256??null}));
 await env.DB.batch(drafts.map(row=>row.statement));const offerIds=drafts.map(row=>row.id);
 const interactive=files.length===1?{type:'button',body:{text:'I found '+candidates[0].filename+'.\nSend this file here?'},action:{buttons:[{type:'reply',reply:{id:'chat:'+offerIds[0]+':send',title:files[0].mime_type==='application/pdf'?'Send PDF':'Send file'}},{type:'reply',reply:{id:'chat:'+offerIds[0]+':cancel',title:'Cancel'}}]}}:
  {type:'list',body:{text:('Choose a file to send it here. You can also reply with its number.\n\n'+candidates.map((file,i)=>`${i+1}. ${file.filename} (${file.kind})`).join('\n\n')).slice(0,1024)},action:{button:'Choose file',sections:[{title:'Send a saved file',rows:files.slice(0,5).map((file,i)=>({id:'chat:'+offerIds[i]+':send',title:(file.filename.replace(/[\r\n]/g,' ').slice(0,24)||'Saved file'),description:(file.kind+' · '+new Date((file.source_epoch+19800)*1000).toISOString().slice(0,10)+' · '+file.filename.replace(/[\r\n]/g,' ')).slice(0,72)}))}]}};
 return withChat({type:'interactive',interactive},{candidates,offerIds});
}
export function parseChoice(message){
 if(message.type!=='interactive')return null;
 const selection=message.interactive?.type==='button_reply'?message.interactive.button_reply:message.interactive?.type==='list_reply'?message.interactive.list_reply:null;
 const id=typeof selection?.id==='string'?selection.id:'';
 const reminder=id.match(/^reminder:(\d{1,9}):(snooze:(\d{1,3})|cancel|done)$/);
 if(reminder)return {kind:'reminder_action',args:{reminderId:Number(reminder[1]),action:reminder[2].startsWith('snooze')?'snooze':reminder[2],minutes:reminder[3]?Number(reminder[3]):null}};
 const match=id.match(/^chat:([a-f0-9]{32}):(send|cancel)$/);
 return {kind:'chat_choice',args:match?{proposalId:match[1],action:match[2],contextMessageId:message.context?.id??null}:{invalid:true}};
}
export async function pendingProposal(env,job,context){
 const ids=context.offerIds??[];
 if(ids.length!==1)return null;
 return env.DB.prepare(`SELECT * FROM chat_proposals WHERE proposal_id=? AND owner=? AND dataset=? AND source_reply_id=? AND state='pending' AND expires_at>?`)
  .bind(ids[0],job.owner,dataset(env),context.sourceReplyId,Date.now()).first();
}
export async function executeChoice(env,job,args){
 checkOwner(env,job.owner);
 if(args.invalid||!args.contextMessageId)return textReply('That choice is unavailable. Please ask me to find the file again.');
 const row=await env.DB.prepare('SELECT * FROM chat_proposals WHERE proposal_id=? AND owner=? AND dataset=? AND source_reply_id=?')
  .bind(args.proposalId,job.owner,dataset(env),args.contextMessageId).first();
 if(!row)return textReply('That choice is unavailable. Please ask me again.');
 if(row.state==='done')return textReply('That action already completed. Ask me to send it again if you want another copy.');
 if(row.state==='executing'&&row.executing_message_id!==job.message_id)return textReply('That action is already being processed.');
 if(row.expires_at<=Date.now()||!['pending','executing'].includes(row.state))return textReply('That choice has expired or was replaced. Please ask me again.');
 if(args.action==='cancel'){
  const result=await env.DB.prepare(`UPDATE chat_proposals SET state='cancelled' WHERE proposal_id=? AND owner=? AND state='pending'`).bind(row.proposal_id,job.owner).run();
  if(!result.meta.changes)return textReply('That action has already started; I cannot cancel or change it now.');
  return textReply('Cancelled.');
 }
 if(row.action!=='send'||args.action!=='send')return textReply('That button does not match the proposed action.');
 const claimed=await env.DB.prepare(`UPDATE chat_proposals SET state='executing',executing_message_id=? WHERE proposal_id=? AND owner=? AND expires_at>?
  AND (state='pending' OR (state='executing' AND executing_message_id=?)) AND EXISTS(SELECT 1 FROM command_jobs WHERE message_id=? AND lease_token=? AND state='processing')`)
  .bind(job.message_id,row.proposal_id,job.owner,Date.now(),job.message_id,job.message_id,job.lease_token).run();
 if(claimed.meta.changes!==1)return textReply('That action changed before confirmation. Please ask me again.');
 const payload=JSON.parse(row.payload_json);
 const content=await prepareChatDelivery(env,job.owner,payload.fileId,{expectedHash:payload.sha256,proposalClaimed:true});
 return withChat(content,{executedProposal:row.proposal_id});
}
export function timedChatEnv(env,{budgetMs=16000}={}){
 const metrics={dbMs:0,dbCalls:0,routerMs:0,plannerMs:0,embeddingMs:0,vectorMs:0,modelCalls:0},started=performance.now();
 const measure=async(key,fn)=>{const begin=performance.now();try{return await fn();}finally{metrics[key]+=performance.now()-begin;}};
 const wrap=statement=>({raw:statement,bind(...args){return wrap(statement.bind(...args));},...Object.fromEntries(['first','all','run'].map(name=>[name,(...args)=>{metrics.dbCalls++;return measure('dbMs',()=>statement[name](...args));}]))});
 const DB={prepare:sql=>wrap(env.DB.prepare(sql)),batch(statements){metrics.dbCalls++;return measure('dbMs',()=>env.DB.batch(statements.map(s=>s.raw??s)));}};
 const deadline=Date.now()+budgetMs;
 const AI={run:async(model,input)=>{
  metrics.modelCalls++;const key=model.includes('/clef')?'routerMs':model.includes('bge-small')?'embeddingMs':'plannerMs';
  const remaining=Math.min(12000,deadline-Date.now());if(remaining<=0)throw new ToolError('model_timeout');
  // RPC-backed evaluation bindings cannot serialize AbortSignal; native AI can.
  let timer;try{return await measure(key,()=>Promise.race([env.CHAT_AI_SIGNAL_ENABLED==='true'?env.AI.run(model,input,{signal:AbortSignal.timeout(remaining)}):env.AI.run(model,input),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new ToolError('model_timeout')),remaining);})]));}finally{clearTimeout(timer);}
 }};
 return {env:{...env,DB,AI,FILES:{query:(...args)=>measure('vectorMs',()=>env.FILES.query(...args))},CHAT_DEADLINE:deadline},metrics,elapsed:()=>Math.round(performance.now()-started)};
}
export function startTyping(env,messageId,{enabled=true}={}){
 let finished=false,started=false,timer,release;const controller=new AbortController();
 const settled=new Promise(resolve=>{release=resolve;timer=setTimeout(async()=>{
  if(finished){resolve();return;}
  started=true;
  const timeout=setTimeout(()=>controller.abort(),1000);
  try{const response=await fetch(`https://graph.facebook.com/v26.0/${env.META_PHONE_NUMBER_ID}/messages`,{method:'POST',headers:{Authorization:'Bearer '+env.META_ACCESS_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({messaging_product:'whatsapp',status:'read',message_id:messageId,typing_indicator:{type:'text'}}),signal:controller.signal});await response.body?.cancel();}
  catch{/* Typing is best effort; it never changes delivery state. */}finally{clearTimeout(timeout);resolve();}
 },400);});
 if(!enabled||env.CHAT_TYPING_ENABLED!=='true'){clearTimeout(timer);release();}
 return {async finish(){finished=true;clearTimeout(timer);controller.abort();if(!started)release();await settled;}};
}
