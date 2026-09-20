// Spike 2, eviction half.
//
// The same hibernation API as `aux/chat.js`, but hosted by the *main* Worker so the pool's
// `evictDurableObject()` can reach it: that helper only works on classes defined in `main`, and the
// router-path half of the spike needs its Durable Object in an auxiliary Worker. Duplicated
// deliberately -- an auxiliary Worker is handed straight to Miniflare and cannot import TypeScript.

import { DurableObject } from "cloudflare:workers";

export interface WsAttachment {
  readonly userId: string;
  readonly connectedAt: number;
  readonly seq: number;
}

export class SpikeWsLocal extends DurableObject {
  override async fetch(request: Request): Promise<Response> {
    const userId = new URL(request.url).searchParams.get("user") ?? "anonymous";
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, [userId]);
    server.serializeAttachment({ userId, connectedAt: Date.now(), seq: 0 } satisfies WsAttachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const attachment = ws.deserializeAttachment() as WsAttachment;
    const next: WsAttachment = { ...attachment, seq: attachment.seq + 1 };
    ws.serializeAttachment(next);
    for (const peer of this.ctx.getWebSockets(attachment.userId)) {
      peer.send(JSON.stringify({ t: "echo", from: attachment.userId, seq: next.seq, body: message }));
    }
  }

  /** Read back over RPC, so a test can inspect what hibernation preserved. */
  attachments(userId: string): WsAttachment[] {
    return this.ctx.getWebSockets(userId).map((ws) => ws.deserializeAttachment() as WsAttachment);
  }
}
