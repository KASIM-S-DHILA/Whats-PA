import {createHmac} from 'node:crypto';
import {hash,ToolError} from '../search.js';
import {readStoredObject} from '../storage.js';
export const MODEL_CONTEXT_TOKENS=128000;
export async function nativePdfRequest(env,path,args,{file,timeout=20000}={}){
 const base=new URL(env.RAG_FAISS_URL);
 if(base.protocol!=='https:'||base.username||base.password||base.pathname!=='/'||!env.RAG_INDEX_SECRET)throw new ToolError('rag_pdf_host');
 const body=file?null:JSON.stringify(args),size=file?file.byte_size:Buffer.byteLength(body),digest=file?file.sha256:hash(body),stamp=String(Math.floor(Date.now()/1000));
 if(!Number.isSafeInteger(size)||size<1||size>(file?50*1024*1024:2*1024*1024))throw new ToolError('rag_input_limit');
 const sig=createHmac('sha256',env.RAG_INDEX_SECRET).update(`whats-pdf-tools:v1:${path}:${stamp}:${digest}:${size}`).digest('hex');
 const signal=AbortSignal.timeout(timeout);
 let payload=body,pipe=null;
 if(file){
  const stored=await readStoredObject(env,file.bucket,file.object_key,{timeout:45000});
  if(!stored.ok||!stored.body)throw new ToolError('rag_pdf_read');
  const stream=new FixedLengthStream(size);
  pipe=stored.body.pipeTo(stream.writable,{signal});payload=stream.readable;
 }
 const [response]=await Promise.all([fetch(new URL(path,base),{method:'POST',headers:{'Content-Type':file?'application/octet-stream':'application/json','X-Bridge-Time':stamp,'X-Bridge-Signature':sig,'X-Content-Sha256':digest},body:payload,redirect:'manual',signal}),...(pipe?[pipe]:[])]);
 if(!response.ok)throw new ToolError('rag_pdf_tools_http_'+response.status);
 const reader=response.body.getReader(),parts=[];let bytes=0;
 try{for(;;){const item=await reader.read();if(item.done)break;bytes+=item.value.length;if(bytes>1048576){await reader.cancel();throw new ToolError('rag_pdf_output');}parts.push(item.value);}}finally{reader.releaseLock();}
 return JSON.parse(new TextDecoder().decode(Buffer.concat(parts)));
}
export async function modelInputTokens(env,messages,maxOutput=512){
 const output=await nativePdfRequest(env,'/token-count',{messages},{timeout:12000});
 if(!Number.isSafeInteger(output.tokens)||output.tokens<1||output.tokenizer!=='mistralai/Mistral-Small-3.1-24B-Instruct-2503')throw new ToolError('rag_tokenizer_output');
 if(output.tokens+maxOutput+1024>MODEL_CONTEXT_TOKENS)throw new ToolError('rag_context_limit');
 return output.tokens;
}
