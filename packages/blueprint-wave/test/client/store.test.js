// Store tests against the scripted fake gadget (test/client/fake-gadget.js): the structure
// channel (optimistic creates, deletes, restores, title, template, participants), request replay,
// heartbeat restart and gap detection, presence, and the unrecoverable signal.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRESENCE_HEARTBEAT_MS, PRESENCE_STALE_MS } from "../../src/shared/protocol.js";
import { getTemplate } from "../../src/shared/templates.js";
import { FakeRpcTarget, FakeServer, fakeId, resolved, settle, startStore } from "./helpers.js";
import {
  GAP_GRACE_MS, PRESENCE_FAILURES_TO_RESUBSCRIBE, REQUEST_TIMEOUT_MS, SUBSCRIBE_HANG_MS,
  UNRECOVERABLE_AFTER_MS, createStore,
} from "../../src/client/sync/store.js";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

/** A wave with one root blip and `n` stores. */
async function setup({ n = 2, latency = 5, eventLatency = undefined, seed = undefined } = {}) {
  const server = new FakeServer({ latency, eventLatency });
  const rootId = server.seed({ text: "Seed root" });
  const extra = seed ? seed(server, rootId) : {};
  const clients = [];
  for (let i = 0; i < n; i++) clients.push(await startStore(server, "user" + i));
  await settle();
  return { server, rootId, clients, ...extra };
}

const kinds = (client, kind) => client.changes.filter((c) => c.change.kind === kind);
/** A client's applyOperation calls, less the participant upsert every store sends when it joins. */
const opsFrom = (server, clientId) => server.callsOf("applyOperation")
  .filter((c) => c.args[0].senderId === clientId)
  .filter((c, i) => !(i === 0 && c.args[0].participantOps && !c.args[0].blipOps && !c.args[0].structure));

