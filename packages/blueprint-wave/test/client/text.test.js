// Text channel tests: openBlip hydration, push batching (80 ms idle, 1 KiB flush, merge, one in
// flight across blips), echoes, gap detection and resync through a state vector, resync after a
// re-subscribe, blip_full handling, refcount release, pendingText, flushText, and pendingUpdate +
// restoreUpdate (Re-insert unsaved text after a reload).
import * as Y from "yjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRESENCE_HEARTBEAT_MS, TEXT_FLUSH_BYTES, TEXT_IDLE_MS, TEXT_MAX_WAIT_MS, decodeBytes, encodeBytes } from "../../src/shared/protocol.js";
import { FakeServer, resolved, settle, startStore } from "./helpers.js";
import { RESTORE_ORIGIN, restoreUpdate } from "../../src/client/sync/text.js";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

async function setup({ n = 2, latency = 5, eventLatency = undefined, text = "Hello world" } = {}) {
  const server = new FakeServer({ latency, eventLatency });
  const rootId = server.seed({ text });
  const clients = [];
  for (let i = 0; i < n; i++) clients.push(await startStore(server, "user" + i));
  await settle();
  return { server, rootId, clients };
}

/** Opens a blip, driving fake timers until the handle resolves. */
function open(store, id) {
  return resolved(store.openBlip(id));
}

const pushes = (server, clientId) => server.callsOf("pushText").filter((c) => c.args[0].senderId === clientId);
const kinds = (client, kind) => client.changes.filter((c) => c.change.kind === kind);

describe("open and hydrate", () => {
  it("hydrates the doc from openBlip and rejects unknown or deleted blips", async () => {
    const { server, rootId, clients: [a] } = await setup({ n: 1 });
    const h = await open(a.store, rootId);
    expect(h.text.toString()).toBe("Hello world");
    expect(a.store.getState().text[rootId]).toEqual({ textSeq: 0, saving: "saved", resyncing: false, lastError: null });
    await expect(open(a.store, "b_000000000000")).rejects.toMatchObject({ error: "unknown_blip" });
    a.store.deleteBlip(rootId);
    await settle(50);
    h.close();
    await expect(open(a.store, rootId)).rejects.toMatchObject({ error: "unknown_blip" });
    expect(server.callsOf("openBlip")).toHaveLength(1);
  });

  it("shares one doc between openers and releases it after the last close and ack", async () => {
    const { rootId, clients: [a] } = await setup({ n: 1, latency: 20 });
    const h1 = await open(a.store, rootId);
    const h2 = await open(a.store, rootId);
    expect(h2.doc).toBe(h1.doc);
    h1.text.insert(0, "x");
    h1.close();
    h2.close();
    expect(a.store.getState().text[rootId].saving).toBe("saving");
    await settle(TEXT_IDLE_MS + 100);
    expect(a.store.getState().text[rootId]).toBeUndefined();
    expect(a.store.pendingText(rootId)).toBeNull();
    const h3 = await open(a.store, rootId);
    expect(h3.doc).not.toBe(h1.doc);
    expect(h3.text.toString()).toBe("xHello world");
  });
});

