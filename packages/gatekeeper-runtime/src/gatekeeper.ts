import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type { AccountDescription, ApprovalQueue, Gatekeeper, GatekeeperConnectCallback,
  GatekeeperConnectOptions, GatekeeperUser, GatekeeperUserVerifier, ResourceConfiguratorFrame,
  ResourceDescription, SupportedResource, VendorDescription } from "@gadgets/workshop-shared/gatekeeper";
import type { NotebookRuntime, RuntimeIntent, RuntimeRun, RuntimeStatus } from "./types.js";
import { intentHash, validateIntent } from "./protocol.js";
import { TYPES_CODE, CONFIGURATOR_HTML } from "./generated.js";

const RESOURCE: SupportedResource = { urlPattern: "python://notebook/:name", title: "Notebook Python kernel",
  description: "A fresh isolated Python kernel for this connection. Saved results can be shared; only the workspace owner can request execution." };
class EmptyConfigurator extends RpcTarget {}
const AVATAR = { url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ctext y='25' font-size='28'%3Eπ%3C/text%3E%3C/svg%3E" };

type Props = { accountId: string; name: string };
type Action = { intent: RuntimeIntent; hash: string; run: RuntimeRun; submitted: boolean };

export class RuntimeAccountState extends DurableObject<Cloudflare.Env> {
  check(): void { if (this.ctx.storage.kv.get("revoked")) throw new Error("Python connection revoked."); }
  revoke(): void { this.ctx.storage.kv.put("revoked", true); }
}

@validateRpc()
export class RuntimeGatekeeper extends DurableObject<Cloudflare.Env, Props> implements Gatekeeper<NotebookRuntime> {
  #runtimeId(): string {
    let id = this.ctx.storage.kv.get<string>("runtimeId");
    if (!id) { id = crypto.randomUUID(); this.ctx.storage.kv.put("runtimeId", id); }
    return id;
  }
  #runner() { return this.env.SESSIONS.getByName(this.#runtimeId()); }
  async #check(): Promise<void> { await this.env.ACCOUNTS.getByName(this.ctx.props.accountId).check(); }
  async describe(): Promise<ResourceDescription> {
    return { url: `python://notebook/${this.ctx.props.name}`, title: "Notebook Python",
      snippet: "Owner-operated Python; collaborators can read saved results.", workspaceReadable: true, suggestedBindingName: "PYTHON", tsType: "NotebookRuntime" };
  }
  async getTypeScriptTypes(): Promise<string> { return TYPES_CODE; }
  async getAutoApprovableActions(): Promise<[]> { return []; }
  async startSession(queue: RpcStub<ApprovalQueue>): Promise<NotebookRuntime> {
    await this.#check(); return new RuntimeSessionApi(this, queue.dup());
  }
  // Sharing explicitly grants access to this notebook's outputs, never execution permits.
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}
  async removeObserver(_id: string): Promise<void> {}

  @skipRpcValidation()
  async status(): Promise<RuntimeStatus> {
    await this.#check();
    const runner = this.#runner(); const state = await runner.getState();
    const pending = this.ctx.storage.kv.get<string>("pending");
    const action = pending && this.ctx.storage.kv.get<Action>(`request:${pending}`);
    let active = state.active;
    if (action) {
      const latest = (await runner.getRun(pending)) ?? action.run;
      if (!active || latest.status === "pending" || latest.status === "submission-unknown" || latest.status === "running") active = latest;
    }
    return { sequence: this.ctx.storage.kv.get<number>("sequence") ?? 0, generation: state.generation, active };
  }
  @skipRpcValidation()
  async readRun(id: string): Promise<RuntimeRun | null> {
    await this.#check();
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid run ID.");
    return (await this.#runner().getRun(id)) ?? this.ctx.storage.kv.get<Action>(`request:${id}`)?.run ?? null;
  }
  @skipRpcValidation()
  async submitOperation(input: RuntimeIntent, permit: string, queue: RpcStub<ApprovalQueue>): Promise<RuntimeRun> {
    await this.#check();
    const intent = validateIntent(input); const hash = await intentHash(intent);
    const existing = this.ctx.storage.kv.get<Action>(`request:${intent.requestId}`);
    if (existing) {
      if (existing.hash !== hash) throw new Error("Request ID already used for a different operation.");
      // A response lost after submission is retrieved, never submitted/executed a second time.
      return existing.run;
    }
    const state = await this.status();
    if (intent.sequence !== state.sequence || intent.generation !== state.generation) throw new Error("Runtime changed. Refresh and retry.");
    if (state.active && ["pending", "submission-unknown", "running"].includes(state.active.status) && intent.operation !== "stop") throw new Error("Wait for the current run, or reject it in Activity.");
    await queue.consumeOwnerActionPermit(permit, hash, intent.sequence);
    // Recheck after the authority RPC: another owner's tab may have reserved this sequence.
    if ((this.ctx.storage.kv.get<number>("sequence") ?? 0) !== intent.sequence) throw new Error("Another operation was submitted. Refresh and retry.");
    const run: RuntimeRun = { id: intent.requestId, sequence: intent.sequence, generation: intent.generation,
      cellId: intent.cellId, sourceRevision: intent.sourceRevision, status: "pending", text: "", truncated: false };
    const action: Action = { intent, hash, run, submitted: false };
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.kv.put("sequence", intent.sequence + 1);
      this.ctx.storage.kv.put(`action:${intent.sequence}`, intent.requestId);
      this.ctx.storage.kv.put(`request:${intent.requestId}`, action);
      this.ctx.storage.kv.put("pending", intent.requestId);
      // Keep a bounded ledger; sequence rejects replays beyond this window.
      const expired = this.ctx.storage.kv.get<string>(`action:${intent.sequence - 64}`);
      if (expired) { this.ctx.storage.kv.delete(`request:${expired}`); this.ctx.storage.kv.delete(`action:${intent.sequence - 64}`); }
    });
    try {
      await queue.submitAction(intent.sequence, {
        title: intent.operation === "execute" ? "Run notebook Python cell" : "Stop notebook Python kernel",
        description: intent.operation === "execute"
          ? `Execute this exact Python source in an isolated, internet-disabled kernel (60 second limit). Output is shared with workspace collaborators.\n\n${intent.source.split("\n").map(line => "    " + line).join("\n")}`
          : "Stop this notebook's Python kernel. Variables, active execution and temporary files will be lost. Saved cells and outputs remain.",
        implementsRevert: false, awaitDecision: true,
      });
      const current = this.ctx.storage.kv.get<Action>(`request:${intent.requestId}`);
      if (current) { current.submitted = true; this.ctx.storage.kv.put(`request:${intent.requestId}`, current); }
    } catch {
      // Submission and storage are not atomic. Never resubmit an ambiguous operation automatically.
      const current = this.ctx.storage.kv.get<Action>(`request:${intent.requestId}`);
      if (current?.run.status === "pending") {
        current.run.status = "submission-unknown";
        current.run.text = "Submission outcome unknown. Check Activity: reject the original request, or click Stop / reset before running again.";
        this.ctx.storage.kv.put(`request:${intent.requestId}`, current);
      }
      return current?.run ?? run;
    }
    return run;
  }
  async applyAction(sequence: number): Promise<void> {
    await this.#check();
    const id = this.ctx.storage.kv.get<string>(`action:${sequence}`);
    const action = id && this.ctx.storage.kv.get<Action>(`request:${id}`);
    if (!action) throw new Error("Runtime action expired.");
    if (action.run.status === "rejected") throw new Error("Runtime action was rejected.");
    await this.#runner().submit(action.intent);
  }
  async rejectAction(sequence: number): Promise<void> {
    const id = this.ctx.storage.kv.get<string>(`action:${sequence}`);
    const action = id && this.ctx.storage.kv.get<Action>(`request:${id}`);
    if (!action) return;
    await this.#runner().reject(action.intent);
    action.run.status = "rejected"; this.ctx.storage.kv.put(`request:${id}`, action);
  }
  async revertAction(_sequence: number): Promise<void> { throw new Error("Python execution cannot be undone."); }
}