describe("optimistic structure", () => {
  it("creates a root optimistically with an order key after the last root and converges", async () => {
    const { server, rootId, clients: [a, b] } = await setup({ latency: 20 });
    const id = a.store.createBlip({ parentId: null, text: "Hello" });
    const local = a.store.getState().blips[id];
    expect(local).toMatchObject({ id, parentId: null, anchor: null, kind: "note", by: "user0", version: 0, preview: "Hello" });
    expect(local.order > server.blips[rootId].order).toBe(true);
    expect(a.store.getState().pending).toBe(1);
    expect(a.store.getState().saving).toBe("saving");
    expect(a.store.getState().meta.rootOrder).toEqual([rootId, id]);
    expect(kinds(a, "blips").at(-1).change).toEqual({ kind: "blips", blips: [id] });
    await settle(200);
    expect(server.blips[id]).toMatchObject({ version: 1, order: local.order, preview: "Hello" });
    expect(server.textOf(id)).toBe("Hello");
    for (const c of [a, b]) {
      expect(c.store.getState().blips).toEqual(server.wave().blips);
      expect(c.store.getState().meta.rootOrder).toEqual([rootId, id]);
      expect(c.store.getState().pending).toBe(0);
      expect(c.store.getState().saving).toBe("saved");
    }
    expect(kinds(a, "events").length).toBeGreaterThan(0);
  });

  it("creates a reply with anchor end by default, and orders between siblings with `after`", async () => {
    const { server, rootId, clients: [a] } = await setup({ n: 1 });
    const r1 = a.store.createBlip({ parentId: rootId, text: "one" });
    const r2 = a.store.createBlip({ parentId: rootId, text: "two" });
    const mid = a.store.createBlip({ parentId: rootId, text: "between", after: r1 });
    const first = a.store.createBlip({ parentId: rootId, text: "first", after: null });
    const s = a.store.getState().blips;
    expect(s[r1]).toMatchObject({ parentId: rootId, anchor: { type: "end" } });
    expect(s[first].order < s[r1].order).toBe(true);
    expect(s[r1].order < s[mid].order && s[mid].order < s[r2].order).toBe(true);
    await settle(300);
    expect(Object.keys(server.blips)).toHaveLength(5);
    expect(a.store.getState().blips).toEqual(server.wave().blips);
  });

  it("refuses a reply to an unknown or deleted parent locally", async () => {
    const { rootId, clients: [a] } = await setup({ n: 1 });
    expect(a.store.createBlip({ parentId: fakeId() })).toBe("");
    expect(a.store.getState().lastError).toBe("unknown_blip");
    a.store.deleteBlip(rootId);
    expect(a.store.createBlip({ parentId: rootId })).toBe("");
  });

  it("soft-deletes and restores optimistically; the server agrees", async () => {
    const { server, rootId, clients: [a, b] } = await setup({ latency: 20 });
    a.store.deleteBlip(rootId);
    expect(a.store.getState().blips[rootId].deleted).toBe(true);
    await settle(200);
    expect(server.blips[rootId].deleted).toBe(true);
    expect(b.store.getState().blips[rootId].deleted).toBe(true);
    b.store.restoreBlip(rootId);
    expect(b.store.getState().blips[rootId].deleted).toBe(false);
    await settle(200);
    expect(server.blips[rootId].deleted).toBe(false);
    expect(a.store.getState().blips[rootId]).toEqual(server.blips[rootId]);
    expect(server.blips[rootId].version).toBe(3);
  });

  it("refuses to delete a locked blip with an error", async () => {
    const { clients: [a] } = await setup({ n: 1, seed: (server) => ({ dec: server.seed({ kind: "decision", locked: true, text: "Decided" }) }) });
    const dec = Object.values(a.store.getState().blips).find((b) => b.kind === "decision");
    a.store.deleteBlip(dec.id);
    expect(a.store.getState().blips[dec.id].deleted).toBe(false);
    expect(a.store.getState().lastError).toBe("locked");
  });

  it("cancels create + delete before sending, and coalesces delete + restore", async () => {
    const { server, rootId, clients: [a] } = await setup({ n: 1, latency: 20 });
    a.store.setTitle("hold the queue"); // in flight
    const id = a.store.createBlip({ parentId: null });
    a.store.deleteBlip(id);
    expect(a.store.getState().blips[id]).toBeUndefined();
    a.store.deleteBlip(rootId);
    a.store.restoreBlip(rootId);
    expect(a.store.getState().blips[rootId].deleted).toBe(false);
    await settle(300);
    const sends = opsFrom(server, a.clientId);
    expect(sends).toHaveLength(1);
    expect(server.blips[id]).toBeUndefined();
    expect(server.blips[rootId].version).toBe(1);
  });

  it("rolls a refused change back and reports it", async () => {
    const { server, rootId, clients: [a] } = await setup({ n: 1, latency: 20 });
    server.beforeApply = (req) => { for (const op of req.blipOps ?? []) if (op.op === "delete") server.blips[op.blipId].locked = true; };
    a.store.deleteBlip(rootId);
    expect(a.store.getState().blips[rootId].deleted).toBe(true);
    await settle(200);
    expect(a.store.getState().blips[rootId].deleted).toBe(false);
    expect(a.store.getState().lastError).toBe("locked");
    expect(a.store.getState().pending).toBe(0);
  });

  it("retries a delete rejected as stale against the new version", async () => {
    const { server, rootId, clients: [a] } = await setup({ n: 1, latency: 20 });
    let bumped = false;
    server.beforeApply = () => {
      if (bumped) return;
      bumped = true;
      server.blips[rootId].version += 5; // someone changed it twice since we read it
    };
    a.store.deleteBlip(rootId);
    await settle(300);
    expect(server.blips[rootId].deleted).toBe(true);
    expect(a.store.getState().blips[rootId]).toEqual(server.blips[rootId]);
    expect(opsFrom(server, a.clientId)).toHaveLength(2);
  });

  it("sets the title (last writer wins) and upserts the viewer as a participant", async () => {
    const { server, clients: [a, b] } = await setup();
    expect(server.participants.map((p) => p.id).sort()).toEqual(["p-user0", "p-user1"]);
    a.store.setTitle("  Plan  ");
    expect(a.store.getState().meta.title).toBe("Plan");
    expect(kinds(a, "meta").length).toBeGreaterThan(0);
    b.store.setTitle("Plan B");
    await settle(200);
    expect(server.title).toBe("Plan B");
    for (const c of [a, b]) expect(c.store.getState().meta.title).toBe("Plan B");
    a.store.setViewer("Alice", "#ABCDEF");
    expect(a.store.getState().viewer).toMatchObject({ name: "Alice", color: "#abcdef" });
    expect(a.store.getState().meta.participants.find((p) => p.id === "p-user0")).toMatchObject({ name: "Alice", color: "#abcdef" });
    await settle(200);
    expect(server.participants.find((p) => p.id === "p-user0")).toEqual({ id: "p-user0", name: "Alice", color: "#abcdef" });
  });

  it("applies a template once; the second applier keeps the first's template id", async () => {
    const server = new FakeServer({ latency: 10 });
    const a = await startStore(server, "a");
    const b = await startStore(server, "b");
    await settle();
    const pa = a.store.applyTemplate("decision");
    const pb = b.store.applyTemplate("retrospective");
    await settle(200);
    const [ra, rb] = [await pa, await pb];
    expect(ra.status).toBe("applied");
    expect(rb.status).toBe("applied"); // its creates land (the fake has no "unchanged" for that)
    expect(server.template).toBe("decision");
    const t = getTemplate("decision");
    expect(Object.values(server.blips).filter((x) => x.kind === "brief")).toHaveLength(2);
    expect(Object.values(server.blips)).toHaveLength(2 + t.roots.length + getTemplate("retrospective").roots.length);
    for (const c of [a, b]) expect(c.store.getState().meta.template).toBe("decision");
    expect(await a.store.applyTemplate("blank")).toMatchObject({ error: "invalid_argument" });
    expect(await a.store.applyTemplate("nope")).toMatchObject({ error: "invalid_argument" });
  });

  it("sends one request at a time, never two ops on one blip in a request", async () => {
    const { server, rootId, clients: [a] } = await setup({ n: 1, latency: 20 });
    a.store.setTitle("x"); // in flight
    a.store.deleteBlip(rootId);
    a.store.setTitle("y");
    const id = a.store.createBlip({ parentId: null });
    await settle(400);
    const sends = opsFrom(server, a.clientId).map((c) => c.args[0]);
    expect(sends).toHaveLength(2);
    expect(sends[1].blipOps.map((o) => o.op)).toEqual(["delete", "create"]);
    expect(sends[1].structure).toEqual({ title: "y" });
    expect(server.blips[id]).toBeTruthy();
    expect(server.blips[rootId].deleted).toBe(true);
  });
});

