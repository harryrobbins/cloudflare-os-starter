// Server tests in workerd: the Gadget Durable Object over real DO storage, RPC callbacks,
// presence, snapshot paging, imports and the ExportHandler. Storage persists between tests, so
// each test uses its own DO. The last describe block is spike S1/S2 (docs/plans/
// network-map-blueprint.md §11): storage and transfer at the editable limits.
import { env, RpcTarget } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ExportHandler } from "../../src/server/index.js";
import { createNetworkMap } from "../../src/core/network-map.js";
import { DoStorageRepository } from "../../src/server/do-repository.js";

class Callbacks extends RpcTarget {
  ops = [];
  calls = [];
  operation(event) { this.ops.push(event); }
  presence(events) { this.calls.push(events); }
  get presences() { return this.calls.flat(); }
}

const fresh = () => {
  const name = crypto.randomUUID();
  return env.GADGET.get(env.GADGET.idFromName(name));
};
const hex = (n) => n.toString(16).padStart(12, "0");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The message an RPC call rejects with (expect().rejects leaves an unhandled rejection in workerd). */
async function errorOf(promise) {
  try { await promise; } catch (e) { return String(e?.message ?? e); }
  return null;
}

async function readAll(stub) {
  const first = await stub.openSnapshot();
  const objects = [...first.objects];
  const positions = [...first.positions];
  let next = first.next;
  let pages = 1;
  while (next !== null) {
    const page = await stub.snapshotPage(first.token, next);
    objects.push(...page.objects);
    positions.push(...page.positions);
    next = page.next;
    pages++;
  }
  return { first, objects, positions, pages };
}

describe("storage", () => {
  it("seeds the demo and uses the documented key layout", async () => {
    const stub = fresh();
    const d = await stub.describeMap();
    expect(d.counts).toMatchObject({ elements: 16, connections: 22, loops: 2, views: 3, types: 5, fields: 3 });
    const keys = await runInDurableObject(stub, async (_i, state) => [...(await state.storage.list()).keys()]);
    const prefixes = new Set(keys.map((k) => (k.includes(":") ? k.slice(0, k.indexOf(":") + 1) : k)));
    expect([...prefixes].sort()).toEqual(["history", "meta", "o:", "p:", "requests"].sort());
    for (const k of keys) {
      const size = await runInDurableObject(stub, async (_i, state) => JSON.stringify(await state.storage.get(k)).length);
      expect(size).toBeLessThan(100 * 1024);
    }
  });

  it("commits a change with its inverse and survives a new instance over the same storage", async () => {
    const stub = fresh();
    const r = await stub.applyOperation({ senderId: "s", by: "Ann", requestId: "r:1", ops: [
      { op: "create", object: { id: "e_" + hex(0xabc), label: "New" } },
      { op: "move", layout: "shared", items: [{ id: "e_" + hex(0xabc), x: 10, y: 20 }] },
    ] });
    expect(r.status).toBe("applied");
    const keys = await runInDurableObject(stub, async (_i, state) => [...(await state.storage.list({ prefix: "inv:" })).keys()]);
    expect(keys).toEqual([`inv:${r.history.id}:0`]);
    const reloaded = await runInDurableObject(stub, async (_i, state) => {
      const map = createNetworkMap(new DoStorageRepository(state.storage));
      return (await map.getMap()).objects.find((o) => o.id === "e_" + hex(0xabc));
    });
    expect(reloaded.label).toBe("New");
    const undone = await stub.undo({ senderId: "s", by: "Ann" });
    expect(undone.status).toBe("applied");
    expect((await stub.findElements({ text: "New" })).length).toBe(0);
  });
});

