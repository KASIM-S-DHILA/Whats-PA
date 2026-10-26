import {createHmac} from 'node:crypto';
import {forwardLiveKitCall} from './livekit.js';
import {hash} from './search.js';
import {createMediaStatement,processMedia} from './media.js';
import {runPendingIndex} from './indexing.js';
import {ownerEnv,resolveOwner} from './owners.js';
const callId=id=>typeof id==='string'&&/^wacid\.[A-Za-z0-9_.=-]{1,490}$/.test(id);
export async function forwardCall(env,eventId){
 if(env.CALL_BRIDGE_ENABLED!=='true'||(env.CALL_BRIDGE_BACKEND!=='livekit'&&!env.CALL_BRIDGE_URL))return;
 const target=env.CALL_BRIDGE_BACKEND==='livekit'?null:new URL(env.CALL_BRIDGE_URL);if(target&&(target.protocol!=='https:'||target.username||target.password||!target.hostname.endsWith('.trycloudflare.com')))throw new Error('invalid_bridge_url');
 const token=crypto.randomUUID(),now=Date.now();
 const claim=await env.DB.prepare(`UPDATE call_events SET state='sending',attempts=attempts+1,lease_token=?,lease_until=? WHERE event_id=? AND attempts<3 AND (state='pending' OR (state='sending' AND lease_until<=?)) AND EXISTS(SELECT 1 FROM call_sessions s WHERE s.call_id=call_events.call_id AND s.owner=?)`).bind(token,now+25000,eventId,now,env.ALLOWED_SENDER).run();if(claim.meta.changes!==1)return;
 const row=await env.DB.prepare('SELECT * FROM call_events WHERE event_id=? AND lease_token=?').bind(eventId,token).first();
 const terminal=await env.DB.prepare("SELECT state FROM call_sessions WHERE call_id=? AND owner=?").bind(row.call_id,env.ALLOWED_SENDER).first();
 if(row.event==='connect'&&(terminal?.state==='terminated'||Date.now()-Number(JSON.parse(row.payload_json).timestamp)*1000>60000)){
  await env.DB.prepare("UPDATE call_events SET state='discarded',lease_token=NULL,lease_until=0 WHERE event_id=? AND lease_token=?").bind(eventId,token).run();return;
 }
 try{
  if(env.CALL_BRIDGE_BACKEND==='livekit')await forwardLiveKitCall(env,row);
  else{
  const body=JSON.stringify({eventId:row.event_id,phoneNumberId:env.META_PHONE_NUMBER_ID,owner:env.ALLOWED_SENDER,call:JSON.parse(row.payload_json)}),timestamp=String(Math.floor(Date.now()/1000));
  const signature=createHmac('sha256',env.META_APP_SECRET).update('whats-bridge:v1:'+timestamp+':'+body).digest('hex');
  const response=await fetch(new URL('/calls',target),{method:'POST',headers:{'Content-Type':'application/json','X-Bridge-Time':timestamp,'X-Bridge-Signature':signature},body,redirect:'manual',signal:AbortSignal.timeout(8000)});await response.body?.cancel();if(!response.ok)throw new Error('bridge_unavailable');
  }
  await env.DB.prepare("UPDATE call_events SET state='forwarded',lease_token=NULL,lease_until=0 WHERE event_id=? AND lease_token=?").bind(eventId,token).run();
 }catch{await env.DB.prepare("UPDATE call_events SET state=CASE WHEN attempts>=3 THEN 'failed' ELSE 'pending' END,lease_token=NULL,lease_until=0 WHERE event_id=? AND lease_token=?").bind(eventId,token).run();console.error(JSON.stringify({event:'call_forward_failed'}));}
}
export async function ingestCalls(env,payload,ctx){
 if(env.CALL_BRIDGE_ENABLED!=='true')return;
 const deploymentEnv=env;
 let count=0,failed=false;
 for(const entry of payload.entry)for(const change of Array.isArray(entry.changes)?entry.changes:[]){
  const value=change.value;if(change.field!=='calls'||entry.id!==env.META_WABA_ID||value?.metadata?.phone_number_id!==env.META_PHONE_NUMBER_ID)continue;
  for(const call of Array.isArray(value.calls)?value.calls:[]){
   if(++count>20)throw new Error('too_many_calls');
   try{
   if(!callId(call?.id))continue;
   if(call.from!==undefined&&call.from!==null&&!resolveOwner(deploymentEnv,call.from))continue;
   const prior=await deploymentEnv.DB.prepare('SELECT owner,state FROM call_sessions WHERE call_id=?').bind(call.id).first();
   if(prior&&call.from!==undefined&&call.from!==null&&call.from!==prior.owner)continue;
   const owner=call.event==='connect'?resolveOwner(deploymentEnv,call.from):resolveOwner(deploymentEnv,prior?.owner);
   if(!owner||prior&&prior.owner!==owner)continue;
   const env=ownerEnv(deploymentEnv,owner);
   if(['call_recording_available','call_transcription_available'].includes(call.event)){
    if(env.CALL_RECORDING_ENABLED==='true'&&prior?.owner===env.ALLOWED_SENDER&&(!call.from||call.from===env.ALLOWED_SENDER))await ingestArtifact(env,call,ctx);
    continue;
   }
   if(!['connect','terminate'].includes(call.event))continue;
   if(call.event==='connect'&&(call.session?.sdp_type!=='offer'||typeof call.session.sdp!=='string'||call.session.sdp.length>65536||!Number.isFinite(Number(call.timestamp))||Math.abs(Date.now()-Number(call.timestamp)*1000)>60000))continue;
   const time=new Date().toISOString(),eventId=call.id+':'+call.event+':'+String(call.timestamp??'');
   await env.DB.batch([
    env.DB.prepare(`INSERT INTO call_sessions(call_id,owner,state,updated_at) VALUES(?,?,?,?) ON CONFLICT(call_id) DO UPDATE SET state=CASE WHEN call_sessions.state='terminated' THEN 'terminated' ELSE excluded.state END,updated_at=excluded.updated_at WHERE call_sessions.owner=excluded.owner`).bind(call.id,env.ALLOWED_SENDER,call.event==='terminate'?'terminated':'offered',time),
    env.DB.prepare(`INSERT INTO call_events(event_id,call_id,event,payload_json,created_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM call_sessions WHERE call_id=? AND owner=?) ON CONFLICT(event_id) DO NOTHING`).bind(eventId,call.id,call.event,JSON.stringify(call),time,call.id,owner)
   ]);
   ctx.waitUntil(forwardCall(env,eventId).catch(()=>console.error(JSON.stringify({event:'call_forward_failed'}))));
   console.log(JSON.stringify({event:'call_webhook',kind:call.event,ownSender:true}));
   }catch{failed=true;console.warn(JSON.stringify({event:'call_ingest_failed',state:'deferred'}));}
  }
 }
 if(failed)throw new Error('call_ingest_deferred');
}
async function ingestArtifact(env,call,ctx){
 const recording=call.event==='call_recording_available',kind=recording?'recording':'transcript',type=recording?'audio':'document';
 const media=recording?call.call_recording?.audio:call.call_transcript?.document;
 if(!media||!/^\d{1,40}$/.test(media.id??'')||typeof media.sha256!=='string'||!(recording?media.mime_type?.startsWith('audio/'):media.mime_type==='application/json'))return;
 const existing=await env.DB.prepare('SELECT media_id,message_id FROM call_artifacts WHERE call_id=? AND kind=?').bind(call.id,kind).first();
 if(existing){if(existing.media_id===media.id)ctx.waitUntil(processMedia(env,existing.message_id).then(()=>runPendingIndex(env)));return;}
 const now=new Date().toISOString(),id='call-artifact:'+hash(call.id+':'+kind),epoch=Number(call.timestamp);
 const message={id,from:env.ALLOWED_SENDER,type,timestamp:String(Number.isFinite(epoch)&&epoch>0?epoch:Math.floor(Date.now()/1000)),call_artifact:kind,
  [type]:{id:media.id,sha256:media.sha256,mime_type:media.mime_type,filename:'Call '+kind+' '+now.replace(/[:.]/g,'-')+(recording?'.ogg':'.json')}};
 // The webhook URL is deliberately discarded; the media ID gets fresh authenticated metadata.
 await env.DB.batch([
  env.DB.prepare("INSERT INTO inbound_messages(message_id,sender,phone_number_id,message_type,message_timestamp,payload_json,received_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(message_id) DO NOTHING").bind(id,env.ALLOWED_SENDER,env.META_PHONE_NUMBER_ID,type,message.timestamp,JSON.stringify(message),now),
  createMediaStatement(env,message,now),
  env.DB.prepare("INSERT INTO call_artifacts(call_id,kind,message_id,media_id,created_at) VALUES(?,?,?,?,?) ON CONFLICT(call_id,kind) DO NOTHING").bind(call.id,kind,id,media.id,now)
 ]);
 ctx.waitUntil(processMedia(env,id).then(()=>runPendingIndex(env)).catch(()=>console.error(JSON.stringify({event:'call_artifact_failed',kind}))));
}
export async function runPendingCalls(env){
 if(env.CALL_BRIDGE_ENABLED!=='true')return;
 await env.DB.prepare("UPDATE call_events SET state='failed',lease_token=NULL,lease_until=0 WHERE attempts>=3 AND state='sending' AND lease_until<=? AND EXISTS(SELECT 1 FROM call_sessions s WHERE s.call_id=call_events.call_id AND s.owner=?)").bind(Date.now(),env.ALLOWED_SENDER).run();
 const rows=await env.DB.prepare("SELECT e.event_id FROM call_events e JOIN call_sessions s ON s.call_id=e.call_id WHERE s.owner=? AND e.attempts<3 AND (e.state='pending' OR (e.state='sending' AND e.lease_until<=?)) ORDER BY e.created_at DESC LIMIT 3").bind(env.ALLOWED_SENDER,Date.now()).all();
 for(const row of rows.results)await forwardCall(env,row.event_id);
}
