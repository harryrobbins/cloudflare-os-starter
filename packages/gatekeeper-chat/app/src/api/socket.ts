// The live-updates socket.
//
// Reconnection is jittered exponential backoff, capped: without the jitter every tab in the
// deployment reconnects in lockstep after a Worker redeploy and the first thing the new Durable
// Object sees is a thundering herd. The store, not this module, does the `since` catch-up -- it owns
// the per-channel high-water marks that `hello` reports, and the catch-up is HTTP paging, not a socket
// concern.

import { WS_PATH, type ClientEvent, type ServerEvent } from "../contract.js";
import type { ChatSocket, SocketStatus } from "./types.js";

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 30_000;
/** Heartbeat, so a silently dead connection is noticed and so presence does not expire on us. */
const PING_INTERVAL_MS = 25_000;

export function socketUrl(): string {
  const url = new URL(WS_PATH, window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function createWebSocketClient(url: string = socketUrl()): ChatSocket {
  let socket: WebSocket | null = null;
  let status: SocketStatus = "idle";
  let attempt = 0;
  let wanted = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let retryAt: number | null = null;
  const eventListeners = new Set<(event: ServerEvent) => void>();
  const statusListeners = new Set<(status: SocketStatus) => void>();
  /** Frames sent while the socket was down; replayed on open so a `sub` is never lost. */
  let pending: ClientEvent[] = [];

  function setStatus(next: SocketStatus): void {
    if (status === next) return;
    status = next;
    for (const listener of statusListeners) listener(next);
  }

  function clearTimers(): void {
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    if (pingTimer !== null) clearInterval(pingTimer);
    reconnectTimer = null;
    pingTimer = null;
  }

  /** Full jitter: uniform over [0, cap], which is what avoids the synchronised retry. */
  function nextDelay(): number {
    const cap = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
    return Math.round(Math.random() * cap);
  }

  function scheduleReconnect(): void {
    if (!wanted || reconnectTimer !== null) return;
    const delay = nextDelay();
    attempt = Math.min(attempt + 1, 8);
    retryAt = Date.now() + delay;
    setStatus("reconnecting");
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect(): void {
    if (!wanted) return;
    setStatus(attempt === 0 ? "connecting" : "reconnecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      scheduleReconnect();
      return;
    }
    socket = ws;

    ws.addEventListener("open", () => {
      attempt = 0;
      retryAt = null;
      setStatus("open");
      const queued = pending;
      pending = [];
      for (const event of queued) send(event);
      pingTimer = setInterval(() => send({ t: "ping" }), PING_INTERVAL_MS);
    });

    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      if (typeof parsed !== "object" || parsed === null || !("t" in parsed)) return;
      for (const listener of eventListeners) listener(parsed as ServerEvent);
    });

    ws.addEventListener("close", () => {
      socket = null;
      clearTimers();
      if (!wanted) {
        setStatus("closed");
        return;
      }
      scheduleReconnect();
    });

    // `error` is always followed by `close`, so the reconnect is scheduled there and not twice.
    ws.addEventListener("error", () => undefined);
  }

  function send(event: ClientEvent): void {
    if (socket !== null && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(event));
      return;
    }
    // Only the frames that matter after a reconnect are worth queueing. A stale `typing` or `ping`
    // replayed minutes later is noise; a `sub` or a `read` is state the server needs.
    if (event.t === "sub" || event.t === "read") {
      pending = [...pending.filter((queued) => queued.t !== event.t || event.t !== "sub"), event];
    }
  }

  return {
    open(): void {
      if (wanted) return;
      wanted = true;
      attempt = 0;
      connect();
    },
    close(): void {
      wanted = false;
      clearTimers();
      pending = [];
      socket?.close();
      socket = null;
      setStatus("closed");
    },
    send,
    status: () => status,
    retryInSeconds: () =>
      status === "reconnecting" && retryAt !== null
        ? Math.max(0, Math.ceil((retryAt - Date.now()) / 1000))
        : null,
    onEvent(listener): () => void {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    onStatus(listener): () => void {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
  };
}
