import {createHmac} from 'node:crypto';
import {hash} from './search.js';

const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
export function livekitRoom(callId){return 'whats-'+hash(callId).slice(0,32);}
async function rpc(env,method,data,requestId){
 const url=new URL(env.LIVEKIT_URL);
 if(!['https:','wss:'].includes(url.protocol)||!/^[-a-z0-9]+\.livekit\.cloud$/.test(url.hostname)||url.username||url.password||url.port||url.search||url.hash||url.pathname!=='/')throw new Error('invalid_livekit_url');
 if(!env.LIVEKIT_API_KEY||!env.LIVEKIT_API_SECRET)throw new Error('missing_livekit_credentials');
 url.protocol='https:';url.pathname='/twirp/livekit.Connector/'+method;
 const now=Math.floor(Date.now()/1000),head=encode({alg:'HS256',typ:'JWT'}),claims=encode({iss:env.LIVEKIT_API_KEY,nbf:now-10,exp:now+60,video:{roomCreate:true}});
 const jwt=head+'.'+claims+'.'+createHmac('sha256',env.LIVEKIT_API_SECRET).update(head+'.'+claims).digest('base64url');
 const response=await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+jwt,'Content-Type':'application/json','X-Livekit-Request-Id':requestId},body:JSON.stringify(data),redirect:'manual',signal:AbortSignal.timeout(10000)});
 const reader=response.body?.getReader(),chunks=[];let size=0;
 if(reader)try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>20000){await reader.cancel();throw new Error('oversized_livekit_response');}chunks.push(value);}}finally{reader.releaseLock();}
 let result;try{result=JSON.parse(Buffer.concat(chunks).toString());}catch{throw new Error('invalid_livekit_response');}
 if(!response.ok){
  // A repeated call ID cannot create a second connector. Already-ended cleanup is idempotent.
  if((method==='AcceptWhatsAppCall'&&result.code==='already_exists')||(method==='DisconnectWhatsAppCall'&&result.code==='not_found'))return;
  throw new Error('livekit_'+response.status+'_'+String(result.code??'failed').replace(/[^a-z_]/g,'').slice(0,40));
 }
 return result;
}
export async function disconnectLiveKitCall(env,callId,business=false){
 // Live Cloud currently validates the Meta key even for USER_INITIATED (observed 2026-10-13).
 await rpc(env,'DisconnectWhatsAppCall',{whatsappCallId:callId,whatsappApiKey:env.META_ACCESS_TOKEN,disconnectReason:business?'BUSINESS_INITIATED':'USER_INITIATED'},hash('disconnect:'+callId+':'+business));
}
export async function forwardLiveKitCall(env,row){
 if(row.event==='terminate'){await disconnectLiveKitCall(env,row.call_id,JSON.parse(row.payload_json).business===true);return;}
 const call=JSON.parse(row.payload_json),room=livekitRoom(row.call_id);
 const signature=createHmac('sha256',env.VOICE_BRIDGE_SECRET).update('whats-livekit:v1:'+row.call_id+':'+room).digest('hex');
 await rpc(env,'AcceptWhatsAppCall',{
  whatsappPhoneNumberId:env.META_PHONE_NUMBER_ID,whatsappApiKey:env.META_ACCESS_TOKEN,whatsappCloudApiVersion:'26.0',whatsappCallId:row.call_id,
  sdp:{type:'offer',sdp:call.session.sdp},roomName:room,participantIdentity:'caller',participantName:'Caller',
  agents:[{agentName:'whats-voice',metadata:JSON.stringify({callId:row.call_id,room,signature})}],waitUntilAnswered:false
 },hash('accept:'+row.call_id));
 // A hangup can race a slow accept. Close any connector created after the tombstone.
 const current=await env.DB.prepare('SELECT state FROM call_sessions WHERE call_id=?').bind(row.call_id).first();
 if(current?.state==='terminated')await disconnectLiveKitCall(env,row.call_id,true);
}
