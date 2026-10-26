import {createHmac,timingSafeEqual} from 'node:crypto';
import {checkOwner,dataset,hash,ownerKey,ToolError} from '../search.js';
import {reserve,MODEL,cache} from '../rag-v1/core.js';
import {evidenceNamespace} from '../rag-v1/evidence.js';
import {nativePdfRequest} from './native.js';
import {notifyDocumentProcessed} from '../media.js';
import {ownerEnv,resolveOwner} from '../owners.js';

const key=(env,id,generation)=>[env.ALLOWED_SENDER,dataset(env),id,generation];
const json=value=>Response.json(value,{headers:{'Cache-Control':'no-store'}});
const validId=value=>typeof value==='string'&&/^[a-f0-9]{16}$/u.test(value);
const validHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
const integer=(n,low,high)=>Number.isSafeInteger(n)&&n>=low&&n<=high;
const diagnosticKind='pdf_publish_failure';
function publicationRetryable(error){
 const text=String(error?.message??'')+' '+String(error?.cause?.message??'');
 if(/40041|too many requests/iu.test(text)||[408,429].includes(error?.status))return true;
 if([400,401,403,404,409,413,422].includes(error?.status))return false;
 if(error instanceof ToolError&&['fast_input','fast_vectors','fast_missing_chunks','fast_auth','fast_plan','rag_source_changed'].includes(error.code))return false;
 // Unknown outages remain pending with capped backoff; they never silently become successful.
 return true;
}
async function publicationDiagnostic(env,a,stage,position,error){
 const clean=value=>{
  let text=String(value??'');
  for(const name of ['RAG_INDEX_SECRET','META_ACCESS_TOKEN','META_APP_SECRET','SUPABASE_KEY']){
   const secret=env[name];if(typeof secret==='string'&&secret.length>=6)text=text.split(secret).join('[redacted]');
  }
  return text.replace(/Bearer\s+[^\s]+/giu,'Bearer [redacted]').replace(/https?:\/\/[^\s]+/giu,'[url]').replace(/[\r\n\t]+/gu,' ').slice(0,1200);
 };
 const describe=e=>({name:clean(e?.name??'Error').slice(0,64),code:clean(e?.code).slice(0,80),message:clean(e?.message??e),httpStatus:integer(e?.status,100,599)?e.status:null});
 const diagnosticKey=hash(JSON.stringify([diagnosticKind,env.ALLOWED_SENDER,dataset(env),a.fileId,a.generation,a.sourceHash,stage,position]));
 const detail={fileId:a.fileId,generation:a.generation,sourceHash:a.sourceHash,stage,position,at:new Date().toISOString(),error:describe(error),cause:error?.cause?describe(error.cause):null};
 await cache(env,env.ALLOWED_SENDER,diagnosticKey,diagnosticKind,detail,86400000);
 console.warn(JSON.stringify({event:'pdf_publication_diagnostic',stage,diagnosticKey}));
 return diagnosticKey;
}
const current=(env,a)=>env.DB.prepare(`SELECT f.*,p.state AS pdf_state,c.filename FROM rag_pdf_fast_jobs f JOIN rag_pdf_jobs p ON p.owner=f.owner AND p.dataset=f.dataset AND p.file_id=f.file_id AND p.generation=f.generation AND p.source_hash=f.source_hash JOIN file_catalog c ON c.owner=p.owner AND c.dataset=p.dataset AND c.file_id=p.file_id AND c.sha256=p.source_hash WHERE f.owner=? AND f.dataset=? AND f.file_id=? AND f.generation=? AND f.source_hash=? AND f.state IN ('running','ready') AND p.state IN ('extracting','indexing','ready')`).bind(...key(env,a.fileId,a.generation),a.sourceHash).first();
const fence=(env,a)=>env.DB.prepare(`INSERT INTO rag_guards(nonce,valid) SELECT ?,0 WHERE NOT EXISTS(SELECT 1 FROM rag_pdf_fast_jobs f JOIN rag_pdf_jobs p ON p.owner=f.owner AND p.dataset=f.dataset AND p.file_id=f.file_id AND p.generation=f.generation AND p.source_hash=f.source_hash JOIN file_catalog c ON c.owner=p.owner AND c.dataset=p.dataset AND c.file_id=p.file_id AND c.sha256=p.source_hash WHERE f.owner=? AND f.dataset=? AND f.file_id=? AND f.generation=? AND f.source_hash=? AND f.state IN ('running','ready') AND p.state IN ('extracting','indexing','ready'))`).bind(crypto.randomUUID(),...key(env,a.fileId,a.generation),a.sourceHash);

