// Run only through AWS's asm-exec wrapper. The dedicated key never enters logs or local files.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=new URL('../../',import.meta.url),configURL=new URL('wrangler.chat.jsonc',root);
const url=new URL(process.argv[2]??'');
const match=/^faiss-(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})\.sslip\.io$/.exec(url.hostname);
if(url.protocol!=='https:'||!match||match.slice(1).some(x=>Number(x)>255)||url.port||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('Expected the deployed EC2 service HTTPS root');
const key=process.env.RAG_INDEX_SECRET;
if(!/^[A-Za-z0-9]{64}$/.test(key??''))throw new Error('Dedicated AWS service key missing');
const config=JSON.parse(await readFile(configURL,'utf8'));
if(config.vars.RAG_ENABLED!=='true')throw new Error('RAG is not enabled');
const before=await readFile(configURL),stamp=Date.now(),folder=new URL('.local/backups/aws-faiss-connect-'+stamp+'/',root);
await mkdir(folder,{recursive:true});await writeFile(new URL('wrangler.chat.jsonc',folder),before,{flag:'wx'});
const {RAG_INDEX_SECRET:discarded,...childEnv}=process.env;
const run=(args,input)=>execFileSync(process.execPath,[fileURLToPath(new URL('node_modules/wrangler/wrangler-dist/cli.js',root)),...args],{cwd:fileURLToPath(root),input,encoding:'utf8',env:{...childEnv,CI:'true',WRANGLER_SEND_METRICS:'false'},stdio:['pipe','pipe','pipe']});
try{
 await writeFile(new URL('.local/logs/aws-faiss-secret-'+stamp+'.log',root),run(['secret','put','RAG_INDEX_SECRET','--config','wrangler.chat.jsonc'],key+'\n'),{flag:'wx'});
 config.vars.RAG_FAISS_URL=url.href;await writeFile(configURL,JSON.stringify(config,null,2)+'\n');
 await writeFile(new URL('.local/logs/aws-faiss-deploy-'+stamp+'.log',root),run(['deploy','--config','wrangler.chat.jsonc']),{flag:'wx'});
 console.log('AWS FAISS service key installed privately and Worker endpoint deployed. Runtime processing and owner Q&A checks remain separate.');
}catch(error){
 await writeFile(configURL,before);
 console.error('AWS connection deployment failed; local configuration restored. Inspect the private Wrangler logs.');
 process.exitCode=1;
}
