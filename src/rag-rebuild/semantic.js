import {checkOwner,dataset,hash,ownerKey,ToolError} from '../search.js';
import {embed} from '../rag-v1/core.js';
import {evidenceFingerprint,evidenceNamespace,evidenceQuery} from '../rag-v1/evidence.js';
import {modelFailure} from '../chat-recovery-v1/models.js';

export async function findSemanticPassages(env,owner,file,query){
 checkOwner(env,owner);
 if(typeof query!=='string'||!query.trim()||query.length>2000||!env.RAG_VECTORS)throw new ToolError('rag_semantic_unavailable');
 const stored=await env.DB.prepare(`SELECT c.*,s.state AS source_state,s.fingerprint,s.generation,s.version,s.chunk_count,s.embedding_cursor
  FROM file_catalog c JOIN rag_sources s ON s.owner=c.owner AND s.dataset=c.dataset AND s.file_id=c.file_id
  WHERE c.owner=? AND c.dataset=? AND c.file_id=? AND c.mime_type='application/pdf' LIMIT 1`).bind(owner,dataset(env),file.file_id).first();
 if(!stored||stored.source_state!=='ready'||stored.embedding_cursor!==stored.chunk_count||!stored.chunk_count||stored.extracted_text!==file.preview||stored.filename!==file.filename||evidenceFingerprint(stored)!==stored.fingerprint)throw new ToolError('rag_semantic_not_ready');
 const started=performance.now();
 let match=null,lexicalStatus=env.RAG_HYBRID_ENABLED==='true'?'skipped':'disabled';
 if(env.RAG_HYBRID_ENABLED==='true'&&query.length<=300){try{match=evidenceQuery(query);}catch{ /* Long/complex token sets keep the existing semantic path. */ }}
 if(match)lexicalStatus='queried';
 const [[vector],lexical]=await Promise.all([
  embed({...env,RAG_REQUEST_KIND:'interactive',RAG_DEADLINE:Math.min(env.CHAT_DEADLINE??Infinity,Date.now()+4000)},[query]),
  match?env.DB.prepare(`WITH hits AS MATERIALIZED (
   SELECT p.position,bm25(rag_fts,0.0,0.0,1.0) AS lexical_rank FROM rag_fts JOIN rag_passages p ON p.rowid=rag_fts.rowid
   WHERE p.owner=? AND p.dataset=? AND p.file_id=? AND p.generation=? AND p.version=? AND rag_fts.content=p.content AND rag_fts MATCH ?)
   SELECT position FROM hits WHERE lexical_rank<0 ORDER BY lexical_rank,position LIMIT 6`)
   .bind(owner,dataset(env),file.file_id,stored.generation,stored.version,match).all().then(r=>(r.results??[]).filter(p=>Number.isInteger(p.position)&&p.position>=0&&p.position<stored.chunk_count)).catch(()=>{lexicalStatus='unavailable';console.warn(JSON.stringify({event:'rag_rebuild_lexical',state:'unavailable'}));return [];}):Promise.resolve([])
 ]);
 let timer,matches;
 try{
  const result=await Promise.race([
   env.RAG_VECTORS.query(vector,{namespace:evidenceNamespace(env,owner),topK:6,returnMetadata:'all',filter:{owner:{$eq:ownerKey(owner)},dataset:{$eq:hash(dataset(env))},file_id:{$eq:file.file_id}}}),
   new Promise((_,reject)=>{timer=setTimeout(()=>reject(new ToolError('rag_semantic_timeout')),2000);})
  ]);
  matches=result.matches??[];
 }finally{clearTimeout(timer);}
 // ponytail: provisional cosine floor, then manual quality evaluation; similarity is not proof of an answer.
 const candidates=matches.slice(0,6).filter(m=>Number.isFinite(m.score)&&m.score>=0.4&&m.metadata?.owner===ownerKey(owner)&&m.metadata.dataset===hash(dataset(env))&&m.metadata.file_id===file.file_id&&m.metadata.generation===stored.generation&&m.metadata.version===stored.version&&Number.isInteger(m.metadata.position)&&m.metadata.position>=0&&m.metadata.position<stored.chunk_count&&m.id===hash(JSON.stringify(['rag-v1',owner,dataset(env),file.file_id,stored.generation,m.metadata.position])));
 // Same bounded reciprocal-rank fusion as the existing evidence lane; no learned reranker.
 const scores=new Map();
 for(const [kind,list] of [['lexical',lexical],['semantic',candidates.map(m=>m.metadata)]]){
  [...new Set(list.map(p=>p.position))].forEach((position,index)=>{
   const hit=scores.get(position)??{position,score:0,lexicalRank:null,semanticRank:null};
   hit.score+=1/(60+index+1);hit[kind+'Rank']=index+1;scores.set(position,hit);
  });
 }
 const ranked=[...scores.values()].sort((a,b)=>b.score-a.score||(a.lexicalRank??999)-(b.lexicalRank??999)||a.position-b.position);
 const rows=ranked.length?(await env.DB.prepare('SELECT position,heading,content,char_start,char_end FROM rag_passages WHERE owner=? AND dataset=? AND file_id=? AND generation=? AND version=? AND position IN (SELECT value FROM json_each(?)) LIMIT 12').bind(owner,dataset(env),file.file_id,stored.generation,stored.version,JSON.stringify(ranked.map(p=>p.position))).all()).results:[];
 const byPosition=new Map(rows.map(row=>[row.position,row]));
 const selected=[];let remaining=2400;
 for(const candidate of ranked){
  const row=byPosition.get(candidate.position);
  if(!row||selected.some(p=>p.position===row.position)||!Number.isInteger(row.char_start)||!Number.isInteger(row.char_end)||row.char_start<0||row.char_end<=row.char_start||row.char_end>file.preview.length||file.preview.slice(row.char_start,row.char_end)!==row.content||!row.content.trim()||row.content.length>remaining)continue;
  selected.push({position:row.position,heading:row.heading,start:row.char_start,end:row.char_end,content:row.content});
  remaining-=row.content.length;if(selected.length===2)break;
 }
 console.log(JSON.stringify({event:'rag_rebuild_semantic',state:selected.length?'matched':'no_match',candidates:candidates.length,lexicalCandidates:lexical.length,passages:selected.length,elapsedMs:Math.round(performance.now()-started)}));
 return {state:selected.length?'matched':'semantic_no_match',method:lexical.length?'hybrid_fts_vector':'semantic_fallback',passages:selected,...(env.RAG_HYBRID_ENABLED==='true'?{lexicalStatus,ranking:ranked.map(({position,lexicalRank,semanticRank})=>({position,lexicalRank,semanticRank}))}:{})};
}

export function semanticFailure(error){
 const code=typeof error?.code==='string'&&/^[a-z_0-9]{1,60}$/u.test(error.code)?error.code:'service_error';
 const details=modelFailure(error);
 console.warn(JSON.stringify({event:'rag_rebuild_semantic',state:'unavailable',code,...details}));
 const answer=code==='rag_daily_budget'?"Document search has reached this app's daily limit. Your PDF is still available to read.":code==='rag_semantic_not_ready'?'I can read this PDF, but search for that wording is not ready yet. Try asking for a specific check.':['quota_exhausted','rate_limited'].includes(details.reason)?'The search service has reached its current limit. Please try again later, or ask me to show a specific check.':'I could not search the PDF for that wording right now. Please try again, or ask me to show a specific check.';
 return {state:'semantic_unavailable',answer,sources:[],confirmed:false,failureCode:code};
}
