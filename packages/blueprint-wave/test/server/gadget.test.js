// Server tests in workerd: the Gadget Durable Object over real DO storage (key layout, binary
// values, atomic commits, restarts), the RPC surface with base64 Yjs updates, subscriber callbacks
// (operation, text, presence), the Model binding seam, and the ExportHandler. The wave's rules are
// covered in test/core; these check what only the platform runtime can. Storage persists between
// tests, so each test uses its own DO.
import { env, exports, RpcTarget } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import * as Y from "yjs";
import { describe, expect, it, vi } from "vitest";
import { createFakeModel } from "../../harness/fake-model.js";
import { DoStorageRepository } from "../../src/server/do-repository.js";
import { decodeBytes, encodeBytes } from "../../src/shared/protocol.js";

class Callbacks extends RpcTarget {
  ops = [];
  /** @type {any[][]} one entry per text() call */
  texts = [];
  /** @type {any[][]} one entry per presence() call */
  calls = [];
  disposed = false;
  operation(event) {
    this.ops.push(event);
  }
  text(events) {
    this.texts.push(events);
  }
  presence(events) {
    this.calls.push(events);
  }
  get presences() {
    return this.calls.flat();
  }
  [Symbol.dispose]() {
    this.disposed = true;
  }
}

// A subscriber whose operation deliveries reject: it lacks the method.
class Dead extends RpcTarget {
  presence() {}
  text() {}
}

const idFor = (name) => env.GADGET.idFromName(name);
const fresh = () => {
  const name = crypto.randomUUID();
  return { name, stub: env.GADGET.get(idFor(name)), again: () => env.GADGET.get(idFor(name)) };
};
const blipId = () => "b_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
let reqN = 0;
const rid = () => "t:" + ++reqN;

async function createBlip(stub, { text, parentId = null, kind, senderId = "setup" } = {}) {
  const id = blipId();
  const op = { op: "create", blipId: id, parentId };
  if (text !== undefined) op.text = text;
  if (kind) op.kind = kind;
  const result = await stub.applyOperation({ senderId, by: "Tester", requestId: rid(), blipOps: [op] });
  return { id, result };
}

/** Opens a blip over RPC into a local doc. */
async function openDoc(stub, id) {
  const r = await stub.openBlip({ blipId: id });
  expect(r.error).toBeUndefined();
  expect(typeof r.update).toBe("string");
  const doc = new Y.Doc();
  Y.applyUpdateV2(doc, decodeBytes(r.update));
  return { doc, textSeq: r.textSeq };
}

/** Edits a local doc and pushes the diff as base64 over RPC. */
async function push(stub, id, doc, mutate, { senderId = "s1", requestId = rid() } = {}) {
  const sv = Y.encodeStateVector(doc);
  doc.transact(() => mutate(doc.getText("t")));
  const update = encodeBytes(Y.encodeStateAsUpdateV2(doc, sv));
  return { result: await stub.pushText({ senderId, by: "Tester", blipId: id, update, requestId }), update, requestId };
}

