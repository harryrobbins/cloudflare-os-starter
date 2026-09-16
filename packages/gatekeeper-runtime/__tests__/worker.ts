import { DurableObject, RpcTarget, RpcStub } from 'cloudflare:workers';
import { RuntimeGatekeeper } from '../src/gatekeeper.js';
import type { RuntimeIntent } from '../src/types.js';
export { RuntimeGatekeeper, RuntimeAccountState, RuntimeSession, PythonSandbox } from '../src/index.js';
export { default } from '../src/index.js';
class Queue extends RpcTarget {
  observations = 0; submissions = 0;
  private authorizedAction?: number;
  constructor(private gatekeeper: RuntimeGatekeeper, private failSubmission = false, private legacyQueue = false) { super(); }
  async authorizeObservation() { this.observations++; }
  async consumeOwnerActionPermit(permit: string, _hash: string, action?: number) { if(permit !== 'owner') throw new Error('Owner permit required'); if (!this.legacyQueue) this.authorizedAction = action; }
  async submitAction(action: number) {
    this.submissions++;
    if (this.failSubmission) throw new Error("Injected queue disconnect");
    if (this.authorizedAction === action) { this.authorizedAction = undefined; await this.gatekeeper.applyAction(action); }
  }
}
export class FakeRunner extends DurableObject {
  getState() { return {generation:0,active:null}; }
  getRun(id:string) { return this.ctx.storage.kv.get('run:'+id) ?? null; }
  submit(intent:RuntimeIntent) { this.ctx.storage.kv.put('run:'+intent.requestId,{id:intent.requestId,status:'succeeded',text:'42',cellId:intent.cellId,sourceRevision:intent.sourceRevision,generation:0,sequence:intent.sequence,truncated:false}); }
}
export class TestHarness extends DurableObject {
  async check(intent:RuntimeIntent,permit:string,apply:boolean,failSubmission=false,legacyQueue=false) {
    // Run the real gatekeeper against this test object's storage and account props.
    Object.defineProperty(this.ctx, 'props', { value: { accountId: 'test', name: 'test' }, configurable: true });
    const gatekeeper = new RuntimeGatekeeper(this.ctx, this.env as Cloudflare.Env);
    const queue=new Queue(gatekeeper,failSubmission,legacyQueue);
    using queueStub=new RpcStub(queue);
    using session=await gatekeeper.startSession(queueStub);
    const before=await session.getStatus();
    const submitted=await session.submit(intent,permit);
    if(apply) await gatekeeper.applyAction(intent.sequence);
    const after=await session.getRun(intent.requestId);
    return {before,submitted,after,observations:queue.observations,submissions:queue.submissions};
  }
}
