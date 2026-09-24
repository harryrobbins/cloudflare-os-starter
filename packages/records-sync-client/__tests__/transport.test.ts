import { describe, expect, it, vi } from "vitest";

import { SyncTransportError } from "../src/errors.js";
import { RecordStore } from "../src/store.js";
import { httpTransport, pokeSource, type FetchLike } from "../src/transport.js";
import { guardUnload } from "../src/unload.js";

function fakeFetch(status: number, body: unknown, contentType = "application/json") {
  const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? contentType : null) },
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    };
  };
  return { fetchImpl, calls };
}

const pushReq = { clientGroupId: "group-000001", clientId: "client-000001", mutations: [{ id: 1, name: "projects.addComment" as const, args: {} }] };

describe("httpTransport", () => {
  it("posts JSON to /sync/push and /sync/pull with fresh headers", async () => {
    const { fetchImpl, calls } = fakeFetch(200, { outcomes: [{ id: 1, status: "skipped" }], head: 3 });
    let n = 0;
    const t = httpTransport("https://records.example/v1/datastores/ds/", fetchImpl, () => ({ authorization: `Bearer t${++n}` }));
    await expect(t.push(pushReq)).resolves.toEqual({ outcomes: [{ id: 1, status: "skipped" }], head: 3 });
    expect(calls[0]!.url).toBe("https://records.example/v1/datastores/ds/sync/push");
    expect(calls[0]!.init).toMatchObject({ method: "POST", headers: { "content-type": "application/json", authorization: "Bearer t1" } });
    expect(JSON.parse(calls[0]!.init.body)).toEqual(pushReq);

    const pull = fakeFetch(200, { cookie: 4, lastMutationIdChanges: {}, patch: [] });
    const t2 = httpTransport("https://x/api", pull.fetchImpl);
    await expect(t2.pull({ clientGroupId: "group-000001", cookie: null })).resolves.toMatchObject({ cookie: 4 });
    expect(pull.calls[0]!.url).toBe("https://x/api/sync/pull");
  });

  it("maps problem+json errors to transport errors", async () => {
    const problem = { type: "x", title: "unauthenticated", status: 401, code: "unauthenticated", detail: "Sign in again." };
    const t = httpTransport("https://x", fakeFetch(401, problem, "application/problem+json").fetchImpl);
    const err = await t.push(pushReq).catch((e) => e);
    expect(err).toBeInstanceOf(SyncTransportError);
    expect(err).toMatchObject({ kind: "client", status: 401, code: "unauthenticated", message: "Sign in again.", retryable: false });

    const e503 = await httpTransport("https://x", fakeFetch(503, "gateway down", "text/plain").fetchImpl).pull({ clientGroupId: "group-000001", cookie: 1 }).catch((e) => e);
    expect(e503).toMatchObject({ kind: "server", status: 503, retryable: true });

    const e429 = await httpTransport("https://x", fakeFetch(429, { code: "rate_limited", title: "rate limited" }).fetchImpl).push(pushReq).catch((e) => e);
    expect(e429).toMatchObject({ kind: "server", code: "rate_limited", message: "rate limited" });
  });

  it("treats thrown fetches and timeouts as network errors, and malformed bodies as server errors", async () => {
    const boom: FetchLike = async () => {
      throw new TypeError("Failed to fetch");
    };
    await expect(httpTransport("https://x", boom).push(pushReq)).rejects.toMatchObject({ kind: "network", message: "Failed to fetch" });

    vi.useFakeTimers();
    const hang: FetchLike = (_u, init) =>
      new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    const p = httpTransport("https://x", hang, undefined, { timeoutMs: 1000 }).push(pushReq).catch((e) => e);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toMatchObject({ kind: "network", message: "The sync request timed out." });
    vi.useRealTimers();

    await expect(httpTransport("https://x", fakeFetch(200, { nope: true }).fetchImpl).pull({ clientGroupId: "group-000001", cookie: 0 })).rejects.toMatchObject({
      kind: "server",
      code: "malformed_response",
    });
  });
});

class FakeSource {
  private listeners = new Map<string, Set<(e: { data?: unknown }) => void>>();
  addEventListener(type: string, fn: (e: { data?: unknown }) => void) {
    (this.listeners.get(type) ?? this.listeners.set(type, new Set()).get(type)!).add(fn);
  }
  removeEventListener(type: string, fn: (e: { data?: unknown }) => void) {
    this.listeners.get(type)?.delete(fn);
  }
  dispatch(type: string, data?: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn({ data });
  }
  count() {
    return [...this.listeners.values()].reduce((n, s) => n + s.size, 0);
  }
}

