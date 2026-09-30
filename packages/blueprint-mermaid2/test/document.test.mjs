import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const code=(await readFile(new URL('../src/server/index.js',import.meta.url),'utf8')).replace("import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';",'const {DurableObject,WorkerEntrypoint}=globalThis.__mermaid2TestRuntime;');
globalThis.__mermaid2TestRuntime={DurableObject:class {constructor(ctx,env){this.ctx=ctx;this.env=env;}},WorkerEntrypoint:class {}};
const {Gadget}=await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
delete globalThis.__mermaid2TestRuntime;

test('persistent drafts reject concurrent overwrites and preserve separate language source', async () => {
  const entries=new Map(); const rendered=[];
  const gadget=new Gadget({storage:{kv:{get:key=>entries.get(key),put:(key,value)=>entries.set(key,value)}}},{MERMAID2:{render:input=>{rendered.push(input);return input;}}});
  const document={drafts:{d2:'a -> b',mermaid:'flowchart LR\n A --> B'},language:'d2',layout:'elk',theme:'104',live:true,sketch:false};
  assert.equal(gadget.getDocument().revision,0);
  const saved=gadget.setDocument({expectedRevision:0,document});assert.equal(saved.revision,1);
  assert.throws(()=>gadget.setDocument({expectedRevision:0,document:{...document,language:'mermaid'}}),/conflict/);
  assert.equal(gadget.getDocument().drafts.mermaid,document.drafts.mermaid);
  await gadget.exportDiagram('png',3);assert.equal(rendered[0].layout,'elk');assert.equal(rendered[0].source,'a -> b');assert.equal(rendered[0].scale,3);
  assert.throws(()=>gadget.setDocument({expectedRevision:1,document:{...document,layout:'unknown'}}),/invalid_request/);
});
