// Transport helpers: HTTP push/pull and a poke adapter for SSE or WebSocket.

import type { PullRequest, PullResponse, PushRequest, PushResponse } from "@records/contracts";

import type { SyncTransport } from "./client.js";
import { SyncTransportError } from "./errors.js";

/** The subset of `fetch` used here; the browser's and Node's fetch both fit. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export type HttpTransportOptions = {
  /** Abort a request after this long (counts as a network failure, so it is retried). Default 20 s. */
  timeoutMs?: number;
};

function parseJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** Maps an HTTP error response (RFC 9457 problem+json when available) to a SyncTransportError. */
export function errorFromResponse(status: number, body: unknown): SyncTransportError {
  const problem = (body && typeof body === "object" ? body : {}) as { code?: unknown; detail?: unknown; title?: unknown };
  const code = typeof problem.code === "string" ? problem.code : null;
  const message =
    typeof problem.detail === "string" && problem.detail
      ? problem.detail
      : typeof problem.title === "string" && problem.title
        ? problem.title
        : `The sync request failed with HTTP ${status}.`;
  const kind = status >= 500 || status === 408 || status === 429 ? "server" : "client";
  return new SyncTransportError(kind, message, status, code);
}

/**
 * `POST {baseUrl}/sync/push` and `POST {baseUrl}/sync/pull` with JSON bodies. `headers()` is
 * called per request (for fresh auth tokens). Approvals are not part of the HTTP sync surface; add
 * `approvals` to the returned object if the host has a way to ask.
 */
export function httpTransport(
  baseUrl: string,
  fetchImpl: FetchLike = (globalThis as unknown as { fetch: FetchLike }).fetch,
  headers: () => Record<string, string> | Promise<Record<string, string>> = () => ({}),
  options: HttpTransportOptions = {},
): SyncTransport {
  const base = baseUrl.replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? 20_000;

  async function post(path: string, body: unknown): Promise<unknown> {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    let res: Awaited<ReturnType<FetchLike>>;
    let text: string;
    try {
      const init: Parameters<FetchLike>[1] = {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", ...(await headers()) },
        body: JSON.stringify(body),
      };
      if (controller) init.signal = controller.signal;
      res = await fetchImpl(`${base}${path}`, init);
      text = await res.text();
    } catch (err) {
      const aborted = controller?.signal.aborted;
      throw new SyncTransportError("network", aborted ? "The sync request timed out." : err instanceof Error ? err.message : "Network error.");
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
    const json = parseJson(text);
    if (!res.ok) throw errorFromResponse(res.status, json);
    if (json === null || typeof json !== "object") {
      throw new SyncTransportError("server", "The sync response was not JSON.", res.status, "malformed_response");
    }
    return json;
  }

  return {
    async push(request: PushRequest): Promise<PushResponse> {
      const res = (await post("/sync/push", request)) as PushResponse;
      if (!Array.isArray(res.outcomes)) throw new SyncTransportError("server", "Malformed push response.", 200, "malformed_response");
      return res;
    },
    async pull(request: PullRequest): Promise<PullResponse> {
      const res = (await post("/sync/pull", request)) as PullResponse;
      if (typeof res.cookie !== "number" || !Array.isArray(res.patch) || typeof res.lastMutationIdChanges !== "object") {
        throw new SyncTransportError("server", "Malformed pull response.", 200, "malformed_response");
      }
      return res;
    },
  };
}

/** Anything with DOM-style message events: EventSource, WebSocket, a MessagePort, a test double. */
export type MessageSourceLike = {
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
  removeEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
};

export type PokeSourceOptions = {
  /** Ignore pokes for other datastores (one socket may multiplex several). */
  datastoreId?: string;
  /** Event type carrying pokes. Default "message" (an unnamed SSE event or a WebSocket frame). */
  eventType?: string;
  /** Pull on (re)connect, since pokes sent while disconnected are lost. Default true. */
  pullOnOpen?: boolean;
};

/**
 * Adapts an SSE/WebSocket stream of `{datastoreId, head}` messages to the SyncClient's `onPoke`
 * hook: `new SyncClient({ onPoke: pokeSource(new EventSource(url), { datastoreId }), … })`.
 * Closing the underlying connection is the caller's business.
 */
export function pokeSource(source: MessageSourceLike, options: PokeSourceOptions = {}) {
  const eventType = options.eventType ?? "message";
  return (handler: (head: number) => void): (() => void) => {
    const onMessage = (event: { data?: unknown }) => {
      let poke: unknown = event.data;
      if (typeof poke === "string") poke = parseJson(poke);
      if (!poke || typeof poke !== "object") return;
      const { datastoreId, head } = poke as { datastoreId?: unknown; head?: unknown };
      if (typeof head !== "number" || !Number.isFinite(head)) return;
      if (options.datastoreId !== undefined && datastoreId !== options.datastoreId) return;
      handler(head);
    };
    const onOpen = () => handler(Number.POSITIVE_INFINITY);
    source.addEventListener(eventType, onMessage);
    if (options.pullOnOpen !== false) source.addEventListener("open", onOpen);
    return () => {
      source.removeEventListener(eventType, onMessage);
      source.removeEventListener("open", onOpen);
    };
  };
}