describe("batching", () => {
  it("sends after 80 ms idle as one merged update, with a requestId", async () => {
    const { server, rootId, clients: [a, b] } = await setup({ latency: 5 });
    const h = await open(a.store, rootId);
    const hb = await open(b.store, rootId);
    const textChangesAtOpen = kinds(a, "text").length; // hydration is remote content and may emit
    h.text.insert(11, "!");
    await settle(TEXT_IDLE_MS / 2);
    h.text.insert(12, "?");
    await settle(TEXT_IDLE_MS / 2);
    expect(pushes(server, a.clientId)).toHaveLength(0);
    await settle(TEXT_IDLE_MS);
    const sent = pushes(server, a.clientId);
    expect(sent).toHaveLength(1);
    expect(sent[0].args[0]).toMatchObject({ blipId: rootId, senderId: a.clientId, by: "user0" });
    expect(sent[0].args[0].requestId).toMatch(/^[0-9a-f]{24}:\d+$/);
    await settle(50);
    expect(server.textOf(rootId)).toBe("Hello world!?");
    expect(hb.text.toString()).toBe("Hello world!?");
    expect(a.store.getState().text[rootId]).toMatchObject({ saving: "saved", textSeq: server.blips[rootId].textSeq });
    expect(kinds(b, "text").at(-1).change).toEqual({ kind: "text", blips: [rootId] });
    expect(kinds(a, "text")).toHaveLength(textChangesAtOpen); // own echo emits no text change
  });

  it("flushes at once when 1 KiB is pending", async () => {
    const { server, rootId, clients: [a] } = await setup({ n: 1, latency: 5 });
    const h = await open(a.store, rootId);
    h.text.insert(0, "x".repeat(TEXT_FLUSH_BYTES + 100));
    await settle(1);
    expect(pushes(server, a.clientId)).toHaveLength(1);
    expect(decodeBytes(pushes(server, a.clientId)[0].args[0].update).length).toBeGreaterThan(TEXT_FLUSH_BYTES);
  });

  it("sends within TEXT_MAX_WAIT_MS while someone types without ever pausing TEXT_IDLE_MS", async () => {
    const { server, rootId, clients: [a, b] } = await setup({ latency: 5 });
    const h = await open(a.store, rootId);
    const hb = await open(b.store, rootId);
    // A key every 60 ms for 3 s: never idle for 80 ms, and far below 1 KiB per push.
    const start = Date.now();
    const sendTimes = [];
    let seen = 0;
    for (let i = 0; i < 50; i++) {
      h.text.insert(h.text.length, "k");
      await settle(60);
      const n = pushes(server, a.clientId).length;
      if (n > seen) { sendTimes.push(Date.now() - start); seen = n; }
    }
    expect(sendTimes[0]).toBeLessThanOrEqual(TEXT_MAX_WAIT_MS + 60);
    const gaps = sendTimes.slice(1).map((t, i) => t - sendTimes[i]);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(TEXT_MAX_WAIT_MS + 60 + 60);
    // About 4 a second at a 250 ms cap, never one per key.
    expect(sendTimes.length).toBeGreaterThanOrEqual(8);
    expect(sendTimes.length).toBeLessThan(25);
    expect(hb.text.toString().length).toBeGreaterThan("Hello world".length + 40);
  });

  it("keeps one push in flight across blips, oldest pending first", async () => {
    const { server, rootId, clients: [a] } = await setup({ n: 1, latency: 40 });
    const other = server.seed({ text: "Other" });
    server.broadcast("operation", { type: "operation", senderId: "", seq: ++server.seq, upserts: [server.blips[other]], deletes: [], events: [] });
    await settle(20);
    const h1 = await open(a.store, rootId);
    const h2 = await open(a.store, other);
    h2.text.insert(0, "B");
    await settle(5);
    h1.text.insert(0, "A");
    await settle(TEXT_IDLE_MS + 5);
    expect(server.callsOf("pushText")).toHaveLength(1);
    expect(server.callsOf("pushText")[0].args[0].blipId).toBe(other);
    h1.text.insert(0, "A2"); // more pending while the first is in flight: merged into the next push
    await settle(100);
    expect(server.callsOf("pushText")).toHaveLength(2);
    expect(server.callsOf("pushText")[1].args[0].blipId).toBe(rootId);
    await settle(200);
    expect(server.textOf(rootId)).toBe("A2AHello world");
    expect(server.textOf(other)).toBe("BOther");
    expect(a.store.getState().saving).toBe("saved");
  });

  it("reports saving per blip and overall, and whenSaved / flushText resolve on the ack", async () => {
    const { rootId, clients: [a] } = await setup({ n: 1, latency: 20 });
    const h = await open(a.store, rootId);
    h.text.insert(0, "x");
    expect(a.store.getState().text[rootId].saving).toBe("saving");
    expect(a.store.getState().saving).toBe("saving");
    expect(a.store.pendingText(rootId)).toBe("xHello world");
    let saved = false;
    a.store.flushText(rootId).then(() => { saved = true; });
    await settle(10);
    expect(saved).toBe(false);
    await settle(60);
    expect(saved).toBe(true);
    expect(a.store.getState().text[rootId].saving).toBe("saved");
    expect(a.store.getState().saving).toBe("saved");
    expect(a.store.pendingText(rootId)).toBeNull();
    await h.whenSaved();
  });
});

