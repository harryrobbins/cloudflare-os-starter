// Records Worker: the organisation datastore service and its Gatekeeper, in one Worker.
//
// Public HTTP arrives only through the Router (`/gatekeeper/records/*`):
//   /gatekeeper/records/v1/...   machine API (Access service token + Records credential)
//   /gatekeeper/records/connect  Access-verified connect flow for people
// The Workshop reaches the vendor, accounts and facets over RPC. The outbox publisher runs after
// writes and on a one-minute cron; the queue consumer fans change notifications out to feeds.

import { WorkerEntrypoint } from "cloudflare:workers";

import { CONNECT_PATH, handleConnect } from "./connect.js";
import { consumeChanges } from "./feed/consumer.js";
import { outboxLag, pruneDelivered, publishPending, type PublishResult } from "./feed/publisher.js";
import { verifyAccessAssertion } from "./http/access.js";
import { API_PREFIX, handleApi } from "./http/api.js";
import { closeQuietly, publisherDatabase, recordsService } from "./runtime.js";

export { RecordsConnectFlow } from "./connect.js";
export { DatastoreFeed } from "./feed/feed.js";
export { RecordsHookController } from "./feed/hook-controller.js";
export { RecordsAccount } from "./vendor/account.js";
export { RecordsGatekeeper } from "./vendor/gatekeeper.js";
export { RecordsVerifier } from "./vendor/verifier.js";
export { GatekeeperVendor } from "./vendor/vendor.js";

// same-origin, not no-referrer: under no-referrer a same-site form POST carries `Origin: null`,
// which the connect page's Origin check must refuse (see connect-guard.ts).
const SECURITY_HEADERS = { "x-content-type-options": "nosniff", "referrer-policy": "same-origin" };

export default class RecordsWorker extends WorkerEntrypoint<Cloudflare.Env> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    let response: Response;
    if (url.pathname === API_PREFIX || url.pathname.startsWith(`${API_PREFIX}/`)) {
      const env = this.env;
      const service = recordsService(env);
      response = await handleApi(request, {
        service,
        verifyAccess: async (r) => (await verifyAccessAssertion(r, { issuer: env.CF_ACCESS_ISS, audience: env.RECORDS_API_ACCESS_AUD })) !== null,
        rateLimit: async (key) => (await env.API_RATE_LIMITER.limit({ key })).success,
      });
      this.ctx.waitUntil(closeQuietly(service.db));
      if (["POST", "PATCH"].includes(request.method) && response.ok) this.ctx.waitUntil(this.publishNow());
    } else if (url.pathname === CONNECT_PATH) {
      response = await handleConnect(request, this.env, this.ctx.exports);
    } else {
      response = new Response("Not found", { status: 404 });
    }
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
    return new Response(response.body, { status: response.status, headers });
  }

  /** Publish pending change events now (called after writes; the cron is the backstop). */
  async publishNow(): Promise<PublishResult> {
    const db = publisherDatabase(this.env);
    try {
      return await publishPending(db, this.env.CHANGES as never);
    } finally {
      await closeQuietly(db);
    }
  }

  override async scheduled(_controller: ScheduledController): Promise<void> {
    const db = publisherDatabase(this.env);
    let total = 0;
    // Drain up to a bounded amount per tick; the next tick continues.
    for (let i = 0; i < 10; i++) {
      const result = await publishPending(db, this.env.CHANGES as never);
      total += result.published;
      if (result.claimed < 100) break;
    }
    const lag = await outboxLag(db);
    const pruned = new Date().getUTCMinutes() === 0 ? await pruneDelivered(db) : null;
    await closeQuietly(db);
    console.log(JSON.stringify({ event: "records.outbox.tick", published: total, pending: lag.pending, oldestPendingSeconds: Math.round(lag.oldestSeconds), dead: lag.dead, pruned }));
  }

  override async queue(batch: MessageBatch<unknown>): Promise<void> {
    await consumeChanges(batch, {
      deliver: (datastoreId, notifications) => this.ctx.exports.DatastoreFeed.getByName(datastoreId).deliver(notifications),
    });
  }
}
