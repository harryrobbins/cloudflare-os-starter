// DatastorePokeHub: one Durable Object per datastore (named by its ID) that tells subscribers the
// datastore's clock moved. A poke is `{ datastoreId, head }` and carries no record content: every
// subscriber then pulls through its own, separately authorised, channel.
//
// Subscribers:
//   * WebSockets from `GET …/v1/datastores/:id/poke`. The API adapter authenticates the credential
//     and checks issues.read before handing the upgrade here. Sockets use the hibernation API (the
//     hub sleeps between pokes; "ping" is answered with "pong" without waking it). Every socket is
//     closed with code 4000 after POKE_SOCKET_LIFETIME_MS, so a revoked credential or membership
//     stops receiving pokes within that bound; clients reconnect (which re-authorises) and pull on
//     reconnect, since pokes sent while disconnected are lost. At most POKE_MAX_SUBSCRIBERS sockets.
//   * Gadget hooks registered for pokes (`onChange(callback, { deliver: "pokes" })`): forwarded to
//     the datastore's DatastoreFeed, which re-checks each binding and coalesces.
//
// Writers call `poke(datastoreId, head)` best effort after a commit (ctx.waitUntil). Delivery is
// at-most-once and may skip heads; subscribers must also pull on a timer.

import { DurableObject } from "cloudflare:workers";
import type { Poke } from "@records/contracts";

export const POKE_SOCKET_LIFETIME_MS = 10 * 60_000;
export const POKE_MAX_SUBSCRIBERS = 1_000;
/** Header the Worker sets on the upgrade it forwards; never taken from the client. */
export const POKE_DATASTORE_HEADER = "x-records-poke-datastore";
export const POKE_CLOSE_LIFETIME = 4000;

type Attachment = { expiresAt: number };

function closeQuietly(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    // already closed
  }
}

export class DatastorePokeHub extends DurableObject<Cloudflare.Env> {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a WebSocket upgrade.", { status: 426 });
    const datastoreId = request.headers.get(POKE_DATASTORE_HEADER);
    if (!datastoreId) return new Response("Missing datastore.", { status: 400 });
    this.#sweep(Date.now());
    if (this.ctx.getWebSockets().length >= POKE_MAX_SUBSCRIBERS) {
      return new Response(JSON.stringify({ type: "about:blank", title: "Too many subscribers", status: 503, code: "unavailable", detail: "This datastore has too many live subscribers; poll instead." }), {
        status: 503, headers: { "content-type": "application/problem+json", "retry-after": "60" },
      });
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    const expiresAt = Date.now() + POKE_SOCKET_LIFETIME_MS;
    server.serializeAttachment({ expiresAt } satisfies Attachment);
    await this.#scheduleAt(expiresAt);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Broadcast the new head. Returns how many sockets it was sent to. */
  async poke(datastoreId: string, head: number): Promise<number> {
    if (!Number.isSafeInteger(head) || head < 0) return 0;
    const message = JSON.stringify({ datastoreId, head } satisfies Poke);
    const now = Date.now();
    let sent = 0;
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (!a || a.expiresAt <= now) {
        closeQuietly(ws, POKE_CLOSE_LIFETIME, "Maximum lifetime reached; reconnect.");
        continue;
      }
      try {
        ws.send(message);
        sent++;
      } catch {
        // closing; the runtime drops it
      }
    }
    try {
      await this.ctx.exports.DatastoreFeed.getByName(datastoreId).poke(datastoreId, head);
    } catch (err) {
      console.warn(JSON.stringify({ event: "records.poke.hooks_failed", error: err instanceof Error ? err.message : String(err) }));
    }
    return sent;
  }

  async subscriberCount(): Promise<number> {
    return this.ctx.getWebSockets().length;
  }

  override async alarm(): Promise<void> {
    const next = this.#sweep(Date.now());
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }

  override async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {
    // Subscribers only listen ("ping" is answered by the auto-response).
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    closeQuietly(ws, code === 1005 || code === 1006 ? 1000 : code, reason);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    closeQuietly(ws, 1011, "error");
  }

  /** Close sockets past their lifetime; returns the earliest remaining expiry. */
  #sweep(now: number): number | null {
    let next: number | null = null;
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (!a || a.expiresAt <= now) closeQuietly(ws, POKE_CLOSE_LIFETIME, "Maximum lifetime reached; reconnect.");
      else next = next === null ? a.expiresAt : Math.min(next, a.expiresAt);
    }
    return next;
  }

  async #scheduleAt(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }
}
