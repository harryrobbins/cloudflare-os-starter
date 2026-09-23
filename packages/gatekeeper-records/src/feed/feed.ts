// DatastoreFeed: one Durable Object per datastore, holding the enabled change hooks of the gadget
// bindings on it, and delivering authorisation-filtered notifications (identifiers and revisions
// only, never record content) to them.
//
// Hooks are keyed by binding ID, so registering again replaces rather than duplicates. Before each
// delivery the binding is re-checked against Postgres; a revoked binding's hook is dropped. Each
// delivery opens a new hook session through the Workshop (startHook), authorises it as an
// observation, calls the gadget, and disposes every stub it received.

import { DurableObject } from "cloudflare:workers";
import type { HookInitiator, HookTargetMetadata } from "@gadgets/workshop-shared/gatekeeper";
import type { ChangeNotification } from "@records/contracts";

import type { RecordsService } from "../domain/service.js";
import { recordsService } from "../runtime.js";
import type { RecordsChangeHook } from "../vendor/types.js";

type StoredHook = { orgId: string; bindingId: string; initiator: Fetcher<HookInitiator<never>>; target: HookTargetMetadata };

function dispose(stub: unknown): void {
  try {
    (stub as { [Symbol.dispose]?: () => void } | undefined)?.[Symbol.dispose]?.();
  } catch {
    // already disposed
  }
}

export class DatastoreFeed extends DurableObject<Cloudflare.Env> {
  #service?: RecordsService;
  async register(orgId: string, bindingId: string, initiator: Fetcher<HookInitiator<never>>, target: HookTargetMetadata): Promise<void> {
    const previous = this.ctx.storage.kv.get<StoredHook>(`hook:${bindingId}`);
    this.ctx.storage.kv.put<StoredHook>(`hook:${bindingId}`, { orgId, bindingId, initiator, target });
    if (previous) dispose(previous.initiator);
  }

  async unregister(bindingId: string): Promise<void> {
    const previous = this.ctx.storage.kv.get<StoredHook>(`hook:${bindingId}`);
    this.ctx.storage.kv.delete(`hook:${bindingId}`);
    if (previous) dispose(previous.initiator);
  }

  async hookCount(): Promise<number> {
    return [...this.ctx.storage.kv.list({ prefix: "hook:" })].length;
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
    const service = (this.#service ??= recordsService(this.env));
    let reached = 0;
    for (const [, hook] of this.ctx.storage.kv.list<StoredHook>({ prefix: "hook:" })) {
      const binding = await service.registry.resolveBinding(hook.orgId, hook.bindingId);
      if (!binding?.active) {
        await this.unregister(hook.bindingId);
        continue;
      }
      type Started = { callback: RecordsChangeHook; approvalQueue: { authorizeObservation(d: { title: string; description: string }): Promise<void> } };
      let started: Started | undefined;
      try {
        started = (await hook.initiator.startHook()) as unknown as Started;
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