@validateRpc()
export class RuntimeSessionApi extends RpcTarget implements NotebookRuntime {
  constructor(private gatekeeper: RuntimeGatekeeper, private queue: RpcStub<ApprovalQueue>) { super(); }
  async #observe(): Promise<void> {
    await this.queue.authorizeObservation({ title: "Read notebook Python results", description: "Read execution status and outputs shared with this workspace." });
  }
  async getStatus(): Promise<RuntimeStatus> { await this.#observe(); return this.gatekeeper.status(); }
  async getRun(id: string): Promise<RuntimeRun | null> { await this.#observe(); return this.gatekeeper.readRun(id); }
  async submit(intent: RuntimeIntent, ownerPermit: string): Promise<RuntimeRun> {
    // Also authorize duplicate replies, which may carry previously observed status.
    await this.#observe(); return this.gatekeeper.submitOperation(intent, ownerPermit, this.queue);
  }
  [Symbol.dispose](): void { this.queue[Symbol.dispose](); }
}

@validateRpc()
export class RuntimeAccount extends WorkerEntrypoint<Cloudflare.Env, { accountId: string }> implements GatekeeperUser {
  async describe(): Promise<AccountDescription> { return { displayName: "Notebook Python", avatar: AVATAR }; }
  async getSupportedResources(): Promise<SupportedResource[]> { return [RESOURCE]; }
  async getGatekeeperClassFor(url: string): Promise<{ class: DurableObjectClass<Gatekeeper<NotebookRuntime>>; resource: SupportedResource }> {
    const match = /^python:\/\/notebook\/([a-zA-Z0-9_-]{1,64})$/.exec(url);
    if (!match) throw new Error("Expected python://notebook/<name>.");
    await this.env.ACCOUNTS.getByName(this.ctx.props.accountId).check();
    return { class: this.ctx.exports.RuntimeGatekeeper({ props: { accountId: this.ctx.props.accountId, name: match[1] } }), resource: RESOURCE };
  }
  async startResourceConfigurator(_pattern: string): Promise<ResourceConfiguratorFrame> {
    return { iframeHtml: CONFIGURATOR_HTML, ui: new RpcStub(new EmptyConfigurator()) };
  }
  async ensureResources(_patterns: string[]): Promise<{ url?: string }> { return {}; }
  async revoke(): Promise<void> { await this.env.ACCOUNTS.getByName(this.ctx.props.accountId).revoke(); }
  async reconnect(): Promise<{ url: string }> { throw new Error("Connect a new Python account instead."); }
  async getAuthenticatedEmail(): Promise<null> { return null; }
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> { return this.ctx.exports.RuntimeVerifier({}); }
}
@validateRpc()
export class RuntimeVerifier extends WorkerEntrypoint<Cloudflare.Env> implements GatekeeperUserVerifier {
  verify(): void {}
}
@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  async describe(): Promise<VendorDescription> {
    return { displayName: "Notebook Python", url: "https://developers.cloudflare.com/sandbox/", autoProvisionsAccount: true,
      tagline: "Python notebooks with shared results", description: "Connect a fresh Python kernel to a notebook. Only its workspace owner can request runs; collaborators can read outputs.", providesAuth: false };
  }
  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> { return this.ctx.exports.RuntimeAccount({ props: { accountId: crypto.randomUUID() } }); }
  async connectAccount(_callback: Fetcher<GatekeeperConnectCallback>, _options?: GatekeeperConnectOptions): Promise<{ url: string }> { throw new Error("This connector provisions accounts without OAuth."); }
  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> { return [RESOURCE]; }
  async getTypeScriptTypes(): Promise<string> { return TYPES_CODE; }
}
