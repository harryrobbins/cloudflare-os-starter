// DatastoreFeed: one Durable Object per datastore, holding the enabled change hooks of the gadget
// bindings on it, and delivering authorisation-filtered notifications (identifiers and revisions
// only, never record content) to them.
//
// A hook is registered for one of two deliveries:
//   "changes"  (the original) ChangeNotification batches from the outbox → Queue path
//   "pokes"    `{ datastoreId, head }` from the DatastorePokeHub after each commit; the gadget then
//              pulls by seq (`syncPull`). Pokes are coalesced: while one delivery round runs, later
//              heads replace each other and the newest is delivered next.
//
// Hooks are keyed by binding ID, so registering again replaces rather than duplicates. Before each
// delivery the binding is re-checked against Postgres; a revoked binding's hook is dropped. Each
// delivery opens a new hook session through the Workshop (startHook), authorises it as an
// observation, calls the gadget, and disposes every stub it received.

import { DurableObject } from "cloudflare:workers";
import type { HookInitiator, HookTargetMetadata } from "@gadgets/workshop-shared/gatekeeper";
import type { ChangeNotification, Poke } from "@records/contracts";

import type { RecordsService } from "@records/core";
import { recordsService } from "../runtime.js";
import type { RecordsChangeHook, RecordsPokeHook } from "../vendor/types.js";

export type HookDelivery = "changes" | "pokes";

type StoredHook = {
  orgId: string;
  bindingId: string;
  initiator: Fetcher<HookInitiator<never>>;
  target: HookTargetMetadata;
  /** Absent on hooks registered before pokes existed: "changes". */
  deliver?: HookDelivery;
};

type Started<C> = { callback: C; approvalQueue: { authorizeObservation(d: { title: string; description: string }): Promise<void> } };

function dispose(stub: unknown): void {
  try {
    (stub as { [Symbol.dispose]?: () => void } | undefined)?.[Symbol.dispose]?.();
  } catch {
    // already disposed
  }
}

export class DatastoreFeed extends DurableObject<Cloudflare.Env> {
  #service?: RecordsService;
  /** The newest head waiting for poke delivery, and the delivery round in progress. */
  #pendingPoke: number | null = null;
  #poking: Promise<number> | null = null;

  async register(orgId: string, bindingId: string, initiator: Fetcher<HookInitiator<never>>, target: HookTargetMetadata, deliver: HookDelivery = "changes"): Promise<void> {
    const previous = this.ctx.storage.kv.get<StoredHook>(`hook:${bindingId}`);
    this.ctx.storage.kv.put<StoredHook>(`hook:${bindingId}`, { orgId, bindingId, initiator, target, deliver });
    if (previous) dispose(previous.initiator);
  }

  async unregister(bindingId: string): Promise<void> {
    const previous = this.ctx.storage.kv.get<StoredHook>(`hook:${bindingId}`);
    this.ctx.storage.kv.delete(`hook:${bindingId}`);
    if (previous) dispose(previous.initiator);
  }

  async hookCount(deliver?: HookDelivery): Promise<number> {
    return [...this.ctx.storage.kv.list<StoredHook>({ prefix: "hook:" })].filter(([, h]) => !deliver || (h.deliver ?? "changes") === deliver).length;
  }

  /**
   * Deliver `{datastoreId, head}` to every hook registered for pokes. Coalesced: calls made while
   * a round is running collapse into one more round with the highest head they carried. Returns
   * the hook deliveries made by the rounds this call started (0 when it joined a running one).
   */
  async poke(datastoreId: string, head: number): Promise<number> {
    if (!Number.isSafeInteger(head) || head < 0) return 0;
    // Not monotonic on purpose: after a restore the head may go back, and subscribers must hear it.
    this.#pendingPoke = this.#pendingPoke === null ? head : Math.max(this.#pendingPoke, head);
    if (this.#poking) return 0;
    this.#poking = (async () => {
      let reached = 0;
      try {
        while (this.#pendingPoke !== null) {
          const next = this.#pendingPoke;
          this.#pendingPoke = null;
          reached += await this.#deliverPoke({ datastoreId, head: next });
        }
      } finally {
        this.#poking = null;
      }
      return reached;
    })();
    return this.#poking;
  }

  async #deliverPoke(poke: Poke): Promise<number> {
    let reached = 0;
    for (const [, hook] of this.ctx.storage.kv.list<StoredHook>({ prefix: "hook:" })) {
      if ((hook.deliver ?? "changes") !== "pokes") continue;
      if (!(await this.#stillBound(hook))) continue;
      let started: Started<RecordsPokeHook> | undefined;
      try {
        started = (await hook.initiator.startHook()) as unknown as Started<RecordsPokeHook>;
        await started.approvalQueue.authorizeObservation({
          title: "Records changed",
          description: `Tell the gadget that its datastore's change counter is now ${poke.head} (no record content).`,
        });
        await started.callback.poked(poke);
        reached++;
      } catch (err) {
        console.warn(JSON.stringify({ event: "records.feed.poke_failed", bindingId: hook.bindingId, error: err instanceof Error ? err.message : String(err) }));
      } finally {
        dispose(started?.callback);
        dispose(started?.approvalQueue);
      }
    }
    return reached;
  }

  /** Re-check the binding against Postgres; a revoked binding's hook is dropped. */
  async #stillBound(hook: StoredHook): Promise<boolean> {
    const service = (this.#service ??= recordsService(this.env));
    const binding = await service.registry.resolveBinding(hook.orgId, hook.bindingId);
    if (binding?.active) return true;
    await this.unregister(hook.bindingId);
    return false;
  }

  /** Deliver notifications to every enabled hook. Returns how many hooks were reached. */
  async deliver(notifications: ChangeNotification[]): Promise<number> {
    if (notifications.length === 0) return 0;
    // Collapse duplicates and keep the newest revision per entity.
    const latest = new Map<string, ChangeNotification>();
    for (const n of notifications) {
      const key = `${n.entityType}:${n.entityId}`;
      const seen = latest.get(key);
      if (!seen || n.revision >= seen.revision) latest.set(key, n);
    }
    const batch = [...latest.values()];
    let reached = 0;
    for (const [, hook] of this.ctx.storage.kv.list<StoredHook>({ prefix: "hook:" })) {
      if ((hook.deliver ?? "changes") !== "changes") continue;
      if (!(await this.#stillBound(hook))) continue;
      let started: Started<RecordsChangeHook> | undefined;
      try {
        started = (await hook.initiator.startHook()) as unknown as Started<RecordsChangeHook>;
        await started.approvalQueue.authorizeObservation({
          title: "Records changed",
          description: `Tell the gadget that ${batch.length} record(s) changed in its datastore (identifiers and revisions only).`,
        });
        await started.callback.changed(batch);
        reached++;
      } catch (err) {
        console.warn(JSON.stringify({ event: "records.feed.delivery_failed", bindingId: hook.bindingId, error: err instanceof Error ? err.message : String(err) }));
      } finally {
        dispose(started?.callback);
        dispose(started?.approvalQueue);
      }
    }
    return reached;
  }
}
