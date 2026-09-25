import type { Identity } from './gateway.ts';
import { problem } from './gateway.ts';

/** Notifications carry no data. Every hint causes clients to pull the durable, authorised journal. */
export class HintRelay {
  private clients = new Map<number, { datastore: string; poke(): void; close(): void }>();
  private nextId = 0;
  private options: { maxClients?: number; intervalMs?: number; lifetimeMs?: number };
  constructor(options: { maxClients?: number; intervalMs?: number; lifetimeMs?: number } = {}) { this.options = options; }
  notify(datastore: string): void {
    for (const client of this.clients.values()) if (client.datastore === datastore) client.poke();
  }
  close(): void { for (const client of this.clients.values()) client.close(); }
  subscribe(request: Request, identity: Identity, revalidate: () => Promise<boolean>): Response {
    if (this.clients.size >= (this.options.maxClients ?? 1000)) return problem(503, 'Event stream capacity reached');
    const id = ++this.nextId; const encoder = new TextEncoder();
    let dispose = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start: controller => {
        let closed = false; let checking = false;
        const close = () => {
          if (closed) return; closed = true;
          clearInterval(interval); clearTimeout(lifetime);
          request.signal.removeEventListener('abort', close); this.clients.delete(id);
          try { controller.close(); } catch { /* The consumer may already have cancelled. */ }
        };
        const poke = () => {
          if (closed) return;
          // One queued hint is sufficient. Stalled consumers cannot grow memory unboundedly.
          if ((controller.desiredSize ?? 0) <= 0) { close(); return; }
          controller.enqueue(encoder.encode('event: changes\ndata: {}\n\n'));
        };
        const interval = setInterval(async () => {
          if (checking || closed) return; checking = true;
          try { if (await revalidate()) poke(); else close(); } catch { close(); }
          finally { checking = false; }
        }, this.options.intervalMs ?? 15000);
        const lifetime = setTimeout(close, this.options.lifetimeMs ?? 300000);
        dispose = close;
        this.clients.set(id, { datastore: identity.datastore_id, poke, close });
        request.signal.addEventListener('abort', close, { once: true });
        if (request.signal.aborted) close(); else poke();
      },
      cancel: () => dispose(),
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } });
  }
}
