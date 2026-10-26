import {createHash} from 'node:crypto';
import {resolveOwner} from './owners.js';
export const EMBEDDING_MODEL='@cf/baai/bge-small-en-v1.5';
export class ToolError extends Error { constructor(code){super(code);this.code=code;} }
export const hash=value=>createHash('sha256').update(value).digest('hex');
export const dataset=env=>env.FILE_DATASET || 'live';
export function checkOwner(env,owner){if(owner!==env.ALLOWED_SENDER||!resolveOwner(env,owner))throw new ToolError('forbidden');}
export const ownerKey=owner=>hash(owner);
export const namespace=(env,owner)=>ownerKey(owner).slice(0,40)+(env.VECTOR_NAMESPACE_SUFFIX || '');
export const vectorId=(env,owner,fileId,position)=>hash(namespace(env,owner)).slice(0,12)+':'+fileId+':'+position;
export function boundedText(text,bytes=400){
 let out='',count=0;
 for(const char of String(text)){const size=new TextEncoder().encode(char).length;if(count+size>bytes)break;out+=char;count+=size;}
 return out;
}
export function chunkText(text){
 const chunks=[];let buffer='',size=0;
 for(const char of text.replace(/\r\n/g,'\n')){
  const length=new TextEncoder().encode(char).length;
  if(size+length>400){chunks.push(buffer);buffer='';size=0;}
  buffer+=char;size+=length;
 }
 if(buffer.length)chunks.push(buffer);
 return chunks;
}
export function dateQuery(query,now=new Date()){
 const seconds=Math.floor(now.getTime()/1000),offset=19800;
 const local=new Date((seconds+offset)*1000),midnight=Math.floor((seconds+offset)/86400)*86400-offset;
 let start=null,end=null,label=null;
 if(/\blast week\b/i.test(query)){end=midnight-((local.getUTCDay()+6)%7)*86400;start=end-7*86400;label='previous Monday–Sunday in Asia/Kolkata';}
 else if(/\byesterday\b/i.test(query)){start=midnight-86400;end=midnight;label='yesterday in Asia/Kolkata';}
 else if(/\btoday\b/i.test(query)){start=midnight;end=midnight+86400;label='today in Asia/Kolkata';}
 return {query:query.replace(/\b(last week|yesterday|today)\b/ig,'').trim(),start,end,label};
}
export async function embed(env,texts){
 const result=await env.AI.run(EMBEDDING_MODEL,{text:texts,pooling:'cls'});
 if(!Array.isArray(result.data)||result.data.length!==texts.length||result.data.some(vector=>
  !Array.isArray(vector)||vector.length!==384||vector.some(n=>!Number.isFinite(n))))throw new ToolError('invalid_embeddings');
 return result.data;
}
export async function get_file(env,owner,fileId,{delivery=false}={}){
 checkOwner(env,owner);
 if(!/^[a-f0-9]{16}$/.test(fileId ?? ''))throw new ToolError('invalid_file_id');
 const file=delivery?await env.DB.prepare(`SELECT c.file_id,c.owner,c.dataset,c.message_id,c.kind,c.filename,c.mime_type,c.byte_size,
  c.sha256,c.bucket,c.object_key,
  c.meta_media_id,c.meta_media_phone,c.meta_media_sha256,c.meta_media_expires_at,m.media_id AS incoming_media_id
  FROM file_catalog c LEFT JOIN media_files m ON m.message_id=c.message_id AND m.sender=c.owner AND m.state='ready'
  AND m.sha256=c.sha256 AND m.byte_size=c.byte_size AND m.created_at>?
  AND EXISTS(SELECT 1 FROM inbound_messages i WHERE i.message_id=m.message_id AND i.sender=c.owner AND i.phone_number_id=?)
  WHERE c.file_id=? AND c.owner=? AND c.dataset=?`)
  .bind(new Date(Date.now()-6*86400000).toISOString(),env.META_PHONE_NUMBER_ID,fileId,owner,dataset(env)).first():
  await env.DB.prepare('SELECT * FROM file_catalog WHERE file_id=? AND owner=? AND dataset=?').bind(fileId,owner,dataset(env)).first();
 if(!file)throw new ToolError('file_not_found');
 return file;
}
export async function list_files(env,owner,limit=5){
 checkOwner(env,owner);
 const result=await env.DB.prepare('SELECT file_id,filename,kind,mime_type,sha256,source_epoch,index_state FROM file_catalog WHERE owner=? AND dataset=? ORDER BY source_epoch DESC LIMIT ?')
  .bind(owner,dataset(env),Math.max(1,Math.min(10,limit))).all();return result.results;
}
export async function search_files(env,owner,query,{now=new Date(),limit=5,excludeMessageId=null,metadataOnly=false}={}){
 checkOwner(env,owner);
 if(typeof query!=='string'||!query.trim()||query.length>300)throw new ToolError('invalid_query');
 const date=dateQuery(query,now),base=[owner,dataset(env)];
 // A voice shortlist does not need document contents or extraction bookkeeping.
 const columns=metadataOnly?'file_id,filename,kind,mime_type,source_epoch,sha256':'*';
 let where='owner=? AND dataset=?';
 // A clear format suffix is a file constraint, not just an embedding keyword.
 if(/\bpdfs?(?:\s+(?:files?|documents?))?$/i.test(query.trim())&&!/\b(?:not|except|without|excluding|non-pdf)\b/i.test(query)){where+=' AND mime_type=?';base.push('application/pdf');}
 if(excludeMessageId!==null){where+=' AND message_id!=?';base.push(excludeMessageId);}
 if(date.start!==null){where+=' AND source_epoch>=? AND source_epoch<?';base.push(date.start,date.end);}
 if(!date.query){
  const rows=await env.DB.prepare(`SELECT ${columns} FROM file_catalog WHERE ${where} ORDER BY source_epoch DESC LIMIT ?`).bind(...base,limit).all();
  return {files:rows.results.map(row=>({...row,score:0})),dateRule:date.label};
 }
 const [vector]=await embed(env,[boundedText(date.query,480)]);
 const filter={owner:{$eq:ownerKey(owner)}};
 if(date.start!==null)filter.sent_at={$gte:date.start,$lt:date.end};
 const matches=await env.FILES.query(vector,{topK:50,namespace:namespace(env,owner),returnMetadata:'all',filter});
 const candidates=new Map();
 for(const match of matches.matches ?? []){
  const id=match.metadata?.file_id;
  if(match.metadata?.owner!==ownerKey(owner)||!/^[a-f0-9]{16}$/.test(id ?? '')||!Number.isFinite(match.score))continue;
  candidates.set(id,Math.max(candidates.get(id)??-1,match.score));
 }
 if(candidates.size===0)return {files:[],dateRule:date.label};
 const ids=[...candidates.keys()];
 const rows=await env.DB.prepare(`SELECT ${columns} FROM file_catalog WHERE ${where} AND file_id IN (${ids.map(()=>'?').join(',')})`)
  .bind(...base,...ids).all();
 const tokens=date.query.toLowerCase().split(/\s+/).filter(word=>word.length>=3);
 const ranked=rows.results.map(row=>{
  const name=row.filename.toLowerCase();const nameHit=tokens.some(token=>name.includes(token));
  return {...row,score:candidates.get(row.file_id)+(nameHit?0.06:0)};
 }).filter(row=>row.score>=0.45).sort((a,b)=>b.score-a.score||b.source_epoch-a.source_epoch);
 return {files:ranked.slice(0,Math.min(5,limit)),dateRule:date.label};
}
