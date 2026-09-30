import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parse } from 'jsonc-parser';
const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url);
const deployment=parse(await readFile(join(root,'../../deployment.jsonc'),'utf8'));
assert.equal(deployment.mermaid2?.enabled,true);
const folder=await mkdtemp(join(tmpdir(),'mermaid2-rpc-'));
const config=join(folder,'wrangler.jsonc');
await writeFile(config,JSON.stringify({name:'mermaid2-local-verification',main:join(root,'scripts/verify-worker.mjs'),account_id:deployment.accountId,compatibility_date:'2026-08-22',compatibility_flags:['nodejs_compat'],workers_dev:false,preview_urls:false,services:[{binding:'MERMAID2',service:deployment.workers.mermaid2.name,entrypoint:'DiagramRenderer',remote:true},{binding:'VENDOR',service:deployment.workers.mermaid2.name,entrypoint:'GatekeeperVendor',remote:true},{binding:'WORKSHOP',service:deployment.workers.workshop.name,remote:true}]}));
const processHandle=spawn(process.execPath,[join(dirname(require.resolve('wrangler/package.json')),'bin/wrangler.js'),'dev','--config',config,'--ip','127.0.0.1','--port','8894','--inspector-port','0'],{cwd:root,stdio:['ignore','pipe','pipe']});
let log='';for(const stream of [processHandle.stdout,processHandle.stderr])stream.on('data',data=>{log=(log+data.toString()).slice(-8000);});
const base='http://127.0.0.1:8894';
const fetchProbe=(path,options={})=>fetch(base+path,{...options,signal:AbortSignal.timeout(150000)});
try{
 let ready=false;
 for(let count=0;count<60;count++){
  if(processHandle.exitCode!==null)throw new Error('Wrangler verification server exited: '+log);
  try{ready=(await fetchProbe('/health')).ok;}catch{}
  if(ready)break;await new Promise(resolve=>setTimeout(resolve,1000));
 }
 // The local probe uses the newest date supported by the checkout's pinned workerd.
 assert.ok(ready,'Verification server did not start: '+log);
 const workshop=await (await fetchProbe('/workshop')).json();assert.equal(workshop.status,403);
 const capabilities=await (await fetchProbe('/capabilities')).json();
 assert.deepEqual(capabilities.layouts,['tala','dagre','elk']);assert.equal(capabilities.formats.length,9);
 const vendor=await (await fetchProbe('/vendor')).json();assert.equal(vendor.vendor,'MermaiD2');assert.ok(vendor.configurator);
 for(const id of ['mermaid2-connector','mermaid2-blueprint','d2-authoring'])assert.match(await (await fetchProbe('/skills/'+id)).text(),new RegExp('name: '+id));
 for(const language of ['d2','mermaid'])for(const layout of ['tala','dagre','elk']){
  const source=language==='d2'?'a: Client\nb: API\na -> b':'flowchart LR\n a[Client] --> b[API]';
  const response=await fetchProbe('/render',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({source,language,layout,format:'svg'})});
  assert.equal(response.status,200,await response.clone().text());assert.match(await response.text(),/<svg/);assert.equal(response.headers.get('x-nodes'),'2');
  console.log(`${language}/${layout}/svg: passed`);
 }
 for(const format of capabilities.formats.filter(candidate=>candidate!=='svg')){
  const response=await fetchProbe('/render',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({source:'a: Client\nb: API\na -> b',language:'d2',layout:'tala',format,scale:1})});
  assert.equal(response.status,200,await response.clone().text());const data=Buffer.from(await response.arrayBuffer());assert.ok(data.length>20);
  if(format==='png')assert.equal(data.subarray(1,4).toString(),'PNG');
  if(format==='jpeg')assert.equal(data.subarray(0,2).toString('hex'),'ffd8');
  if(format==='webp')assert.equal(data.subarray(8,12).toString(),'WEBP');
  if(format==='pdf')assert.equal(data.subarray(0,5).toString(),'%PDF-');
  if(format==='json')assert.ok(JSON.parse(data.toString()).diagram);
  console.log(`d2/tala/${format}: passed (${data.length} bytes)`);
 }
 const invalid=await fetchProbe('/render',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({source:'a -> b',layout:'unknown'})});assert.equal(invalid.status,422);
 console.log('Live private RPC, connector resource, skills and invalid-input checks passed.');
}finally{
 processHandle.kill('SIGTERM');await new Promise(resolve=>processHandle.exitCode!==null?resolve():processHandle.once('exit',resolve));await rm(folder,{recursive:true,force:true});
}
