import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import postgres from 'postgres';

const outputDirectory=process.argv.find(a=>a.startsWith('--output='))?.slice(9);
const client=JSON.parse(await readFile(new URL('../.eval/client.json',import.meta.url),'utf8'));
const base=process.argv.find(a=>a.startsWith('--base='))?.slice(7)??client.baseUrl;
if(!['gateway','localhost','127.0.0.1'].includes(new URL(base).hostname))throw Error('Local benchmark only');
const env=await readFile(new URL('../.eval/compose.env',import.meta.url),'utf8');
const database=/^RECORDS_MIGRATION_URL=(.+)$/m.exec(env)?.[1];
if(!database||new URL(database).hostname!=='db')throw Error('Private local provisioning unavailable');
const sql=postgres(database,{max:1,onnotice:()=>{}});
const datastore=randomUUID(),binding=randomUUID(),key=`sse_${randomUUID()}_${randomUUID()}`;
await sql.begin(async tx=>{
 await tx`insert into records_private.datastores(id,org_id,module_id,api_major) values(${datastore},${client.orgId},'work',1)`;
 await tx`insert into records_private.bindings(id,datastore_id,principal_id,scopes) values(${binding},${datastore},${client.principalId},ARRAY['work.read','work.write'])`;
 await tx`insert into records_private.service_credentials(key_hash,binding_id) values(public.digest(${key},'sha256'),${binding})`;
});await sql.end();
const endpoint=`${base}/v1/datastores/${datastore}`,headers={authorization:`Bearer ${key}`,'content-type':'application/json'};
const controller=new AbortController();
const response=await fetch(`${endpoint}/events`,{headers,signal:controller.signal});
if(!response.ok||!response.body)throw Error(`SSE returned ${response.status}`);
let next:((time:number)=>void)|undefined;let frames=0;
function hint(){return Promise.race([new Promise<number>(resolve=>{next=resolve;}),new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(Error('Missing SSE hint')),5000);timer.unref();})]);}
const ready=hint();
const reader=response.body.getReader();
const consuming=(async()=>{const decoder=new TextDecoder();let pending='';try{for(;;){const part=await reader.read();if(part.done)break;pending+=decoder.decode(part.value,{stream:true});let end;while((end=pending.indexOf('\n\n'))!==-1){const frame=pending.slice(0,end);pending=pending.slice(end+2);if(frame.includes('event: changes')){frames++;const callback=next;next=undefined;callback?.(performance.now());}}}}catch(error){if(!controller.signal.aborted)throw error;}})();
const latencies:number[]=[];let durationMs=0;
try{
 await ready;const started=performance.now();
 for(let i=0;i<30;i++){
  const received=hint(),start=performance.now();
  const command=await fetch(`${endpoint}/modules/work/v1/rpc/work.create`,{method:'POST',headers:{...headers,'idempotency-key':`sse-${i}`},body:JSON.stringify({title:`SSE latency probe ${i}`})});
  if(!command.ok)throw Error(`Probe command returned ${command.status}`);
  await command.body?.cancel();latencies.push((await received)-start);
 }
 durationMs=performance.now()-started;
}finally{controller.abort();await consuming;}
latencies.sort((a,b)=>a-b);const p=(n:number)=>Number(latencies[Math.ceil(latencies.length*n)-1]!.toFixed(3));
const evidence={completedAt:new Date().toISOString(),samples:latencies.length,frames,durationMs,p50:p(.5),p95:p(.95),p99:p(.99),max:p(1),passed:latencies.length===30&&frames===31&&durationMs<15000&&p(.95)<1000,method:'Thirty serial HTTP creates in an otherwise idle dedicated datastore, with one live authenticated SSE subscription; initial frame consumed before measuring. Each command waits for its next change hint. A run at least 15 seconds long or containing extra frames fails to avoid conflating periodic reconciliation hints with notifications. Measured request-start to SSE hint is an upper bound on postcommit relay latency, not an exact commit timestamp.'};
console.log('SANITIZED_SSE_EVIDENCE '+JSON.stringify(evidence));
await writeFile(outputDirectory ? join(outputDirectory,'benchmark-sse.json') : new URL('../.eval/benchmark-sse.json',import.meta.url),JSON.stringify(evidence,null,2)+'\n');
await writeFile(outputDirectory ? join(outputDirectory,'benchmark-sse.md') : new URL('../docs/benchmark-sse.md',import.meta.url),`# Local SSE notification probe\n\nMeasured ${evidence.completedAt}.\n\n${evidence.method}\n\n- Samples: ${evidence.samples}; stream frames including initial frame: ${frames}.\n- Probe duration: ${durationMs.toFixed(2)} ms.\n- Latency p50/p95/p99: ${evidence.p50}/${evidence.p95}/${evidence.p99} ms.\n- Subsecond p95 gate: **${evidence.passed?'PASS':'NOT PASSED'}**.\n\nThis is a serial functional latency probe on the local reference stack, separate from the ten-minute sustained load test. It is not a production SLA or a sustained subscriber-load test.\n`);
console.log(JSON.stringify(evidence));
