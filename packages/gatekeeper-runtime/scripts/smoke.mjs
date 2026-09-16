import assert from 'node:assert/strict';
const origin=process.env.NOTEBOOK_RUNTIME_URL ?? 'http://127.0.0.1:8794';
const session=crypto.randomUUID();
async function call(path,body){const r=await fetch(`${origin}${path}${path.includes('?')?'&':'?'}session=${session}`,body?{method:'POST',body:JSON.stringify(body),headers:{'content-type':'application/json'}}:{});const data=await r.json();if(!r.ok)throw new Error(JSON.stringify(data));return data;}
async function wait(id){for(let i=0;i<100;i++){const run=await call('/run?id='+id);if(run&&run.status!=='running')return run;await new Promise(r=>setTimeout(r,1000));}throw new Error('Run timed out');}
let sequence=0;
async function execute(source){const state=await call('/state');const request={requestId:crypto.randomUUID(),sequence:sequence++,generation:state.generation,operation:'execute',cellId:'smoke',sourceRevision:1,source};await call('/submit',request);return {request,result:await wait(request.requestId)};}
assert.deepEqual(await call('/state'),{generation:0,active:null});
const rejected={requestId:crypto.randomUUID(),sequence:sequence++,generation:0,operation:'execute',cellId:'smoke',sourceRevision:1,source:'print("must not run")'};
await call('/reject',rejected);
await assert.rejects(call('/submit',rejected), /rejected/);
const a=await execute('answer = 40\nprint("ready")');assert.equal(a.result.status,'succeeded',JSON.stringify(a.result));assert.match(a.result.text,/ready/);
const b=await execute('answer += 2\nprint(answer)');assert.equal(b.result.status,'succeeded',JSON.stringify(b.result));assert.match(b.result.text,/42/);
await call('/submit',b.request);
await assert.rejects(call('/reject',b.request), /already started/);
const c=await execute('print(answer)');assert.match(c.result.text,/42/);
const network=await execute('import urllib.request\ntry:\n    urllib.request.urlopen("https://example.com", timeout=3)\n    print("NETWORK_ALLOWED")\nexcept Exception:\n    print("NETWORK_DENIED")');
assert.match(network.result.text,/NETWORK_DENIED/);assert.doesNotMatch(network.result.text,/NETWORK_ALLOWED/);
const d=await execute('raise ValueError("expected smoke failure")');assert.equal(d.result.status,'failed',JSON.stringify(d.result));
const e=await execute('print("x" * 20000)');assert.equal(e.result.truncated,true);assert.ok(e.result.text.length<=12000);
const state=await call('/state');const slow={requestId:crypto.randomUUID(),sequence:sequence++,generation:state.generation,operation:'execute',cellId:'slow',sourceRevision:1,source:'import time\ntime.sleep(120)'};
await call('/submit',slow);await new Promise(r=>setTimeout(r,1500));
const stop={requestId:crypto.randomUUID(),sequence:sequence++,generation:state.generation,operation:'stop',cellId:'',sourceRevision:0,source:''};await call('/submit',stop);
assert.equal((await wait(stop.requestId)).status,'succeeded');assert.equal((await wait(slow.requestId)).status,'interrupted');
assert.equal((await call('/state')).generation,state.generation+1);
const fresh=await execute('print("answer" in globals())');assert.match(fresh.result.text,/False/);
const end=await call('/state');await call('/submit',{...stop,requestId:crypto.randomUUID(),sequence:sequence++,generation:end.generation});
console.log('PASS: Python startup, cross-cell state, duplicate submission, errors, internet denial, bounded output, stop during execution, reset isolation.');
