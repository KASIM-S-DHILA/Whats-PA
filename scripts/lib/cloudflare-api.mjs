import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
export const projectRoot = new URL('../../',import.meta.url);
const run=promisify(execFile);
export async function queryD1(sql){
  try{
    const {stdout}=await run(process.execPath,[fileURLToPath(new URL('node_modules/wrangler/bin/wrangler.js',projectRoot)),
      'd1','execute','whats-phase0-db','--remote','--command',sql,'--json'],{cwd:projectRoot,timeout:30000,
      env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
    const result=JSON.parse(stdout);if(result.some(row=>!row.success))throw new Error();
    return result.flatMap(row=>row.results);
  }catch{throw new Error('D1 request failed; private output withheld');}
}
export async function cfRequest(suffix,options={}){
  const config=JSON.parse(await readFile(new URL('wrangler.chat.jsonc',projectRoot),'utf8'));
  const tokenFile=process.env.WRANGLER_CREDENTIAL_FILE || path.join(process.env.APPDATA,'xdg.config','.wrangler','config','default.toml');
  const auth=await readFile(tokenFile,'utf8');const token=auth.match(/^oauth_token\s*=\s*"([^"\r\n]+)"/m)?.[1];
  if(!token)throw new Error('Authenticated Wrangler token unavailable');
  let response;
  try{response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${config.account_id}/${suffix}`,{
    ...options,headers:{Authorization:`Bearer ${token}`,...options.headers},redirect:'error',signal:AbortSignal.timeout(45000)});}
  catch{throw new Error('Cloudflare request failed; details withheld');}
  const data=await response.json();
  if(!response.ok||data.success!==true){const error=new Error('Cloudflare API failed (HTTP '+response.status+')');error.status=response.status;error.codes=data.errors?.map(e=>e.code);throw error;}
  return data.result;
}
