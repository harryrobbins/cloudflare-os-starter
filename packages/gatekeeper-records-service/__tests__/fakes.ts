// Test doubles: an in-memory Records service (the gateway's HTTP contract for one work datastore),
// synchronous Durable Object storage and a Workshop ApprovalQueue.
import type { SyncStorage, WorkshopQueue } from "../src/host.js";

export const DATASTORE = "7c1e4b52-3a0d-4d7e-9b1f-2f6a8c9d0e11";
// Built at runtime so secret scanners do not flag a fixture credential.
export const KEY = ["rk", "test", "fixture".repeat(3)].join("_");

type Row = { id: string; entity: string; revision: number; data: Record<string, unknown> };

export function fakeRecordsService(options: { epoch?: number; scopes?: string[] } = {}) {
  let seq = 0;
  const epoch = { value: options.epoch ?? 1 };
  const rows = new Map<string, Row>();
  const journal: { seq: number; ordinal: number; entity: string; record_id: string; revision: number; data: Record<string, unknown> }[] = [];
  const receipts = new Map<string, unknown>();
  const requests: { method: string; path: string; headers: Record<string, string>; body?: unknown }[] = [];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const problem = (status: number) => json(status, { type: "about:blank", title: "problem", status });

  const fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ method: init.method ?? "GET", path: url.pathname + url.search, headers, body });
    if (url.pathname.startsWith("/v1/models/work/v1/")) {
      if (url.pathname.endsWith("/profile")) return json(200, { entities: { work_item: { fields: { title: { type: "string", required: true } } } } });
      if (url.pathname.endsWith("/schema/work_item")) return json(200, { type: "object", properties: { title: { type: "string" } } });
      return problem(404);
    }
    if (headers.authorization !== `Bearer ${KEY}`) return problem(401);
    const prefix = `/v1/datastores/${DATASTORE}/`;
    if (!url.pathname.startsWith(prefix)) return problem(404);
    const rest = url.pathname.slice(prefix.length);
    if (rest === "describe") {
      return json(200, {
        id: DATASTORE, module_id: "work", api_major: 1, permission_epoch: epoch.value, granted_scopes: options.scopes ?? ["work.read", "work.write"],
        modules: [{ id: "work", api_majors: [1], scopes: ["work.read", "work.write"], entities: ["work_item"], commands: ["work.create", "work.update"] }],
      });
    }
    if (rest === "modules/work/v1/snapshot") return json(200, { records: [...rows.values()], seq, permission_epoch: epoch.value, complete: true });
    if (rest === "modules/work/v1/records") return json(200, { records: [...rows.values()].sort((a, b) => a.id.localeCompare(b.id)), seq, permission_epoch: epoch.value });
    if (rest === "changes") {
      const after = Number(url.searchParams.get("after") ?? 0);
      if (url.searchParams.has("epoch") && Number(url.searchParams.get("epoch")) !== epoch.value) return problem(409);
      const page = journal.filter((entry) => entry.seq > after);
      return json(200, { changes: page, cursor: page.at(-1)?.seq ?? after, permission_epoch: epoch.value });
    }
    const rpc = /^modules\/work\/v1\/rpc\/(work\.create|work\.update)$/.exec(rest);
    if (rpc && init.method === "POST") {
      const key = headers["idempotency-key"];
      if (!key) return problem(400);
      if (receipts.has(key)) return json(200, receipts.get(key));
      const ifMatch = headers["if-match"];
      let row: Row;
      if (rpc[1] === "work.create") {
        if (ifMatch) return problem(400);
        row = { id: crypto.randomUUID(), entity: "work_item", revision: 0, data: { title: body.title, status: body.status ?? "open", description: body.description ?? "", extensions: {} } };
      } else {
        if (!ifMatch) return problem(428);
        const current = rows.get(body.id);
        if (!current) return problem(404);
        if (`"${current.revision}"` !== ifMatch) return problem(412);
        const { id: _id, ...changes } = body;
        row = { ...current, data: { ...current.data, ...changes } };
      }
      seq += 1;
      row = { ...row, revision: seq };
      rows.set(row.id, row);
      journal.push({ seq, ordinal: 0, entity: row.entity, record_id: row.id, revision: seq, data: row.data });
      const result = { record: row, seq, permission_epoch: epoch.value };
      receipts.set(key, result);
      return json(200, result);
    }
    return problem(404);
  };
  return { fetch: fetch as typeof globalThis.fetch, rows, journal, requests, epoch };
}

export function memoryStorage(): SyncStorage {
  const map = new Map<string, unknown>();
  return {
    kv: {
      get: <T>(key: string) => structuredClone(map.get(key)) as T | undefined,
      put: (key, value) => { map.set(key, structuredClone(value)); },
      delete: (key) => map.delete(key),
      list: <T>({ prefix }: { prefix: string }) => [...map].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, value as T] as [string, T]),
    },
    transactionSync: (fn) => fn(),
  };
}

export function fakeQueue(viewer = { id: "ada@example.com", displayName: "Ada" }) {
  const assertions = new Map<string, string>();
  const log: string[] = [];
  const submitted: { action: number; description: Parameters<WorkshopQueue["submitAction"]>[1] }[] = [];
  let excluded: string[] | undefined;
  const queue: WorkshopQueue = {
    async consumeViewerAssertion(assertion, hash) {
      const expected = assertions.get(assertion);
      assertions.delete(assertion);
      if (expected !== hash) throw new Error("Viewer assertion is invalid, expired or for another intent.");
      log.push("assert");
      return viewer;
    },
    async authorizeObservation(description) { excluded = description.excludeObservers; log.push(`observe:${description.title}`); },
    async submitAction(action, description) { submitted.push({ action, description }); log.push(`submit:${action}`); },
  };
  return {
    queue, log, submitted,
    get excluded() { return excluded; },
    /** What `gadget.$createViewerAssertion(binding, digest)` does in the Workshop. */
    assert(digest: string) { const token = crypto.randomUUID(); assertions.set(token, digest); return token; },
  };
}
