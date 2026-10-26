import {findPassages} from './passages.js';
import {isNaturalPdfRead,resolveNaturalPdf,wantsPdfAnswer} from './natural.js';
import {answerFromPassages} from './answer.js';
import {parsePdfFollowup,recentPdfContext,referencePassages,FULL_TEXT_LIMIT} from './context.js';
import {findSemanticPassages,semanticFailure} from './semantic.js';
import {checkOwner,dataset,hash,ToolError} from '../search.js';
import {readPagedPdf} from './pdf-pages.js';
const result=answer=>({state:'source_preview',answer,sources:[],confirmed:false});
const title=value=>String(value).replace(/[\u0000-\u001f]/g,' ').slice(0,180);
export function parsePdfReadCommand(query){
 if(typeof query!=='string'||query.length>2000)return null;
 const requested=query.trim().match(/^(?:read|preview|show(?:\s+me)?)\s+(?:the\s+)?pdf\s*:\s*(.+)$/iu)?.[1]?.trim();
 const separator=requested?.indexOf(' | ')??-1,name=separator<0?requested:requested.slice(0,separator).trim(),keywords=separator<0?null:requested.slice(separator+3).trim();
 return name?{name,keywords}:null;
}
export async function previewDocument(env,owner,query,{contextMessageId,pdfRequest}={}){
 checkOwner(env,owner);
 if(typeof query!=='string'||query.length>2000)throw new ToolError('invalid_request');
 if(pdfRequest&&(!/^[a-f0-9]{16}$/u.test(pdfRequest.fileId??'')||typeof pdfRequest.filename!=='string'||!['answer','rephrase','preview','passages','summary','structure'].includes(pdfRequest.mode)||pdfRequest.mode==='summary'&&env.RAG_WHOLE_SUMMARY_ENABLED!=='true'))throw new ToolError('invalid_request');
 const wholeSummary=pdfRequest?.mode==='summary';
 const documentStructure=pdfRequest?.mode==='structure';
 const wholeText=wholeSummary||documentStructure;
 const followup=pdfRequest?(pdfRequest.mode==='rephrase'?{reusePassages:true,answer:true,keywords:null}:null):env.RAG_FOLLOWUPS_ENABLED==='true'?parsePdfFollowup(query):null;
 const summaryFollowup=pdfRequest?.mode==='answer'&&env.RAG_FOLLOWUPS_ENABLED==='true'&&env.RAG_WHOLE_SUMMARY_ENABLED==='true';
 const previous=followup||summaryFollowup?await recentPdfContext(env,owner,contextMessageId,{requireLatest:summaryFollowup||!!followup?.reusePassages}):null;
 const fullContext=summaryFollowup&&previous?.file_id===pdfRequest.fileId&&previous.reference?.scope==='full_extracted_text';
 if(followup&&!previous)return result(followup.reusePassages?'Which point do you mean? Ask the PDF question first, then I can rephrase it.':'Which PDF do you mean? Please name it once, then you can ask follow-up questions.');
 if(followup?.reusePassages&&previous.file_id!==pdfRequest.fileId)return result('Which PDF answer do you mean? Please reply directly to it.');
 const requested=pdfRequest?{name:pdfRequest.filename,fileId:pdfRequest.fileId,keywords:['preview','rephrase','summary','structure'].includes(pdfRequest.mode)?null:parsePdfFollowup(query)?.keywords??query}:followup?{name:previous.filename,fileId:previous.file_id,keywords:followup.keywords}:parsePdfReadCommand(query)??(isNaturalPdfRead(query)?await resolveNaturalPdf(env,owner,query):{});
 if(requested.answer)return result(requested.answer);
 const {name,keywords}=requested;
 if(!name){
  const listed=await env.DB.prepare("SELECT filename FROM file_catalog WHERE owner=? AND dataset=? AND mime_type='application/pdf' ORDER BY created_at DESC LIMIT 5").bind(owner,dataset(env)).all();
  return result('Ask naturally, for example: “Read my security checklist PDF” or “What does my security checklist PDF say about database credentials?”'+(listed.results.length?'\n\nSaved PDFs:\n'+listed.results.map(f=>title(f.filename)).join('\n'):'\n\nNo saved PDFs were found.'));
 }
 if(name.length>200)return result('Please use the exact PDF filename, up to 200 characters.');
 if(keywords!==null&&(!['passage_search','single_answer'].includes(env.RAG_REBUILD_STAGE)||!keywords||keywords.length>(pdfRequest?2000:200)))return result('Please ask a shorter, more specific question about the PDF.');
 const needsPassages=keywords!==null||followup?.reusePassages;
 const found=await env.DB.prepare(`SELECT file_id,filename,sha256,extraction_status,extraction_method,substr(extracted_text,1,?) AS preview,length(extracted_text) AS text_chars FROM file_catalog WHERE owner=? AND dataset=? AND mime_type='application/pdf' AND ${followup||pdfRequest?'file_id=?':'filename=? COLLATE NOCASE'} LIMIT 2`).bind(wholeText?FULL_TEXT_LIMIT+1:needsPassages?60001:1800,owner,dataset(env),followup||pdfRequest?requested.fileId:name).all();
 if(!found.results.length)return result('No saved PDF matches that exact filename. Please check the name.');
 if(found.results.length>1)return result('More than one saved PDF has that exact filename. Please give the PDFs distinct names before choosing one.');
 const file=found.results[0];
 if(env.RAG_PDF_BATCHES_ENABLED==='true'&&file.extraction_method==='pdf_text:paged')return readPagedPdf(env,owner,query,file,pdfRequest??{mode:keywords?'answer':'preview'},previous);
 if(file.extraction_status==='pending')return result('Found '+title(file.filename)+'. Its text is still processing.');
 if(file.extraction_status!=='ready'||file.extraction_method==='metadata'||!file.preview?.trim())return result('Found '+title(file.filename)+', but readable extracted text is unavailable.');
 const topic=followup?.reusePassages?previous.reference?.topic:query;
 const sourceScope=wholeText||fullContext?'full_extracted_text':followup?.reusePassages?previous.reference?.scope:null;
 const finish=outcome=>{
  if(env.RAG_FOLLOWUPS_ENABLED!=='true')return outcome;
  const ragSource={fileId:file.file_id,dataset:dataset(env)};
  if(env.RAG_PRONOUN_FOLLOWUPS_ENABLED==='true'&&['answered','passages'].includes(outcome.state)&&outcome.retrieval?.passages?.length&&typeof topic==='string'&&topic.length<=1000)Object.assign(ragSource,{textHash:hash(file.preview),topic});
  if(ragSource.textHash&&sourceScope==='full_extracted_text')ragSource.scope=sourceScope;
  return {...outcome,ragSource};
 };
 if(wholeText){
  if(file.text_chars>FULL_TEXT_LIMIT||file.preview.length>FULL_TEXT_LIMIT)return finish(result('This PDF is too long for a complete summary in one response. Please ask about a section or topic.'));
  const passages=[{position:0,start:0,end:file.preview.length,heading:'',content:file.preview}];
  const retrieval={method:documentStructure?'document_structure_full_text':'full_document_text',scope:'full_extracted_text',passages:[{position:0,charStart:0,charEnd:file.preview.length}]};
  const answer=await answerFromPassages(env,owner,query,file,passages,{fullText:true,documentStructure});
  return finish({...answer,answer:wholeSummary&&answer.state==='answered'?'Summary of the PDF’s readable text:\n\n'+answer.answer:answer.answer,retrieval});
 }
 if(needsPassages){
  if(file.text_chars>60000||file.preview.length>60000)return finish(result('This PDF has more text than this first passage-search version supports.'));
  let selected=followup?.reusePassages||fullContext?referencePassages(file.preview,previous.reference):findPassages(file.preview,keywords);
  if(fullContext&&selected.fullText)selected={...selected,method:'full_document_context'};
  if(selected.state==='reference_needed')return finish(result('Which point do you mean? Ask the PDF question first, then I can rephrase it.'));
  if(selected.state==='reference_stale')return finish(result('The PDF has changed since that answer. Please ask your PDF question again.'));
  if(selected.fullText&&env.RAG_WHOLE_SUMMARY_ENABLED!=='true')return finish(result('Please ask about a specific topic in this PDF.'));
  const semanticQuestion=pdfRequest?['answer','passages'].includes(pdfRequest.mode)&&['no_match','query_needed'].includes(selected.state):selected.state==='no_match'&&isNaturalPdfRead(query)&&wantsPdfAnswer(query)&&!/\d/u.test(keywords);
  if(semanticQuestion&&env.RAG_SEMANTIC_ENABLED==='true'&&env.RAG_REBUILD_STAGE==='single_answer'&&!parsePdfReadCommand(query)){
   try{selected=await findSemanticPassages(env,owner,file,keywords);}catch(error){return finish(semanticFailure(error));}
  }
  if(selected.state==='query_needed')return finish(result('Please ask a shorter, more specific question about the PDF.'));
  if(selected.state==='range_too_large')return finish(result('Please ask for a smaller range of checks, up to five at a time.'));
  if(selected.state==='ambiguous_range')return finish(result('Several numbered lists match that range. Please ask about the topic in words instead.'));
  if(!selected.passages.length)return finish({...result(selected.state==='range_missing'?'I could not locate that complete numbered range in '+title(file.filename)+'.':selected.state==='semantic_no_match'?'I could not find a relevant passage for that question in '+title(file.filename)+'.':'No text passages matched all those keywords in '+title(file.filename)+'.'),state:'no_match'});
  const previousAnswer=followup?.reusePassages?previous.reference?.answer??null:null;
  const retrieval={method:selected.method??'keyword_all_terms',...(selected.fullText?{scope:'full_extracted_text'}:{}),...(previousAnswer?{subjectContext:'previous_sent_answer'}:{}),passages:selected.passages.map(p=>({position:p.position,charStart:p.start,charEnd:p.end})),...(selected.ranking?{lexicalStatus:selected.lexicalStatus,ranking:selected.ranking}:{})};
  const previousQuestion=followup?.reusePassages?topic??null:null;
  const answerRequested=pdfRequest?['answer','rephrase'].includes(pdfRequest.mode):followup?followup.answer:wantsPdfAnswer(query);
  if(env.RAG_REBUILD_STAGE==='single_answer'&&answerRequested&&!parsePdfReadCommand(query))return finish({...await answerFromPassages(env,owner,query,file,selected.passages,{fullText:!!selected.fullText,previousAnswer,previousQuestion}),retrieval});
  return finish({state:'passages',sources:[],confirmed:false,answer:title(file.filename)+'\n\nMatching source passages:\n\n'+selected.passages.map((p,i)=>'['+(i+1)+']'+(p.heading?' '+title(p.heading):'')+'\n'+p.content.trim()).join('\n\n'),retrieval});
 }
 return finish(result(title(file.filename)+'\n\nPDF text preview:\n\n'+file.preview.trim()+(file.text_chars>1800?'\n\n[Preview ends here.]':'')));
}