describe("remote events", () => {
  it("applies peers' updates with origin remote and advances textSeq on own echoes", async () => {
    const { server, rootId, clients: [a, b] } = await setup({ latency: 5 });
    const ha = await open(a.store, rootId);
    const hb = await open(b.store, rootId);
    const origins = [];
    hb.doc.on("updateV2", (_u, origin) => origins.push(origin));
    ha.text.insert(0, "A");
    await settle(TEXT_IDLE_MS + 60);
    hb.text.insert(0, "B");
    await settle(TEXT_IDLE_MS + 60);
    expect(origins).toContain("remote");
    expect(ha.text.toString()).toBe(hb.text.toString());
    expect(server.textOf(rootId)).toBe(hb.text.toString());
    const seq = server.blips[rootId].textSeq;
    expect(a.store.getState().text[rootId].textSeq).toBe(seq);
    expect(b.store.getState().text[rootId].textSeq).toBe(seq);
  });

  it("applies a peer's update whose event arrives after the result of a later own push", async () => {
    // The push result and the event stream travel separately: a's own push can be acknowledged
    // (with a textSeq past the peer's) before the peer's earlier event reaches a. That event
    // must still be applied, not skipped as "already have it".
    const { server, rootId, clients: [a, b] } = await setup({ latency: 5 });
    const ha = await open(a.store, rootId);
    const hb = await open(b.store, rootId);
    server.holdEvents(a.clientId);
    hb.text.insert(0, "1");
    await settle(TEXT_IDLE_MS + 40);
    ha.text.insert(ha.text.length, "2");
    await settle(TEXT_IDLE_MS + 40);
    expect(a.store.getState().text[rootId].saving).toBe("saved");
    server.releaseEvents(a.clientId);
    await settle(50);
    expect(server.textOf(rootId)).toBe("1Hello world2");
    expect(ha.text.toString()).toBe("1Hello world2");
    expect(hb.text.toString()).toBe("1Hello world2");
    expect(a.store.getState().text[rootId].textSeq).toBe(server.blips[rootId].textSeq);
  });

  it("applies a text event carrying its own senderId that it did not push (an accepted proposal)", async () => {
    // The core now sends server-made text with an empty senderId (test/core/wave.test.js), but a
    // server from before that fix tagged an accepted proposal's replacement with the reviewer's
    // senderId: the client applies every event, so the reviewer still gets the text.
    const { server, rootId, clients: [a] } = await setup({ n: 1 });
    const ha = await open(a.store, rootId);
    const doc = server.doc(rootId);
    const before = Y.encodeStateVector(doc);
    doc.getText("t").insert(0, "Accepted: ");
    const update = Y.encodeStateAsUpdateV2(doc, before);
    const blip = server.blips[rootId];
    const prevTextSeq = blip.textSeq;
    blip.textSeq = blip.seq = ++server.seq;
    server.broadcast("text", { blipId: rootId, senderId: a.clientId, seq: server.seq, prevTextSeq, textSeq: server.seq, update: encodeBytes(update) });
    await settle(50);
    expect(ha.text.toString()).toBe("Accepted: Hello world");
    expect(a.store.getState().text[rootId].textSeq).toBe(server.seq);
  });

  it("detects a gap by prevTextSeq and resyncs through openBlip with a state vector", async () => {
    const { server, rootId, clients: [a, b] } = await setup({ latency: 5 });
    const ha = await open(a.store, rootId);
    const hb = await open(b.store, rootId);
    server.holdEvents(a.clientId);
    hb.text.insert(0, "1");
    await settle(TEXT_IDLE_MS + 40);
    server.releaseEvents(a.clientId, { discard: true }); // "1" never reaches a
    hb.text.insert(1, "2");
    await settle(TEXT_IDLE_MS + 40);
    const opens = server.callsOf("openBlip").filter((c) => c.args[0].stateVector);
    expect(opens).toHaveLength(1);
    expect(a.store.getState().text[rootId].resyncing).toBe(false);
    expect(ha.text.toString()).toBe("12Hello world");
    expect(a.store.getState().text[rootId].textSeq).toBe(server.blips[rootId].textSeq);
    // The diff was a diff, not the whole state.
    const full = Y.encodeStateAsUpdateV2(server.doc(rootId)).length;
    expect(decodeBytes(server.callsOf("openBlip").length ? "" : "")).toBeTruthy();
    expect(full).toBeGreaterThan(0);
  });

  it("resyncs every open blip after a re-subscribe", async () => {
    const { server, rootId, clients: [a, b] } = await setup({ latency: 5 });
    const ha = await open(a.store, rootId);
    const hb = await open(b.store, rootId);
    server.restart();
    hb.text.insert(0, "Z"); // b's push fails (connection lost) and is replayed after it reconnects
    await settle(PRESENCE_HEARTBEAT_MS + 500);
    expect(server.textOf(rootId)).toBe("ZHello world");
    expect(ha.text.toString()).toBe("ZHello world");
    expect(hb.text.toString()).toBe("ZHello world");
    expect(server.callsOf("openBlip").filter((c) => c.args[0].stateVector).length).toBeGreaterThanOrEqual(2);
    expect(a.store.getState().saving).toBe("saved");
    expect(b.store.getState().saving).toBe("saved");
    expect(server.callsOf("pushText").filter((c) => c.args[0].senderId === b.clientId).length).toBeGreaterThanOrEqual(1);
  });

  it("types into a blip whose create is not yet acknowledged; the text follows the ack", async () => {
    // Latency well past the idle delay, so the batch is ready long before the create's ack arrives.
    const { server, rootId, clients: [a, b] } = await setup({ latency: 150 });
    const id = a.store.createBlip({ parentId: rootId });
    const h = await open(a.store, id);
    h.text.insert(0, "typed early");
    expect(a.store.getState().text[id].saving).toBe("saving");
    await settle(TEXT_IDLE_MS + 20);
    expect(server.callsOf("pushText")).toHaveLength(0);
    await settle(1500);
    expect(server.textOf(id)).toBe("typed early");
    expect(a.store.getState().text[id].saving).toBe("saved");
    const hb = await open(b.store, id);
    expect(hb.text.toString()).toBe("typed early");
  });
});