describe("events and results", () => {
  it("applies the result and the echo once, keeping identity for a no-op echo", async () => {
    const { rootId, clients: [a] } = await setup({ n: 1, latency: 5, eventLatency: 60 });
    a.store.deleteBlip(rootId);
    await settle(20); // result arrived, echo (same seq) still on its way
    const afterResult = a.store.getState().blips[rootId];
    expect(afterResult.deleted).toBe(true);
    const count = kinds(a, "blips").length;
    await settle(100); // echo arrived
    expect(kinds(a, "blips").length).toBe(count);
    expect(a.store.getState().blips[rootId]).toBe(afterResult);
  });

  it("carries runs from events and results; retryRun re-asks with the run's scope", async () => {
    const server = new FakeServer({ latency: 5, model: true });
    server.seed({});
    const a = await startStore(server, "a");
    const b = await startStore(server, "b");
    await settle();
    expect(a.store.getState().capabilities.model).toBe(true);
    const res = await resolved(a.store.askAgent({ op: "summarise", instructions: "short" }));
    expect(res.run.state).toBe("queued");
    expect(a.store.getState().runs[res.run.id]).toMatchObject({ op: "summarise" });
    await settle(50);
    expect(b.store.getState().runs[res.run.id]).toMatchObject({ op: "summarise" });
    expect(kinds(b, "runs").length).toBeGreaterThanOrEqual(1);
    const cancelled = await resolved(a.store.cancelRun(res.run.id));
    expect(cancelled.run.state).toBe("cancelled");
    const retried = await resolved(a.store.retryRun(res.run.id));
    expect(retried.run).toMatchObject({ op: "summarise", instructions: "short" });
    expect(await resolved(a.store.retryRun("r_000000000000"))).toMatchObject({ error: "unknown_run" });
  });

  it("reply and recordDecision fold their blips in; reviewProposal sends the current version", async () => {
    const { server, rootId, clients: [a] } = await setup({ n: 1 });
    const r = await resolved(a.store.reply({ parentId: rootId, text: "hi" }));
    expect(a.store.getState().blips[r.blip.id]).toMatchObject({ parentId: rootId, preview: "hi" });
    const d = await resolved(a.store.recordDecision({ threadId: rootId, text: "Do it", rationale: "why" }));
    expect(a.store.getState().blips[d.blip.id]).toMatchObject({ kind: "decision", locked: true });
    expect(await resolved(a.store.reviewProposal(fakeId(), "accept"))).toMatchObject({ error: "unknown_blip" });
    const pid = server.seed({ parentId: rootId, kind: "proposal", version: 4, proposal: { targetId: rootId, baseSeq: 0, quote: "", replacement: "x", summary: "s", sources: [], state: "review" } });
    server.broadcast("operation", { type: "operation", senderId: "", seq: ++server.seq, upserts: [server.blips[pid]], deletes: [], events: [] });
    await settle(20);
    expect(a.store.getState().blips[pid].version).toBe(4);
    const rv = await resolved(a.store.reviewProposal(pid, "accept"));
    expect(rv.status).toBe("applied");
    expect(server.callsOf("reviewProposal").at(-1).args[0]).toMatchObject({ proposalId: pid, expectedVersion: 4, decision: "accept" });
    expect(a.store.getState().blips[pid].proposal.state).toBe("accepted");
    expect(await resolved(a.store.getChanges(0))).toMatchObject({ seq: server.seq });
    expect(typeof await resolved(a.store.exportMarkdown())).toBe("string");
  });
});