describe("live updates", () => {
  it("delivers operations and presence to subscribers", async () => {
    const stub = fresh();
    const a = new Callbacks(), b = new Callbacks();
    const sa = await stub.subscribe(a, { clientId: "a", name: "Ann", color: "#ff0000" });
    const sb = await stub.subscribe(b, { clientId: "b", name: "Bob", color: "#00ff00" });
    expect(sa.counts.elements).toBe(16);
    await stub.applyOperation({ senderId: "a", by: "Ann", ops: [{ op: "create", object: { id: "e_" + hex(0xf00001), label: "Live" } }] });
    await stub.updatePresence({ clientId: "a", session: sa.session, cursor: { x: 1, y: 2 }, selection: ["e_" + hex(0xf00001)] });
    for (let i = 0; i < 50 && (!b.ops.length || !b.presences.some((p) => p.clientId === "a" && p.cursor)); i++) await sleep(20);
    expect(b.ops.at(-1).upserts[0].label).toBe("Live");
    expect(b.presences.find((p) => p.clientId === "a" && p.cursor)).toMatchObject({ cursor: { x: 1, y: 2 }, name: "Ann" });
    const res = await stub.updatePresence({ clientId: "b", session: "0".repeat(32), cursor: null });
    expect(res.known).toBe(false);
    stub.leavePresence("b", sb.session);
  });

  it("gives snapshot pages from one revision while writes continue", async () => {
    const stub = fresh();
    const first = await stub.openSnapshot();
    await stub.applyOperation({ senderId: "x", ops: [{ op: "create", object: { id: "e_" + hex(0xf00002), label: "Later" } }] });
    let next = first.next;
    const objects = [...first.objects];
    while (next !== null) { const p = await stub.snapshotPage(first.token, next); objects.push(...p.objects); next = p.next; }
    expect(objects.some((o) => o.label === "Later")).toBe(false);
    expect((await stub.openSnapshot()).revision).toBe(first.revision + 1);
  });
});

describe("imports", () => {
  it("stages, reviews and applies a changeset with checkpoints", async () => {
    const stub = fresh();
    const cs = await stub.createChangeset({ name: "people", source: "test:people", by: "Ann" });
    await stub.addChangesetItems({ changesetId: cs.id, items: [
      { kind: "type", name: "Person", appliesTo: "element" },
      { kind: "element", key: "a", label: "Alice", type: "Person" },
      { kind: "element", key: "b", label: "Food bank" },
      { kind: "connection", from: "a", to: "b", label: "volunteers at" },
    ] });
    const review = await stub.finalizeChangeset({ changesetId: cs.id });
    expect(review.status).toBe("review");
    expect(review.counts).toMatchObject({ create: 3, "use-existing": 1 });
    const done = await stub.acceptChangeset({ changesetId: cs.id, digest: review.digest, by: "Ann", senderId: "s" });
    expect(done.status).toBe("applied");
    const alice = (await stub.findElements({ text: "Alice" }))[0];
    expect(alice.provenance).toMatchObject({ origin: "import", changesetId: cs.id });
    const hood = await stub.getNeighbourhood({ id: alice.id });
    expect(hood.elements.map((e) => e.label)).toContain("Food bank");
    expect(await errorOf(stub.acceptChangeset({ changesetId: cs.id, digest: review.digest, by: "Ann" }))).toMatch(/applied, not in review/);
  });

  it("refuses an accept whose digest is not the reviewed one", async () => {
    const stub = fresh();
    const cs = await stub.createChangeset({ name: "x", by: "Ann" });
    await stub.addChangesetItems({ changesetId: cs.id, items: [{ kind: "element", key: "k", label: "K" }] });
    const review = await stub.finalizeChangeset({ changesetId: cs.id });
    await stub.setDecisions({ changesetId: cs.id, decisions: [{ iid: "i0", action: "skip" }] });
    expect(await errorOf(stub.acceptChangeset({ changesetId: cs.id, digest: review.digest, by: "Ann" }))).toMatch(/changed since you reviewed/);
  });
});

describe("export handler", () => {
  it("offers and produces every format through snapshot pages", async () => {
    const stub = fresh();
    const handler = new ExportHandler({}, {});
    const formats = await handler.getExportFormats(stub);
    expect(formats.map((f) => f.id)).toEqual(["backup", "kumu", "elements-csv", "connections-csv", "graphml", "gexf"]);
    for (const f of formats) {
      const body = await handler.export(stub, f.id);
      const text = await new Response(body).text();
      expect(text.length).toBeGreaterThan(200);
      if (f.id === "backup") expect(JSON.parse(text)).toMatchObject({ format: "cloudflare-os-network-map", version: 1 });
      if (f.id === "graphml") expect(text).toContain("<graphml");
    }
  });
});