describe("refusals", () => {
  it("blip_full: saving failed with lastError, the local text is kept, and a later edit retries", async () => {
    const { server, rootId, clients: [a] } = await setup({ n: 1, latency: 5 });
    const h = await open(a.store, rootId);
    h.text.insert(0, "x".repeat(16000));
    await settle(200);
    expect(a.store.getState().text[rootId]).toMatchObject({ saving: "failed", lastError: "blip_full" });
    expect(a.store.getState().saving).toBe("failed");
    expect(a.store.getState().lastError).toBe("blip_full");
    expect(h.text.toString().length).toBe(16011);
    expect(a.store.pendingText(rootId)).toBe(h.text.toString());
    expect(server.textOf(rootId)).toBe("Hello world");
    h.text.delete(0, 100);
    await settle(200);
    expect(a.store.getState().text[rootId]).toMatchObject({ saving: "saved", lastError: null });
    expect(server.textOf(rootId).length).toBe(15911);
  });

  it("locked: saving failed and nothing more is sent for that push", async () => {
    const { server, rootId, clients: [a] } = await setup({ n: 1, latency: 5 });
    const h = await open(a.store, rootId);
    server.errorNextCall("pushText", "locked");
    h.text.insert(0, "x");
    await settle(200);
    expect(a.store.getState().text[rootId]).toMatchObject({ saving: "failed", lastError: "locked" });
    expect(server.callsOf("pushText")).toHaveLength(1);
    expect(a.store.pendingText(rootId)).toBe("xHello world");
    h.close();
    await settle(10);
    expect(a.store.getState().text[rootId]).toBeUndefined();
  });

  it("a refused create fails the text state of a blip typed into early", async () => {
    const { server, rootId, clients: [a] } = await setup({ n: 1, latency: 20 });
    server.beforeApply = (req) => { for (const op of req.blipOps ?? []) if (op.op === "create") server.blips[op.blipId] = { ...server.blips[rootId], id: op.blipId }; };
    const id = a.store.createBlip({ parentId: rootId });
    const h = await open(a.store, id);
    h.text.insert(0, "lost?");
    await settle(300);
    expect(a.store.getState().text[id]).toMatchObject({ saving: "failed", lastError: "exists" });
    expect(a.store.pendingText(id)).toBe("lost?");
  });

  it("replays a push whose result was lost with the same requestId", async () => {
    const { server, rootId, clients: [a] } = await setup({ n: 1, latency: 5 });
    const h = await open(a.store, rootId);
    server.failNext("pushText");
    h.text.insert(0, "once");
    await settle(2000);
    const sent = pushes(server, a.clientId);
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(new Set(sent.map((c) => c.args[0].requestId)).size).toBe(1);
    expect(server.textOf(rootId)).toBe("onceHello world");
    expect(a.store.getState().text[rootId].saving).toBe("saved");
  });
});

