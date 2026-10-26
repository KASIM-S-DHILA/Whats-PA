import {createHmac,timingSafeEqual} from 'node:crypto';
import {dataset} from '../search.js';
import {runEvidenceIngest} from './ingest.js';
import {deleteEvidenceSource} from './evidence.js';
import {runPdfBackfill} from './pdf.js';
import {runGraphJob} from './graph.js';
import {runPagedPdfStep} from '../rag-rebuild/pdf-pages.js';
import {runPagedSummaryStep} from '../rag-rebuild/pdf-summary.js';
import {maintainFastPdfs} from '../rag-rebuild/pdf-fast.js';
import {ownerEnv,primaryOwner} from '../owners.js';
// Global expiry runs once per 15-minute slot, independent of the number of owners.
export async function runRagGlobalMaintenance(env){
 const now=Date.now();
 await env.DB.batch([
  env.DB.prepare('DELETE FROM rag_cache WHERE cache_key IN (SELECT cache_key FROM rag_cache WHERE expires_at<=? LIMIT 100)').bind(now),
  env.DB.prepare('DELETE FROM rag_context WHERE expires_at<=?').bind(now),
  env.DB.prepare('DELETE FROM rag_budget WHERE day<?').bind(new Date(now-7*86400000).toISOString().slice(0,10)),
  env.DB.prepare('DELETE FROM call_summary_budget WHERE day<?').bind(new Date(now-7*86400000).toISOString().slice(0,10))
 ]);
}
// Owner cleanup remains bounded; a backlog can require multiple 15-minute slots.
export async function runRagBroadMaintenance(env){
 env={...env,RAG_REQUEST_KIND:'background'};
 const now=Date.now();
 try{
  await env.DB.batch([
   env.DB.prepare(`DELETE FROM rag_graphs WHERE owner=? AND NOT EXISTS(SELECT 1 FROM rag_sources s JOIN file_catalog c ON c.file_id=s.file_id AND c.owner=s.owner AND c.dataset=s.dataset WHERE s.owner=rag_graphs.owner AND s.dataset=rag_graphs.dataset AND s.file_id=rag_graphs.file_id AND s.generation=rag_graphs.generation AND s.state='ready')`).bind(env.ALLOWED_SENDER),
   env.DB.prepare(`DELETE FROM rag_vectors WHERE owner=? AND NOT EXISTS(SELECT 1 FROM rag_sources s JOIN file_catalog c ON c.file_id=s.file_id AND c.owner=s.owner AND c.dataset=s.dataset WHERE s.owner=rag_vectors.owner AND s.dataset=rag_vectors.dataset AND s.file_id=rag_vectors.file_id AND s.generation=rag_vectors.generation AND s.state='ready')`).bind(env.ALLOWED_SENDER)
  ]);
 }catch{console.warn(JSON.stringify({event:'rag_broad_cleanup',state:'failed'}));}
 try{
  const expired=(await env.DB.prepare(`SELECT s.file_id,s.version FROM rag_sources s LEFT JOIN file_catalog c ON c.owner=s.owner AND c.dataset=s.dataset AND c.file_id=s.file_id WHERE s.owner=? AND s.dataset=? AND s.state='ready' AND (c.file_id IS NULL OR (c.message_id LIKE 'call-summary:%' AND NOT EXISTS(SELECT 1 FROM call_summaries cs WHERE cs.file_id=c.file_id AND cs.owner=c.owner AND cs.expires_at>?))) LIMIT 4`).bind(env.ALLOWED_SENDER,dataset(env),now).all()).results;
  for(const s of expired)await deleteEvidenceSource(env,env.ALLOWED_SENDER,{fileId:s.file_id,expectedVersion:s.version});
 }catch{console.warn(JSON.stringify({event:'rag_source_cleanup',state:'failed'}));}
}
export async function runRagMaintenance(env){
 env={...env,RAG_REQUEST_KIND:'background'};
 if(env.RAG_ENABLED!=='true')return;
 if(env.RAG_PDF_BATCHES_ENABLED==='true'){
  try{await maintainFastPdfs(env);}catch{console.warn(JSON.stringify({event:'pdf_fast_maintenance',state:'failed'}));}
  // Two small, sequential steps per tick; preserve each lease/cursor and stop on deferral.
  const pdfUntil=Date.now()+20000;
  try{for(let step=0;step<2&&Date.now()<pdfUntil;step++){if(!await runPagedPdfStep(env))break;}}catch{console.warn(JSON.stringify({event:'pdf_page_maintenance',state:'failed'}));}
  try{await runPagedSummaryStep(env);}catch{console.warn(JSON.stringify({event:'pdf_summary_maintenance',state:'failed'}));}
 }
 try{await runPdfBackfill(env);}catch{console.warn(JSON.stringify({event:'rag_maintenance',step:'pdf',state:'failed'}));}
 if(['source_preview','passage_search','single_answer'].includes(env.RAG_REBUILD_STAGE)){
  if(env.RAG_REBUILD_STAGE==='single_answer'&&env.RAG_SEMANTIC_ENABLED==='true'&&env.RAG_PDF_INDEXING_ENABLED==='true'){
   try{const result=await runEvidenceIngest(env,env.ALLOWED_SENDER,{pdfOnly:true,publishLimit:1,indexLimit:1});console.log(JSON.stringify({event:'rag_rebuild_pdf_index',published:result.published,indexed:result.indexed,failed:result.failed,errors:result.errors.map(e=>({step:e.step,code:typeof e.code==='string'&&/^[a-z_0-9]{1,60}$/.test(e.code)?e.code:'service_error'}))}));}
   catch{console.warn(JSON.stringify({event:'rag_rebuild_pdf_index',state:'failed'}));}
  }
  return;
 }
 try{const result=await runEvidenceIngest(env,env.ALLOWED_SENDER);console.log(JSON.stringify({event:'rag_ingest',published:result.published,indexed:result.indexed,errors:result.errors.map(e=>({step:e.step,code:typeof e.code==='string'&&/^[a-z_]{1,60}$/.test(e.code)?e.code:'service_error'}))}));}catch{console.warn(JSON.stringify({event:'rag_maintenance',step:'ingest',state:'failed'}));}
 await runGraphJob(env);
}
export async function indexSnapshot(request,env){
 // The legacy native snapshot is primary-only. New owners use scoped Vectorize.
 env=ownerEnv(env,primaryOwner(env));
 if(env.RAG_ENABLED!=='true'||!env.RAG_INDEX_SECRET)return new Response('Unavailable',{status:503});
 const stamp=request.headers.get('X-Bridge-Time')??'',sig=request.headers.get('X-Bridge-Signature')??'';
 if(!/^\d{10}$/.test(stamp)||Math.abs(Date.now()/1000-Number(stamp))>60||!/^[a-f0-9]{64}$/.test(sig))return new Response('Forbidden',{status:403});
 const reader=request.body?.getReader();if(!reader)return new Response('Invalid',{status:400});let bytes=0,parts=[];
 try{while(true){const next=await reader.read();if(next.done)break;bytes+=next.value.length;if(bytes>2048){await reader.cancel();return new Response('Invalid',{status:413});}parts.push(next.value);}}finally{reader.releaseLock();}
 const body=Buffer.concat(parts),expected=createHmac('sha256',env.RAG_INDEX_SECRET).update('whats-rag-index:v1:'+stamp+':').update(body).digest();
 if(!timingSafeEqual(expected,Buffer.from(sig,'hex')))return new Response('Forbidden',{status:403});
 let args;try{args=JSON.parse(body);}catch{return new Response('Invalid',{status:400});}
 if(!args||!['version','snapshot'].includes(args.action)||Object.keys(args).some(k=>!['action','after'].includes(k))||args.after!==undefined&&(typeof args.after!=='string'||!/^[a-f0-9]{64}$/.test(args.after)))return new Response('Invalid',{status:400});
 const revision=await env.DB.prepare('SELECT revision FROM rag_revision WHERE id=1').first('revision');
 if(args.action==='version')return Response.json({revision,dimensions:1024});
 const rows=(await env.DB.prepare(`SELECT v.passage_id AS id,v.vector_json FROM rag_vectors v JOIN rag_sources s ON s.owner=v.owner AND s.dataset=v.dataset AND s.file_id=v.file_id AND s.generation=v.generation AND s.state='ready' JOIN file_catalog c ON c.owner=s.owner AND c.dataset=s.dataset AND c.file_id=s.file_id
 WHERE v.owner=? AND v.dataset=? AND v.passage_id>? AND (c.message_id NOT LIKE 'call-summary:%' OR EXISTS(SELECT 1 FROM call_summaries cs WHERE cs.file_id=c.file_id AND cs.owner=c.owner AND cs.expires_at>?)) ORDER BY v.passage_id LIMIT 128`).bind(env.ALLOWED_SENDER,dataset(env),args.after??'',Date.now()).all()).results;
 return Response.json({revision,dimensions:1024,rows:rows.map(r=>({id:r.id,vector:JSON.parse(r.vector_json)})),next:rows.length===128?rows.at(-1).id:null});
}
