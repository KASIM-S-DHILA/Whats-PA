import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

test('active modules load',async()=>{
 for(const modulePath of [
  '../src/owners.js',
  '../src/rag-rebuild/context.js',
  '../src/rag-rebuild/answer.js',
  '../src/chat-recovery-v1/commands.js',
  '../src/chat-recovery-v1/search-query.js',
  '../src/chat-recovery-v1/replies.js',
 ])await import(modulePath);
});

test('owner configuration is exact and rejects invalid input',async()=>{
 const {configuredOwners,resolveOwner,ownerEnv}=await import('../src/owners.js');
 const env={ALLOWED_SENDER:'15550000001',ALLOWED_SENDERS:'["15550000001","15550000002"]'};
 assert.deepEqual(configuredOwners(env),['15550000001','15550000002']);
 assert.equal(resolveOwner(env,'15550000003'),null);
 assert.equal(ownerEnv(env,'15550000002').ALLOWED_SENDER,'15550000002');
 assert.throws(()=>configuredOwners({ALLOWED_SENDER:'bad'}),/invalid_owner_configuration/);
});

test('PDF follow-up parser keeps bounded numbered shortcuts',async()=>{
 const {parsePdfFollowup,REPHRASE_PASSAGE_LIMIT,REPHRASE_TEXT_LIMIT}=await import('../src/rag-rebuild/context.js');
 assert.deepEqual(parsePdfFollowup('Explain steps 2 to 4 simply'),{keywords:'steps 2 to 4',answer:true});
 assert.deepEqual(parsePdfFollowup('show me section 3'),{keywords:'section 3 to 3',answer:false});
 assert.equal(parsePdfFollowup('Summarize the whole PDF'),null);
 assert.equal(parsePdfFollowup('Random question'),null);
 assert.equal(REPHRASE_PASSAGE_LIMIT,6);
 assert.equal(REPHRASE_TEXT_LIMIT,14400);
});

test('rephrase limits reject oversized prior context before inference',async()=>{
 const {answerFromPassages}=await import('../src/rag-rebuild/answer.js');
 const env={ALLOWED_SENDER:'15550000001'};
 const file={filename:'test.pdf',paged:false,preview:'x'};
 const one=[{content:'evidence'}];
 const rejects=(options,passages=one)=>assert.rejects(
  ()=>answerFromPassages(env,'15550000001','question',file,passages,options),
  error=>error.code==='invalid_request'
 );
 await rejects({previousAnswer:'x'.repeat(4801)});
 await rejects({previousQuestion:'x'.repeat(2001)});
 await rejects({previousAnswer:'ok'},Array.from({length:7},()=>({content:'x'})));
 await rejects({previousAnswer:'ok'},[{content:'x'.repeat(2401)}]);
});

test('active command parser handles core commands',async()=>{
 const {parseCommand}=await import('../src/chat-recovery-v1/commands.js');
 assert.deepEqual(parseCommand({type:'text',text:{body:'help'}}),{kind:'help',args:{}});
 assert.deepEqual(parseCommand({type:'text',text:{body:'search invoices'}}),{kind:'search',args:{query:'invoices',sendBest:false}});
 assert.equal(parseCommand({type:'text',text:{body:'unknown'}}),null);
});

test('example configuration stays safe and points at the active entrypoint',()=>{
 const config=JSON.parse(readFileSync(path.join(root,'wrangler.chat.example.jsonc'),'utf8'));
 assert.equal(config.main,'src/chat-recovery-v1/worker.js');
 assert.ok(existsSync(path.join(root,config.main)));
 assert.equal(config.account_id,'YOUR_CLOUDFLARE_ACCOUNT_ID');
 assert.deepEqual(JSON.parse(config.vars.ALLOWED_SENDERS),[]);
 assert.equal(config.vars.SCHEDULER_ENABLED,'false');
 assert.deepEqual(config.triggers.crons,[]);
});

test('example secrets cover the documented deployment keys',()=>{
 const keys=new Set(readFileSync(path.join(root,'.dev.vars.example'),'utf8').split(/\r?\n/)
  .map(line=>line.match(/^([A-Z0-9_]+)=/)?.[1]).filter(Boolean));
 for(const key of ['META_VERIFY_TOKEN','META_APP_SECRET','META_ACCESS_TOKEN','ALLOWED_SENDER','SUPABASE_KEY','LIVEKIT_API_KEY','LIVEKIT_API_SECRET','VOICE_BRIDGE_SECRET','RAG_INDEX_SECRET'])assert.ok(keys.has(key),`missing ${key}`);
});

test('migrations are sequential, unique and SQL-only',()=>{
 const files=readdirSync(path.join(root,'migrations')).filter(name=>/^\d{4}_.+\.sql$/.test(name));
 const numbers=files.map(name=>Number(name.slice(0,4))).sort((a,b)=>a-b);
 assert.ok(numbers.length>0);
 assert.equal(new Set(numbers).size,numbers.length);
 assert.deepEqual(numbers,Array.from({length:numbers.length},(_,index)=>index+1));
});
