import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { cpus, totalmem, platform, arch } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import postgres from 'postgres';

const flag = (name: string, fallback: string) => process.argv.find(v => v.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const duration = Number(flag('duration', '600'));
const outputDirectory = flag('output', '');
const targetRate = Number(flag('rate', '60'));
const concurrency = Number(flag('concurrency', '16'));
if (!Number.isFinite(duration) || duration < 1 || duration > 3600 || !Number.isInteger(targetRate) || targetRate < 1 || targetRate > 500 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) throw Error('Invalid bounded benchmark configuration');
const fixture = JSON.parse(await readFile(new URL('../.eval/client.json', import.meta.url), 'utf8'));
const base = flag('base', fixture.baseUrl);
if (!['127.0.0.1', 'localhost', 'gateway'].includes(new URL(base).hostname)) throw Error('Benchmark only permits local reference deployment');
let endpoint = `${base}/v1/datastores/${fixture.work.datastoreId}`;
const headers = { authorization: `Bearer ${fixture.work.key}`, 'content-type': 'application/json' };
for (let attempt = 0; ; attempt++) {
  try {
    if (!(await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(2000) })).ok) throw Error('health');
    const described = await fetch(`${endpoint}/describe`, { headers, signal: AbortSignal.timeout(3000) });
    if (!described.ok) throw Error('describe');
    await described.body?.cancel(); break;
  } catch { if (attempt >= 90) throw Error('Local service did not become ready'); await new Promise(r => setTimeout(r, 1000)); }
}
// Keep benchmark rows away from the demo/snapshot fixtures. The privileged connection
// exists only inside this disposable local operator tool, never the public gateway.
const envText = await readFile(new URL('../.eval/compose.env', import.meta.url), 'utf8');
const migrationUrl = /^RECORDS_MIGRATION_URL=(.+)$/m.exec(envText)?.[1];
if (!migrationUrl || new URL(migrationUrl).hostname !== 'db') throw Error('Local provisioning connection unavailable');
const owner = postgres(migrationUrl, { max: 1, onnotice: () => {} });
const benchmarkDatastore = randomUUID(), benchmarkBinding = randomUUID(), benchmarkKey = `bench_${randomUUID()}_${randomUUID()}`;
await owner.begin(async tx => {
 await tx`insert into records_private.datastores(id,org_id,module_id,api_major) values(${benchmarkDatastore},${fixture.orgId},'work',1)`;
 await tx`insert into records_private.bindings(id,datastore_id,principal_id,scopes) values(${benchmarkBinding},${benchmarkDatastore},${fixture.principalId},ARRAY['work.read','work.write'])`;
 await tx`insert into records_private.service_credentials(key_hash,binding_id) values(public.digest(${benchmarkKey},'sha256'),${benchmarkBinding})`;
});
await owner.end();
fixture.work.datastoreId = benchmarkDatastore;
endpoint = `${base}/v1/datastores/${benchmarkDatastore}`;
headers.authorization = `Bearer ${benchmarkKey}`;
const listenerUrl = process.env.RECORDS_LISTENER_DATABASE_URL;
if (!listenerUrl) throw Error('Private listener connection is required to correlate commit hints');
const sql = postgres(listenerUrl, { max: 2, onnotice: () => {} });
const notifications = new Map<number, number>();
await sql.listen('records_changes', payload => {
  const event = JSON.parse(payload);
  if (event.datastore_id === fixture.work.datastoreId) notifications.set(Number(event.seq), performance.now());
});
const dbStats = async () => (await sql`select xact_commit,xact_rollback,deadlocks,conflicts,blks_read,blks_hit,blk_read_time,blk_write_time from pg_stat_database where datname=current_database()`)[0];
const beforeStats = await dbStats();
const pendingLocks: number[] = [];
let sampling = false;
const samplingTimer = setInterval(async () => {
  if (sampling) return; sampling = true;
  try { pendingLocks.push(Number((await sql`select count(*) count from pg_locks where not granted and database=(select oid from pg_database where datname=current_database())`)[0]!.count)); } catch { /* Sampling failure does not alter command results. */ }
  finally { sampling = false; }
}, 2000);
const run = randomUUID();
const latencies: number[] = [];
const successes: { seq: number; start: number; end: number }[] = [];
const errors: Record<string, number> = {};
let launched = 0, droppedSchedule = 0, maxInflight = 0;
const active = new Set<Promise<void>>();
const startedAt = new Date().toISOString(); const begin = performance.now();
async function send(index: number) {
 const start = performance.now();
 try {
  const response = await fetch(`${endpoint}/modules/work/v1/rpc/work.create`, { method: 'POST', headers: { ...headers, 'idempotency-key': `bench-${run}-${index}` }, body: JSON.stringify({ title: `Benchmark ${run} ${index}`, extensions: { benchmark: run } }), signal: AbortSignal.timeout(15000) });
  const end = performance.now(); latencies.push(end-start);
  if (!response.ok) { errors[`http_${response.status}`] = (errors[`http_${response.status}`] ?? 0)+1; await response.body?.cancel(); return; }
  const result = await response.json(); successes.push({seq:result.seq,start,end});
 } catch { errors.transport = (errors.transport ?? 0)+1; }
}
console.log(`Local benchmark started: ${duration}s, ${targetRate} requests/s, concurrency cap ${concurrency}. No credentials or record contents are logged.`);
let nextProgress = begin + 30000;
while (performance.now() - begin < duration * 1000) {
 const due = begin + launched * 1000 / targetRate;
 const delay = due-performance.now();
 if (delay > 0) await new Promise(r => setTimeout(r, Math.min(delay, 100)));
 if (performance.now()-begin >= duration*1000) break;
 if (performance.now() < due) continue;
 const index = launched++;
 if (active.size >= concurrency) { droppedSchedule++; continue; }
 const request = send(index).finally(() => active.delete(request)); active.add(request); maxInflight=Math.max(maxInflight,active.size);
 if (performance.now()>=nextProgress) { console.log(`Progress ${Math.round((performance.now()-begin)/1000)}s: ${successes.length} successful, ${Object.values(errors).reduce((a,b)=>a+b,0)} errors, ${droppedSchedule} capacity skips`); nextProgress+=30000; }
}
await Promise.all(active); const elapsedMs=performance.now()-begin;
await new Promise(r=>setTimeout(r,1000)); clearInterval(samplingTimer);
while(sampling) await new Promise(r=>setTimeout(r,10));
const afterStats = await dbStats(); await sql.end();
const statsDelta = Object.fromEntries(Object.entries(afterStats!).map(([key,value])=>[key,Number(value)-Number(beforeStats![key])]));
function percentiles(values: number[]) { const sorted=[...values].sort((a,b)=>a-b); const q=(p:number)=>sorted.length ? Number(sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*p)-1)]!.toFixed(3)) : null;return {samples:sorted.length,p50:q(.5),p95:q(.95),p99:q(.99),max:q(1)}; }
const notifyLatency = successes.flatMap(s=>notifications.has(s.seq) ? [notifications.get(s.seq)!-s.start] : []);
const responseToNotify = successes.flatMap(s=>notifications.has(s.seq) ? [notifications.get(s.seq)!-s.end] : []);
const hardware = { platform:platform(), architecture:arch(), cpuModel:cpus()[0]?.model, logicalCpus:cpus().length, systemMemoryBytes:totalmem(),node:process.version,cgroupCpuMax:await readFile('/sys/fs/cgroup/cpu.max','utf8').then(s=>s.trim()).catch(()=>null),cgroupMemoryMax:await readFile('/sys/fs/cgroup/memory.max','utf8').then(s=>s.trim()).catch(()=>null) };
const successRate=successes.length/(elapsedMs/1000);
const evidence={benchmarkDatastore,startedAt,completedAt:new Date().toISOString(),durationSeconds:duration,elapsedSeconds:elapsedMs/1000,targetRequestsPerSecond:targetRate,maxConcurrency:concurrency,maxObservedInflight:maxInflight,scheduled:launched,attempted:launched-droppedSchedule,capacitySkips:droppedSchedule,successful:successes.length,successfulPerSecond:successRate,errors,requestLatencyMs:percentiles(latencies),requestStartToPostCommitNotificationMs:percentiles(notifyLatency),responseHeadersToNotificationMs:percentiles(responseToNotify),missingNotifications:successes.length-notifyLatency.length,lockWaitSamples:percentiles(pendingLocks),databaseStatsDelta:statsDelta,hardware,passedTenMinute50PerSecondGate:duration>=600&&successRate>=50&&Object.keys(errors).length===0,passedNotificationGate:notifyLatency.length===successes.length&&notifyLatency.length>0&&percentiles(notifyLatency).p95!<1000,notes:['Synthetic small work.create commands through HTTP gateway and ES256 PostgREST on one datastore; concurrency bounded. HTTP latency ends at response headers; bodies are consumed before a request completes.','Notification latency correlates durable sequence to PostgreSQL LISTEN delivery, measured from request start; this upper-bounds commit-to-listener latency. It does not measure SSE browser delivery.','Response-to-notification can be negative because LISTEN can arrive before HTTP headers.','Database counters include other local work during measurement; pg_locks count samples are not per-command lock wait durations.','Docker resources share the host. This is local reference evidence, not a production SLA.','Each request creates one retained synthetic record in a dedicated benchmark datastore; demo fixtures remain untouched. No cleanup/delete capability is implied.']};
console.log('SANITIZED_BENCHMARK_EVIDENCE '+JSON.stringify(evidence));
if (!outputDirectory) await mkdir(new URL('../docs/',import.meta.url),{recursive:true});
await writeFile(outputDirectory ? join(outputDirectory,'benchmark.json') : new URL('../.eval/benchmark.json',import.meta.url),JSON.stringify(evidence,null,2)+'\n');
await writeFile(outputDirectory ? join(outputDirectory,'benchmark.md') : new URL('../docs/benchmark.md',import.meta.url),`# Local reference benchmark\n\nMeasured ${startedAt}.\n\n- Duration: ${(elapsedMs/1000).toFixed(2)} seconds; target ${targetRate} requests/s; concurrency cap ${concurrency}.\n- Successful commands: ${successes.length}; achieved **${successRate.toFixed(2)}/s**.\n- Errors: ${JSON.stringify(errors)}; capacity skips: ${droppedSchedule}.\n- HTTP response-header latency p50/p95/p99: ${evidence.requestLatencyMs.p50}/${evidence.requestLatencyMs.p95}/${evidence.requestLatencyMs.p99} ms.\n- Request start to correlated after-commit LISTEN hint p50/p95/p99: ${evidence.requestStartToPostCommitNotificationMs.p50}/${evidence.requestStartToPostCommitNotificationMs.p95}/${evidence.requestStartToPostCommitNotificationMs.p99} ms; missing hints ${evidence.missingNotifications}.\n- Ten-minute 50/s gate: **${evidence.passedTenMinute50PerSecondGate?'PASS':'NOT PASSED'}**. Notification gate: **${evidence.passedNotificationGate?'PASS':'NOT PASSED'}**.\n- Hardware: ${hardware.cpuModel}, ${hardware.logicalCpus} logical CPUs, ${(hardware.systemMemoryBytes/1024**3).toFixed(1)} GiB system RAM; cgroup CPU ${hardware.cgroupCpuMax}, memory ${hardware.cgroupMemoryMax}.\n- Sampled pending locks maximum: ${evidence.lockWaitSamples.max}; database deadlock delta: ${statsDelta.deadlocks}.\n\n${evidence.notes.map(n=>`- ${n}`).join('\n')}\n\nReproduce locally: run this script in the private Compose network with a writable service checkout, \`--base=http://gateway:8788 --duration=600 --rate=60\`. It loads ignored fixture credentials without printing them. Sanitized machine evidence is written to \`.eval/benchmark.json\`.\n`);
console.log(JSON.stringify({successfulPerSecond:successRate,errors,throughputGate:evidence.passedTenMinute50PerSecondGate,notificationGate:evidence.passedNotificationGate}));
