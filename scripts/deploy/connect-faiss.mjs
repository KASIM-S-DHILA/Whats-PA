// Explicit operator setup only. No account creation, paid plan, keep-alive, inference or test request.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=new URL('../../',import.meta.url),configURL=new URL('wrangler.chat.jsonc',root),secretURL=new URL('.local/secrets/.rag-faiss.secret.json',root);
const cli=new URL('node_modules/wrangler/wrangler-dist/cli.js',root);
const run=(args,input)=>execFileSync(process.execPath,[fileURLToPath(cli),...args],{cwd:fileURLToPath(root),input,encoding:'utf8',env:{...process.env,CI:'true',WRANGLER_SEND_METRICS:'false'},stdio:['pipe','pipe','pipe']});
const argv=process.argv.slice(2);
if(argv.length===1&&argv[0]==='--prepare-secret'){
 let saved;try{saved=JSON.parse(await readFile(secretURL,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;saved={secret:randomBytes(32).toString('hex')};await writeFile(secretURL,JSON.stringify(saved),{flag:'wx',mode:0o600});}
 if(typeof saved.secret!=='string'||!/^[a-f0-9]{64}$/.test(saved.secret))throw new Error('Invalid dedicated secret file');
 const log=run(['secret','put','RAG_INDEX_SECRET','--config','wrangler.chat.jsonc'],saved.secret+'\n');
 await writeFile(new URL('.local/logs/faiss-secret-'+Date.now()+'.log',root),log,{flag:'wx'});
 console.log('Dedicated secret prepared privately in .local/secrets/.rag-faiss.secret.json and installed on the Worker. Set the same key privately in Render; no host has been connected.');
}else if(argv.length===2&&argv[0]==='--url'){
 const url=new URL(argv[1]);if(url.protocol!=='https:'||!url.hostname.endsWith('.onrender.com')||url.username||url.password||url.port||url.pathname!=='/'||url.search||url.hash)throw new Error('Provide the Render service HTTPS root URL with trailing slash');
 const key=JSON.parse(await readFile(secretURL,'utf8'));if(!/^[a-f0-9]{64}$/.test(key.secret??''))throw new Error('Prepare the dedicated secret first');
 const config=JSON.parse(await readFile(configURL,'utf8'));if(config.vars.RAG_ENABLED!=='true')throw new Error('RAG must be enabled first');
 const folder=new URL('.local/backups/faiss-connect-'+Date.now()+'/',root);await mkdir(folder,{recursive:true});await writeFile(new URL('wrangler.chat.jsonc',folder),await readFile(configURL),{flag:'wx'});
 config.vars.RAG_FAISS_URL=url.href;await writeFile(configURL,JSON.stringify(config,null,2)+'\n');
 const log=run(['deploy','--config','wrangler.chat.jsonc']);await writeFile(new URL('.local/logs/faiss-connect-'+Date.now()+'.log',root),log,{flag:'wx'});
 console.log('FAISS host connection deployed. Actual cold-start, snapshot retrieval, PDF parsing and quality still need owner verification.');
}else throw new Error('Usage: --prepare-secret OR --url https://SERVICE.onrender.com/');
