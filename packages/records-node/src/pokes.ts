// The poke hub off Cloudflare (canonical plan §2: "SSE plus pub/sub off Cloudflare").
//
// On Workers each datastore's DatastorePokeHub Durable Object holds hibernating WebSockets. On Node
// the equivalent is an in-process set of Server-Sent Events streams per datastore, with the same
// contract: a poke is `{ datastoreId, head }`, carries no record content, is at-most-once, and every
// stream is closed after a maximum lifetime so a revoked credential stops receiving pokes (the
// client reconnects, which re-authorises, and pulls).
//
// Several Node instances behind a load balancer share pokes through Postgres LISTEN/NOTIFY
// (`pubsub: "postgres"`): a commit on one instance NOTIFYs `records_poke`, and every instance
// (itself included) fans the poke out to its own subscribers. With `pubsub: "memory"` (the
// default) pokes stay in the process, which is right for a single instance.

import type { Db } from "@records/core";

export const POKE_CHANNEL = "records_poke";

export type PokeHubOptions = {
  /** Close each stream after this long (default 10 minutes, as the Durable Object hub). */
  lifetimeMs?: number;
  /** Comment line sent this often to keep proxies from timing the stream out (default 25 s). */
  heartbeatMs?: number;
  /** Streams per datastore (default 1000, as the Durable Object hub). */
  maxSubscribers?: number;
};

type Subscriber = { send(chunk: string): void; close(): void };

const encoder = new TextEncoder();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class SsePokeHub {
  readonly #subs = new Map<string, Set<Subscriber>>();
  readonly #lifetimeMs: number;
  readonly #heartbeatMs: number;
  readonly #max: number;
  #publish: (datastoreId: string, head: number) => void = (d, h) => this.deliver(d, h);
  #unlisten: (() => Promise<void>) | null = null;

  constructor(opts: PokeHubOptions = {}) {
    this.#lifetimeMs = opts.lifetimeMs ?? 10 * 60_000;
    this.#heartbeatMs = opts.heartbeatMs ?? 25_000;
    this.#max = opts.maxSubscribers ?? 1_000;
  }

  /** Share pokes between instances through Postgres LISTEN/NOTIFY on `db`. */
  async usePostgres(db: Db): Promise<void> {
    const { unlisten } = await db.listen(POKE_CHANNEL, (payload) => {
      try {
        const { datastoreId, head } = JSON.parse(payload) as { datastoreId: unknown; head: unknown };
        if (typeof datastoreId === "string" && typeof head === "number") this.deliver(datastoreId, head);
      } catch {
        // not ours
      }
    });
    this.#unlisten = unlisten;
    this.#publish = (datastoreId, head) => {
      db.notify(POKE_CHANNEL, JSON.stringify({ datastoreId, head })).catch((err: unknown) => {
        console.warn(JSON.stringify({ event: "records.poke.notify_failed", error: err instanceof Error ? err.message : String(err) }));
        this.deliver(datastoreId, head);
      });
    };
  }

  /** A commit moved `datastoreId`'s clock to at least `head`. Best effort. */
  poke(datastoreId: string, head: number): void {
    if (!UUID.test(datastoreId) || !Number.isSafeInteger(head) || head < 0) return;
    this.#publish(datastoreId, head);
  }

  /** Send a poke to this process's subscribers. Returns how many streams it reached. */
  deliver(datastoreId: string, head: number): number {
    const subs = this.#subs.get(datastoreId);
    if (!subs) return 0;
    const chunk = `event: poke\ndata: ${JSON.stringify({ datastoreId, head })}\n\n`;
    for (const s of subs) s.send(chunk);
    return subs.size;
  }

  subscriberCount(datastoreId: string): number {
    return this.#subs.get(datastoreId)?.size ?? 0;
  }

  /** An authorised subscription: a `text/event-stream` response. */
  subscribe(datastoreId: string): Response {
    const subs = this.#subs.get(datastoreId) ?? new Set<Subscriber>();
    if (subs.size >= this.#max) {
      return new Response(
        JSON.stringify({ type: "https://records.invalid/problems/unavailable", title: "unavailable", status: 503, code: "unavailable", detail: "This datastore has too many live subscribers; poll instead." }),
        { status: 503, headers: { "content-type": "application/problem+json", "retry-after": "60", "cache-control": "no-store" } },
      );
    }
    this.#subs.set(datastoreId, subs);
    let sub: Subscriber | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let lifetime: ReturnType<typeof setTimeout> | undefined;
    const drop = () => {
      clearInterval(heartbeat);
      clearTimeout(lifetime);
      if (sub) subs.delete(sub);
      if (subs.size === 0 && this.#subs.get(datastoreId) === subs) this.#subs.delete(datastoreId);
    };
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        let open = true;
        sub = {
          send(chunk) {
            if (!open) return;
            try {
              controller.enqueue(encoder.encode(chunk));
            } catch {
              open = false;
            }
          },
          close() {
            drop();
            if (!open) return;
            open = false;
            try {
              controller.close();
            } catch {
              // already closed
            }
          },
        };
        subs.add(sub);
        // `retry` tells EventSource how long to wait before reconnecting.
        sub.send(`retry: 3000\nevent: ready\ndata: ${JSON.stringify({ datastoreId })}\n\n`);
        heartbeat = setInterval(() => sub!.send(": ping\n\n"), this.#heartbeatMs);
        lifetime = setTimeout(() => {
          sub!.send(`event: close\ndata: ${JSON.stringify({ reason: "Maximum lifetime reached; reconnect." })}\n\n`);
          sub!.close();
        }, this.#lifetimeMs);
      },
      cancel: drop,
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" },
    });
  }

  /** Close every stream and stop listening. */
  async close(): Promise<void> {
    for (const subs of [...this.#subs.values()]) for (const s of [...subs]) s.close();
    this.#subs.clear();
    await this.#unlisten?.().catch(() => {});
    this.#unlisten = null;
  }
}
