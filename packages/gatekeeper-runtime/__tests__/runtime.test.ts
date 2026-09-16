import { env } from 'cloudflare:test';
import { it, expect } from 'vitest';
import { intentHash } from '../src/protocol.js';
import { collectOutput } from '../src/stream.js';
import type { RuntimeIntent, RuntimeRun } from '../src/types.js';
const intent=():RuntimeIntent=>({requestId:crypto.randomUUID(),sequence:0,generation:0,operation:'execute',cellId:'cell',sourceRevision:1,source:'print(42)'});
it('authorizes reads but rejects collaborator execution',async()=>{
  const h=env.TEST.getByName(crypto.randomUUID());
  await expect((async () => await h.check(intent(),'collaborator',false))()).rejects.toThrow(/Owner permit/);
});
it('does not execute before approval; retries never submit another action',async()=>{
  const h=env.TEST.getByName(crypto.randomUUID()), request=intent();
  const a=await h.check(request,'owner',false);
  expect(a.submitted.status).toBe('pending');expect(a.after.status).toBe('pending');expect(a.observations).toBe(3);expect(a.submissions).toBe(1);
  const b=await h.check(request,'owner',true);expect(b.after.text).toBe('42');expect(b.submissions).toBe(0);
  await expect((async () => await h.check({...request,source:'bad'},'owner',true))()).rejects.toThrow(/different/);
});
it('intent digests bind exact source, generation and operation',async()=>{
 const a=intent();expect(await intentHash(a)).not.toBe(await intentHash({...a,source:'print(43)'}));
 expect(await intentHash(a)).not.toBe(await intentHash({...a,generation:1}));
 await expect(intentHash({...a,source:'x'.repeat(16001)})).rejects.toThrow();
});
it('streams bounded text, refuses active MIME, and requires an explicit completion',async()=>{
 const run:RuntimeRun={id:'x',sequence:0,generation:0,cellId:'x',sourceRevision:1,status:'running',text:'',truncated:false};
 const stream=(events:unknown[])=>new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join('')).body!;
 await collectOutput(stream([{type:'stdout',text:'x'.repeat(14000)},{type:'result',data:{'text/html':'<script>evil()</script>'}},{type:'execution_complete',execution_count:1}]),run,()=>{},new AbortController().signal);
 expect(run.text).toHaveLength(12000);expect(run.truncated).toBe(true);expect(run.status).toBe('succeeded');expect(run.executionCount).toBe(1);
 await expect(collectOutput(stream([{type:'stdout',text:'hi'}]),{...run},()=>{},new AbortController().signal)).rejects.toThrow(/completion/);
});

it('records uncertain submission without losing its identity or retrying the action', async () => {
  const h=env.TEST.getByName(crypto.randomUUID()), request=intent();
  const a=await h.check(request,'owner',false,true);
  expect(a.submitted.status).toBe('submission-unknown'); expect(a.submissions).toBe(1);
  const b=await h.check(request,'owner',false,false);
  expect(b.submitted.status).toBe('submission-unknown'); expect(b.submissions).toBe(0);
});
