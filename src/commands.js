import {prepareAssistant} from './assistant.js';
import {search_files,get_file,log_note,list_files,dataset,ToolError} from './search.js';
import {indexingConfigured} from './indexing.js';
import {prepareChatDelivery as prepare_file_delivery} from './chat.js';
import {sendResponse} from './acknowledge.js';
import {parseChoice,executeChoice,fileChoices,withChat,publicationStatements,timedChatEnv,startTyping,chatState,pendingProposal} from './chat.js';
export function parseCommand(message,{natural=false}={}){
 if(natural&&message.type==='interactive')return parseChoice(message);
 if(message.type!=='text'||typeof message.text?.body!=='string')return null;
 const text=message.text.body.trim();let match;
 if(natural&&/^(hi|hello|hey|नमस्ते|thanks|thank you|धन्यवाद|शुक्रिया)[!.।]?$/i.test(text))return {kind:'greeting',args:{thanks:/^(thanks|thank you|धन्यवाद|शुक्रिया)/i.test(text)}};
 if(natural&&/^(cancel|रद्द करो)[.!।]?$/i.test(text))return {kind:'chat_cancel',args:{contextMessageId:message.context?.id??null}};
 if(/^(help|menu)$/i.test(text))return {kind:'help',args:{}};
 if(/^files$/i.test(text))return {kind:'files',args:{}};
 if((match=text.match(/^(search|find|send me)\s+(.+)$/is))){if(natural&&match[1].toLowerCase()==='send me')return null;return {kind:'search',args:{query:match[2].trim(),sendBest:match[1].toLowerCase()==='send me'}};}
 if((match=text.match(/^get\s+([a-f0-9]{16})$/i)))return {kind:'get',args:{fileId:match[1].toLowerCase()}};
 if((match=text.match(/^note\s+(.+)$/is)))return {kind:'note',args:{text:match[1]}};
 if(natural&&(match=text.match(/^(?:please\s+)?(?:save (?:this as )?a note|नोट सेव करो|नोट सहेजें|याद रखो)\s*:\s*(.+)$/is)))return {kind:'note',args:{text:match[1]}};
 if((match=text.match(/^transcript(?:\s+(last|[a-f0-9]{16}))?$/i)))return {kind:'transcript',args:{fileId:match[1]?.toLowerCase()??'last'}};
 return null;
}
export function createCommandStatement(env,message,command,now){
 if(command.kind==='voice_assistant')return env.DB.prepare(`INSERT INTO command_jobs (message_id,owner,kind,arguments_json,created_at)
  SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM inbound_messages WHERE message_id=? AND received_at=? AND ack_state='pending')
  ON CONFLICT(message_id) DO NOTHING`).bind(message.id,env.ALLOWED_SENDER,command.kind,JSON.stringify(command.args),now,message.id,now);
 return env.DB.prepare(`INSERT INTO command_jobs (message_id,owner,kind,arguments_json,created_at)
  VALUES (?,?,?,?,?) ON CONFLICT(message_id) DO NOTHING`).bind(message.id,env.ALLOWED_SENDER,command.kind,JSON.stringify(command.args),now);
}
const textReply=body=>({type:'text',text:{body:body.slice(0,4096),preview_url:false}});
function listing(files){return files.map((file,index)=>`${index+1}. ${file.filename.replace(/[\r\n]/g,' ').slice(0,180)} (${file.kind})\nID: ${file.file_id}`).join('\n\n');}
async function voiceSource(env,job){
 const media=await env.DB.prepare('SELECT state,error_code FROM media_files WHERE message_id=? AND sender=?').bind(job.message_id,job.owner).first();
 if(!media||!['ready','failed','rejected'].includes(media.state))return null;
 if(media.state!=='ready')return {body:media.error_code==='too_large'?'This voice note is too large. Please send a shorter one.':'I could not save this voice note. Please send it again.'};
 const file=await env.DB.prepare('SELECT extracted_text,extraction_status,extraction_method,index_state FROM file_catalog WHERE message_id=? AND owner=? AND dataset=? AND voice_note=1').bind(job.message_id,job.owner,dataset(env)).first();
 if(!file||file.extraction_status==='pending'&&file.index_state!=='failed')return null;
 if(file.extraction_status!=='ready'||file.extraction_method!=='transcript'||!file.extracted_text.trim())return {body:'Voice note saved, but I could not transcribe it clearly. Please send a clearer voice note or type your request.'};
 if(file.extracted_text.length>2000)return {body:'Voice note saved. Please send a shorter voice request or type it in fewer than 2,000 characters.'};
 return {text:file.extracted_text.trim()};
}
async function prepareCommand(env,job){
 const owner=job.owner,args=JSON.parse(job.arguments_json);
 if(job.kind==='chat_choice')return executeChoice(env,job,args);
 if(job.kind==='greeting')return textReply(args.thanks?'You’re welcome.':'Hi! I can find or send your files, summarize them, or save a note.');
 if(job.kind==='chat_cancel'){
  const {context}=await chatState(env,owner,args.contextMessageId),proposal=await pendingProposal(env,job,context);
  return proposal?executeChoice(env,job,{proposalId:proposal.proposal_id,action:'cancel',contextMessageId:proposal.source_reply_id}):textReply('There is no pending confirmation to cancel. An action already sent or saved cannot be undone here.');
 }
 if(job.kind==='assistant')return prepareAssistant(env,job);
 if(job.kind==='voice_assistant'){const source=await voiceSource(env,job);if(!source)throw new ToolError('transcript_pending');if(source.body)return textReply(source.body);return prepareAssistant(env,{...job,arguments_json:JSON.stringify({text:source.text})});}
 if(job.kind==='help')return textReply('You can type or send a voice note to find, send or summarize a file, or save a note.\n\nCommands:\nsearch <words>\nsend me <description>\nget <file ID>\nfiles\nnote <text>\ntranscript last\n\n“Last week” means the previous Monday–Sunday in India time.');
 if(job.kind==='files'){
  const files=await list_files(env,owner);return files.length?fileChoices(env,job,files,'Your latest files:\n\n'+listing(files)+'\n\nChoose a file to send it here, or reply get <ID>.'):textReply('No saved files yet.');
 }
 if(job.kind==='note'){
  const result=await log_note(env,owner,args.text,job.message_id);return withChat(textReply('Note saved. ID: '+result.fileId),{lastNote:{fileId:result.fileId,filename:result.filename,kind:'note'}});
 }
 if(job.kind==='get')return prepare_file_delivery(env,owner,args.fileId);
 if(job.kind==='transcript'){
  let file;
  if(args.fileId==='last')file=await env.DB.prepare(`SELECT * FROM file_catalog WHERE owner=? AND dataset=?
   AND kind='audio' AND voice_note=1 ORDER BY source_epoch DESC LIMIT 1`).bind(owner,dataset(env)).first();
  else file=await get_file(env,owner,args.fileId);
  if(!file)return textReply('No saved voice note found.');
  if(file.extraction_method!=='transcript')return textReply('The transcript is not ready yet. Please try again shortly.');
  return textReply('Transcript:\n'+file.extracted_text);
 }
 if(job.kind==='search'){
  const result=await search_files(env,owner,args.query,{metadataOnly:true});
  if(!result.files.length)return textReply('No matching indexed files found. Newly saved files may need a little time to become searchable.');
  const [first,second]=result.files;
  const ambiguous=second&&first.score-second.score<0.05;
  if(args.sendBest&&!ambiguous&&first.score>=0.55)return prepare_file_delivery(env,owner,first.file_id);
  return fileChoices(env,job,result.files,(ambiguous?'I found several close matches.':'Matching files:')+'\n\n'+listing(result.files)+
   '\n\nChoose a file to send it here, or reply get <ID>.'+(result.dateRule?'\nDate rule: '+result.dateRule:''));
 }
 throw new ToolError('unknown_command');
}
export async function processCommand(originalEnv,id,{drain=true,budgetMs=27000}={}){
 if(!indexingConfigured(originalEnv))return false;
 const measured=timedChatEnv(originalEnv,{budgetMs:Math.max(1000,Math.min(16000,budgetMs-11000))}),{env,metrics}=measured,token=crypto.randomUUID(),now=Date.now();
 const claimed=await env.DB.batch([
  env.DB.prepare(`UPDATE command_jobs SET state='processing',lease_token=?,lease_until=?
   WHERE message_id=? AND owner=? AND (state='pending' OR (state='processing' AND lease_until<=?))
   AND EXISTS(SELECT 1 FROM inbound_messages i WHERE i.message_id=command_jobs.message_id AND i.ack_state='pending')
   AND (kind='chat_cancel' OR (kind='chat_choice' AND json_extract(arguments_json,'$.action') IN ('cancel','edit')) OR NOT EXISTS(SELECT 1 FROM command_jobs earlier WHERE earlier.owner=command_jobs.owner AND earlier.state!='done'
    AND (earlier.created_at<command_jobs.created_at OR (earlier.created_at=command_jobs.created_at AND earlier.message_id<command_jobs.message_id))))`)
   .bind(token,now+180000,id,env.ALLOWED_SENDER,now),
  env.DB.prepare('SELECT * FROM command_jobs WHERE message_id=? AND lease_token=?').bind(id,token)
 ]);
 if(claimed[0].meta.changes!==1)return false;
 const job=claimed[1].results[0];
 env.CHAT_JOB={messageId:id,leaseToken:token};
 if(job.kind==='voice_assistant'&&!await voiceSource(env,job)){
  await env.DB.prepare("UPDATE command_jobs SET state='pending',lease_until=0,lease_token=NULL WHERE message_id=? AND lease_token=?").bind(id,token).run();return false;
 }
 const cached=job.prepared_reply_json?JSON.parse(job.prepared_reply_json):null,cachedContent=cached?.content??cached;
 const staleLink=cachedContent?.text?.body?.includes('/storage/v1/object/sign/')&&(!cached?.preparedAt||Date.now()-cached.preparedAt>240000);
 const typing=startTyping(env,id,{enabled:!cachedContent||staleLink}),prepareStarted=performance.now();
 let payload,prepareFailed=false;
 try{payload=cachedContent&&!staleLink?cachedContent:await prepareCommand(env,job);}
 catch(error){prepareFailed=true;console.error(JSON.stringify({event:'command_prepare_failed',kind:job.kind,code:error instanceof ToolError?error.code:'internal_error'}));payload=textReply(error instanceof ToolError&&error.code==='file_not_found'?'That file was not found in your library.':error instanceof ToolError&&error.code==='file_changed'?'That file changed. Please find it again before sending.':'I could not complete this request. Please try again.');}
 finally{await typing.finish();}
 metrics.prepareMs=Math.round(performance.now()-prepareStarted);
 const statements=[env.DB.prepare('UPDATE command_jobs SET prepared_reply_json=? WHERE message_id=? AND lease_token=?').bind(JSON.stringify({content:payload,preparedAt:Date.now()}),id,token)];
 const turn=payload._chat?.turn;
 if(turn)statements.push(env.DB.prepare(`INSERT INTO assistant_turns(message_id,owner,user_text,reply_text,intent,route_probability,routing_ms,total_ms,tool_name,created_at)
  SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM command_jobs WHERE message_id=? AND lease_token=?) ON CONFLICT(message_id) DO NOTHING`).bind(id,job.owner,turn.text,payload.type==='text'?payload.text.body:payload.type==='interactive'?payload.interactive.body.text:'[file attachment]',turn.intent,turn.probability,turn.routingMs,turn.totalMs,turn.toolName,new Date().toISOString(),id,token));
 statements.push(env.DB.prepare(`UPDATE inbound_messages SET ack_state='sending',ack_updated_at=? WHERE message_id=? AND sender=? AND ack_state='pending'
  AND EXISTS(SELECT 1 FROM command_jobs c WHERE c.message_id=inbound_messages.message_id AND c.lease_token=?)`).bind(new Date().toISOString(),id,env.ALLOWED_SENDER,token));
 const prepared=await env.DB.batch(statements);
 if(prepared.at(-1).meta.changes!==1)return false;
 const sendStart=performance.now(),result=await sendResponse(env,id,payload);metrics.sendMs=Math.round(performance.now()-sendStart);
 const completed=[...(!prepareFailed&&env.ASSISTANT_ENABLED==='true'?publicationStatements(env,job,payload,result):[]),
  env.DB.prepare(`UPDATE chat_proposals SET state=CASE WHEN action='note' AND EXISTS(SELECT 1 FROM file_catalog WHERE message_id='chat-note:'||proposal_id AND owner=chat_proposals.owner) THEN 'done' ELSE ? END
   WHERE executing_message_id=? AND owner=? AND state='executing'`).bind(prepareFailed?'failed':result.state==='sent'?'done':result.state==='uncertain'?'uncertain':'failed',id,job.owner),
  env.DB.prepare("UPDATE command_jobs SET state='done',lease_until=0,lease_token=NULL,timings_json=? WHERE message_id=? AND lease_token=?")
   .bind(JSON.stringify({...metrics,queueWaitMs:Math.max(0,now-Date.parse(job.created_at)),accepted:result.state==='sent'}),id,token)];
 if(drain)completed.push(env.DB.prepare(`SELECT message_id FROM command_jobs WHERE owner=? AND state='pending' ORDER BY created_at,message_id LIMIT 1`).bind(job.owner));
 const finalized=await env.DB.batch(completed);
 console.log(JSON.stringify({event:'chat_timing',kind:job.kind,state:result.state,queueWaitMs:Math.max(0,now-Date.parse(job.created_at)),totalMs:measured.elapsed(),...Object.fromEntries(Object.entries(metrics).map(([key,value])=>[key,Math.round(value)]))}));
 const next=drain?finalized.at(-1).results[0]:null;
 if(next&&budgetMs-measured.elapsed()>=12000)await processCommand(originalEnv,next.message_id,{drain:false,budgetMs:budgetMs-measured.elapsed()});
 return true;
}
export async function runPendingCommands(env,{budgetMs=20000,limit=3}={}){
 if(!indexingConfigured(env)||budgetMs<=0)return;
 const started=Date.now();
 await env.DB.prepare(`UPDATE command_jobs SET state='done',lease_token=NULL,lease_until=0 WHERE owner=? AND state IN ('pending','processing') AND lease_until<=?
  AND EXISTS(SELECT 1 FROM inbound_messages i WHERE i.message_id=command_jobs.message_id AND i.ack_state!='pending')`).bind(env.ALLOWED_SENDER,Date.now()).run();
 for(let count=0;count<limit&&budgetMs-(Date.now()-started)>=12000;count++){
  const row=await env.DB.prepare(`SELECT message_id FROM command_jobs WHERE owner=? AND (state='pending' OR (state='processing' AND lease_until<=?)) ORDER BY created_at,message_id LIMIT 1`).bind(env.ALLOWED_SENDER,Date.now()).first();
  if(!row||!await processCommand(env,row.message_id,{drain:false,budgetMs:budgetMs-(Date.now()-started)}))break;
 }
}