export async function startFastPdf(env,fileId){
 if(env.RAG_PDF_FAST_ENABLED!=='true')return;
 checkOwner(env,env.ALLOWED_SENDER);
 const c=await env.DB.prepare("SELECT * FROM file_catalog WHERE owner=? AND dataset=? AND file_id=? AND extraction_method='pdf_text:paged' AND mime_type='application/pdf'").bind(env.ALLOWED_SENDER,dataset(env),fileId).first();
 if(!c)return;
 const now=Date.now();
 await env.DB.prepare(`INSERT OR IGNORE INTO rag_pdf_jobs(owner,dataset,file_id,source_hash,generation,state,lease_token,lease_until,updated_at) VALUES(?,?,?,?,lower(hex(randomblob(32))),'extracting','fast',?,?)`).bind(c.owner,c.dataset,c.file_id,c.sha256,now+180000,now).run();
 const p=await env.DB.prepare('SELECT * FROM rag_pdf_jobs WHERE owner=? AND dataset=? AND file_id=? AND source_hash=?').bind(c.owner,c.dataset,c.file_id,c.sha256).first();
 if(!p||p.state==='failed'||p.state==='ready')return;
 if(p.lease_until>now&&p.lease_token!=='fast')return;
 // Only a new, untouched paged job can enter this lane.
 if(p.page_cursor!==0&&!await env.DB.prepare('SELECT 1 FROM rag_pdf_fast_jobs WHERE owner=? AND dataset=? AND file_id=? AND generation=?').bind(...key(env,fileId,p.generation)).first())return;
 await env.DB.prepare(`INSERT OR IGNORE INTO rag_pdf_fast_jobs(owner,dataset,file_id,generation,source_hash,started_at,updated_at) VALUES(?,?,?,?,?,?,?)`).bind(...key(env,fileId,p.generation),p.source_hash,now,now).run();
 const claimed=await env.DB.prepare("UPDATE rag_pdf_fast_jobs SET state='running',attempts=attempts+1,updated_at=? WHERE owner=? AND dataset=? AND file_id=? AND generation=? AND state='pending' AND attempts<3 AND next_attempt_at<=?").bind(now,...key(env,fileId,p.generation),now).run();
 if(claimed.meta.changes!==1)return;
 await env.DB.prepare("UPDATE rag_pdf_jobs SET lease_token='fast',lease_until=? WHERE owner=? AND dataset=? AND file_id=? AND generation=?").bind(now+180000,...key(env,fileId,p.generation)).run();
 const args={fileId,generation:p.generation,sourceHash:p.source_hash};
 try{
  try{await nativePdfRequest(env,'/pdf-fast-start',args,{timeout:5000});}
  catch(error){if(error.code!=='rag_pdf_tools_http_410')throw error;await nativePdfRequest(env,'/pdf-upload',null,{file:c,timeout:45000});await nativePdfRequest(env,'/pdf-fast-start',args,{timeout:5000});}
 }catch(error){
  const code=/^[a-z_0-9]{1,60}$/u.test(error?.code??'')?error.code:'fast_start_unavailable';
  await env.DB.prepare("UPDATE rag_pdf_fast_jobs SET state=CASE WHEN attempts>=3 THEN 'failed' ELSE 'pending' END,error_code=?,next_attempt_at=?,updated_at=? WHERE owner=? AND dataset=? AND file_id=? AND generation=? AND state='running'").bind(code,Date.now()+60000,Date.now(),...key(env,fileId,p.generation)).run();
  console.warn(JSON.stringify({event:'pdf_fast_start',state:'deferred',code}));
 }
}