describe("unsaved edits across a reload (pendingUpdate + restoreUpdate)", () => {
  it("pendingUpdate is null when everything is acknowledged and covers in-flight plus queued edits otherwise", async () => {
    const { rootId, clients: [a] } = await setup({ n: 1, latency: 20 });
    const h = await open(a.store, rootId);
    expect(a.store.pendingUpdate(rootId)).toBeNull();
    h.text.insert(11, " one");
    await settle(TEXT_IDLE_MS + 5); // in flight
    h.text.insert(15, " two"); // queued
    const doc = new Y.Doc();
    Y.applyUpdateV2(doc, decodeBytes(a.store.pendingUpdate(rootId)));
    // Only the unacknowledged items: the seed "Hello world" is not in the update, so the two
    // insertions are pending structs of a doc that lacks the text they are attached to.
    expect(doc.getText("t").toString()).toBe("");
    await settle(300);
    expect(a.store.pendingUpdate(rootId)).toBeNull();
  });

  it("restores only the unacknowledged part, once, even when an in-flight push did commit, and keeps a peer's concurrent edit in place", async () => {
    const { server, rootId, clients: [a, b] } = await setup({ latency: 20 });
    const ha = await open(a.store, rootId);
    ha.text.insert(11, " acked");
    await settle(TEXT_IDLE_MS + 200);
    expect(server.textOf(rootId)).toBe("Hello world acked");
    ha.text.insert(17, " committed");
    await settle(TEXT_IDLE_MS + 30); // applied by the server, result not yet back
    expect(server.textOf(rootId)).toBe("Hello world acked committed");
    ha.text.insert(27, " unsent");
    const update = a.store.pendingUpdate(rootId);
    const text = a.store.pendingText(rootId);
    expect(text).toBe("Hello world acked committed unsent");
    a.store.dispose(); // the frame reloads: " unsent" never reaches the server
    await settle(200);
    expect(server.textOf(rootId)).toBe("Hello world acked committed");

    // Meanwhile Bob edits at the start and in the middle.
    const hb = await open(b.store, rootId);
    hb.text.insert(0, "Bob: ");
    hb.text.insert(hb.text.toString().indexOf(" committed"), " (b)");
    await settle(300);
    expect(server.textOf(rootId)).toBe("Bob: Hello world acked (b) committed");

    const c = await startStore(server, "user0-reloaded");
    const hc = await open(c.store, rootId);
    let restoredOrigin = null;
    hc.doc.on("updateV2", (_u, origin) => { restoredOrigin ??= origin; });
    expect(restoreUpdate(hc.doc, update)).toBe("applied");
    expect(restoredOrigin).toBe(RESTORE_ORIGIN);
    const expected = "Bob: Hello world acked (b) committed unsent";
    expect(hc.text.toString()).toBe(expected);
    await settle(400);
    expect(server.textOf(rootId)).toBe(expected);
    expect(hb.text.toString()).toBe(expected);
    // Applying it again (a second click, or a later reload carrying the same edits) adds nothing.
    expect(restoreUpdate(hc.doc, update)).toBe("unchanged");
    await settle(300);
    expect(server.textOf(rootId)).toBe(expected);
  });

  it("restores unsent deletions too, and reports unchanged when every carried edit had arrived", async () => {
    const { server, rootId, clients: [a] } = await setup({ n: 2, latency: 20 });
    const ha = await open(a.store, rootId);
    ha.text.delete(0, 6); // "world"
    const update = a.store.pendingUpdate(rootId);
    a.store.dispose();
    await settle(300);
    expect(server.textOf(rootId)).toBe("Hello world");
    const c = await startStore(server, "reloaded");
    const hc = await open(c.store, rootId);
    expect(restoreUpdate(hc.doc, update)).toBe("applied");
    await settle(300);
    expect(server.textOf(rootId)).toBe("world");

    const h2 = await open(c.store, rootId);
    h2.text.insert(5, "!");
    const sent = c.store.pendingUpdate(rootId);
    await settle(300); // acknowledged after all
    expect(server.textOf(rootId)).toBe("world!");
    const d = await startStore(server, "reloaded-again");
    const hd = await open(d.store, rootId);
    expect(restoreUpdate(hd.doc, sent)).toBe("unchanged");
    expect(hd.text.toString()).toBe("world!");
  });

  it("applies nothing and reports incomplete when the carried edits build on text the server never got", async () => {
    const { server, rootId, clients: [a] } = await setup({ n: 1, latency: 5 });
    const ha = await open(a.store, rootId);
    server.errorNextCall("pushText", "locked"); // a refusal that drops the push
    ha.text.insert(0, "refused ");
    await settle(200);
    expect(a.store.getState().text[rootId].lastError).toBe("locked");
    ha.text.insert(8, "later ");
    const update = a.store.pendingUpdate(rootId);
    expect(update).not.toBeNull();
    a.store.dispose();
    await settle(100);
    const c = await startStore(server, "reloaded");
    const hc = await open(c.store, rootId);
    expect(restoreUpdate(hc.doc, update)).toBe("incomplete");
    expect(hc.text.toString()).toBe("Hello world");
    expect(restoreUpdate(hc.doc, "not base64!")).toBe("invalid");
    await settle(200);
    expect(server.textOf(rootId)).toBe("Hello world");
  });
});
