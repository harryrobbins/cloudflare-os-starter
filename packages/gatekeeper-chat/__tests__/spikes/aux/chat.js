// Stands in for cfos-chat, reached only through the router's service binding.
//
// Proves three things at once: a WebSocket upgrade survives the service-binding hop, the Durable
// Object can hibernate (acceptWebSocket + serializeAttachment + webSocketMessage/webSocketClose), and
// the `assets` binding serves a Vite build under a `base` prefix from behind the same hop.
import { DurableObject } from "cloudflare:workers";

export class SpikeWs extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    const userId = url.searchParams.get("user") ?? "anonymous";

    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      // Lets a test read the hibernation-visible state without a socket.
      return Response.json({
        tags: this.ctx.getWebSockets(userId).map((ws) => ws.deserializeAttachment()),
        total: this.ctx.getWebSockets().length,
      });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // The tag is the fan-out key: getWebSockets(userId) returns every socket this user has open.
    this.ctx.acceptWebSocket(server, [userId]);
    // Small and rewritten on change: it has to survive eviction, and the DO rebuilds everything else
    // from SQLite.
    server.serializeAttachment({ userId, connectedAt: Date.now(), seq: 0 });

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    const attachment = ws.deserializeAttachment();
    const next = { ...attachment, seq: attachment.seq + 1 };
    ws.serializeAttachment(next);

    // Fan-out by tag, exactly as the chat DO will for personal events.
    for (const peer of this.ctx.getWebSockets(attachment.userId)) {
      peer.send(JSON.stringify({ t: "echo", from: attachment.userId, seq: next.seq, body: message }));
    }
  }

  webSocketClose(ws, code, reason, wasClean) {
    this.ctx.storage.put("lastClose", { code, wasClean, reason });
    // 1000-1003/1005 are reserved as close *codes* a server may not echo back; 1000 is always safe.
    ws.close(1000, "spike closed");
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/gatekeeper/chat/ws") {
      const id = env.SPIKE_WS.idFromName("main");
      return env.SPIKE_WS.get(id).fetch(request);
    }
    if (url.pathname === "/gatekeeper/chat/sockets") {
      const id = env.SPIKE_WS.idFromName("main");
      return env.SPIKE_WS.get(id).fetch(request);
    }
    // Everything else is the SPA. The prefix has to come off first: the asset server resolves the
    // URL against the asset directory and knows nothing about Vite's `base`, so the prefixed path
    // 404s. Same rewrite as src/serve.ts.
    const target = new URL(request.url);
    target.pathname = url.pathname.slice("/gatekeeper/chat".length) || "/";
    return env.ASSETS.fetch(new Request(target, request));
  },
};
