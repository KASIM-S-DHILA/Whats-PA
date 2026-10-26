import {checkOwner,dataset} from '../search.js';
const words=text=>text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}\p{M}]+/gu)??[];
const filler=new Set('a an the and or to of for from in on at is are was were be do does did what which how please tell me my this that about say says explain summarize summarise summary read preview show according can could would will you it s contain contains mention mentions discuss discusses pdf file document checklist'.split(' '));
const specific=text=>words(text).filter(word=>!filler.has(word));
const label=name=>name.replace(/[\u0000-\u001f]/g,' ').slice(0,180);

// Resolve catalog identifiers anywhere in a request; this does not classify intent or authorize actions.
export function explicitPdfReference(query,files){
 const requested=' '+words(query).join(' ')+' ',hasFilename=/\.pdf\b/iu.test(query);
 const matches=files.flatMap(file=>{
  const full=words(file.filename).join(' '),base=words(file.filename.normalize('NFKC').replace(/\.pdf$/iu,''));
  const kind=hasFilename?(requested.includes(' '+full+' ')?'full_filename':null):base.length>=2&&requested.includes(' '+base.join(' ')+' ')?'complete_title':null;
  return kind?[{file,kind}]:[];
 });
 return matches.length===1?matches[0]:null;
}

// Corroboration only: this partial title match cannot select a source on its own.
export function matchingPdfTitle(query,files){
 if(/\.pdf\b/iu.test(query))return null;
 const requested=new Set(words(query));
 const matches=files.filter(file=>words(file.filename.normalize('NFKC').replace(/\.pdf$/iu,'')).some(word=>word.length>=4&&/\p{L}/u.test(word)&&requested.has(word)));
 return matches.length===1?matches[0]:null;
}

export function isNaturalPdfRead(query){
 return typeof query==='string'&&query.length<=2000&&/\bpdf\b/iu.test(query)&&
  /^(?:please\s+)?(?:(?:(?:can|could|would|will)\s+you\s+)?(?:read|preview|show|explain|summari[sz]e|tell)\b|what\b|how\b|which\b|according\s+to\b)/iu.test(query.trim());
}

export function wantsPdfAnswer(query){
 return isNaturalPdfRead(query)&&/^(?:please\s+)?(?:(?:(?:can|could|would|will)\s+you\s+)?(?:explain|summari[sz]e|tell)\b|what\b|how\b|which\b|according\s+to\b)/iu.test(query.trim());
}

// ponytail: bounded English title/keyword matching; clarify instead of guessing when titles tie.
export async function resolveNaturalPdf(env,owner,query){
 checkOwner(env,owner);
 const exact=await env.DB.prepare("SELECT filename FROM file_catalog WHERE owner=? AND dataset=? AND mime_type='application/pdf' AND instr(lower(?),lower(filename))>0 LIMIT 2").bind(owner,dataset(env),query).all();
 let name=exact.results.length===1?exact.results[0].filename:null;
 if(exact.results.length>1)return {answer:'That request names more than one saved PDF. Which one should I read?'};
 if(!name){
  const listed=await env.DB.prepare("SELECT filename FROM file_catalog WHERE owner=? AND dataset=? AND mime_type='application/pdf' ORDER BY created_at DESC LIMIT 51").bind(owner,dataset(env)).all();
  const files=listed.results;
  if(!files.length)return {answer:'No saved PDFs were found.'};
  if(files.length>50)return {answer:'Please include the full PDF filename so I can choose it reliably.'};
  const before=query.slice(0,query.search(/\bpdf\b/iu)).replace(/\.\s*$/u,'');
  const hint=before.split(/\b(?:from|in|according\s+to)\b/iu).at(-1);
  const terms=specific(hint).filter(word=>!/^\d{1,2}$/u.test(word)&&!['checks','check','steps','items','sections'].includes(word));
  const candidates=/\.pdf\b/iu.test(query)?[]:files.filter(file=>{
   const titleWords=new Set(words(file.filename));
   return terms.length?terms.every(term=>titleWords.has(term)):files.length===1;
  });
  if(candidates.length!==1)return {answer:(candidates.length?'Several PDFs match. Which one should I read?':'I could not identify that PDF. Which saved PDF do you mean?')+'\n\n'+(candidates.length?candidates:files).slice(0,5).map(file=>label(file.filename)).join('\n')};
  name=candidates[0].filename;
 }
 const titleWords=new Set(words(name));
 const nameStart=query.toLowerCase().indexOf(name.toLowerCase());
 const withoutName=nameStart<0?query:query.slice(0,nameStart)+query.slice(nameStart+name.length);
 const after=withoutName.match(/\bpdf\b[\s\S]*$/iu)?.[0]?.replace(/^pdf\b/iu,'')??'';
 const hasTopicAfter=specific(after).length>0,topic=hasTopicAfter?after:withoutName;
 const range=topic.match(/\b(?:checks?|items?|steps?|sections?)\s+(\d{1,3})\s*(?:to|through|[-–—])\s*(\d{1,3})\b/iu);
 const terms=specific(topic).filter(term=>hasTopicAfter||!titleWords.has(term));
 const keywords=range?range[0]:terms.join(' ');
 if(keywords.length>200||terms.length>24)return {answer:'Please ask a shorter, more specific question about the PDF.'};
 return {name,keywords:keywords||null};
}