describe("storage", () => {
  it("uses the README key layout, and binary values come back from storage as Uint8Array", async () => {
    const { stub } = fresh();
    const { id } = await createBlip(stub, { text: "Hello" });
    const { doc } = await openDoc(stub, id);
    await push(stub, id, doc, (t) => t.insert(5, " world"));
    const raw = await runInDurableObject(stub, async (_i, state) => {
      const all = await state.storage.list();
      return { keys: [...all.keys()], all: Object.fromEntries(all) };
    });
    const pad = (n) => String(n).padStart(12, "0");
    // A create with text takes two sequences (blip.create, then the seeding text update); the push a third.
    expect(raw.keys.sort()).toEqual([
      "meta", `blip:${id}`, `upd:${id}:${pad(2)}`, `upd:${id}:${pad(3)}`,
      `event:${pad(1)}`, `event:${pad(2)}`, `event:${pad(3)}`, "req:setup", "req:s1",
    ].sort());
    expect(Object.keys(raw.all.meta).sort()).toEqual(
      ["earliestSeq", "lastModified", "participants", "retainedBytes", "rootOrder", "schemaVersion", "seq", "template", "title"]);
    expect(raw.all.meta).toMatchObject({ seq: 3, rootOrder: [id] });
    const upd = raw.all[`upd:${id}:${pad(3)}`];
    expect(upd.update).toBeInstanceOf(Uint8Array);
    expect(upd).toMatchObject({ blipId: id, seq: 3, by: "Tester" });
    expect(raw.all[`blip:${id}`]).toMatchObject({ id, textSeq: 3, textChars: 11, version: 1, preview: "Hello world" });
  });

  it("commit is atomic: a failing write rolls back earlier writes in the same commit", async () => {
    const { stub } = fresh();
    await runInDurableObject(stub, async (_instance, state) => {
      const repo = new DoStorageRepository(state.storage);
      const keep = { id: "b_000000000001", text: "keep" };
      await repo.commit({ putBlips: [keep], meta: { seq: 1 } });
      await expect(repo.commit({
        deleteEvents: [1],
        meta: { seq: 2 },
        putBlips: [{ id: "b_000000000002", notCloneable: () => 1 }],
      })).rejects.toThrow();
      expect(await state.storage.get("blip:b_000000000001")).toEqual(keep);
      expect(await state.storage.get("meta")).toEqual({ seq: 1 });
      expect(await state.storage.get("blip:b_000000000002")).toBeUndefined();
    });
  });

  it("writes, lists and deletes more than one 128-key batch in one commit, in sequence order", async () => {
    const { stub } = fresh();
    await runInDurableObject(stub, async (_instance, state) => {
      const repo = new DoStorageRepository(state.storage);
      const id = "b_0000000000aa";
      const updates = Array.from({ length: 300 }, (_, i) => ({ blipId: id, seq: i + 1, by: "T", at: 0, update: new Uint8Array([i & 255]) }));
      await repo.commit({ putUpdates: updates, putEvents: updates.map((u) => ({ seq: u.seq, at: 0, by: "T", kind: "text" })) });
      const listed = await repo.listUpdates(id);
      expect(listed.map((u) => u.seq)).toEqual(updates.map((u) => u.seq));
      expect(listed[9].update).toBeInstanceOf(Uint8Array);
      expect((await repo.listUpdates(id, { fromSeq: 100, toSeq: 110 })).map((u) => u.seq)).toEqual(Array.from({ length: 11 }, (_, i) => 100 + i));
      expect((await repo.listEvents({ afterSeq: 250, limit: 5 })).map((e) => e.seq)).toEqual([251, 252, 253, 254, 255]);
      await repo.commit({ deleteUpdates: updates.slice(0, 290).map((u) => ({ blipId: id, seq: u.seq })), deleteEvents: updates.slice(0, 290).map((u) => u.seq) });
      expect((await repo.listUpdates(id)).map((u) => u.seq)).toEqual(updates.slice(290).map((u) => u.seq));
      expect(await repo.listEvents()).toHaveLength(10);
    });
  });

  it("text, playback and request records survive a restart", async () => {
    const { stub, again } = fresh();
    const { id } = await createBlip(stub, { text: "Durable" });
    const { doc } = await openDoc(stub, id);
    const first = await push(stub, id, doc, (t) => t.insert(7, " text"));
    expect(first.result).toMatchObject({ seq: 3, textSeq: 3 });
    await abortAllDurableObjects();
    const after = await openDoc(again(), id);
    expect(after.doc.getText("t").toString()).toBe("Durable text");
    expect(after.textSeq).toBe(3);
    // A replayed push is answered from the record and stores nothing.
    const replay = await again().pushText({ senderId: "s1", by: "Tester", blipId: id, update: first.update, requestId: first.requestId });
    expect(replay).toMatchObject({ seq: 3, textSeq: 3, duplicate: true });
    expect((await again().getWave()).seq).toBe(3);
    const pb = await again().getPlayback({ blipId: id });
    const replayed = new Y.Doc();
    const base = decodeBytes(pb.base.state);
    if (base.length) Y.applyUpdateV2(replayed, base);
    for (const u of pb.updates) Y.applyUpdateV2(replayed, decodeBytes(u.update));
    expect(replayed.getText("t").toString()).toBe("Durable text");
  });
});