// Spike S1 (facet storage at scale) and S2 (snapshot transfer). Numbers print to the console and
// are recorded in docs/plans/network-map-blueprint.md; the assertions are the plan's pass criteria.
describe("spike S1/S2: 10,000 elements and 30,000 connections", () => {
  it("writes, reloads and pages the map within the budgets", async () => {
    const stub = fresh();
    // The demo holds 16 elements and 22 connections; fill up to exactly the limits.
    const N = 10_000 - 16, M = 30_000 - 22;
    const t0 = Date.now();
    for (let start = 0; start < N; start += 2000) {
      const ops = [];
      for (let i = start; i < Math.min(N, start + 2000); i++) ops.push({ op: "create", object: { id: "e_" + hex(0x100000 + i), label: `Element ${i} with a realistic label`, tags: i % 3 ? ["alpha"] : ["beta", "gamma"] } });
      const r = await stub.applyOperation({ senderId: "fill", ops });
      expect(r.errors).toEqual([]);
    }
    const tElements = Date.now() - t0;
    let s = 42;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let start = 0; start < M; start += 2000) {
      const ops = [];
      for (let j = start; j < Math.min(M, start + 2000); j++) {
        const a = Math.floor(rnd() * N), b = Math.floor(Math.pow(rnd(), 2) * N);
        ops.push({ op: "create", object: { id: "c_" + hex(0x200000 + j), from: "e_" + hex(0x100000 + a), to: "e_" + hex(0x100000 + b), direction: j % 3 ? "directed" : "undirected", ...(j % 5 ? {} : { label: "supports" }) } });
      }
      const r = await stub.applyOperation({ senderId: "fill", ops });
      expect(r.errors).toEqual([]);
    }
    const tConnections = Date.now() - t0 - tElements;
    // Positions for every element, in chunks.
    for (let start = 0; start < N; start += 2000) {
      const items = [];
      for (let i = start; i < Math.min(N, start + 2000); i++) items.push({ id: "e_" + hex(0x100000 + i), x: (i % 100) * 50, y: Math.floor(i / 100) * 50 });
      await stub.applyOperation({ senderId: "fill", ops: [{ op: "move", layout: "shared", items }] });
    }
    const tWrite = Date.now() - t0;

    // Cold load: a fresh map over the same storage.
    const cold = await runInDurableObject(stub, async (_i, state) => {
      const start = Date.now();
      const map = createNetworkMap(new DoStorageRepository(state.storage));
      const snap = await map.openSnapshot();
      const loadMs = Date.now() - start;
      const dbBytes = state.storage.sql?.databaseSize ?? null;
      return { loadMs, dbBytes, counts: snap.counts, hasSql: typeof state.storage.sql?.exec === "function" };
    });

    // Transfer: every snapshot page over RPC.
    const t1 = Date.now();
    const all = await readAll(stub);
    const tTransfer = Date.now() - t1;
    const jsonBytes = JSON.stringify(all.objects).length + JSON.stringify(all.positions).length;

    console.log(JSON.stringify({
      spike: "S1/S2", elements: N + 16, connections: M + 22, writeElementsMs: tElements, writeConnectionsMs: tConnections, writeAllMs: tWrite,
      coldLoadMs: cold.loadMs, sqliteDatabaseBytes: cold.dbBytes, storageSqlAvailable: cold.hasSql,
      snapshotPages: all.pages, snapshotTransferMs: tTransfer, snapshotJsonBytes: jsonBytes,
    }));
    expect(cold.counts).toMatchObject({ elements: N + 16, connections: M + 22 });
    expect(all.objects.length).toBe(N + M + 16 + 22 + 2 + 3 + 5 + 3);
    expect(all.positions.find((p) => p.layout === "shared").ids.length).toBe(N + 16);
    expect(cold.loadMs).toBeLessThan(5000);
  });
});
