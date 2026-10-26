import {dataset,hash} from '../search.js';
export async function pagedSourceCurrent(env,owner,file,passages){
 const current=await env.DB.prepare(`SELECT 1 AS current FROM rag_pdf_jobs j JOIN file_catalog c ON c.owner=j.owner AND c.dataset=j.dataset AND c.file_id=j.file_id
 WHERE j.owner=? AND j.dataset=? AND j.file_id=? AND j.generation=? AND j.source_hash=? AND c.sha256=j.source_hash AND c.filename=? AND c.mime_type='application/pdf' AND j.state IN ('extracting','indexing','ready')`).bind(owner,dataset(env),file.file_id,file.generation,file.sha256,file.filename).first();
 if(!current)return false;
 const rows=(await env.DB.prepare('SELECT page,text,text_hash FROM rag_pdf_pages WHERE owner=? AND dataset=? AND file_id=? AND generation=? AND page IN (SELECT value FROM json_each(?))').bind(owner,dataset(env),file.file_id,file.generation,JSON.stringify([...new Set(passages.map(p=>p.page))])).all()).results;
 const pages=new Map(rows.map(p=>[p.page,p]));
 for(const p of passages){
  const page=pages.get(p.page);
  if(!page||hash(page.text)!==page.text_hash||page.text.slice(p.start,p.end)!==p.content)return false;
 }
 return true;
}
