import {DurableObject} from 'cloudflare:workers';
import {hash,dataset} from '../search.js';
import {processMedia} from '../media.js';
import {ensureCatalog,processIndex} from '../indexing.js';
import {runPendingCommands} from './commands.js';
import {ownerEnv,resolveOwner} from '../owners.js';

// One durable timer per owned upload; no polling when there is no active upload.
export async function scheduleMediaRecovery(env,messageId){
 if(!env.MEDIA_RECOVERY)return false;
 await env.MEDIA_RECOVERY.getByName(hash('media-recovery:'+env.ALLOWED_SENDER+':'+messageId)).start(messageId,env.ALLOWED_SENDER);
 return true;
}

export class MediaRecovery extends DurableObject {
 async start(messageId,owner){
  if(typeof messageId!=='string'||!messageId||messageId.length>512)throw new Error('invalid_media_message');
  const row=await this.env.DB.prepare("SELECT m.sender FROM media_files m JOIN inbound_messages i ON i.message_id=m.message_id AND i.sender=m.sender WHERE m.message_id=? AND m.state IN ('pending','processing')")
   .bind(messageId).first();
  if(!row)return;
  // An older primary-only Worker may still call start(messageId) during rollout.
  owner=owner??row.sender;
  if(owner!==row.sender||!resolveOwner(this.env,owner))throw new Error('media_recovery_scope');
  if(this.ctx.id.toString()!==this.env.MEDIA_RECOVERY.idFromName(hash('media-recovery:'+owner+':'+messageId)).toString())throw new Error('media_recovery_scope');
  await this.ctx.storage.transaction(async storage=>{
   const current=await storage.get('messageId');
   const storedOwner=await storage.get('owner');
   if(current&&current!==messageId||storedOwner&&storedOwner!==owner)throw new Error('media_recovery_scope');
   await storage.put({messageId,owner});
   if(await storage.getAlarm()===null)await storage.setAlarm(Date.now());
  });
 }

 async alarm(){
  const id=await this.ctx.storage.get('messageId');
  if(!id)return;
  const row=await this.env.DB.prepare('SELECT m.sender FROM media_files m JOIN inbound_messages i ON i.message_id=m.message_id AND i.sender=m.sender WHERE m.message_id=?').bind(id).first();
  const storedOwner=await this.ctx.storage.get('owner');
  const owner=storedOwner??row?.sender;
  if(!row||owner!==row.sender||!resolveOwner(this.env,owner)){
   await this.ctx.storage.deleteAlarm();return;
  }
  if(this.ctx.id.toString()!==this.env.MEDIA_RECOVERY.idFromName(hash('media-recovery:'+owner+':'+id)).toString()){
   await this.ctx.storage.deleteAlarm();return;
  }
  if(!storedOwner)await this.ctx.storage.put('owner',owner);
  const env=ownerEnv(this.env,owner);
  // Persist the next check before network work, so an interrupted invocation can recover.
  await this.ctx.storage.setAlarm(Date.now()+5000);
  try{
   await env.DB.prepare("UPDATE media_files SET state='failed',error_code='attempts_exhausted',lease_until=0,lease_token=NULL WHERE message_id=? AND sender=? AND state='processing' AND lease_until<=? AND attempts>=3")
    .bind(id,owner,Date.now()).run();
   await processMedia(env,id);
   const media=await env.DB.prepare('SELECT state FROM media_files WHERE message_id=? AND sender=?')
    .bind(id,owner).first();
   if(media?.state==='ready'){
    await ensureCatalog(env);
    const file=await env.DB.prepare('SELECT file_id FROM file_catalog WHERE message_id=? AND owner=? AND dataset=?')
     .bind(id,owner,dataset(env)).first();
    if(file)await processIndex(env,file.file_id);
    await runPendingCommands(env);
   }
   if(!media||!['pending','processing'].includes(media.state)){
    await this.ctx.storage.transaction(async storage=>{
     await storage.deleteAlarm();
     await storage.delete('messageId');
    });
    return;
   }
  }catch{
   console.warn(JSON.stringify({event:'media_recovery',state:'deferred'}));
  }
  // Preserve the existing transfer lease and three-attempt cap; never overlap a live transfer.
  await this.ctx.storage.setAlarm(Date.now()+5000);
 }
}
