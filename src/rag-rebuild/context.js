import {checkOwner,dataset,hash} from '../search.js';
// Character bound protects transport memory; actual large requests are checked with the model tokenizer.
export const FULL_TEXT_LIMIT=1500000;
// Bounded opening-page evidence for model-selected document-organization questions.
export const STRUCTURE_PAGE_LIMIT=32;
export const STRUCTURE_TEXT_LIMIT=120000;
// A library answer can cite up to six passages, each validated at <=2400 characters.
export const REPHRASE_PASSAGE_LIMIT=6;
export const REPHRASE_TEXT_LIMIT=REPHRASE_PASSAGE_LIMIT*2400;

export function parsePdfFollowup(query){
 if(typeof query!=='string'||query.length>500||/\bpdf\b/iu.test(query))return null;
 // Legacy numbered shortcut; natural conversation is interpreted by the existing router.
 const match=query.trim().match(/^(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?(explain|summari[sz]e|show(?:\s+me)?|read|tell\s+me\s+about|what\s+about)\s+(?:(?:the|that|this)\s+)?(checks?|items?|steps?|sections?)\s+(\d{1,3})(?:\s*(?:to|through|[-–—])\s*(\d{1,3}))?(?:\s+(?:(?:more\s+)?(?:simply|clearly|briefly)|in\s+(?:simple|plain)\s+(?:words|english)|again|please))?[.!?]*$/iu);
 return match?{keywords:match[2]+' '+match[3]+' to '+(match[4]??match[3]),answer:!/^(?:show|read)/iu.test(match[1])}:null;
}

export async function recentPdfContext(env,owner,contextMessageId,{requireLatest=false,recoveryDepth=0}={}){
 checkOwner(env,owner);
 const rows=await env.DB.prepare(`SELECT c.prepared_reply_json,json_extract(i.payload_json,'$.context.id') AS context_reply_id FROM command_jobs c JOIN inbound_messages i ON i.message_id=c.message_id
  WHERE c.owner=? AND i.sender=? ${requireLatest?'':"AND c.kind='assistant'"} AND i.ack_state='sent'
  ${contextMessageId?'AND i.ack_message_id=?':''}
  ${requireLatest?'':'AND c.prepared_reply_json IS NOT NULL'}
  ORDER BY i.ack_updated_at DESC LIMIT ${contextMessageId?1:8}`).bind(owner,owner,...(contextMessageId?[contextMessageId]:[])).all();
 for(const row of rows.results){
  let cached;try{cached=JSON.parse(row.prepared_reply_json);}catch{if(requireLatest)return null;continue;}
  const content=cached?.content??cached,meta=content?._chat;
  if(!meta?.ragResult){if(requireLatest)return null;continue;}
  const decision=meta.ragRouting?.decision;
  // A failed rewrite did not establish a new subject. Recover only owned sent
  // answers, following an explicit reply when present; never cross a source switch.
  if(meta.ragFailureCode&&decision?.mode?.choice==='rephrase'&&['context','quoted'].includes(decision.binding)){
   if(typeof row.context_reply_id==='string'&&row.context_reply_id!==contextMessageId&&recoveryDepth<4){
    const previous=await recentPdfContext(env,owner,row.context_reply_id,{requireLatest:true,recoveryDepth:recoveryDepth+1});
    if(previous)return previous;
   }
   if(!contextMessageId)continue;
   return null;
  }
  if(Object.hasOwn(meta,'ragSource')){
   const source=meta.ragSource;
   const rejected=meta.ragRouting?.decision;
   // A confidence-only clarification did not change the PDF; retain the source boundary without a clock.
   if(source===null&&!contextMessageId&&meta.routing==='pdf_model_clarification'&&rejected?.context==='recent'&&rejected.sourceAccepted===false&&rejected.sourceResolution==='model'&&rejected.source?.choice==='context_pdf')continue;
   if(!source||source.dataset!==dataset(env))return null;
   const hasFile=/^[a-f0-9]{16}$/u.test(source.fileId??'');
   if(!hasFile&&(typeof source.topic!=='string'||!source.topic.trim()))return null;
   const file=hasFile?await env.DB.prepare("SELECT file_id,filename FROM file_catalog WHERE owner=? AND dataset=? AND file_id=? AND mime_type='application/pdf' LIMIT 1").bind(owner,dataset(env),source.fileId).first():null;
   if(hasFile&&!file)return null;
   const body=content.text?.body;
   // The library lane appends "Sources:\n"; a single-document answer appends "Source: ".
   const marker=typeof body==='string'?Math.max(body.lastIndexOf('\n\nSource: '),body.lastIndexOf('\n\nSources:\n')):-1;
   const answer=meta.turn?.toolName==='answer_document_source'&&marker>0&&marker<=4800?body.slice(0,marker):null;
   const reference={textHash:source.textHash,topic:source.topic,scope:source.scope,generation:source.generation,summaryJob:source.summaryJob,passages:meta.ragTrace?.passages,answer};
   return file?{...file,reference}:{reference};
  }
  if(['literal_pdf_command','natural_pdf_read'].includes(meta.routing)&&meta.turn?.toolName!=='answer_document_source')return null;
  if(requireLatest)return null;
  // Upgrade bridge: only a backend-appended source on a previously sent rebuild answer, never the PDF help inventory.
  if(dataset(env)!=='live'||meta.turn?.toolName!=='answer_document_source'||meta.routing!=='natural_pdf_read')continue;
  const body=content.text?.body??'',index=body.lastIndexOf('\n\nSource: ');
  if(index<0)continue;
  const label=body.slice(index+10).trim();
  const found=await env.DB.prepare("SELECT file_id,filename FROM file_catalog WHERE owner=? AND dataset=? AND mime_type='application/pdf' AND (?=filename OR substr(?,1,length(filename)+3)=filename||' · ') LIMIT 2").bind(owner,dataset(env),label,label).all();
  return found.results.length===1?found.results[0]:null;
 }
 return null;
}

export function referencePassages(text,reference){
 const invalid={state:'reference_needed',passages:[]};
 const rewrite=typeof reference?.answer==='string'&&!!reference.answer.trim();
 if(!reference||!/^[a-f0-9]{64}$/u.test(reference.textHash??'')||typeof reference.topic!=='string'||!reference.topic.trim()||reference.topic.length>2000||!Array.isArray(reference.passages)||reference.passages.length<1||reference.passages.length>(rewrite?REPHRASE_PASSAGE_LIMIT:2))return invalid;
 if(hash(text)!==reference.textHash)return {state:'reference_stale',passages:[]};
 const spans=reference.passages;
 const fullText=reference.scope==='full_extracted_text';
 if(fullText&&(spans.length!==1||spans[0]?.charStart!==0||spans[0]?.charEnd!==text.length||text.length>FULL_TEXT_LIMIT))return invalid;
 if(spans.some(p=>!p||!Number.isInteger(p.position)||p.position<0||!Number.isInteger(p.charStart)||!Number.isInteger(p.charEnd)||p.charStart<0||p.charEnd<=p.charStart||p.charEnd>text.length||rewrite&&!fullText&&p.charEnd-p.charStart>2400)||spans.reduce((n,p)=>n+p.charEnd-p.charStart,0)>(fullText?FULL_TEXT_LIMIT:rewrite?REPHRASE_TEXT_LIMIT:2400))return invalid;
 return {state:'matched',method:'previous_source_passages',fullText,passages:spans.map(p=>({position:p.position,start:p.charStart,end:p.charEnd,heading:[...text.slice(0,p.charStart).matchAll(/^#{1,6}[ \t]+([^\r\n]+).*$/gm)].at(-1)?.[1]??'',content:text.slice(p.charStart,p.charEnd)}))};
}
