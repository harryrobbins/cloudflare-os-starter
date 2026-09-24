// Test worker for the workerd suite. Re-exports the production entrypoints and adds TestHooks, a
// Durable Object that instantiates RecordsGatekeeper as a facet (the way the overseer does) and
// drives it with a scripted ApprovalQueue standing in for the kernel.

import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type { GadgetViewer } from "@gadgets/workshop-shared/api";
import type { ActionDescription, ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";

import type { RecordsGatekeeper, RecordsGatekeeperProps } from "../../src/vendor/gatekeeper.js";

export { default } from "../../src/index.js";
export {
  DatastoreFeed,
  DatastorePokeHub,
  GatekeeperVendor,
  RecordsAccount,
  RecordsConnectFlow,
  RecordsGatekeeper,
  RecordsHookController,
  RecordsVerifier,
} from "../../src/index.js";

type Log = { observations: ObservationDescription[]; actions: { id: number; description: ActionDescription }[] };

/**
 * Plays the kernel's ApprovalQueue: viewer assertions are one-use tokens bound to a digest (like
 * ActionPermits), observations are recorded, and actions are applied immediately when `autoApply`.
 */
class ScriptedQueue extends RpcTarget {
  constructor(
    private readonly log: Log,
    private readonly assertions: Map<string, { digest: string; viewer: GadgetViewer }>,
    private readonly apply: ((id: number) => Promise<void>) | null,
    private readonly refuseExcluded: boolean,
  ) {
    super();
  }
  async authorizeObservation(d: ObservationDescription) {
    if (this.refuseExcluded && d.excludeObservers?.length) throw new Error("cannot hide this observation from a current observer");
    this.log.observations.push(d);
  }
  async consumeViewerAssertion(token: string, digest: string): Promise<GadgetViewer> {
    const a = this.assertions.get(token);
    this.assertions.delete(token);
    if (!a || a.digest !== digest) throw new Error("This operation requires a fresh assertion from the person using the gadget.");
    return a.viewer;
  }
  async consumeOwnerActionPermit() {
    throw new Error("not used");
  }
  async submitAction(id: number, description: ActionDescription) {
    this.log.actions.push({ id, description });
    if (this.apply) await this.apply(id).catch(() => {});
  }
  async bindHook() {
    throw new Error("hooks are covered separately");
  }
}

type Call = { method: string; args: unknown[] };

type HooksStub = { recordPoke(log: string, poke: unknown): Promise<void> };

/** Plays the Workshop's HookInitiator for a feed hook: each startHook() yields a recording callback. */
export class TestInitiator extends WorkerEntrypoint<Cloudflare.Env, { log: string }> {
  async startHook() {
    const log = this.ctx.props.log;
    const hooks = (this.env as unknown as { TEST_HOOKS: DurableObjectNamespace }).TEST_HOOKS.getByName("hooks") as unknown as HooksStub;
    return {
      callback: new (class extends RpcTarget {
        async poked(poke: unknown) {
          await hooks.recordPoke(log, poke);
        }
        changed() {}
        resync() {}
      })(),
      approvalQueue: new (class extends RpcTarget {
        async authorizeObservation() {}
      })(),
    };
  }
}

export class TestHooks extends DurableObject<Cloudflare.Env> {
  #assertions = new Map<string, { digest: string; viewer: GadgetViewer }>();
  #pokes = new Map<string, unknown[]>();

  async recordPoke(log: string, poke: unknown): Promise<void> {
    this.#pokes.set(log, [...(this.#pokes.get(log) ?? []), poke]);
  }

  pokesFor(log: string): unknown[] {
    return this.#pokes.get(log) ?? [];
  }

  /** Register a feed hook for `bindingId` whose callbacks are recorded under `log`. */
  async registerHook(datastoreId: string, orgId: string, bindingId: string, log: string, deliver: "changes" | "pokes"): Promise<void> {
    const exports = this.ctx.exports as unknown as { TestInitiator(o: { props: { log: string } }): Fetcher };
    const feeds = (this.env as unknown as { FEEDS: DurableObjectNamespace }).FEEDS.getByName(datastoreId) as unknown as {
      register(orgId: string, bindingId: string, initiator: Fetcher, target: unknown, deliver: string): Promise<void>;
    };
    await feeds.register(orgId, bindingId, exports.TestInitiator({ props: { log } }), { title: "test" }, deliver);
  }

  #facet(name: string, props: RecordsGatekeeperProps) {
    const exports = this.ctx.exports as unknown as { RecordsGatekeeper(o: { props: RecordsGatekeeperProps }): DurableObjectClass<RecordsGatekeeper> };
    return this.ctx.facets.get<RecordsGatekeeper>(name, () => ({ class: exports.RecordsGatekeeper({ props }) }));
  }

  /** Mint a one-use assertion for `viewer` and `digest`, as GadgetClient.createViewerAssertion would. */
  mintAssertion(digest: string, viewer: GadgetViewer): string {
    const token = crypto.randomUUID();
    this.#assertions.set(token, { digest, viewer });
    return token;
  }

  async describe(name: string, props: RecordsGatekeeperProps) {
    const d = await this.#facet(name, props).describe();
    return { url: d.url, title: d.title, snippet: d.snippet };
  }

  async addObserver(name: string, props: RecordsGatekeeperProps, id: string, identity: { orgId: string; principalId: string }): Promise<string | null> {
    const verifier = new RpcStub(new (class extends RpcTarget { identity() { return identity; } })());
    try {
      await this.#facet(name, props).addObserver(id, verifier as never);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  /** Run a sequence of session calls in one session. Returns results (or error messages) and the queue log. */
  async session(name: string, props: RecordsGatekeeperProps, calls: Call[], opts: { autoApply?: boolean; refuseExcluded?: boolean } = {}) {
    const facet = this.#facet(name, props);
    const log: Log = { observations: [], actions: [] };
    const queue = new RpcStub(new ScriptedQueue(log, this.#assertions, opts.autoApply === false ? null : (id) => facet.applyAction(id), opts.refuseExcluded ?? false));
    using session = (await facet.startSession(queue as never)) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>> & Disposable;
    const results: unknown[] = [];
    for (const call of calls) {
      try {
        results.push({ ok: await session[call.method]!(...call.args) });
      } catch (err) {
        results.push({ error: err instanceof Error ? err.message : String(err) });
      }
    }
    return JSON.parse(JSON.stringify({ results, log }));
  }

  async applyAction(name: string, props: RecordsGatekeeperProps, id: number): Promise<string | null> {
    try {
      await this.#facet(name, props).applyAction(id);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  async rejectAction(name: string, props: RecordsGatekeeperProps, id: number): Promise<void> {
    await this.#facet(name, props).rejectAction(id);
  }
}
