// Shared fixtures for the stream A suites.
//
// Every suite gets its own `ChatWorkspace` instance, addressed by a random name, because the object
// is a whole deployment's chat: one shared instance would let #general accumulate messages across
// suites and let one test's rate-limit budget fail another's.
//
// Requests go straight to the object with the `x-chat-user` header the Worker would have set. The
// Worker's own half (Access verification, the `Origin` check, the asset fallback) has its own suite
// in `identity.test.ts`; these suites are about what the object does once the caller is known.

import { env } from "cloudflare:test";
import { expect } from "vitest";

import { IDENTITY_HEADER, type ChatIdentity, type ServerEvent } from "../src/shared/protocol.js";
import type { ChatWorkspace } from "../src/workspace.js";

export const ORIGIN = "https://chat.example.test";

export type Workspace = DurableObjectStub<ChatWorkspace>;

export function freshWorkspace(label: string): Workspace {
  const name = `${label}-${crypto.randomUUID()}`;
  return env.CHAT_WORKSPACE.get(env.CHAT_WORKSPACE.idFromName(name)) as Workspace;
}

export function identity(id: string, name?: string): ChatIdentity {
  return { id, email: `${id}@example.test`, ...(name === undefined ? {} : { name }) };
}

/** `admin@example.test` is in the test environment's `ADMINS`. */
export const ADMIN_IDENTITY: ChatIdentity = { id: "admin", email: "admin@example.test", name: "Admin" };

export interface Client {
  readonly identity: ChatIdentity;
  request(method: string, path: string, body?: unknown): Promise<Response>;
  get<T>(path: string): Promise<T>;
  send<T>(method: string, path: string, body?: unknown): Promise<T>;
  status(method: string, path: string, body?: unknown): Promise<number>;
  error(method: string, path: string, body?: unknown): Promise<{ status: number; code: string }>;
  socket(): Promise<Socket>;
}

export function client(workspace: Workspace, who: ChatIdentity): Client {
  async function request(method: string, path: string, body?: unknown): Promise<Response> {
    const headers = new Headers({ [IDENTITY_HEADER]: JSON.stringify(who) });
    const bodied = body !== undefined && method !== "GET" && method !== "HEAD";
    if (bodied) headers.set("content-type", "application/json");
    return workspace.fetch(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers,
        ...(bodied ? { body: JSON.stringify(body) } : {}),
      }),
    );
  }

  return {
    identity: who,
    request,
    async get<T>(path: string): Promise<T> {
      const response = await request("GET", path);
      expect(response.status, `GET ${path}: ${await response.clone().text()}`).toBe(200);
      return (await response.json()) as T;
    },
    async send<T>(method: string, path: string, body?: unknown): Promise<T> {
      const response = await request(method, path, body);
      expect(response.status, `${method} ${path}: ${await response.clone().text()}`).toBe(200);
      return (await response.json()) as T;
    },
    async status(method: string, path: string, body?: unknown): Promise<number> {
      return (await request(method, path, body)).status;
    },
    async error(method: string, path: string, body?: unknown) {
      const response = await request(method, path, body);
      const payload = (await response.json()) as { error: { code: string } };
      return { status: response.status, code: payload.error.code };
    },
    async socket(): Promise<Socket> {
      return openSocket(workspace, who);
    },
  };
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

export interface Socket {
  readonly ws: WebSocket;
  readonly events: readonly ServerEvent[];
  send(frame: unknown): void;
  /** Waits for the first event matching `t` that has not been consumed by an earlier wait. */
  next<T extends ServerEvent["t"]>(t: T, timeoutMs?: number): Promise<Extract<ServerEvent, { t: T }>>;
  /** Everything received so far of one type. */
  all<T extends ServerEvent["t"]>(t: T): readonly Extract<ServerEvent, { t: T }>[];
  close(): void;
}

export async function openSocket(workspace: Workspace, who: ChatIdentity): Promise<Socket> {
  const response = await workspace.fetch(
    new Request(`${ORIGIN}/gatekeeper/chat/ws`, {
      headers: { Upgrade: "websocket", [IDENTITY_HEADER]: JSON.stringify(who) },
    }),
  );
  expect(response.status).toBe(101);
  const ws = response.webSocket;
  if (ws === null) throw new Error("The upgrade produced no socket.");
  ws.accept();

  const events: ServerEvent[] = [];
  let cursor = 0;
  ws.addEventListener("message", (event: MessageEvent) => {
    if (typeof event.data !== "string") return;
    events.push(JSON.parse(event.data) as ServerEvent);
  });

  return {
    ws,
    events,
    send(frame) {
      ws.send(JSON.stringify(frame));
    },
    async next(t, timeoutMs = 1000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        while (cursor < events.length) {
          const event = events[cursor++]!;
          if (event.t === t) return event as never;
        }
        if (Date.now() > deadline) throw new Error(`No ${t} event within ${timeoutMs}ms.`);
        await tick();
      }
    },
    all(t) {
      return events.filter((event) => event.t === t) as never;
    },
    close() {
      ws.close(1000, "test over");
    },
  };
}

/** Lets the runtime deliver queued socket frames. */
export function tick(ms = 5): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
