import {hash,dataset,checkOwner,ToolError} from '../search.js';
import {runWorkersAi} from '../chat-recovery-v1/models.js';
import {primaryOwner} from '../owners.js';
export const MODEL='@cf/baai/bge-m3';
export const fail=code=>{throw new ToolError(code);};
export const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
export const only=(x,keys)=>object(x)&&Object.keys(x).every(k=>keys.includes(k));
export const fileId=x=>typeof x==='string'&&/^[a-f0-9]{16}$/.test(x);
export async function cached(env,owner,key,kind){
 key=owner===primaryOwner(env)?key:hash(JSON.stringify([owner,kind,key]));
 checkOwner(env,owner);try{const row=await env.DB.prepare('SELECT value_json FROM rag_cache WHERE cache_key=? AND owner=? AND kind=? AND expires_at>?').bind(key,owner,kind,Date.now()).first();return row?JSON.parse(row.value_json):null;}catch{return null;}
}
export async function cache(env,owner,key,kind,value,ttl=600000){
 checkOwner(env,owner);
 key=owner===primaryOwner(env)?key:hash(JSON.stringify([owner,kind,key]));
 const json=JSON.stringify(value);if(json.length>90000)return;
 try{await env.DB.prepare('INSERT INTO rag_cache(cache_key,owner,kind,value_json,expires_at) VALUES(?,?,?,?,?) ON CONFLICT(cache_key) DO UPDATE SET value_json=excluded.value_json,expires_at=excluded.expires_at WHERE rag_cache.owner=excluded.owner AND rag_cache.kind=excluded.kind').bind(key,owner,kind,json,Date.now()+ttl).run();}catch{}
}
export async function reserve(env){
 const day=new Date().toISOString().slice(0,10),totalLimit=Number(env.RAG_DAILY_MODEL_REQUESTS);
 const backgroundLimit=Number(env.RAG_DAILY_BACKGROUND_REQUESTS??Math.max(0,totalLimit-16));
 if(!Number.isInteger(totalLimit)||totalLimit<1||totalLimit>8192||!Number.isInteger(backgroundLimit)||backgroundLimit<0||backgroundLimit>totalLimit)fail('rag_budget_invalid');
 const interactive=env.RAG_REQUEST_KIND==='interactive',limit=interactive?totalLimit:backgroundLimit;
 const rows=await env.DB.batch([env.DB.prepare('INSERT INTO rag_budget(day,requests) VALUES(?,0) ON CONFLICT(day) DO NOTHING').bind(day),env.DB.prepare('UPDATE rag_budget SET requests=requests+1 WHERE day=? AND requests<?').bind(day,limit)]);
 if(rows[1].meta.changes!==1)fail(interactive?'rag_daily_budget':'rag_background_budget');
}
export async function infer(env,model,input,ms=6000){
 const deadline=env.RAG_DEADLINE??env.CHAT_DEADLINE;
 if(deadline)ms=Math.min(ms,deadline-Date.now());if(ms<300)fail('rag_deadline');
 const verified=env.RAG_VERIFIED_INPUT_TOKENS;
 const expanded=model==='@cf/mistralai/mistral-small-3.1-24b-instruct'&&Number.isSafeInteger(verified)&&verified>0&&verified+(input.max_tokens??512)+1024<=128000;
 if(Buffer.byteLength(JSON.stringify(input))>(expanded?2*1024*1024:60000))fail('rag_input_limit');
 await reserve(env);let timer;
 try{return await Promise.race([runWorkersAi(env,model,input,{signal:AbortSignal.timeout(ms),responseLimit:model===MODEL?1024*1024:128*1024}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new ToolError('rag_model_timeout')),ms);})]);}finally{clearTimeout(timer);}
}
export async function embed(env,texts){
 const maxBatch=env.RAG_PDF_BATCHES_ENABLED==='true'&&env.RAG_REQUEST_KIND==='background'?32:16;
 if(!Array.isArray(texts)||!texts.length||texts.length>maxBatch||texts.some(t=>typeof t!=='string'||t.length>2400))fail('rag_embedding_input');
 const key=hash(JSON.stringify(['rag-embed-v1',env.ALLOWED_SENDER,dataset(env),MODEL,texts])),hit=await cached(env,env.ALLOWED_SENDER,key,'embedding');
 const valid=data=>Array.isArray(data)&&data.length===texts.length&&data.every(v=>Array.isArray(v)&&v.length===1024&&v.every(Number.isFinite));
 if(valid(hit))return hit;
 const result=await infer(env,MODEL,{text:texts},7000);
 if(!valid(result?.data))fail('rag_embedding_output');
 await cache(env,env.ALLOWED_SENDER,key,'embedding',result.data);return result.data;
}
// Search small, coherent children; retrieval can include their adjacent section passages.
export function passages(text,{maxChars=1500,maxChunks=256}={}){
 if(typeof text!=='string'||!text.trim()||text.length>60000)fail('invalid_evidence_text');
 const headings=[...text.matchAll(/^#{1,6}[ \t]+([^\r\n]+).*$/gm)].map(m=>({start:m.index,text:m[1].slice(0,180)}));
 const result=[];let start=0;
 while(start<text.length){
  if(result.length>=maxChunks)fail('evidence_chunk_limit');
  let end=Math.min(text.length,start+maxChars),next=headings.find(h=>h.start>start&&h.start<end);
  if(next)end=next.start;
  else if(end<text.length){
   const block=text.lastIndexOf('\n\n',end),line=text.lastIndexOf('\n',end);
   if(block>start+maxChars/3)end=block+2;
   else if(line>start+maxChars/2)end=line+1;
   else{const sentence=[...text.slice(start,end).matchAll(/[.!?।][ \t\n]+/g)].at(-1);if(sentence&&sentence.index>maxChars/2)end=start+sentence.index+sentence[0].length;}
  }
  if(/[\uD800-\uDBFF]/.test(text[end-1]))end--;
  if(end<=start)fail('invalid_evidence_boundary');
  const content=text.slice(start,end);
  if(content.trim())result.push({position:result.length,start,end,heading:headings.filter(h=>h.start<=start).at(-1)?.text??'',content});start=end;
 }
 return result;
}
export async function rerank(env,query,rows){
 if(rows.length<2)return {rows,status:'not_needed'};
 try{
  const chosen=rows.slice(0,12),result=await infer(env,'@cf/baai/bge-reranker-base',{query,contexts:chosen.map(r=>({text:(r.title+'\n'+r.heading+'\n'+r.content).slice(0,1500)})),top_k:chosen.length},1800);
  const scores=result?.response;
  if(!Array.isArray(scores)||scores.length!==chosen.length||new Set(scores.map(s=>s.id)).size!==chosen.length||scores.some(s=>!Number.isInteger(s.id)||s.id<0||s.id>=chosen.length||!Number.isFinite(s.score)))fail('rag_reranker_output');
  return {rows:scores.sort((a,b)=>b.score-a.score).map(s=>chosen[s.id]),status:'applied'};
 }catch{return {rows,status:'hybrid_fallback'};}
}
export async function faissSearch(env,vector){
 if(env.ALLOWED_SENDER!==primaryOwner(env))return {ids:[],status:'vectorize_fallback'};
 if(!env.RAG_FAISS_URL)return {ids:[],status:'not_configured'};
 try{
  const url=new URL(env.RAG_FAISS_URL);if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/')fail('rag_faiss_url');
  const time=String(Math.floor(Date.now()/1000)),body=JSON.stringify({vector,limit:30});
  const {createHmac}=await import('node:crypto');
  const sig=createHmac('sha256',env.RAG_INDEX_SECRET).update('whats-faiss:v1:'+time+':'+body).digest('hex');
  const response=await fetch(new URL('search',url),{method:'POST',headers:{'Content-Type':'application/json','X-Bridge-Time':time,'X-Bridge-Signature':sig},body,redirect:'manual',signal:AbortSignal.timeout(1800)});
  if(!response.ok||Number(response.headers.get('Content-Length')??0)>16000)fail('rag_faiss_unavailable');
  const reader=response.body.getReader();let size=0,parts=[];try{while(true){const item=await reader.read();if(item.done)break;size+=item.value.length;if(size>16000){await reader.cancel();fail('rag_faiss_size');}parts.push(item.value);}}finally{reader.releaseLock();}
  const data=JSON.parse(new TextDecoder().decode(Buffer.concat(parts)));
  if(!Array.isArray(data.ids)||data.ids.length>30||data.ids.some(id=>typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id)))fail('rag_faiss_output');
  return {ids:data.ids,status:'queried'};
 }catch{return {ids:[],status:'vectorize_fallback'};}
}