describe("pokeSource", () => {
  it("forwards heads for the datastore, pulls on open, and unsubscribes", () => {
    const src = new FakeSource();
    const heads: number[] = [];
    const off = pokeSource(src, { datastoreId: "ds-1" })((h) => heads.push(h));
    src.dispatch("message", JSON.stringify({ datastoreId: "ds-1", head: 5 }));
    src.dispatch("message", JSON.stringify({ datastoreId: "ds-2", head: 9 }));
    src.dispatch("message", { datastoreId: "ds-1", head: 6 }); // already-parsed data (e.g. a MessagePort)
    src.dispatch("message", "not json");
    src.dispatch("message", JSON.stringify({ datastoreId: "ds-1", head: "7" }));
    src.dispatch("open");
    expect(heads).toEqual([5, 6, Number.POSITIVE_INFINITY]);
    off();
    expect(src.count()).toBe(0);
  });
});

describe("guardUnload", () => {
  it("asks to confirm leaving only while changes are unsynced", () => {
    const src = new FakeSource();
    const client = { hasUnsyncedChanges: false, flush: vi.fn(async () => {}) };
    const off = guardUnload(client, src as never);
    const ev = { preventDefault: vi.fn(), returnValue: undefined as unknown };
    src.dispatch("beforeunload");
    const fire = () => {
      for (const fn of (src as unknown as { listeners: Map<string, Set<(e: unknown) => void>> }).listeners.get("beforeunload")!) fn(ev);
    };
    fire();
    expect(ev.preventDefault).not.toHaveBeenCalled();
    client.hasUnsyncedChanges = true;
    fire();
    expect(ev.preventDefault).toHaveBeenCalledOnce();
    expect(ev.returnValue).toBe("");
    expect(client.flush).toHaveBeenCalledOnce();
    off();
    expect(src.count()).toBe(0);
  });
});

describe("RecordStore", () => {
  const ctx = { principal: { id: "p", displayName: "P", kind: "human" as const }, timestamp: 0 };

  it("a throwing replay step leaves no partial writes and others still apply", () => {
    const store = new RecordStore();
    store.applyServerPatch([{ op: "put", key: "a/1", value: { n: 1 } }]);
    const errors: unknown[] = [];
    const seen: string[][] = [];
    store.subscribe((c) => seen.push(c.changedKeys));
    store.rebase([
      {
        context: ctx,
        run: (tx) => {
          tx.put("a/2", { n: 2 });
          throw new Error("nope");
        },
        onError: (e) => errors.push(e),
      },
      { context: ctx, run: (tx) => tx.put("a/3", { n: tx.get<{ n: number }>("a/1")!.n + 2 }) },
    ]);
    expect(store.scan("a/")).toEqual([
      ["a/1", { n: 1 }],
      ["a/3", { n: 3 }],
    ]);
    expect(errors).toHaveLength(1);
    expect(seen).toEqual([["a/1", "a/3"]]);

    // Rebuilding to the same visible state notifies nobody.
    store.rebase([{ context: ctx, run: (tx) => tx.put("a/3", { n: 3 }) }]);
    expect(seen).toHaveLength(1);

    store.applyServerPatch([{ op: "clear" }]);
    store.rebase([]);
    expect(store.scan("")).toEqual([]);
    expect(seen.at(-1)).toEqual(["a/1", "a/3"]);
  });

  it("scan sees the transaction's own writes and deletes", () => {
    const store = new RecordStore();
    store.applyServerPatch([
      { op: "put", key: "x/1", value: 1 },
      { op: "put", key: "x/2", value: 2 },
    ]);
    store.rebase([]);
    store.applyLocal({
      context: ctx,
      run: (tx) => {
        tx.del("x/1");
        tx.put("x/3", 3);
        expect(tx.scan("x/")).toEqual([
          ["x/2", 2],
          ["x/3", 3],
        ]);
      },
    });
    expect(store.values("x/")).toEqual([2, 3]);
    expect(store.server.scan("x/")).toEqual([
      ["x/1", 1],
      ["x/2", 2],
    ]);
  });
});
