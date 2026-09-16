import { DurableObject } from "cloudflare:workers";
import { Sandbox as BaseSandbox, getSandbox } from "@cloudflare/sandbox";
import { withInterpreter, type CodeContext } from "@cloudflare/sandbox/interpreter";
import type { RuntimeIntent, RuntimeRun } from "./types.js";
import { collectOutput } from "./stream.js";

export class PythonSandbox extends BaseSandbox {
  interpreter = withInterpreter(this);
  override sleepAfter = "5m";
  override enableInternet = false;
}

type Kernel = { generation: number; context?: CodeContext; activeId?: string };
type Watchdog = { runId: string; generation: number; operation: "execute" | "stop" };

/** Private coordinator. Every run owns its generation and watchdog, including after eviction. */
export class RuntimeSession extends DurableObject<Cloudflare.Env> {
  #controller?: AbortController;
  #busy = false;
  #kernel: Kernel;
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.#kernel = ctx.storage.kv.get<Kernel>("kernel") ?? { generation: 0 };
    // A recorded in-flight run is never replayed after eviction. Its persisted watchdog cleans
    // up the OLD generation; a new run is refused until that cleanup has completed.
  }
  #sandbox(generation = this.#kernel.generation) {
    return getSandbox(this.env.PYTHON, `${this.ctx.id.toString().slice(0, 48)}-${generation}`, { sleepAfter: "5m" });
  }
  getState(): { generation: number; active: RuntimeRun | null } {
    return { generation: this.#kernel.generation,
      active: this.#kernel.activeId ? this.getRun(this.#kernel.activeId) : null };
  }
  getRun(id: string): RuntimeRun | null { return this.ctx.storage.kv.get<RuntimeRun>(`run:${id}`) ?? null; }

  reject(intent: RuntimeIntent): void {
    const prior = this.getRun(intent.requestId);
    if (prior?.status === "rejected") return;
    if (prior) throw new Error("Execution already started.");
    const run: RuntimeRun = { id: intent.requestId, sequence: intent.sequence, generation: intent.generation,
      cellId: intent.cellId, sourceRevision: intent.sourceRevision, status: "rejected", text: "", truncated: false };
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.kv.put(`run:${run.id}`, run);
      this.ctx.storage.kv.put("lastSequence", Math.max(intent.sequence, this.ctx.storage.kv.get<number>("lastSequence") ?? -1));
      const history = this.ctx.storage.kv.get<string[]>("history") ?? [];
      history.push(run.id);
      while (history.length > 64) this.ctx.storage.kv.delete(`run:${history.shift()!}`);
      this.ctx.storage.kv.put("history", history);
    });
  }

  async submit(intent: RuntimeIntent): Promise<void> {
    const prior = this.getRun(intent.requestId);
    if (prior?.status === "rejected") throw new Error("Runtime action was rejected.");
    if (prior) return;
    if (intent.sequence <= (this.ctx.storage.kv.get<number>("lastSequence") ?? -1)) throw new Error("Runtime action already consumed.");
    if (intent.generation !== this.#kernel.generation) throw new Error("Kernel changed. Refresh before running.");
    if ((this.#busy || this.#kernel.activeId) && intent.operation !== "stop") throw new Error("Python is busy or recovering; stop the kernel first.");
    // No async gap between admission, generation capture and cancellation registration.
    const sandbox = this.#sandbox(intent.generation);
    if (intent.operation === "stop") this.#controller?.abort();
    const controller = new AbortController(); this.#controller = controller; this.#busy = true;
    const oldId = this.#kernel.activeId;
    if (oldId) {
      const old = this.getRun(oldId);
      if (old) { old.status = "interrupted"; this.ctx.storage.kv.put(`run:${oldId}`, old); }
    }
    const run: RuntimeRun = { id: intent.requestId, sequence: intent.sequence, generation: intent.generation,
      cellId: intent.cellId, sourceRevision: intent.sourceRevision, status: "running", text: "", truncated: false };
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.kv.put("lastSequence", intent.sequence);
      this.ctx.storage.kv.put(`run:${run.id}`, run);
      this.#kernel.activeId = run.id;
      this.ctx.storage.kv.put("kernel", this.#kernel);
      this.ctx.storage.kv.put("watchdog", { runId: run.id, generation: run.generation, operation: intent.operation } satisfies Watchdog);
      const history = this.ctx.storage.kv.get<string[]>("history") ?? [];
      history.push(run.id);
      while (history.length > 64) this.ctx.storage.kv.delete(`run:${history.shift()!}`);
      this.ctx.storage.kv.put("history", history);
    });
    await this.ctx.storage.setAlarm(Date.now() + 90_000);
    this.ctx.waitUntil(this.#execute(intent, run, sandbox, controller));
  }

  async #execute(intent: RuntimeIntent, run: RuntimeRun, sandbox: ReturnType<RuntimeSession["_sandboxForType"]>, controller: AbortController): Promise<void> {
    const owns = () => this.#kernel.generation === run.generation && this.#kernel.activeId === run.id;
    const check = () => { if (!owns() || controller.signal.aborted) throw new Error("Execution interrupted."); };
    const save = () => { if (owns()) this.ctx.storage.kv.put(`run:${run.id}`, run); };
    const timer = setTimeout(() => {
      controller.abort();
      // Cancel is a hard reset; execution-timeout options are not relied upon for enforcement.
      this.ctx.waitUntil(sandbox.destroy().catch(() => {}));
    }, 60_000);
    let reset = intent.operation === "stop";
    let cleanupSucceeded = true;
    try {
      check();
      if (intent.operation === "stop") {
        await sandbox.destroy(); check();
        run.status = "succeeded"; run.text = "Kernel stopped. Variables and temporary files were discarded.";
      } else {
        if (this.#kernel.context) {
          const active = await sandbox.isRuntimeActive(); check();
          if (!active) throw new Error("Kernel expired.");
        }
        if (!this.#kernel.context) {
          const context = await sandbox.interpreter.createCodeContext({ language: "python", cwd: "/workspace" }); check();
          this.#kernel.context = context; this.ctx.storage.kv.put("kernel", this.#kernel);
        }
        check();
        const stream = await sandbox.interpreter.runCodeStream(intent.source, { context: this.#kernel.context });
        if (!owns() || controller.signal.aborted) { await stream.cancel().catch(() => {}); check(); }
        await collectOutput(stream, run, save, controller.signal);
      }
    } catch {
      reset = true;
      run.status = "interrupted";
      run.text = run.text.slice(0, 11_800) + "\nExecution stopped or kernel unavailable. This run was not replayed.";
      save();
      // Keep the watchdog if destruction fails; alarm retries cleanup, never user code.
      try { await sandbox.destroy(); } catch { cleanupSucceeded = false; return; }
    } finally {
      clearTimeout(timer);
      if (owns()) {
        save();
        // Only a completed/interrupted run may release the watchdog; a running stop that failed
        // retains its cleanup record. Alarm is the final recovery authority after eviction.
        if (run.status !== "running" && cleanupSucceeded) {
          this.#kernel = reset ? { generation: run.generation + 1 } : { generation: run.generation, context: this.#kernel.context };
          this.ctx.storage.kv.put("kernel", this.#kernel);
          this.ctx.storage.kv.delete("watchdog");
          await this.ctx.storage.deleteAlarm();
        }
      }
      if (this.#controller === controller) { this.#controller = undefined; this.#busy = false; }
    }
  }
  // Private helper's inferred client type, kept off the exported RPC surface below.
  private _sandboxForType() { return this.#sandbox(); }

  async alarm(): Promise<void> {
    const watchdog = this.ctx.storage.kv.get<Watchdog>("watchdog");
    if (!watchdog) return;
    if (this.#kernel.activeId === watchdog.runId) this.#controller?.abort();
    await this.#sandbox(watchdog.generation).destroy();
    // A stop may supersede this alarm while the container RPC is in flight.
    if (this.ctx.storage.kv.get<Watchdog>("watchdog")?.runId !== watchdog.runId) return;
    const run = this.getRun(watchdog.runId);
    if (run) { run.status = watchdog.operation === "stop" ? "succeeded" : "interrupted"; this.ctx.storage.kv.put(`run:${run.id}`, run); }
    this.#kernel = { generation: watchdog.generation + 1 };
    this.ctx.storage.kv.put("kernel", this.#kernel);
    this.ctx.storage.kv.delete("watchdog");
    this.#busy = false;
  }
}