describe("replay and reconnection", () => {
  it("replays a request whose result was lost verbatim; the server answers it once", async () => {
    const { server, clients: [a] } = await setup({ n: 1, latency: 10 });
    server.failNext("applyOperation");
    const id = a.store.createBlip({ parentId: null, text: "once" });
    await settle(1000);
    const sends = opsFrom(server, a.clientId).filter((c) => c.args[0].blipOps?.some((o) => o.blipId === id));
    expect(sends.length).toBeGreaterThanOrEqual(2);
    expect(new Set(sends.map((c) => c.args[0].requestId)).size).toBe(1);
    expect(Object.values(server.blips).filter((b) => b.preview === "once")).toHaveLength(1);
    expect(a.store.getState().pending).toBe(0);
    expect(a.store.getState().connection).toBe("live");
  });

  it("re-subscribes when the heartbeat says the server does not know us (restart)", async () => {
    const { server, rootId, clients: [a] } = await setup({ n: 1, latency: 10 });
    const subs = server.callsOf("subscribe").length;
    server.restart();
    server.blips[rootId].deleted = true; // changed while we were away
    server.seq++;
    await settle(PRESENCE_HEARTBEAT_MS + 200);
    expect(server.callsOf("subscribe").length).toBe(subs + 1);
    expect(a.store.getState().connection).toBe("live");
    expect(a.store.getState().blips[rootId].deleted).toBe(true);
    expect(kinds(a, "snapshot")).toHaveLength(1); // the first snapshot came before the listener
  });

  it("re-subscribes after a sequence gap reported by the heartbeat persists", async () => {
    const { server, rootId, clients: [a] } = await setup({ n: 1, latency: 10 });
    server.dropping.add(a.clientId);
    server.blips[rootId].deleted = true;
    server.seq += 3;
    const subs = server.callsOf("subscribe").length;
    await settle(PRESENCE_HEARTBEAT_MS + GAP_GRACE_MS + 200);
    server.dropping.delete(a.clientId);
    await settle(200);
    expect(server.callsOf("subscribe").length).toBe(subs + 1);
    expect(a.store.getState().blips[rootId].deleted).toBe(true);
  });

  it("keeps the session across re-subscribes and reports reconnecting meanwhile", async () => {
    const { server, clients: [a] } = await setup({ n: 1, latency: 30 });
    const session = server.callsOf("updatePresence").at(-1).args[0].session;
    expect(session).toMatch(/^[0-9a-f]{32}$/);
    server.disposeSubscriber(a.clientId);
    await settle(10);
    expect(a.store.getState().connection).toBe("reconnecting");
    await settle(200);
    expect(a.store.getState().connection).toBe("live");
    expect(server.callsOf("subscribe").at(-1).args[0].session).toBe(session);
  });

  it("times out a hung request and replays it", async () => {
    const server = new FakeServer({ latency: 5 });
    server.seed({});
    const inner = server.connect();
    let hang = true;
    const gadget = { ...inner, applyOperation: (req) => (hang ? new Promise(() => {}) : inner.applyOperation(req)) };
    const a = await startStore(server, "a", { gadget });
    await settle();
    const id = a.store.createBlip({ parentId: null });
    hang = false;
    await settle(REQUEST_TIMEOUT_MS + 1000);
    expect(server.blips[id]).toBeTruthy();
    expect(a.store.getState().pending).toBe(0);
  });

  it("takes a new clientId when the server says ours is in use", async () => {
    const server = new FakeServer({ latency: 5 });
    server.seed({});
    const a = await startStore(server, "a", { clientId: "shared-id" });
    await settle();
    const b = await startStore(server, "b", { clientId: "shared-id" });
    await settle();
    expect(b.store.getState().viewer.clientId).not.toBe("shared-id");
    expect(b.store.getState().connection).toBe("live");
    expect(a.store.getState().connection).toBe("live");
  });
});

