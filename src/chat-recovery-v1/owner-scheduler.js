import {configuredOwners,ownerEnv} from '../owners.js';
import {dataset,hash} from '../search.js';
import {runRagMaintenance,runRagBroadMaintenance,runRagGlobalMaintenance} from '../rag-v1/runtime.js';
import {runCallSummaryJobs,purgeCallSummaries} from './call-summary.js';
import {purgeCallArchives} from './call-archive.js';
import {runDueReminders} from './reminders.js';
import {runPendingCalls} from '../calls.js';
import {recoverCallTools} from './call-tools.js';
import {runPendingCommands} from './commands.js';
import {runPendingMedia} from '../media.js';
import {runPendingIndex} from '../indexing.js';

// One indexed metadata row per owner. Never inspect passage/vector tables for idle discovery.
async function pendingWork(env){
 const owner=env.ALLOWED_SENDER,now=Date.now();
 return env.DB.prepare(`SELECT
 EXISTS(SELECT 1 FROM file_catalog WHERE owner=? AND dataset=? LIMIT 1) AS documents,
 EXISTS(SELECT 1 FROM inbound_messages WHERE sender=? AND ack_state='pending' LIMIT 1) AS inbound,
 EXISTS(SELECT 1 FROM command_jobs WHERE owner=? AND state IN ('pending','processing') LIMIT 1) AS commands,
 EXISTS(SELECT 1 FROM reminders WHERE owner=? AND state IN ('pending','sending') AND lease_until<=?
  AND ((snooze_until>0 AND snooze_until<=?) OR (snooze_until=0 AND next_due_at<=?)) LIMIT 1) AS reminders,
 EXISTS(SELECT 1 FROM call_sessions WHERE owner=? LIMIT 1) AS calls`)
 .bind(owner,dataset(env),owner,owner,owner,now,now,now,owner).first();
}
async function lane(env,name,run){
 try{return await run();}catch{console.warn(JSON.stringify({event:'owner_recovery',lane:name,owner:hash(env.ALLOWED_SENDER).slice(0,12),state:'failed'}));}
}
export async function runOwnerScheduler(controller,env,ctx){
 if(env.SCHEDULER_ENABLED!=='true')return;
 const time=Number.isFinite(controller.scheduledTime)?controller.scheduledTime:Date.now();
 const owners=configuredOwners(env),offset=Math.floor(time/60000)%owners.length;
 const ordered=[...owners.slice(offset),...owners.slice(0,offset)];
 const broad=new Date(time).getUTCMinutes()%15===0;
 const work=[];
 for(const owner of ordered){const scoped=ownerEnv(env,owner);const pending=await lane(scoped,'preflight',()=>pendingWork(scoped));if(pending)work.push({env:scoped,...pending});}
 if(broad){
  ctx.waitUntil(lane(env,'global_cleanup',()=>runRagGlobalMaintenance(env)));
  ctx.waitUntil((async()=>{for(const owner of ordered){const scoped=ownerEnv(env,owner);await lane(scoped,'broad_cleanup',()=>runRagBroadMaintenance(scoped));}})());
 }
 ctx.waitUntil((async()=>{for(const w of work)if(w.documents||w.inbound)await lane(w.env,'rag',()=>runRagMaintenance(w.env));})());
 ctx.waitUntil((async()=>{for(const w of work)if(w.calls){await lane(w.env,'summary_purge',()=>purgeCallSummaries(w.env));await lane(w.env,'summary',()=>runCallSummaryJobs(w.env));await lane(w.env,'archive_purge',()=>purgeCallArchives(w.env));}})());
 ctx.waitUntil((async()=>{for(const w of work)if(w.reminders)await lane(w.env,'reminders',()=>runDueReminders(w.env));})());
 // These expiry-only operations are global and run once, never once per owner.
 await lane(env,'call_tool_expiry',()=>recoverCallTools(env));
 for(const w of work){
  if(w.commands||w.inbound)await lane(w.env,'commands',()=>runPendingCommands(w.env));
  if(w.calls)await lane(w.env,'calls',()=>runPendingCalls(w.env));
  // Ready-media discovery scans history: use it for pending inbound work and the
  // broad reconciliation slot. Existing catalog/index and PDF jobs still progress every minute.
  if(w.inbound||broad)await lane(w.env,'media',()=>runPendingMedia(w.env));
  if(w.documents||w.inbound||broad)await lane(w.env,'index',()=>runPendingIndex(w.env,{discover:!!w.inbound||broad}));
  if(w.commands||w.inbound)await lane(w.env,'commands',()=>runPendingCommands(w.env));
 }
}