export async function maintainFastPdfs(env){
 if(env.RAG_PDF_FAST_ENABLED!=='true')return;
 const untouched=(await env.DB.prepare("SELECT c.file_id FROM file_catalog c LEFT JOIN rag_pdf_jobs p ON p.owner=c.owner AND p.dataset=c.dataset AND p.file_id=c.file_id LEFT JOIN rag_pdf_fast_jobs f ON f.owner=p.owner AND f.dataset=p.dataset AND f.file_id=p.file_id AND f.generation=p.generation WHERE c.owner=? AND c.dataset=? AND c.extraction_method='pdf_text:paged' AND c.index_state='ready' AND f.file_id IS NULL AND (p.file_id IS NULL OR p.state='extracting' AND p.page_cursor=0 AND p.attempts=0 AND p.lease_until<=?) ORDER BY c.created_at LIMIT 1").bind(env.ALLOWED_SENDER,dataset(env),Date.now()).all()).results;
 for(const row of untouched)await startFastPdf(env,row.file_id);
 // A running native task has its own hard deadline. Lost tasks stop after three attempts.
 await env.DB.prepare("UPDATE rag_pdf_fast_jobs SET state=CASE WHEN attempts>=3 THEN 'failed' ELSE 'pending' END,error_code='fast_task_interrupted',updated_at=? WHERE owner=? AND dataset=? AND state='running' AND updated_at<?").bind(Date.now(),env.ALLOWED_SENDER,dataset(env),Date.now()-180000).run();
 const rows=(await env.DB.prepare("SELECT file_id FROM rag_pdf_fast_jobs WHERE owner=? AND dataset=? AND state='pending' AND next_attempt_at<=? ORDER BY started_at LIMIT 1").bind(env.ALLOWED_SENDER,dataset(env),Date.now()).all()).results;
 for(const row of rows)await startFastPdf(env,row.file_id);
 if(env.RAG_PDF_PUBLICATION_RESUME_ENABLED!=='true')return;
 await env.DB.prepare("UPDATE rag_pdf_fast_jobs SET error_code=NULL,next_attempt_at=0 WHERE owner=? AND dataset=? AND state='ready' AND vectorize_count=total_chunks AND error_code IN ('vectorize_publication_failed','vectorize_publication_pending')").bind(env.ALLOWED_SENDER,dataset(env)).run();
 const copies=(await env.DB.prepare("SELECT f.file_id,f.generation,f.source_hash FROM rag_pdf_fast_jobs f JOIN file_catalog c ON c.owner=f.owner AND c.dataset=f.dataset AND c.file_id=f.file_id AND c.sha256=f.source_hash JOIN rag_pdf_jobs p ON p.owner=f.owner AND p.dataset=f.dataset AND p.file_id=f.file_id AND p.generation=f.generation AND p.source_hash=f.source_hash AND p.state='ready' WHERE f.owner=? AND f.dataset=? AND f.state='ready' AND f.vectorize_count<f.total_chunks AND coalesce(f.error_code,'')<>'vectorize_publication_blocked' AND f.next_attempt_at<=? ORDER BY f.next_attempt_at,f.started_at LIMIT 1").bind(env.ALLOWED_SENDER,dataset(env),Date.now()).all()).results;
 for(const row of copies){
  const claimed=await env.DB.prepare("UPDATE rag_pdf_fast_jobs SET attempts=attempts+1,next_attempt_at=? WHERE owner=? AND dataset=? AND file_id=? AND generation=? AND source_hash=? AND state='ready' AND vectorize_count<total_chunks AND coalesce(error_code,'')<>'vectorize_publication_blocked' AND next_attempt_at<=?").bind(Date.now()+180000,...key(env,row.file_id,row.generation),row.source_hash,Date.now()).run();
  if(claimed.meta.changes!==1)continue;
  try{await nativePdfRequest(env,'/pdf-fast-start',{fileId:row.file_id,generation:row.generation,sourceHash:row.source_hash,publicationOnly:true},{timeout:5000});}
  catch(error){
   await publicationDiagnostic(env,{fileId:row.file_id,generation:row.generation,sourceHash:row.source_hash},'publication_start',-1,error);
   const blocked=/^rag_pdf_tools_http_(400|401|403|404|409|413|422)$/u.test(error?.code??'');
   await env.DB.prepare("UPDATE rag_pdf_fast_jobs SET error_code=? WHERE owner=? AND dataset=? AND file_id=? AND generation=? AND source_hash=? AND state='ready'").bind(blocked?'vectorize_publication_blocked':'vectorize_publication_pending',...key(env,row.file_id,row.generation),row.source_hash).run();
   // An ambiguous start retains the lease: do not overlap a native task that may be running.
  }
 }
}