describe("presence", () => {
  it("delivers peers with blip, editing and carets; clears them off a blip; leaves on dispose", async () => {
    const { rootId, clients: [a, b] } = await setup({ latency: 5 });
    await settle(100);
    expect(a.store.getState().peers.get(b.clientId)).toMatchObject({ name: "user1", blipId: null, editing: false });
    b.store.setPresence({ blipId: rootId, editing: true, anchor: "AAA=", head: "AAA=" });
    await settle(100);
    expect(a.store.getState().peers.get(b.clientId)).toMatchObject({ blipId: rootId, editing: true, anchor: "AAA=", head: "AAA=" });
    b.store.setPresence({ blipId: null });
    await settle(100);
    expect(a.store.getState().peers.get(b.clientId)).toMatchObject({ blipId: null, editing: false, anchor: null, head: null });
    b.store.dispose();
    await settle(100);
    expect(a.store.getState().peers.has(b.clientId)).toBe(false);
  });

  it("drops a peer whose heartbeats stop reaching us", async () => {
    const { server, clients: [a, b] } = await setup({ latency: 5 });
    await settle(100);
    expect(a.store.getState().peers.has(b.clientId)).toBe(true);
    server.dropping.add(a.clientId);
    await settle(PRESENCE_STALE_MS + 2000);
    expect(a.store.getState().peers.has(b.clientId)).toBe(false);
  });

  it("keeps one presence call in flight and sends the latest state after it settles", async () => {
    const { rootId, server, clients: [a] } = await setup({ n: 1, latency: 50 });
    const before = server.callsOf("updatePresence").length;
    for (let i = 0; i < 20; i++) {
      a.store.setPresence({ blipId: rootId, editing: true, head: "AAA" + (i % 4) + "=" });
      await settle(10);
    }
    await settle(300);
    const calls = server.callsOf("updatePresence").slice(before);
    expect(calls.length).toBeLessThan(10);
    expect(calls.at(-1).args[0]).toMatchObject({ blipId: rootId, editing: true });
  });

  it("re-subscribes after repeated presence failures", async () => {
    const { server, clients: [a] } = await setup({ n: 1, latency: 5 });
    const subs = server.callsOf("subscribe").length;
    for (let i = 0; i < PRESENCE_FAILURES_TO_RESUBSCRIBE; i++) server.failNext("updatePresence");
    await settle(PRESENCE_HEARTBEAT_MS * (PRESENCE_FAILURES_TO_RESUBSCRIBE + 1));
    expect(server.callsOf("subscribe").length).toBe(subs + 1);
    expect(a.store.getState().connection).toBe("live");
  });
});