describe("RPC surface", () => {
  it("openBlip with a state vector returns only the missing diff; bad updates are refused as values", async () => {
    const { stub } = fresh();
    const { id } = await createBlip(stub, { text: "abc" });
    const a = await openDoc(stub, id);
    const b = await openDoc(stub, id);
    await push(stub, id, a.doc, (t) => t.insert(3, "def"));
    const sv = encodeBytes(Y.encodeStateVector(b.doc));
    const diff = await stub.openBlip({ blipId: id, stateVector: sv });
    const full = await stub.openBlip({ blipId: id });
    expect(decodeBytes(diff.update).length).toBeLessThan(decodeBytes(full.update).length);
    Y.applyUpdateV2(b.doc, decodeBytes(diff.update));
    expect(b.doc.getText("t").toString()).toBe("abcdef");
    expect(await stub.pushText({ senderId: "s1", blipId: id, update: "not base64!", requestId: rid() })).toMatchObject({ error: "invalid_update" });
    expect(await stub.pushText({ senderId: "s1", blipId: id, update: encodeBytes(new Uint8Array([1, 2, 3, 4, 5])), requestId: rid() })).toMatchObject({ error: "invalid_update" });
    expect(await stub.openBlip({ blipId: blipId() })).toMatchObject({ error: "unknown_blip" });
    expect(await openDoc(stub, id).then((d) => d.doc.getText("t").toString())).toBe("abcdef");
  });

  it("reply, propose, reviewProposal, recordDecision and exports round trip as plain values", async () => {
    const { stub } = fresh();
    const { id: root } = await createBlip(stub, { text: "Which onboarding approach?" });
    const r = await stub.reply({ parentId: root, text: "Option A: white-glove", by: "Assistant", requestId: rid() });
    expect(r.blip).toMatchObject({ parentId: root, kind: "note", by: "Assistant", preview: "Option A: white-glove" });
    const p = await stub.propose({ targetId: r.blip.id, quote: "white-glove", replacement: "self-serve", summary: "Cheaper", sources: [root, blipId()], by: "Assistant", requestId: rid() });
    expect(p.blip.proposal).toMatchObject({ targetId: r.blip.id, state: "review", sources: [root] });
    const accepted = await stub.reviewProposal({ proposalId: p.blip.id, decision: "accept", expectedVersion: p.blip.version, by: "Ann", requestId: rid() });
    expect(accepted).toMatchObject({ status: "applied", blip: { proposal: { state: "accepted", reviewedBy: "Ann" } } });
    expect((await openDoc(stub, r.blip.id)).doc.getText("t").toString()).toBe("Option A: self-serve");
    // A second accept of the same version is a conflict, not a second application.
    const twice = await stub.reviewProposal({ proposalId: p.blip.id, decision: "accept", expectedVersion: p.blip.version, by: "Bob", requestId: rid() });
    expect(twice.status).toBe("conflict");
    expect((await openDoc(stub, r.blip.id)).doc.getText("t").toString()).toBe("Option A: self-serve");
    const d = await stub.recordDecision({ threadId: root, text: "We choose self-serve", rationale: `Cost, see [${r.blip.id}]`, dissent: "Harry", nextSteps: "Checklist", by: "Ann", requestId: rid() });
    expect(d.blip).toMatchObject({ kind: "decision", locked: true, decision: { rationale: `Cost, see [${r.blip.id}]`, recordedBy: "Ann" } });
    const locked = await stub.applyOperation({ requestId: rid(), blipOps: [{ op: "delete", blipId: d.blip.id, baseVersion: 1 }] });
    expect(locked.errors[0].code).toBe("locked");
    const md = await stub.getWaveMarkdown({});
    expect(md).toContain(`[${root}]`);
    expect(md).toContain("self-serve");
    const record = await stub.exportMarkdown({ decisions: true });
    expect(record).toContain("We choose self-serve");
    expect(record).toContain("Cost");
    expect(record).toContain("Harry");
    const changes = await stub.getChanges({ afterSeq: 0 });
    expect(changes.events.map((e) => e.kind)).toEqual(expect.arrayContaining(["blip.create", "text", "proposal.accept", "decision.record"]));
  });

  it("askAgent is no_model without a binding and runs through env.Model when one is present", async () => {
    const { stub } = fresh();
    const { id: root } = await createBlip(stub, { text: "Options?" });
    await stub.reply({ parentId: root, text: "Option A", requestId: rid() });
    expect((await stub.getWave()).capabilities.model).toBe(false);
    expect(await stub.askAgent({ op: "summarise", blipIds: [root], requestId: rid() })).toMatchObject({ error: "no_model" });
    // The binding is read from env on every call, so one added later (Connections) is seen.
    const fake = createFakeModel();
    await runInDurableObject(stub, (instance) => { instance.env.Model = { run: (args) => fake.run(args) }; });
    expect((await stub.getWave()).capabilities.model).toBe(true);
    const ask = await stub.askAgent({ op: "summarise", blipIds: [root], by: "Ann", requestId: rid() });
    expect(ask.run).toMatchObject({ op: "summarise", state: "queued" });
    await vi.waitFor(async () => expect((await stub.getRun({ runId: ask.run.id })).run.state).toBe("done"));
    const run = (await stub.getRun({ runId: ask.run.id })).run;
    expect((await stub.getWave()).blips[run.resultBlipId]).toMatchObject({ kind: "agent", parentId: root, runId: run.id });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].systemPrompt).not.toContain("Option A"); // wave content never in the system prompt
  });

  it("a restart during a model call leaves the run unknown and respawns nothing", async () => {
    const { stub, again } = fresh();
    const { id: root } = await createBlip(stub, { text: "Options?" });
    const fake = createFakeModel({ mode: "hang" });
    await runInDurableObject(stub, (instance) => { instance.env.Model = { run: (args) => fake.run(args) }; });
    const ask = await stub.askAgent({ op: "summarise", blipIds: [root], requestId: rid() });
    await vi.waitFor(async () => expect((await stub.getRun({ runId: ask.run.id })).run.state).toBe("running"));
    await abortAllDurableObjects();
    const run = (await again().getRun({ runId: ask.run.id })).run;
    expect(run).toMatchObject({ state: "unknown", error: expect.stringContaining("restarted") });
    expect((await again().getChanges({ afterSeq: 0 })).events.map((e) => e.kind)).toContain("run.unknown");
    expect(fake.calls).toHaveLength(1);
  });
});

