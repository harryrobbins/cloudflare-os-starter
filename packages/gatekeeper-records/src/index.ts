// Records Worker: the organisation datastore service and its Gatekeeper, in one Worker.
//
// Public HTTP arrives only through the Router (`/gatekeeper/records/*`):
//   /gatekeeper/records/v1/...   machine API (Access service token + Records credential)
//   /gatekeeper/records/connect  Access-verified connect flow for people
//   /gatekeeper/records/.well-known/jwks.json  public keys of the delegated tokens this Worker's
//                                gatekeeper mints (src/identity/keys.ts)
// The Workshop reaches the vendor, accounts and facets over RPC. The outbox publisher runs after
// writes and on a one-minute cron; the queue consumer fans change notifications out to feeds.
// After each committed write the datastore's DatastorePokeHub is poked (best effort) with the new
// clock head, for WebSocket subscribers (`…/v1/datastores/:id/poke`) and gadget poke hooks.
// Once an hour the cron also creates the journal's monthly partitions three months ahead.

import { WorkerEntrypoint } from "cloudflare:workers";

import { CONNECT_PATH, handleConnect } from "./connect.js";
import { consumeChanges } from "./feed/consumer.js";
import { ensureJournalPartitions, outboxLag, pruneDelivered, publishPending, type PublishResult } from "./feed/publisher.js";
import { verifyAccessAssertion } from "./http/access.js";
import { API_PREFIX, handleApi } from "./http/api.js";
import { ServiceAuthenticator } from "./identity/authenticator.js";
import { delegationKeys, JWKS_PATH, jwksResponse } from "./identity/keys.js";
import { handleJiraApi, JIRA_PATH } from "./jira/handler.js";
import { POKE_DATASTORE_HEADER } from "./feed/poke-hub.js";
import { pruneDelegatedTokenUses } from "@records/core";
import { runWebhooks, webhookMaintenance } from "./webhooks/index.js";
import { closeQuietly, publisherDatabase, recordsService } from "./runtime.js";

export { RecordsConnectFlow } from "./connect.js";
export { DatastoreFeed } from "./feed/feed.js";
export { DatastorePokeHub } from "./feed/poke-hub.js";
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
      const authenticator = new ServiceAuthenticator({ service, keys: () => delegationKeys(env) });
      let committed = false;
      const verifyAccess = async (r: Request) => (await verifyAccessAssertion(r, { issuer: env.CF_ACCESS_ISS, audience: env.RECORDS_API_ACCESS_AUD })) !== null;
      const rateLimit = async (key: string) => (await env.API_RATE_LIMITER.limit({ key })).success;
      if (JIRA_PATH.test(url.pathname)) {
        // The Jira-compatible surface (src/jira). Its writes go through the same command bus; they
        // are published here, and subscribers catch up on their next pull.
        response = await handleJiraApi(request, { service, verifyAccess, rateLimit, authenticator });
        committed = ["POST", "PUT"].includes(request.method) && response.ok;
      } else response = await handleApi(request, {
        service,
        verifyAccess,
        authenticator,
        rateLimit,
        onCommit: (datastoreId, head) => {
          committed = true;
          this.ctx.waitUntil(this.poke(datastoreId, head));
        },
        subscribePokes: (datastoreId, upgrade) => {
          const forwarded = new Request(upgrade);
          for (const h of ["authorization", "cf-access-jwt-assertion", "cookie"]) forwarded.headers.delete(h);
          forwarded.headers.set(POKE_DATASTORE_HEADER, datastoreId);
          return this.ctx.exports.DatastorePokeHub.getByName(datastoreId).fetch(forwarded);
        },
      });
      this.ctx.waitUntil(closeQuietly(service.db));
      if (committed) this.ctx.waitUntil(this.publishNow());
      // A WebSocket upgrade passes through untouched (a 101 cannot be rebuilt without its socket).
      if (response.status === 101) return response;
    } else if (url.pathname === JWKS_PATH && (request.method === "GET" || request.method === "HEAD")) {
      response = await jwksResponse(this.env);
    } else if (url.pathname === CONNECT_PATH) {
      response = await handleConnect(request, this.env, this.ctx.exports);
    } else {
      response = new Response("Not found", { status: 404 });
    }
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
    return new Response(response.body, { status: response.status, headers });
  }

  /** Tell the datastore's poke hub the clock moved. Best effort: subscribers also pull on a timer. */
  async poke(datastoreId: string, head: number): Promise<void> {
    try {
      await this.ctx.exports.DatastorePokeHub.getByName(datastoreId).poke(datastoreId, head);
    } catch (err) {
      console.warn(JSON.stringify({ event: "records.poke.failed", error: err instanceof Error ? err.message : String(err) }));
    }
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
    const hourly = new Date().getUTCMinutes() === 0;
    const pruned = hourly ? await pruneDelivered(db) : null;
    const partitionsCreated = hourly ? await ensureJournalPartitions(db) : null;
    const tokenUsesPruned = hourly ? await pruneDelegatedTokenUses(db) : null;
    await closeQuietly(db);
    // Outbound webhooks: the queue consumer runs them as changes arrive; this is the backstop.
    let webhooks: Record<string, unknown> | null = null;
    try {
      webhooks = { ...(await runWebhooks(this.env)), ...(await webhookMaintenance(this.env, hourly)) };
    } catch (err) {
      console.warn(JSON.stringify({ event: "records.webhook.tick_failed", error: err instanceof Error ? err.name : "error" }));
    }
    console.log(JSON.stringify({ event: "records.outbox.tick", published: total, pending: lag.pending, oldestPendingSeconds: Math.round(lag.oldestSeconds), dead: lag.dead, pruned, partitionsCreated, tokenUsesPruned, webhooks }));
  }

  override async queue(batch: MessageBatch<unknown>): Promise<void> {
    await consumeChanges(batch, {
      deliver: (datastoreId, notifications) => this.ctx.exports.DatastoreFeed.getByName(datastoreId).deliver(notifications),
      webhooks: (datastoreIds) => runWebhooks(this.env, { datastoreIds }),
    });
  }
}