async function bodyAndAuth(request,env){
 const stamp=request.headers.get('X-Bridge-Time')??'',sig=request.headers.get('X-Bridge-Signature')??'';
 if(!/^\d{10}$/u.test(stamp)||Math.abs(Date.now()/1000-Number(stamp))>90||!validHash(sig)||!env.RAG_INDEX_SECRET)throw new ToolError('fast_auth');
 const reader=request.body?.getReader();if(!reader)throw new ToolError('fast_input');let size=0;const parts=[];
 try{for(;;){const n=await reader.read();if(n.done)break;size+=n.value.length;if(size>2*1024*1024){await reader.cancel();throw new ToolError('fast_input');}parts.push(n.value);}}finally{reader.releaseLock();}
 const bytes=Buffer.concat(parts),digest=hash(bytes),expected=createHmac('sha256',env.RAG_INDEX_SECRET).update('whats-pdf-fast:v1:'+stamp+':'+digest).digest();
 if(!timingSafeEqual(expected,Buffer.from(sig,'hex')))throw new ToolError('fast_auth');
 const a=JSON.parse(bytes.toString('utf8'));
 if(!validId(a.fileId)||!validHash(a.generation)||!validHash(a.sourceHash))throw new ToolError('fast_input');
 return a;
}

export async function handleFastPdf(request,env,ctx){
 if(env.RAG_PDF_FAST_ENABLED!=='true'||request.method!=='POST')return json({error:'unavailable'});
 let publication=null;
 try{
  const a=await bodyAndAuth(request,env);
  // file_id is globally unique and owner-derived; this lookup starts at its catalog key.
  const job=await env.DB.prepare(`SELECT f.*,p.state AS pdf_state,c.filename FROM file_catalog c
   JOIN rag_pdf_fast_jobs f ON f.owner=c.owner AND f.dataset=c.dataset AND f.file_id=c.file_id AND f.source_hash=c.sha256
   JOIN rag_pdf_jobs p ON p.owner=f.owner AND p.dataset=f.dataset AND p.file_id=f.file_id AND p.generation=f.generation AND p.source_hash=f.source_hash
   WHERE c.file_id=? AND c.sha256=? AND f.generation=? AND f.source_hash=? AND f.state IN ('running','ready') AND p.state IN ('extracting','indexing','ready')`).bind(a.fileId,a.sourceHash,a.generation,a.sourceHash).first();
  if(!job||!resolveOwner(env,job.owner))return Response.json({error:'source_changed'},{status:409});
  env=ownerEnv(env,job.owner);
  const k=key(env,a.fileId,a.generation),now=Date.now();
  if(a.action==='manifest'){
   if(!integer(a.totalPages,1,2048)||!integer(a.totalChunks,0,16384))throw new ToolError('fast_input');
   if(job.total_pages&&job.total_pages!==a.totalPages||job.total_chunks&&job.total_chunks!==a.totalChunks)throw new ToolError('fast_manifest');
   await env.DB.batch([fence(env,a),env.DB.prepare('UPDATE rag_pdf_fast_jobs SET total_pages=?,total_chunks=?,updated_at=? WHERE owner=? AND dataset=? AND file_id=? AND generation=?').bind(a.totalPages,a.totalChunks,now,...k),env.DB.prepare('UPDATE rag_pdf_jobs SET total_pages=?,updated_at=? WHERE owner=? AND dataset=? AND file_id=? AND generation=?').bind(a.totalPages,now,...k)]);
   return json({ok:true});
  }
  if(a.action==='pages'){
   if(!Array.isArray(a.pages)||!a.pages.length||a.pages.length>16||!integer(a.chunkFirst,0,16384))throw new ToolError('fast_input');
   let chars=0;const pages=[],chunks=[];
   for(let i=0;i<a.pages.length;i++){
    const p=a.pages[i];if(!integer(p.page,1,job.total_pages)||i&&p.page!==a.pages[i-1].page+1||typeof p.text!=='string'||p.text.length>60000||typeof p.readable!=='boolean'||!Array.isArray(p.spans))throw new ToolError('fast_pages');
    chars+=p.text.length;let end=0;
    for(const s of p.spans){if(!integer(s.start,end,p.text.length)||p.text.slice(end,s.start).trim()||!integer(s.end,s.start+1,p.text.length)||s.end-s.start>1500||s.end<p.text.length&&/[\uD800-\uDBFF]/u.test(p.text[s.end-1])||!p.text.slice(s.start,s.end).trim())throw new ToolError('fast_spans');chunks.push({position:a.chunkFirst+chunks.length,page:p.page,charStart:s.start,charEnd:s.end,content:p.text.slice(s.start,s.end)});end=s.end;}
    if(p.readable&&p.text.slice(end).trim()||!p.readable&&p.spans.length)throw new ToolError('fast_spans');
    pages.push({page:p.page,text:p.text,textHash:hash(p.text),tokens:Buffer.byteLength(p.text)+128,readable:p.readable?1:0});
   }
   if(chars>120000||a.chunkFirst+chunks.length>job.total_chunks)throw new ToolError('fast_input');
   const fingerprint=hash(JSON.stringify({pages,chunks})),position=pages[0].page;
   const prior=await env.DB.prepare("SELECT fingerprint FROM rag_pdf_fast_parts WHERE owner=? AND dataset=? AND file_id=? AND generation=? AND kind='pages' AND position=?").bind(...k,position).first();
   if(prior){if(prior.fingerprint!==fingerprint)throw new ToolError('fast_replay');return json({ok:true});}
   await env.DB.batch([fence(env,a),
    env.DB.prepare("INSERT INTO rag_pdf_fast_parts(owner,dataset,file_id,generation,kind,position,count,fingerprint,state,updated_at) VALUES(?,?,?,?,'pages',?,?,?,'ready',?)").bind(...k,position,pages.length,fingerprint,now),
    env.DB.prepare(`INSERT INTO rag_pdf_pages(owner,dataset,file_id,generation,page,text,text_hash,tokens,readable) SELECT ?,?,?,?,json_extract(value,'$.page'),json_extract(value,'$.text'),json_extract(value,'$.textHash'),json_extract(value,'$.tokens'),json_extract(value,'$.readable') FROM json_each(?)`).bind(...k,JSON.stringify(pages)),
    env.DB.prepare(`INSERT INTO rag_pdf_chunks(owner,dataset,file_id,generation,position,page,char_start,char_end,content) SELECT ?,?,?,?,json_extract(value,'$.position'),json_extract(value,'$.page'),json_extract(value,'$.charStart'),json_extract(value,'$.charEnd'),json_extract(value,'$.content') FROM json_each(?)`).bind(...k,JSON.stringify(chunks)),
    env.DB.prepare('INSERT INTO rag_pdf_fts(rowid,content) SELECT rowid,content FROM rag_pdf_chunks WHERE owner=? AND dataset=? AND file_id=? AND generation=? AND position>=? AND position<?').bind(...k,a.chunkFirst,a.chunkFirst+chunks.length),
    env.DB.prepare('UPDATE rag_pdf_jobs SET page_cursor=page_cursor+?,chunk_count=chunk_count+?,text_chars=text_chars+?,updated_at=? WHERE owner=? AND dataset=? AND file_id=? AND generation=?').bind(pages.length,chunks.length,chars,now,...k),
    env.DB.prepare('UPDATE rag_pdf_fast_jobs SET updated_at=? WHERE owner=? AND dataset=? AND file_id=? AND generation=?').bind(now,...k)
   ]);
   return json({ok:true});
  }
  if(a.action==='embed'){
   if(!integer(a.position,0,job.total_chunks-1)||!integer(a.count,1,100)||a.position+a.count>job.total_chunks)throw new ToolError('fast_input');
   const rows=(await env.DB.prepare('SELECT position,page,content FROM rag_pdf_chunks WHERE owner=? AND dataset=? AND file_id=? AND generation=? AND position>=? AND position<? ORDER BY position').bind(...k,a.position,a.position+a.count).all()).results;
   if(rows.length!==a.count||rows.some((r,i)=>r.position!==a.position+i))throw new ToolError('fast_missing_chunks');
   const text=rows.map(r=>'Page '+r.page+'\n'+r.content);if(Buffer.byteLength(JSON.stringify(text))>512000)throw new ToolError('fast_input');
   await reserve({...env,RAG_REQUEST_KIND:'background'});
   // Stream provider output to the trusted native validator; do not parse thousands of floats in the free Worker.
   const raw=await (env.CHAT_AI_BINDING??env.AI).run(MODEL,{text},{returnRawResponse:true,signal:AbortSignal.timeout(30000)});
   if(!await current(env,a)){await raw?.body?.cancel();throw new ToolError('rag_source_changed');}
   if(typeof raw?.status!=='number')return json(raw); // Match the existing AI binding fallback; native still validates every float.
   return new Response(raw.body,{status:raw.status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
  }
  if(a.action==='ready'){
   if(!integer(a.readyMs,0,180000)||!integer(a.extractMs,0,120000)||!validHash(a.indexHash))throw new ToolError('fast_input');
   const counts=await env.DB.prepare('SELECT (SELECT count(*) FROM rag_pdf_pages WHERE owner=? AND dataset=? AND file_id=? AND generation=?) AS pages,(SELECT count(*) FROM rag_pdf_chunks WHERE owner=? AND dataset=? AND file_id=? AND generation=?) AS chunks,(SELECT min(position) FROM rag_pdf_chunks WHERE owner=? AND dataset=? AND file_id=? AND generation=?) AS first,(SELECT max(position) FROM rag_pdf_chunks WHERE owner=? AND dataset=? AND file_id=? AND generation=?) AS last').bind(...k,...k,...k,...k).first();
   if(counts.pages!==job.total_pages||counts.chunks!==job.total_chunks||counts.chunks&&(counts.first!==0||counts.last!==counts.chunks-1))throw new ToolError('fast_incomplete');
   if(job.state==='ready'){ctx.waitUntil(notifyDocumentProcessed(env,a.fileId));return json({ok:true,workerReadyMs:job.finished_at-job.started_at});}
   await env.DB.batch([fence(env,a),env.DB.prepare("UPDATE rag_pdf_fast_jobs SET state='ready',finished_at=?,ready_ms=?,extract_ms=?,error_code=NULL,next_attempt_at=?,updated_at=? WHERE owner=? AND dataset=? AND file_id=? AND generation=?").bind(now,a.readyMs,a.extractMs,now+180000,now,...k),env.DB.prepare("UPDATE rag_pdf_jobs SET state='ready',embedding_cursor=chunk_count,attempts=0,error_code=NULL,lease_token=NULL,lease_until=0,updated_at=? WHERE owner=? AND dataset=? AND file_id=? AND generation=?").bind(now,...k),env.DB.prepare("UPDATE file_catalog SET extraction_status='ready',reason='pdf_fast_text_layer_only',updated_at=? WHERE owner=? AND dataset=? AND file_id=? AND sha256=?").bind(new Date().toISOString(),env.ALLOWED_SENDER,dataset(env),a.fileId,a.sourceHash)]);
   const committedAt=Date.now();
   await env.DB.prepare('UPDATE rag_pdf_fast_jobs SET finished_at=? WHERE owner=? AND dataset=? AND file_id=? AND generation=? AND finished_at=?').bind(committedAt,...k,now).run();
   console.log(JSON.stringify({event:'pdf_fast_ready',pages:counts.pages,passages:counts.chunks,nativeReadyMs:a.readyMs,workerReadyMs:committedAt-job.started_at,underTenSeconds:committedAt-job.started_at<10000}));
   ctx.waitUntil(notifyDocumentProcessed(env,a.fileId));
   return json({ok:true,workerReadyMs:committedAt-job.started_at});
  }
  if(a.action==='publication_plan'){
   if(job.state!=='ready'||job.error_code==='vectorize_publication_blocked')throw new ToolError('fast_plan');
   const parts=(await env.DB.prepare("SELECT position,count FROM rag_pdf_fast_parts WHERE owner=? AND dataset=? AND file_id=? AND generation=? AND kind='vectors' AND state='submitted'").bind(...k).all()).results;
   if(parts.some(p=>!integer(p.position,0,job.total_chunks-1)||p.position%16!==0||p.count!==Math.min(16,job.total_chunks-p.position)))throw new ToolError('fast_plan');
   const done=new Set(parts.map(p=>p.position));
   return json({positions:Array.from({length:Math.ceil(job.total_chunks/16)},(_,i)=>i*16).filter(p=>!done.has(p))});
  }
  if(a.action==='publication_complete'){
   if(job.vectorize_count!==job.total_chunks)throw new ToolError('fast_incomplete');
   await env.DB.batch([fence(env,a),env.DB.prepare("UPDATE rag_pdf_fast_jobs SET error_code=NULL,next_attempt_at=0,updated_at=? WHERE owner=? AND dataset=? AND file_id=? AND generation=? AND vectorize_count=total_chunks").bind(now,...k)]);
   return json({ok:true,state:'submitted'});
  }
  if(a.action==='publish'){
   publication={a,stage:'validate_vectors',position:Number.isSafeInteger(a.position)?a.position:-1};
   if(!integer(a.position,0,job.total_chunks-1)||!Array.isArray(a.vectors)||!a.vectors.length||a.vectors.length>16||a.position+a.vectors.length>job.total_chunks||a.vectors.some(v=>!Array.isArray(v)||v.length!==1024||v.some(n=>typeof n!=='number'||!Number.isFinite(n))))throw new ToolError('fast_vectors');
   publication.stage='read_chunks';
   const rows=(await env.DB.prepare('SELECT position FROM rag_pdf_chunks WHERE owner=? AND dataset=? AND file_id=? AND generation=? AND position>=? AND position<? ORDER BY position').bind(...k,a.position,a.position+a.vectors.length).all()).results;
   if(rows.length!==a.vectors.length)throw new ToolError('fast_missing_chunks');
   publication.stage='read_checkpoint';
   const prior=await env.DB.prepare("SELECT 1 FROM rag_pdf_fast_parts WHERE owner=? AND dataset=? AND file_id=? AND generation=? AND kind='vectors' AND position=?").bind(...k,a.position).first();if(prior)return json({ok:true});
   publication.stage='vectorize_upsert';
   await env.RAG_VECTORS.upsert(a.vectors.map((values,i)=>({id:hash(JSON.stringify(['pdf-pages-v1',env.ALLOWED_SENDER,dataset(env),a.fileId,a.generation,a.position+i])),values,namespace:evidenceNamespace(env,env.ALLOWED_SENDER),metadata:{owner:ownerKey(env.ALLOWED_SENDER),dataset:hash(dataset(env)),file_id:a.fileId,generation:a.generation,position:a.position+i,pdf_lane:'pages_v1'}})));
   publication.stage='write_checkpoint';
   await env.DB.batch([fence(env,a),env.DB.prepare("INSERT OR IGNORE INTO rag_pdf_fast_parts(owner,dataset,file_id,generation,kind,position,count,fingerprint,state,updated_at) VALUES(?,?,?,?,'vectors',?,?,'','submitted',?)").bind(...k,a.position,a.vectors.length,now),env.DB.prepare("UPDATE rag_pdf_fast_jobs SET vectorize_count=(SELECT coalesce(sum(count),0) FROM rag_pdf_fast_parts WHERE owner=? AND dataset=? AND file_id=? AND generation=? AND kind='vectors'),updated_at=? WHERE owner=? AND dataset=? AND file_id=? AND generation=?").bind(...k,now,...k)]);
   return json({ok:true});
  }
  if(a.action==='publication_failed'){
   if(a.failure&&typeof a.failure==='object'&&!Array.isArray(a.failure)){
    const f=a.failure,error={name:typeof f.name==='string'?f.name.slice(0,64):'NativePublicationError',code:typeof f.code==='string'?f.code.slice(0,80):'',message:typeof f.message==='string'?f.message.slice(0,240):'Native publication failed',status:f.httpStatus};
    await publicationDiagnostic(env,a,'native_publish',-1,error);
   }
   const blocked=a.failure?.retryable===false;
   const delay=Math.min(900000,5000*2**Math.min(8,Math.max(0,job.attempts-1)));
   await env.DB.batch([fence(env,a),env.DB.prepare("UPDATE rag_pdf_fast_jobs SET error_code=?,next_attempt_at=?,updated_at=? WHERE owner=? AND dataset=? AND file_id=? AND generation=? AND state='ready'").bind(blocked?'vectorize_publication_blocked':'vectorize_publication_pending',now+delay,now,...k)]);return json({ok:true});
  }
  if(a.action==='failed'){
   if(!/^[a-z_0-9]{1,60}$/u.test(a.code??''))throw new ToolError('fast_input');
   if(job.state==='ready'){
    await publicationDiagnostic(env,a,'native_resume',-1,{name:'NativeResumeError',code:a.code,message:a.code});
    await env.DB.prepare('UPDATE rag_pdf_fast_jobs SET error_code=?,next_attempt_at=?,updated_at=? WHERE owner=? AND dataset=? AND file_id=? AND generation=?').bind(a.retryable===true?'vectorize_publication_pending':'vectorize_publication_blocked',now+Math.min(900000,5000*2**Math.min(8,Math.max(0,job.attempts-1))),now,...k).run();return json({ok:true});
   }
   await env.DB.batch([fence(env,a),env.DB.prepare("UPDATE rag_pdf_fast_jobs SET state='failed',error_code=?,updated_at=? WHERE owner=? AND dataset=? AND file_id=? AND generation=?").bind(a.code,now,...k),env.DB.prepare("UPDATE rag_pdf_jobs SET state='failed',error_code=?,lease_token=NULL,lease_until=0,updated_at=? WHERE owner=? AND dataset=? AND file_id=? AND generation=?").bind(a.code,now,...k)]);ctx.waitUntil(notifyDocumentProcessed(env,a.fileId));return json({ok:true});
  }
  throw new ToolError('fast_input');
 }catch(error){
  const code=/^[a-z_0-9]{1,60}$/u.test(error?.code??'')?error.code:'fast_unavailable';
  let diagnosticKey;
  if(publication){try{diagnosticKey=await publicationDiagnostic(env,publication.a,publication.stage,publication.position,error);}catch{console.warn(JSON.stringify({event:'pdf_publication_diagnostic',state:'storage_unavailable'}));}}
  console.warn(JSON.stringify({event:'pdf_fast_callback',state:'failed',code}));
  const retryable=publication?publicationRetryable(error):undefined;
  const throttled=publication&&/40041|too many requests/iu.test(String(error?.message??''));
  return Response.json({error:code,...(publication?{retryable}:{}),...(diagnosticKey?{diagnosticKey,stage:publication.stage}:{})},{status:code==='fast_auth'?403:throttled?429:retryable===false?422:503});
 }
}