describe("live updates", () => {
  it("subscribers receive operations and text as arrays with senderId, in sequence order", async () => {
    const { stub, again } = fresh();
    const a = new Callbacks();
    const b = new Callbacks();
    const snap = await stub.subscribe(a, { clientId: "A", name: "Ann", color: "#112233" });
    await again().subscribe(b, { clientId: "B", name: "Bob", color: "#445566" });
    expect(snap).toMatchObject({ seq: 0, blips: {}, session: expect.stringMatching(/^[0-9a-f]{32}$/) });
    const { id } = await createBlip(again(), { text: "Hi", senderId: "A" });
    const { doc } = await openDoc(stub, id);
    for (let i = 0; i < 5; i++) await push(stub, id, doc, (t) => t.insert(t.length, String(i)), { senderId: "A" });
    // The create (seq 1-2) is one operation; each push (3-7) is a text event and also an operation
    // carrying the blip's new preview and textSeq. The create's seed text is not a text event:
    // openers hydrate it through openBlip.
    await vi.waitFor(() => {
      expect(b.ops).toHaveLength(6);
      expect(b.texts.flat()).toHaveLength(5);
      expect(a.texts.flat()).toHaveLength(5); // the originator gets its own pushes, to advance textSeq
    });
    expect(b.ops[0]).toMatchObject({ type: "operation", senderId: "A", seq: 2, upserts: [{ id }] });
    expect(b.ops.map((e) => e.seq)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(b.ops.at(-1).upserts[0]).toMatchObject({ id, textSeq: 7, preview: "Hi01234" });
    expect(b.texts.every(Array.isArray)).toBe(true);
    const texts = b.texts.flat();
    expect(texts.map((t) => t.seq)).toEqual([3, 4, 5, 6, 7]);
    expect(texts.map((t) => t.prevTextSeq)).toEqual([2, 3, 4, 5, 6]);
    expect(texts[0]).toMatchObject({ blipId: id, senderId: "A", textSeq: 3, update: expect.any(String) });
    const remote = new Y.Doc();
    Y.applyUpdateV2(remote, decodeBytes((await again().openBlip({ blipId: id, stateVector: encodeBytes(Y.encodeStateVector(new Y.Doc())) })).update));
    expect(remote.getText("t").toString()).toBe("Hi01234");
  });

  it("presence carries carets, drops malformed ones, and leave disposes the callback", async () => {
    const { stub } = fresh();
    const a = new Callbacks();
    const b = new Callbacks();
    const { id } = await createBlip(stub, { text: "Hello" });
    const { session } = await stub.subscribe(a, { clientId: "A", name: "Ann", color: "#112233" });
    await stub.subscribe(b, { clientId: "B", name: "Bob", color: "not a colour" });
    await vi.waitFor(() => expect(b.presences.map((p) => p.clientId)).toContain("A"));
    const { doc } = await openDoc(stub, id);
    const caret = encodeBytes(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(doc.getText("t"), 2)));
    const r = await stub.updatePresence({ clientId: "A", session, blipId: id, editing: true, anchor: caret, head: "x".repeat(4000) });
    expect(r).toEqual({ known: true, seq: 2 });
    await vi.waitFor(() => expect(b.presences.at(-1)).toMatchObject({ clientId: "A", blipId: id, editing: true, anchor: caret, head: null }));
    expect(a.presences.some((p) => p.clientId === "A")).toBe(false);
    await stub.leavePresence("A", session);
    await vi.waitFor(() => expect(b.presences.at(-1)).toMatchObject({ type: "leave", clientId: "A" }));
    await vi.waitFor(() => expect(a.disposed).toBe(true));
    expect(await stub.updatePresence({ clientId: "A", session })).toEqual({ known: false, seq: 2 });
  });

  it("a failing subscriber is removed and others see it leave", async () => {
    const { stub } = fresh();
    const good = new Callbacks();
    const { session } = await stub.subscribe(good, { clientId: "G", name: "Good" });
    const dead = await stub.subscribe(new Dead(), { clientId: "T", name: "Bad" });
    await createBlip(stub, {});
    await vi.waitFor(() => expect(good.presences.some((p) => p.type === "leave" && p.clientId === "T")).toBe(true));
    expect(good.ops).toHaveLength(1);
    expect(await stub.updatePresence({ clientId: "T", session: dead.session })).toMatchObject({ known: false });
    expect(await stub.updatePresence({ clientId: "G", session })).toMatchObject({ known: true });
  });

  it("heartbeat reports known: false after a restart with the right seq; re-subscribing keeps the session", async () => {
    const { stub, again } = fresh();
    const { session } = await stub.subscribe(new Callbacks(), { clientId: "A" });
    expect(await stub.updatePresence({ clientId: "A", session })).toEqual({ known: true, seq: 0 });
    await createBlip(stub, {});
    await abortAllDurableObjects();
    expect(await again().updatePresence({ clientId: "A", session })).toEqual({ known: false, seq: 1 });
    const resub = await again().subscribe(new Callbacks(), { clientId: "A", session });
    expect(resub.session).toBe(session);
    expect((await again().updatePresence({ clientId: "A", session })).known).toBe(true);
  });

  it("a refused subscribe disposes its duplicate; the owner can replace its own subscription", async () => {
    const { stub } = fresh();
    const a = new Callbacks();
    const snap = await stub.subscribe(a, { clientId: "A", name: "Ann" });
    const hijacker = new Callbacks();
    await expect(runInDurableObject(stub, (instance) => instance.subscribe(hijacker, { clientId: "A", name: "Mallory" }))).rejects.toThrow("clientId in use");
    expect(await stub.updatePresence({ clientId: "A", name: "Mallory" })).toMatchObject({ known: false });
    const replacement = new Callbacks();
    const again = await stub.subscribe(replacement, { clientId: "A", session: snap.session });
    expect(again.session).toBe(snap.session);
    await vi.waitFor(() => expect(a.disposed).toBe(true));
    expect(replacement.disposed).toBe(false);
  });
});

describe("ExportHandler", () => {
  it("lists Markdown (server) and HTML/PDF (browser) formats", async () => {
    const { stub } = fresh();
    expect(await exports.ExportHandler.getExportFormats(stub)).toEqual([
      { id: "markdown", label: "Markdown", mode: "server", contentType: "text/markdown", fileExtension: ".md" },
      { id: "html", label: "HTML", mode: "browser", contentType: "text/html", fileExtension: ".html" },
      { id: "pdf", label: "PDF", mode: "browser", contentType: "application/pdf", fileExtension: ".pdf" },
    ]);
  });

  // An unknown format throws inside the RPC method, which the pool reports as an unhandled error,
  // so that path is covered by reading the handler rather than here.
  it("exports the wave as Markdown", async () => {
    const { stub } = fresh();
    await stub.applyOperation({ requestId: rid(), structure: { title: "Q4 <plan>" } });
    await createBlip(stub, { text: "Hello **team**" });
    const text = await new Response(await exports.ExportHandler.export(stub, "markdown")).text();
    expect(text).toContain("Q4 <plan>");
    expect(text).toContain("Hello **team**");
  });
});