describe("unrecoverable", () => {
  it("fires once after three failed subscribes in a row, and keeps retrying", async () => {
    const server = new FakeServer({ latency: 5 });
    server.seed({});
    let fired = 0;
    const a = await startStore(server, "a", { onUnrecoverable: () => fired++ });
    await settle();
    for (let i = 0; i < 6; i++) server.failNext("subscribe");
    server.restart();
    await settle(PRESENCE_HEARTBEAT_MS + 30000);
    expect(fired).toBe(1);
    expect(a.store.getState().connection).toBe("live");
  });

  it("fires when non-live for UNRECOVERABLE_AFTER_MS without any call succeeding", async () => {
    const server = new FakeServer({ latency: 5 });
    server.seed({});
    let fired = 0;
    await startStore(server, "a", { onUnrecoverable: () => fired++ });
    await settle();
    for (let i = 0; i < 3; i++) server.failNext("subscribe");
    server.restart();
    await settle(PRESENCE_HEARTBEAT_MS + UNRECOVERABLE_AFTER_MS + 2000);
    expect(fired).toBe(1);
  });

  it("does not count time waiting on a slow subscribe, but fires when it hangs for SUBSCRIBE_HANG_MS", async () => {
    const server = new FakeServer({ latency: 5 });
    server.seed({});
    const inner = server.connect();
    let hang = false;
    const gadget = { ...inner, subscribe: (cb, info) => (hang ? new Promise(() => {}) : inner.subscribe(cb, info)) };
    let fired = 0;
    await startStore(server, "a", { gadget, onUnrecoverable: () => fired++ });
    await settle();
    hang = true;
    server.restart();
    await settle(PRESENCE_HEARTBEAT_MS + UNRECOVERABLE_AFTER_MS + 2000);
    expect(fired).toBe(0);
    await settle(SUBSCRIBE_HANG_MS);
    expect(fired).toBe(1);
  });
});

describe("request ids and startup", () => {
  it("are a per-store random secret plus a counter, never derived from the clientId", async () => {
    const server = new FakeServer({ latency: 5 });
    server.seed({});
    const a = await startStore(server, "a", { clientId: "client-a" });
    const b = await startStore(server, "b", { clientId: "client-b" });
    await settle();
    for (let i = 0; i < 3; i++) {
      a.store.createBlip({ parentId: null });
      b.store.createBlip({ parentId: null });
      await settle(100);
    }
    const ids = (clientId) => server.callsOf("applyOperation").filter((c) => c.args[0].senderId === clientId).map((c) => c.args[0].requestId);
    const [idsA, idsB] = [ids("client-a"), ids("client-b")];
    expect(idsA.length).toBeGreaterThanOrEqual(3);
    const secret = (id) => id.split(":")[0];
    for (const id of [...idsA, ...idsB]) {
      expect(id).toMatch(/^[0-9a-f]{24}:\d+$/);
      expect(id).not.toContain("client-");
    }
    expect(new Set(idsA.map(secret)).size).toBe(1);
    expect(secret(idsA[0])).not.toBe(secret(idsB[0]));
  });

  it("createStore resolves only once subscribed, with the snapshot installed", async () => {
    const server = new FakeServer({ latency: 5 });
    const rootId = server.seed({ text: "x" });
    const p = createStore({ gadget: server.connect(), RpcTarget: FakeRpcTarget, viewer: { clientId: "c", participantId: "p", name: "n", color: "#123456" } });
    await settle(50);
    const store = await p;
    expect(store.getState().connection).toBe("live");
    expect(store.getState().blips[rootId]).toBeTruthy();
    expect(store.getState().capabilities).toEqual({ model: false });
    store.dispose();
  });
});
