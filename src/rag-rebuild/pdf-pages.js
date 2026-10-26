import {checkOwner,dataset,hash,ownerKey,ToolError} from '../search.js';
import {nativePdfRequest} from './native.js';
import {passages,embed} from '../rag-v1/core.js';
import {evidenceNamespace,evidenceQuery} from '../rag-v1/evidence.js';
import {answerFromPassages} from './answer.js';
import {pagedSourceCurrent} from './page-source.js';
import {pagedSummary} from './pdf-summary.js';
import {modelFailure} from '../chat-recovery-v1/models.js';
import {STRUCTURE_PAGE_LIMIT,STRUCTURE_TEXT_LIMIT,REPHRASE_PASSAGE_LIMIT,REPHRASE_TEXT_LIMIT} from './context.js';
const key=(env,owner,id)=>[owner,dataset(env),id];
const vectorId=(env,owner,id,generation,position)=>hash(JSON.stringify(['pdf-pages-v1',owner,dataset(env),id,generation,position]));
const fence=(env,j,token)=>env.DB.prepare(`INSERT INTO rag_guards(nonce,valid) SELECT ?,0 WHERE NOT EXISTS(SELECT 1 FROM rag_pdf_jobs j JOIN file_catalog c ON c.owner=j.owner AND c.dataset=j.dataset AND c.file_id=j.file_id WHERE j.owner=? AND j.dataset=? AND j.file_id=? AND j.generation=? AND j.lease_token=? AND j.lease_until>? AND c.sha256=j.source_hash)`).bind(crypto.randomUUID(),j.owner,j.dataset,j.file_id,j.generation,token,Date.now());
export async function runPagedPdfStep(env){
 if(env.RAG_PDF_BATCHES_ENABLED!=='true')return;
 const ds=dataset(env),now=Date.now();
 await env.DB.prepare("UPDATE rag_pdf_jobs SET state='failed',error_code='attempts_exhausted',lease_token=NULL,lease_until=0 WHERE owner=? AND dataset=? AND state IN ('extracting','indexing') AND attempts>=3 AND lease_until<?").bind(env.ALLOWED_SENDER,ds,now).run();
 await env.DB.prepare(`INSERT OR IGNORE INTO rag_pdf_jobs(owner,dataset,file_id,source_hash,generation,state,updated_at)
 SELECT owner,dataset,file_id,sha256,lower(hex(randomblob(32))),'extracting',? FROM file_catalog WHERE owner=? AND dataset=? AND extraction_method='pdf_text:paged' AND reason='pdf_page_batches_pending' AND byte_size<=52428800`).bind(now,env.ALLOWED_SENDER,ds).run();
 const j=await env.DB.prepare(`SELECT j.*,c.bucket,c.object_key,c.byte_size,c.filename,c.sha256 FROM rag_pdf_jobs j JOIN file_catalog c ON c.owner=j.owner AND c.dataset=j.dataset AND c.file_id=j.file_id AND c.sha256=j.source_hash WHERE j.owner=? AND j.dataset=? AND j.state IN ('extracting','indexing') AND j.attempts<3 AND j.next_attempt_at<=? AND j.lease_until<? AND (j.page_cursor>0 OR ?<>'true') AND NOT EXISTS(SELECT 1 FROM rag_pdf_fast_jobs f WHERE f.owner=j.owner AND f.dataset=j.dataset AND f.file_id=j.file_id AND f.generation=j.generation) ORDER BY j.updated_at,j.file_id LIMIT 1`).bind(env.ALLOWED_SENDER,ds,now,now,env.RAG_PDF_FAST_ENABLED??'false').first();
 if(!j)return;
 const token=crypto.randomUUID();
 const claim=await env.DB.prepare('UPDATE rag_pdf_jobs SET lease_token=?,lease_until=?,attempts=attempts+1 WHERE owner=? AND dataset=? AND file_id=? AND generation=? AND lease_until<? AND attempts<3 AND state=? AND page_cursor=? AND embedding_cursor=?').bind(token,now+90000,...key(env,j.owner,j.file_id),j.generation,now,j.state,j.page_cursor,j.embedding_cursor).run();
 if(claim.meta.changes!==1)return;
 try{
  if(j.state==='extracting'){
   let batch;
   try{batch=await nativePdfRequest(env,'/pdf-batch',{sourceHash:j.source_hash,startPage:j.page_cursor});}
   catch(error){if(error.code!=='rag_pdf_tools_http_410')throw error;await nativePdfRequest(env,'/pdf-upload',null,{file:j,timeout:45000});batch=await nativePdfRequest(env,'/pdf-batch',{sourceHash:j.source_hash,startPage:j.page_cursor});}
   if(batch.sourceHash!==j.source_hash||!Number.isSafeInteger(batch.totalPages)||batch.totalPages<1||batch.totalPages>2048||j.total_pages&&batch.totalPages!==j.total_pages||!Array.isArray(batch.pages)||batch.pages.length<1||batch.pages.length>8||batch.nextPage!==j.page_cursor+batch.pages.length||batch.nextPage>batch.totalPages)throw new ToolError('rag_pdf_output');
   const pages=[],chunks=[];let chars=0;
   for(let i=0;i<batch.pages.length;i++){
    const p=batch.pages[i];
    if(p.page!==j.page_cursor+i+1||typeof p.text!=='string'||p.text.length>60000||!Number.isSafeInteger(p.tokens)||p.tokens<1||typeof p.readable!=='boolean')throw new ToolError('rag_pdf_output');
    chars+=p.text.length;pages.push({...p,textHash:hash(p.text)});
    if(p.readable)for(const c of passages(p.text))chunks.push({...c,position:j.chunk_count+chunks.length,page:p.page});
   }
   if(chars>60000)throw new ToolError('rag_pdf_output');
   const finished=batch.nextPage===batch.totalPages;
   await env.DB.batch([fence(env,j,token),
    env.DB.prepare(`INSERT INTO rag_pdf_pages(owner,dataset,file_id,generation,page,text,text_hash,tokens,readable) SELECT ?,?,?,?,json_extract(value,'$.page'),json_extract(value,'$.text'),json_extract(value,'$.textHash'),json_extract(value,'$.tokens'),json_extract(value,'$.readable') FROM json_each(?)`).bind(...key(env,j.owner,j.file_id),j.generation,JSON.stringify(pages)),
    env.DB.prepare(`INSERT INTO rag_pdf_chunks(owner,dataset,file_id,generation,position,page,char_start,char_end,content) SELECT ?,?,?,?,json_extract(value,'$.position'),json_extract(value,'$.page'),json_extract(value,'$.start'),json_extract(value,'$.end'),json_extract(value,'$.content') FROM json_each(?)`).bind(...key(env,j.owner,j.file_id),j.generation,JSON.stringify(chunks)),
    env.DB.prepare('INSERT INTO rag_pdf_fts(rowid,content) SELECT rowid,content FROM rag_pdf_chunks WHERE owner=? AND dataset=? AND file_id=? AND generation=? AND position>=?').bind(...key(env,j.owner,j.file_id),j.generation,j.chunk_count),
    env.DB.prepare(`UPDATE rag_pdf_jobs SET page_cursor=?,total_pages=?,chunk_count=chunk_count+?,text_chars=text_chars+?,state=?,attempts=0,lease_token=NULL,lease_until=0,error_code=NULL,updated_at=? WHERE owner=? AND dataset=? AND file_id=? AND lease_token=?`).bind(batch.nextPage,batch.totalPages,chunks.length,chars,finished?'indexing':'extracting',Date.now(),...key(env,j.owner,j.file_id),token),
    ...(finished?[env.DB.prepare("UPDATE file_catalog SET extraction_status='ready',reason='pdf_text_layer_only',updated_at=? WHERE owner=? AND dataset=? AND file_id=? AND sha256=?").bind(new Date().toISOString(),...key(env,j.owner,j.file_id),j.source_hash)]:[])
   ]);
   console.log(JSON.stringify({event:'pdf_page_batch',pages:batch.pages.length,processed:batch.nextPage,total:batch.totalPages}));
  }else{
   let rows=(await env.DB.prepare('SELECT * FROM rag_pdf_chunks WHERE owner=? AND dataset=? AND file_id=? AND generation=? AND position>=? ORDER BY position LIMIT 32').bind(...key(env,j.owner,j.file_id),j.generation,j.embedding_cursor).all()).results;
   while(rows.length>1&&Buffer.byteLength(JSON.stringify({text:rows.map(r=>'Page '+r.page+'\n'+r.content)}))>50000)rows=rows.slice(0,-1);
   if(rows.length){
    const vectors=await embed({...env,RAG_REQUEST_KIND:'background'},rows.map(r=>'Page '+r.page+'\n'+r.content));
    await env.RAG_VECTORS.upsert(rows.map((r,i)=>({id:vectorId(env,j.owner,j.file_id,j.generation,r.position),values:vectors[i],namespace:evidenceNamespace(env,j.owner),metadata:{owner:ownerKey(j.owner),dataset:hash(ds),file_id:j.file_id,generation:j.generation,position:r.position,pdf_lane:'pages_v1'}})));
   }
   const cursor=j.embedding_cursor+rows.length;
   await env.DB.batch([fence(env,j,token),env.DB.prepare("UPDATE rag_pdf_jobs SET embedding_cursor=?,state=?,attempts=0,lease_token=NULL,lease_until=0,error_code=NULL,updated_at=? WHERE owner=? AND dataset=? AND file_id=? AND lease_token=? AND embedding_cursor=?").bind(cursor,cursor>=j.chunk_count?'ready':'indexing',Date.now(),...key(env,j.owner,j.file_id),token,j.embedding_cursor)]);
   console.log(JSON.stringify({event:'pdf_page_vectors',indexed:cursor,total:j.chunk_count}));
  }
  return true; // Continue only after a successful, fenced checkpoint.
 }catch(error){
  const reason=modelFailure(error).reason,dayLimit=['rag_background_budget','rag_daily_budget'].includes(error?.code)||reason==='quota_exhausted';
  const deferred=dayLimit||error?.code==='rag_pdf_tools_http_429'||reason==='rate_limited';
  const next=dayLimit?(Math.floor(Date.now()/86400000)+1)*86400000:Date.now()+(deferred?300000:60000);
  await env.DB.prepare(`UPDATE rag_pdf_jobs SET state=CASE WHEN attempts>=3 AND ?=0 THEN 'failed' ELSE state END,attempts=CASE WHEN ?=1 THEN max(0,attempts-1) ELSE attempts END,next_attempt_at=?,error_code=?,lease_token=NULL,lease_until=0,updated_at=? WHERE owner=? AND dataset=? AND file_id=? AND lease_token=?`).bind(deferred?1:0,deferred?1:0,next,/^[a-z_0-9]{1,60}$/.test(error?.code??'')?error.code:'pdf_batch_unavailable',Date.now(),...key(env,j.owner,j.file_id),token).run();
  console.warn(JSON.stringify({event:'pdf_page_batch',state:deferred?'deferred':'retry_or_failed',code:error?.code??'service_error'}));
 }
}
async function findPagePassages(env,owner,file,j,query,previous){
 if(previous){
  if(previous.reference?.generation!==j.generation||!Array.isArray(previous.reference?.passages))throw new ToolError('rag_source_changed');
  const wanted=previous.reference.passages;
  const structure=previous.reference.scope==='paged_structure';
  if(wanted.length<1||wanted.length>(structure?STRUCTURE_PAGE_LIMIT:REPHRASE_PASSAGE_LIMIT)||wanted.some(p=>!Number.isInteger(p.page)||!Number.isInteger(p.charStart)||!Number.isInteger(p.charEnd)||p.charEnd<=p.charStart||p.charStart<0||!structure&&p.charEnd-p.charStart>2400)||wanted.reduce((n,p)=>n+p.charEnd-p.charStart,0)>(structure?STRUCTURE_TEXT_LIMIT:REPHRASE_TEXT_LIMIT))throw new ToolError('invalid_request');
  const out=[];
  for(const p of wanted){const page=await env.DB.prepare('SELECT text FROM rag_pdf_pages WHERE owner=? AND dataset=? AND file_id=? AND generation=? AND page=?').bind(...key(env,owner,file.file_id),j.generation,p.page).first();if(!page||p.charEnd>page.text.length)throw new ToolError('rag_source_changed');out.push({position:p.position,page:p.page,start:p.charStart,end:p.charEnd,heading:'Page '+p.page,content:page.text.slice(p.charStart,p.charEnd)});}
  return out;
 }
 let lexical=[];
 if(query.length<=300){try{const match=evidenceQuery(query);if(match)lexical=(await env.DB.prepare(`SELECT c.position,bm25(rag_pdf_fts) AS rank FROM rag_pdf_fts JOIN rag_pdf_chunks c ON c.rowid=rag_pdf_fts.rowid WHERE c.owner=? AND c.dataset=? AND c.file_id=? AND c.generation=? AND rag_pdf_fts.content=c.content AND rag_pdf_fts MATCH ? ORDER BY rank LIMIT 6`).bind(...key(env,owner,file.file_id),j.generation,match).all()).results;}catch{console.warn(JSON.stringify({event:'pdf_page_lexical',state:'unavailable'}));}}
 let semantic=[];
 if(j.embedding_cursor>0){
  const [vector]=await embed({...env,RAG_REQUEST_KIND:'interactive'},[query]);
  const fast=env.RAG_PDF_FAST_ENABLED==='true'?await env.DB.prepare("SELECT state,vectorize_count FROM rag_pdf_fast_jobs WHERE owner=? AND dataset=? AND file_id=? AND generation=? AND state='ready'").bind(...key(env,owner,file.file_id),j.generation).first():null;
  let native=false;
  if(fast){try{const found=await nativePdfRequest(env,'/pdf-fast-search',{fileId:file.file_id,generation:j.generation,sourceHash:j.source_hash,vector},{timeout:3000});if(!Array.isArray(found.matches)||found.matches.length>6||found.matches.some(m=>!Number.isSafeInteger(m.position)||m.position<0||m.position>=j.chunk_count||typeof m.score!=='number'||!Number.isFinite(m.score)))throw new ToolError('fast_search_output');semantic=found.matches.filter(m=>m.score>=0.4);native=true;}catch(error){console.warn(JSON.stringify({event:'pdf_fast_search',state:'fallback'}));if(fast.vectorize_count<j.chunk_count)throw new ToolError('fast_index_unavailable');}}
  if(!native){const matches=await env.RAG_VECTORS.query(vector,{namespace:evidenceNamespace(env,owner),topK:6,returnMetadata:'all',filter:{owner:{$eq:ownerKey(owner)},dataset:{$eq:hash(dataset(env))},file_id:{$eq:file.file_id}}});semantic=(matches.matches??[]).filter(m=>m.score>=0.4&&m.metadata?.pdf_lane==='pages_v1'&&m.metadata.generation===j.generation&&Number.isInteger(m.metadata.position)&&m.metadata.position<j.embedding_cursor&&m.id===vectorId(env,owner,file.file_id,j.generation,m.metadata.position)).map(m=>m.metadata);}
 }
 const rank=new Map();for(const list of [lexical,semantic])list.forEach((p,i)=>rank.set(p.position,(rank.get(p.position)??0)+1/(61+i)));
 const positions=[...rank].sort((a,b)=>b[1]-a[1]).map(x=>x[0]);
 if(!positions.length)return [];
 const rows=(await env.DB.prepare('SELECT c.*,p.text,p.text_hash FROM rag_pdf_chunks c JOIN rag_pdf_pages p ON p.owner=c.owner AND p.dataset=c.dataset AND p.file_id=c.file_id AND p.generation=c.generation AND p.page=c.page WHERE c.owner=? AND c.dataset=? AND c.file_id=? AND c.generation=? AND c.position IN (SELECT value FROM json_each(?)) LIMIT 12').bind(...key(env,owner,file.file_id),j.generation,JSON.stringify(positions)).all()).results;
 const byPosition=new Map(rows.map(r=>[r.position,r])),out=[];let left=2400;
 for(const position of positions){const r=byPosition.get(position);if(!r||r.content.length>left||hash(r.text)!==r.text_hash||r.text.slice(r.char_start,r.char_end)!==r.content)continue;out.push({position,page:r.page,start:r.char_start,end:r.char_end,heading:'Page '+r.page,content:r.content});left-=r.content.length;if(out.length===2)break;}
 return out;
}
export async function readPagedPdf(env,owner,query,file,pdfRequest,previous){
 checkOwner(env,owner);
 const j=await env.DB.prepare('SELECT * FROM rag_pdf_jobs WHERE owner=? AND dataset=? AND file_id=? AND source_hash=?').bind(...key(env,owner,file.file_id),file.sha256).first();
 const source={fileId:file.file_id,dataset:dataset(env)};
 const result=answer=>({state:'source_preview',answer,sources:[],confirmed:false,ragSource:source});
 if(!j)return result('This PDF is queued for page-by-page processing. Please ask again shortly.');
 const fastStatus=env.RAG_PDF_FAST_ENABLED==='true'?await env.DB.prepare('SELECT state FROM rag_pdf_fast_jobs WHERE owner=? AND dataset=? AND file_id=? AND generation=?').bind(...key(env,owner,file.file_id),j.generation).first():null;
 if(fastStatus?.state==='failed')return result('Processing this PDF stopped before completion. Its saved file is still available.');
 if(j.state==='failed')return result('Processing this PDF stopped before completion. Its saved file is still available.');
 let summaryNotice=null;
 if(pdfRequest?.mode==='summary'||pdfRequest?.mode==='rephrase'&&previous?.reference?.scope==='paged_summary'){
  if(pdfRequest.mode==='rephrase')query='Previous summary request (context only): '+String(previous.reference.topic??'').slice(0,1000)+'\n\nCurrent request: '+query;
  const summary=await pagedSummary(env,owner,query,file,j);
  if(!summary.structureFallback)return {...summary,ragSource:summary.ragSource??source};
  summaryNotice=summary.answer;
 }
 if(pdfRequest?.mode==='preview'){const p=await env.DB.prepare('SELECT text FROM rag_pdf_pages WHERE owner=? AND dataset=? AND file_id=? AND generation=? ORDER BY page LIMIT 1').bind(...key(env,owner,file.file_id),j.generation).first();return result(p?file.filename+'\n\n'+p.text.slice(0,1800):'The first pages are still processing.');}
 const rephrase=pdfRequest?.mode==='rephrase';
 const documentStructure=summaryNotice!==null||pdfRequest?.mode==='structure'||rephrase&&previous?.reference?.scope==='paged_structure';
 const structureUnavailable=answer=>result(summaryNotice?summaryNotice+'\n\n'+answer:answer);
 let selected;
 if(documentStructure&&!rephrase){
  // ponytail: opening32pages only; qualify missing outlines instead of guessing or scanning the entire book.
  const rows=(await env.DB.prepare('SELECT page,text,text_hash FROM rag_pdf_pages WHERE owner=? AND dataset=? AND file_id=? AND generation=? AND page<=? ORDER BY page').bind(...key(env,owner,file.file_id),j.generation,STRUCTURE_PAGE_LIMIT).all()).results;
  if(rows.length!==Math.min(STRUCTURE_PAGE_LIMIT,j.total_pages)||rows.some((p,i)=>p.page!==i+1))return structureUnavailable('The opening pages needed to read this PDF’s contents are still processing. Please ask again shortly.');
  if(rows.some(p=>hash(p.text)!==p.text_hash))throw new ToolError('rag_source_changed');
  if(rows.reduce((n,p)=>n+p.text.length,0)>STRUCTURE_TEXT_LIMIT)return structureUnavailable('The opening pages contain too much text to verify this outline in one answer. Please identify its contents pages.');
  selected=rows.filter(p=>p.text.trim()).map(p=>({position:p.page-1,page:p.page,start:0,end:p.text.length,heading:'Page '+p.page,content:p.text}));
 }else selected=await findPagePassages(env,owner,file,j,query,rephrase?previous:null);
 if(!selected.length)return {...result(j.state==='extracting'?'This PDF is still processing ('+j.page_cursor+'/'+j.total_pages+' pages). I could not find that in the pages available so far.':'I could not find a relevant passage in this PDF.'),state:j.state==='ready'?'no_match':'source_preview'};
 const snapshot={...file,generation:j.generation,paged:true};
 if(!await pagedSourceCurrent(env,owner,snapshot,selected))throw new ToolError('rag_source_changed');
 const retrieval={method:rephrase?'paged_previous_source_passages':documentStructure?'paged_opening_structure':'paged_hybrid',scope:documentStructure?'paged_structure':'paged_passages',...(summaryNotice?{summaryFallback:'structure'}:{}),...(rephrase&&previous?.reference?.answer?{subjectContext:'previous_sent_answer'}:{}),passages:selected.map(p=>({position:p.position,page:p.page,charStart:p.start,charEnd:p.end}))};
 let outcome;
 if(pdfRequest?.mode==='passages')outcome={state:'passages',answer:file.filename+'\n\n'+selected.map(p=>p.heading+'\n'+p.content).join('\n\n'),sources:[],confirmed:false};
 else outcome=await answerFromPassages(env,owner,query,snapshot,selected,{documentStructure,previousAnswer:rephrase?previous?.reference?.answer??null:null,previousQuestion:rephrase?previous?.reference?.topic??null:null});
 if(summaryNotice&&outcome.answer)outcome={...outcome,answer:summaryNotice+'\n\n'+outcome.answer};
 return {...outcome,retrieval,ragSource:{...source,...(['answered','passages'].includes(outcome.state)?{generation:j.generation,scope:documentStructure?'paged_structure':'paged_passages',topic:rephrase?previous.reference.topic:query}:{})}};
}
