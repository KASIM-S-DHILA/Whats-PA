// Keep explicit file-format requests when a planner shortens the search text.
// The shared search function applies its PDF MIME filter to a final "pdf" token.
import {checkOwner,dataset,ToolError} from '../search.js';

export function literalFilenameQuery(query) {
  const value=String(query).trim();
  return /^[^\s/\\]+\.[a-z0-9]{2,8}$/i.test(value)?value.toLowerCase():null;
}

// Similarity cannot stand in for explicit longer identifiers. Small counts and
// ordinary years stay with the existing selection/date rules; literal filenames
// retain all of their numbers, including years.
export async function filterCallIdentifiers(env,owner,userRequest,plannedQuery,result) {
  checkOwner(env,owner);
  const files=result.files??[],literal=literalFilenameQuery(plannedQuery)!==null;
  const identifiers=[...new Set((`${userRequest} ${plannedQuery}`.match(/[0-9]+/g)??[])
    .filter(value=>value.length>=3&&(literal||Number(value)<1900||Number(value)>2199)))];
  if(!files.length||!identifiers.length)return result;
  if(identifiers.length>8)throw new ToolError('query_too_specific');
  const conditions=identifiers.map(()=>literal?"(' '||filename||' ') GLOB ?":"((' '||filename||' ') GLOB ? OR (' '||extracted_text||' ') GLOB ?)");
  const patterns=identifiers.flatMap(value=>{
    const pattern=`*[^0-9]${value}[^0-9]*`;return literal?[pattern]:[pattern,pattern];
  });
  const rows=await env.DB.prepare(`SELECT file_id FROM file_catalog WHERE owner=? AND dataset=?
    AND file_id IN (${files.map(()=>'?').join(',')}) AND ${conditions.join(' AND ')}`)
    .bind(owner,dataset(env),...files.map(file=>file.file_id),...patterns).all();
  const allowed=new Set(rows.results.map(row=>row.file_id));
  const retained=files.filter(file=>allowed.has(file.file_id));
  console.log(JSON.stringify({event:'call_search_identifier_constraint',candidates:files.length,retained:retained.length}));
  return {...result,files:retained};
}

export function groundedSearchQuery(plannedQuery, userRequest = plannedQuery) {
  const query = String(plannedQuery).trim().replace(/[\s.!?。؟।]+$/u, '').trim();
  const request = String(userRequest);
  const asksForPdf = /(?:\bpdfs?\b|\.pdf\b)/i.test(request);
  const excludesPdf = /\b(?:not|no|without|except|excluding)\s+(?:(?:a|any|the)\s+)?pdfs?\b|\bnon[-\s]?pdf\b/i.test(request);
  if (!query || !asksForPdf || excludesPdf || /\bpdfs?(?:\s+(?:files?|documents?))?$/i.test(query)) return query;
  return `${query} pdf`;
}

const searchWordsToIgnore = new Set([
  'find','search','show','look','get','send','me','my','the','this','that','for','from','with','about',
  'please','can','could','you','any','all','file','files','pdf','pdfs','document','documents',
  'note','notes','audio','voice','video','image','picture','photo','latest','last','first','one'
]);

// Vector similarity alone can return unrelated files for a detailed query.
// Require a little source-text agreement before offering or sending them.
export async function filterWeakSearchMatches(env, owner, userRequest, result) {
  checkOwner(env,owner);
  let files=result.files??[];
  if(!files.length)return result;
  const request=String(userRequest);
  const years=[...request.matchAll(/\b(?:19|20|21)\d{2}\b/g)];
  const dated=/\bfrom\s+(?:the\s+year\s+)?((?:19|20|21)\d{2})\b(?!\s*(?:to|through|until|onwards?)\b)/i.exec(request)??
    /(?:^|\s)((?:19|20|21)\d{2})\s+(?:की|का|के)(?=\s|$)/u.exec(request);
  // ponytail: narrow English/Hindi date phrases; extend only for observed forms.
  // A single positive year constrains the file's date or title, not similarity.
  const excludesYear=/\b(?:not|except|excluding|without|before|after|since)\b/i.test(request)||
    /(?:^|\s)(?:नहीं|मत|बिना|छोड़कर|छोड़कर|अलावा|पहले|बाद|से|जगह)(?=\s|[।.!?,]|$)/u.test(request);
  if(dated&&years.length===1&&!excludesYear){
    const year=Number(dated[1]),yearInName=new RegExp(`(?:^|\\D)${year}(?:\\D|$)`);
    files=files.filter(file=>yearInName.test(file.filename??'')||
      Number.isFinite(Number(file.source_epoch))&&
      new Date((Number(file.source_epoch)+19800)*1000).getUTCFullYear()===year);
    console.log(JSON.stringify({event:'chat_search_year_constraint',candidates:result.files.length,retained:files.length}));
    if(!files.length)return {...result,files};
  }
  const terms=[...new Set((String(userRequest).toLowerCase().match(/[a-z0-9]{3,}/g)??[])
    .filter(word=>!searchWordsToIgnore.has(word)))].slice(0,8);
  if(terms.length<3)return {...result,files};
  const ids=files.map(file=>file.file_id);
  const hits=terms.map(()=>'(CASE WHEN instr(lower(filename),?)>0 OR instr(lower(extracted_text),?)>0 THEN 1 ELSE 0 END)');
  const rows=await env.DB.prepare(`SELECT file_id,(${hits.join(' + ')}) AS lexical_hits FROM file_catalog
    WHERE owner=? AND dataset=? AND file_id IN (${ids.map(()=>'?').join(',')})`)
    .bind(...terms.flatMap(term=>[term,term]),owner,dataset(env),...ids).all();
  const byId=new Map(rows.results.map(row=>[row.file_id,Number(row.lexical_hits)]));
  const required=terms.length>=4?2:1;
  const relevant=files.filter(file=>(byId.get(file.file_id)??0)>=required);
  console.log(JSON.stringify({event:'chat_search_relevance',candidates:ids.length,retained:relevant.length,required}));
  return {...result,files:relevant};
}
