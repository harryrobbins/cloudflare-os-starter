// Core rules over the in-memory repository: structure, text, compaction and retention, replay,
// proposals, decisions, Markdown, agent runs and restart handling.
import * as Y from "yjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIMITS, decodeBytes, encodeBytes } from "../../src/shared/protocol.js";
import { InMemoryRepository } from "../../src/core/repository.js";
import { AGENT_NAME, RESTART_NOTE, createWave } from "../../src/core/wave.js";
import { createFakeModel } from "../../harness/fake-model.js";
import { create, edit, nextId, openDoc, playbackText, setup, textOf } from "./wave-helpers.js";

const B = (n) => "b_" + n.toString(16).padStart(12, "0");

describe("structure", () => {
  it("initialises meta and creates roots and replies with seeded text", async () => {
    const { wave, repo, events } = setup();
    const w0 = await wave.getWave();
    expect(w0).toMatchObject({ seq: 0, runs: [], blips: {}, capabilities: { model: false } });
    expect(w0.meta).toEqual({
      schemaVersion: 1, seq: 0, title: "Untitled wave", rootOrder: [], participants: [], earliestSeq: 1, retainedBytes: 0,
      lastModified: expect.any(Number), template: null,
    });
    const root = await create(wave, { kind: "brief", text: "# Brief\n\nHello" });
    expect(root.result).toMatchObject({ status: "applied", seq: 2, deletes: [], conflicts: [], errors: [] });
    expect(root.blip).toMatchObject({
      id: root.id, parentId: null, anchor: null, kind: "brief", order: "a0", by: "Tester", version: 1, seq: 2, textSeq: 2,
      textChars: 14, deleted: false, locked: false, preview: "# Brief Hello", log: { count: 1, sinceCompaction: 1 },
    });
    expect(root.result.events.map((e) => [e.seq, e.kind, e.blipId])).toEqual([[1, "blip.create", root.id], [2, "text", root.id]]);
    expect(root.result.meta).toMatchObject({ seq: 2, rootOrder: [root.id] });
    const reply = await create(wave, { parentId: root.id, text: "A reply" });
    expect(reply.blip).toMatchObject({ parentId: root.id, anchor: { type: "end" }, kind: "note", order: "a0", seq: 4, textSeq: 4 });
    const empty = await create(wave, { parentId: root.id });
    expect(empty.blip).toMatchObject({ textSeq: 0, textChars: 0, preview: "", order: "a1", log: { count: 0 } });
    expect(await textOf(wave, root.id)).toBe("# Brief\n\nHello");
    expect(await textOf(wave, empty.id)).toBe("");
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ type: "operation", senderId: "s1", seq: 2, deletes: [], meta: { seq: 2, rootOrder: [root.id] } });
    // Storage layout: the seed is an update record; no text record until compaction.
    expect(repo.texts.size).toBe(0);
    expect([...repo.updates.get(root.id).keys()]).toEqual([2]);
    expect(repo.events.size).toBe(5);
  });

  it("orders roots by key, accepts a client order and keeps rootOrder derived", async () => {
    const { wave } = setup();
    const a = await create(wave, {});
    const b = await create(wave, {});
    const c = await create(wave, { order: "Zz" });
    const w = await wave.getWave();
    expect(w.meta.rootOrder).toEqual([c.id, a.id, b.id]);
    expect([a.blip.order, b.blip.order, c.blip.order]).toEqual(["a0", "a1", "Zz"]);
    const d = await create(wave, {});
    expect(d.blip.order > "a1").toBe(true);
    // An unacceptable order key is replaced (last among siblings).
    const e = await create(wave, { order: "z" + "z".repeat(70) });
    expect(e.blip.order > d.blip.order).toBe(true);
  });

  it("rejects invalid ops with per-op errors and applies the valid ones", async () => {
    const { wave } = setup();
    const root = await create(wave, {});
    const r = await wave.applyOperation({ by: "T", blipOps: [
      { op: "create", blipId: "nope", parentId: null },
      { op: "create", blipId: root.id, parentId: null },
      { op: "create", blipId: nextId(), parentId: B(0xdead) },
      { op: "create", blipId: nextId(), parentId: null, kind: "agent" },
      { op: "create", blipId: nextId(), parentId: root.id, anchor: { type: "para", pos: "!!" } },
      { op: "create", blipId: nextId(), parentId: root.id, anchor: { type: "para", pos: encodeBytes(new Uint8Array([200, 200, 200, 1, 2, 3])) } },
      { op: "delete", blipId: root.id },
      { op: "create", blipId: nextId(), parentId: root.id, text: "ok" },
      { op: "frobnicate", blipId: root.id },
    ] });
    expect(r.errors.map((e) => [e.index, e.code])).toEqual([
      [0, "invalid_id"], [1, "exists"], [2, "unknown_blip"], [3, "invalid_op"], [4, "invalid_ref"], [5, "invalid_ref"], [6, "invalid_op"], [8, "invalid_op"],
    ]);
    expect(r.status).toBe("applied");
    expect(r.upserts).toHaveLength(1);
    expect(r.upserts[0].preview).toBe("ok");
  });

  it("accepts a paragraph anchor that is a Yjs relative position and re-encodes it", async () => {
    const { wave } = setup();
    const root = await create(wave, { text: "One\n\nTwo" });
    const { doc, text } = await openDoc(wave, root.id);
    const rel = Y.createRelativePositionFromTypeIndex(text, 5);
    const pos = encodeBytes(Y.encodeRelativePosition(rel));
    const reply = await create(wave, { parentId: root.id, anchor: { type: "para", pos } });
    expect(reply.result.errors).toEqual([]);
    expect(reply.blip.anchor).toEqual({ type: "para", pos });
    const back = Y.decodeRelativePosition(decodeBytes(reply.blip.anchor.pos));
    expect(Y.createAbsolutePositionFromRelativePosition(back, doc).index).toBe(5);
  });

  it("clamps replies deeper than replyDepth to depth 6 and caps the blip count", async () => {
    const { wave } = setup();
    let parent = (await create(wave, {})).id;
    const chain = [parent];
    for (let i = 0; i < 7; i++) {
      const r = await create(wave, { parentId: parent });
      chain.push(r.id);
      parent = r.id;
    }
    const w = await wave.getWave();
    const depth = (id) => { let d = 1; let b = w.blips[id]; while (b.parentId) { d++; b = w.blips[b.parentId]; } return d; };
    expect(chain.map(depth)).toEqual([1, 2, 3, 4, 5, 6, 6, 6]);
    expect(w.blips[chain[7]].parentId).toBe(chain[4]);
    expect(w.blips[chain[7]].anchor).toEqual({ type: "end" });

    const small = setup({ limits: { blips: 2 } });
    await create(small.wave, {});
    await create(small.wave, {});
    const over = await create(small.wave, {});
    expect(over.result.errors).toEqual([{ index: 0, code: "limit", message: expect.stringContaining("2 blips") }]);
    expect(over.result.status).toBe("unchanged");
  });

  it("delete, restore and move check baseVersion, bump version once per request, refuse cycles and locked blips", async () => {
    const { wave } = setup();
    const a = await create(wave, { text: "a" });
    const b = await create(wave, { parentId: a.id, text: "b" });
    const c = await create(wave, { parentId: b.id, text: "c" });
    // Stale version: conflict carrying the current record.
    let r = await wave.applyOperation({ by: "T", blipOps: [{ op: "delete", blipId: b.id, baseVersion: 7 }] });
    expect(r).toMatchObject({ status: "conflict", conflicts: [{ blipId: b.id, current: { id: b.id, version: 1 } }], upserts: [] });
    // Delete then move in one request: the second op may use the pre-request version.
    r = await wave.applyOperation({ by: "T", blipOps: [
      { op: "delete", blipId: b.id, baseVersion: 1 },
      { op: "restore", blipId: b.id, baseVersion: 1 },
    ] });
    expect(r.status).toBe("applied");
    expect(r.upserts).toHaveLength(1);
    expect(r.upserts[0]).toMatchObject({ id: b.id, deleted: false, version: 2 });
    expect(r.events.map((e) => e.kind)).toEqual(["blip.delete", "blip.restore"]);
    expect(r.deletes).toEqual([b.id]);
    // A cycle is refused; a move to a new parent takes the last order there.
    r = await wave.applyOperation({ by: "T", blipOps: [{ op: "move", blipId: a.id, baseVersion: 1, parentId: c.id }] });
    expect(r.errors).toEqual([{ index: 0, code: "invalid_ref", message: expect.any(String) }]);
    r = await wave.applyOperation({ by: "T", blipOps: [{ op: "move", blipId: c.id, baseVersion: 1, parentId: a.id }] });
    expect(r.upserts[0]).toMatchObject({ id: c.id, parentId: a.id, version: 2, order: "a1", anchor: { type: "end" } });
    // Moving to a root: anchor null.
    r = await wave.applyOperation({ by: "T", blipOps: [{ op: "move", blipId: c.id, baseVersion: 2, parentId: null }] });
    expect(r.upserts[0]).toMatchObject({ parentId: null, anchor: null, version: 3 });
    expect((await wave.getWave()).meta.rootOrder).toEqual([a.id, c.id]);
    // Nothing to do: already deleted is not an error and not an event.
    await wave.applyOperation({ by: "T", blipOps: [{ op: "delete", blipId: b.id, baseVersion: 2 }] });
    r = await wave.applyOperation({ by: "T", blipOps: [{ op: "delete", blipId: b.id, baseVersion: 3 }] });
    expect(r).toMatchObject({ status: "unchanged", events: [] });
    // A deleted parent is an invalid reference for creates and moves.
    r = await wave.applyOperation({ by: "T", blipOps: [{ op: "create", blipId: nextId(), parentId: b.id }] });
    expect(r.errors[0].code).toBe("invalid_ref");
    // Decisions are locked.
    const d = await wave.recordDecision({ threadId: a.id, text: "Decided", rationale: "why" });
    r = await wave.applyOperation({ by: "T", blipOps: [
      { op: "delete", blipId: d.blip.id, baseVersion: 1 },
      { op: "move", blipId: d.blip.id, baseVersion: 1, parentId: null },
    ] });
    expect(r.errors.map((e) => e.code)).toEqual(["locked", "locked"]);
  });

  it("structure: title last-writer-wins, template only once; participants capped", async () => {
    const { wave } = setup({ limits: { participants: 2 } });
    let r = await wave.applyOperation({ by: "T", structure: { title: " Plan <b> ", template: "decision" } });
    expect(r.status).toBe("applied");
    expect(r.meta).toMatchObject({ title: "Plan <b>", template: "decision" });
    expect(r.events).toEqual([expect.objectContaining({ kind: "structure", detail: "title: Plan <b>; template: decision" })]);
    r = await wave.applyOperation({ by: "T", structure: { title: "Plan <b>", template: "blank" } });
    expect(r.status).toBe("unchanged");
    expect(r.errors).toEqual([{ index: -1, code: "invalid_op", message: expect.stringContaining("already") }]);
    r = await wave.applyOperation({ by: "T", structure: { template: "nope" } });
    expect(r.errors[0].message).toContain("unknown template");
    r = await wave.applyOperation({ by: "T", participantOps: [
      { op: "upsert", participant: { id: "p1", name: "Ann", color: "#112233" } },
      { op: "upsert", participant: { id: "p2", name: "Bob", color: "bad" } },
      { op: "upsert", participant: { id: "p3", name: "Cat" } },
      { op: "upsert", participant: { id: "p1", name: "Ann" } },
      { op: "bogus" },
    ] });
    expect(r.meta.participants).toEqual([{ id: "p1", name: "Ann", color: "#112233" }, { id: "p2", name: "Bob", color: "#e1632e" }]);
    expect(r.errors.map((e) => [e.index, e.code])).toEqual([[2, "limit"], [4, "invalid_op"]]);
    r = await wave.applyOperation({ by: "T", participantOps: [{ op: "remove", id: "p2" }, { op: "upsert", participant: { id: "p1", name: "Anne" } }] });
    expect(r.meta.participants).toEqual([{ id: "p1", name: "Anne", color: "#112233" }]);
    expect(r.events[0].detail).toBe("participant left; Anne updated");
    expect((await wave.getWave()).meta).toMatchObject({ title: "Plan <b>", template: "decision", participants: [{ id: "p1" }] });
  });

  it("getThread returns the root and its replies in tree order; getChanges pages events", async () => {
    const { wave } = setup();
    const a = await create(wave, {});
    const a1 = await create(wave, { parentId: a.id });
    const a2 = await create(wave, { parentId: a.id, order: "Zz" });
    const a11 = await create(wave, { parentId: a1.id });
    await create(wave, {});
    const t = await wave.getThread({ rootId: a11.id });
    expect(t.blips.map((b) => b.id)).toEqual([a.id, a2.id, a1.id, a11.id]);
    expect(t.seq).toBe(5);
    expect(await wave.getThread({ rootId: B(1) })).toMatchObject({ error: "unknown_blip" });
    const c = await wave.getChanges({ afterSeq: 2, limit: 2 });
    expect(c).toEqual({ events: [expect.objectContaining({ seq: 3 }), expect.objectContaining({ seq: 4 })], seq: 5, earliestSeq: 1 });
  });
});

describe("request ids", () => {
  it("replays applyOperation per sender with the recorded outcome and the current seq", async () => {
    const { wave, repo } = setup();
    const id = nextId();
    const req = { senderId: "A", by: "T", requestId: "r-1", blipOps: [{ op: "create", blipId: id, parentId: null, text: "once" }] };
    const first = await wave.applyOperation(req);
    expect(first.status).toBe("applied");
    await create(wave, {});
    const again = await wave.applyOperation(req);
    expect(again).toEqual({ status: "applied", seq: 3, upserts: [], deletes: [], meta: null, events: [], conflicts: [], errors: [], duplicate: true });
    // Another sender with the same requestId is a different request: "exists".
    const other = await wave.applyOperation({ ...req, senderId: "B" });
    expect(other.errors[0].code).toBe("exists");
    expect(other.duplicate).toBeUndefined();
    expect((await repo.getRequests("A"))[0]).toEqual({ requestId: "r-1", seq: 2, at: expect.any(Number), method: "applyOperation", outcome: { status: "applied", conflicts: [], errors: [] } });
    // Records survive a reload of the core over the same repository.
    const fresh = setup({ repo });
    expect((await fresh.wave.applyOperation(req)).duplicate).toBe(true);
    // A request that changed nothing is still recorded.
    const noop = { senderId: "A", requestId: "r-2", structure: { title: "Untitled wave" } };
    expect((await wave.applyOperation(noop)).status).toBe("unchanged");
    expect((await wave.applyOperation(noop)).duplicate).toBe(true);
  });

  it("bounds request records per sender and senders per wave", async () => {
    const { wave, repo } = setup({ limits: { requestRecords: 3, requestSenders: 2 } });
    for (let i = 0; i < 5; i++) await wave.applyOperation({ senderId: "A", requestId: "a" + i, structure: { title: "T" + i } });
    expect((await repo.getRequests("A")).map((r) => r.requestId)).toEqual(["a2", "a3", "a4"]);
    await wave.applyOperation({ senderId: "B", requestId: "b0", structure: { title: "B" } });
    await wave.applyOperation({ senderId: "C", requestId: "c0", structure: { title: "C" } });
    expect((await repo.listRequestSenders()).sort()).toEqual(["B", "C"]);
  });
});

describe("text", () => {
  it("pushes updates, echoes text events, serves full state and diffs, and replays by requestId", async () => {
    const { wave, texts, events } = setup();
    const root = await create(wave, { text: "Hello" });
    events.length = 0;
    const { result, doc } = await edit(wave, root.id, (t) => t.insert(5, " world"), { senderId: "c1" });
    expect(result).toEqual({ seq: 3, textSeq: 3 });
    expect(texts).toEqual([{ blipId: root.id, senderId: "c1", seq: 3, prevTextSeq: 2, textSeq: 3, update: expect.any(String) }]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "operation", senderId: "c1", seq: 3, deletes: [], events: [{ kind: "text", blipId: root.id, bytes: expect.any(Number) }] });
    expect(events[0].upserts[0]).toMatchObject({ id: root.id, seq: 3, textSeq: 3, textChars: 11, preview: "Hello world", version: 1 });
    // Another client with an older copy gets only the diff.
    const other = new Y.Doc();
    Y.applyUpdateV2(other, decodeBytes((await wave.openBlip({ blipId: root.id })).update));
    expect(other.getText("t").toString()).toBe("Hello world");
    const before = Y.encodeStateVector(other);
    await edit(wave, root.id, (t) => t.insert(0, "> "), { doc });
    const diff = await wave.openBlip({ blipId: root.id, stateVector: encodeBytes(before) });
    expect(diff.textSeq).toBe(4);
    expect(decodeBytes(diff.update).length).toBeLessThan(decodeBytes((await wave.openBlip({ blipId: root.id })).update).length);
    Y.applyUpdateV2(other, decodeBytes(diff.update));
    expect(other.getText("t").toString()).toBe("> Hello world");
    // Replay: the recorded seq, nothing appended.
    const update = encodeBytes(Y.encodeStateAsUpdateV2(doc, before));
    const a = await wave.pushText({ senderId: "c1", blipId: root.id, update, requestId: "dup" });
    const b = await wave.pushText({ senderId: "c1", blipId: root.id, update, requestId: "dup" });
    expect(b).toEqual({ ...a, duplicate: true });
    expect((await wave.getWave()).seq).toBe(a.seq);
    // Errors as values.
    expect(await wave.pushText({ senderId: "c1", blipId: B(9), update, requestId: "x" })).toMatchObject({ error: "unknown_blip" });
    expect(await wave.pushText({ senderId: "c1", blipId: "bad", update, requestId: "x" })).toMatchObject({ error: "invalid_argument" });
    expect(await wave.pushText({ senderId: "c1", blipId: root.id, update: "***", requestId: "x" })).toMatchObject({ error: "invalid_update" });
    expect(await wave.pushText({ senderId: "c1", blipId: root.id, update: encodeBytes(new Uint8Array([9, 9, 9, 9, 9, 9, 9])), requestId: "x" })).toMatchObject({ error: "invalid_update" });
    expect(await wave.openBlip({ blipId: root.id, stateVector: "***" })).toMatchObject({ error: "invalid_argument" });
    expect(await wave.openBlip({ blipId: B(9) })).toMatchObject({ error: "unknown_blip" });
  });

  it("refuses a push that would exceed the text cap or edit a decision, leaving the doc unchanged", async () => {
    const { wave } = setup({ limits: { textChars: 10 } });
    const root = await create(wave, { text: "12345" });
    const { result } = await edit(wave, root.id, (t) => t.insert(5, "6789012"));
    expect(result).toMatchObject({ error: "blip_full", message: expect.stringContaining("12 characters") });
    expect(await textOf(wave, root.id)).toBe("12345");
    expect((await wave.getWave()).blips[root.id].textSeq).toBe(2);
    const d = await wave.recordDecision({ threadId: root.id, text: "Fixed", rationale: "r" });
    expect((await edit(wave, d.blip.id, (t) => t.insert(0, "x"))).result).toMatchObject({ error: "locked" });
  });

  it("compacts the text record after N updates and hydrates from it after a cache drop", async () => {
    const { wave, repo } = setup({ limits: { compaction: { updates: 3, bytes: 1 << 20 }, cache: { docs: 1, bytes: 1 << 20, idleMs: 1 << 30 } } });
    const root = await create(wave, { text: "a" });
    let doc;
    for (let i = 0; i < 4; i++) ({ doc } = await edit(wave, root.id, (t) => t.insert(t.length, "b"), { doc }));
    const blip = (await wave.getWave()).blips[root.id];
    // Seed + 4 pushes = 5 updates; compaction at the third and its counter restarts.
    expect(blip.log).toMatchObject({ count: 5, sinceCompaction: 2 });
    expect(repo.texts.get(root.id)).toMatchObject({ id: root.id, textSeq: 4, state: expect.any(Uint8Array) });
    expect(repo.updates.get(root.id).size).toBe(5);
    // Touching another blip evicts the doc (cache of one); the next open hydrates text + later updates.
    const other = await create(wave, { text: "z" });
    await openDoc(wave, other.id);
    expect(wave.cacheStats().docs).toBe(1);
    expect(await textOf(wave, root.id)).toBe("abbbb");
  });

  it("trims retained updates into a base state, keeps playback equal to the live text and raises earliestSeq", async () => {
    // Each one-word update record costs ~165 storedBytes, so 1200 folds to ~3 retained updates.
    const { wave, repo } = setup({ limits: { updBytesPerBlip: 1200, compaction: { updates: 1000, bytes: 1 << 20 } } });
    const root = await create(wave, { text: "start" });
    const before = (await wave.getWave()).meta;
    expect(before).toMatchObject({ earliestSeq: 1, retainedBytes: expect.any(Number) });
    let doc;
    for (let i = 0; i < 12; i++) ({ doc } = await edit(wave, root.id, (t) => t.insert(t.length, " w" + i), { doc }));
    const w = await wave.getWave();
    const blip = w.blips[root.id];
    expect(blip.log.bytes).toBeLessThanOrEqual(1200);
    expect(blip.log.count).toBeGreaterThan(1);
    expect(blip.log.count).toBeLessThan(13);
    expect(w.meta.retainedBytes).toBe(blip.log.bytes);
    const base = repo.bases.get(root.id);
    expect(base).toMatchObject({ id: root.id, seq: expect.any(Number) });
    expect(base.seq).toBeGreaterThan(1);
    expect(w.meta.earliestSeq).toBe(base.seq);
    // The compacted state is at or past the base, so hydration never needs a folded update.
    expect(repo.texts.get(root.id).textSeq).toBeGreaterThanOrEqual(base.seq);
    // Playback from the base reproduces the live text; the folded updates are gone.
    const live = await textOf(wave, root.id);
    const { text, pb } = await playbackText(wave, root.id);
    expect(text).toBe(live);
    expect(pb.base.seq).toBe(base.seq);
    expect(pb.updates.every((u) => u.seq > base.seq)).toBe(true);
    expect(pb.updates.map((u) => u.seq)).toEqual([...repo.updates.get(root.id).keys()].sort((a, b) => a - b));
    // A partial range replays a prefix.
    const mid = pb.updates[Math.floor(pb.updates.length / 2)].seq;
    const partial = await playbackText(wave, root.id, { toSeq: mid });
    expect(live.startsWith(partial.text)).toBe(true);
    expect(partial.text.length).toBeLessThan(live.length);
    // After a cache drop the text still hydrates.
    const fresh = setup({ repo });
    expect(await textOf(fresh.wave, root.id)).toBe(live);
    expect((await playbackText(fresh.wave, root.id)).text).toBe(live);
  });

  it("trims the largest blip when the wave total is over cap, one blip per commit", async () => {
    // Records cost ~160 storedBytes plus their text: a's 400-character edits dwarf b's 1-character ones.
    const { wave, repo } = setup({ limits: { updBytesPerWave: 2000, updBytesPerBlip: 1 << 20 } });
    const a = await create(wave, { text: "a" });
    const b = await create(wave, { text: "b" });
    let da, db;
    for (let i = 0; i < 4; i++) {
      ({ doc: da } = await edit(wave, a.id, (t) => t.insert(t.length, "a".repeat(400)), { doc: da }));
      ({ doc: db } = await edit(wave, b.id, (t) => t.insert(t.length, "b"), { doc: db }));
    }
    const w = await wave.getWave();
    expect(w.meta.retainedBytes).toBeLessThanOrEqual(2000);
    expect(repo.bases.has(a.id)).toBe(true);
    expect(repo.bases.has(b.id)).toBe(false);
    expect(await textOf(wave, a.id)).toBe("a".repeat(1601));
    expect((await playbackText(wave, a.id)).text).toBe(await textOf(wave, a.id));
    expect((await playbackText(wave, b.id)).text).toBe("bbbbb");
  });

  it("drops old events beyond the cap and moves earliestSeq", async () => {
    const { wave, repo } = setup({ limits: { events: 4 } });
    for (let i = 0; i < 4; i++) await create(wave, {});
    const c = await wave.getChanges({ afterSeq: 0 });
    expect(c.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(c.earliestSeq).toBe(1);
    await create(wave, { text: "x" }); // two events
    const d = await wave.getChanges({ afterSeq: 0 });
    expect(d.events.map((e) => e.seq)).toEqual([3, 4, 5, 6]);
    expect(d.earliestSeq).toBe(3);
    expect((await wave.getWave()).meta.earliestSeq).toBe(3);
    expect(repo.events.size).toBe(4);
    const fresh = setup({ repo });
    expect((await fresh.wave.getChanges({ afterSeq: 0 })).earliestSeq).toBe(3);
  });

  it("bounds the doc cache by count and bytes", async () => {
    const { wave } = setup({ limits: { cache: { docs: 2, bytes: 1 << 20, idleMs: 1 << 30 } } });
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await create(wave, { text: "t" + i })).id);
    expect(wave.cacheStats().docs).toBe(2);
    for (const id of ids) await openDoc(wave, id);
    expect(wave.cacheStats().docs).toBe(2);
    const tiny = setup({ limits: { cache: { docs: 64, bytes: 40, idleMs: 1 << 30 } } });
    for (let i = 0; i < 3; i++) await create(tiny.wave, { text: "some text " + i });
    expect(tiny.wave.cacheStats().docs).toBe(1);
  });
});

describe("proposals", () => {
  async function proposalSetup() {
    const s = setup();
    const root = await create(s.wave, { text: "# Brief\n\nShip in May.\n\nMore." });
    const src = await create(s.wave, { parentId: root.id, text: "Evidence" });
    return { ...s, root, src };
  }

  it("propose creates a review proposal under the target with baseSeq and known sources only", async () => {
    const { wave, root, src } = await proposalSetup();
    const p = await wave.propose({ targetId: root.id, quote: "May", replacement: "June", summary: "Slip a month", sources: [src.id, B(0xbad), "junk"], by: "Bot", requestId: "p1", senderId: "x" });
    expect(p.blip).toMatchObject({
      kind: "proposal", parentId: root.id, anchor: { type: "end" }, by: "Bot", preview: "Slip a month",
      proposal: { targetId: root.id, baseSeq: 2, quote: "May", replacement: "June", summary: "Slip a month", sources: [src.id], state: "review" },
    });
    expect(p.seq).toBeGreaterThan(4);
    expect(await wave.propose({ targetId: root.id, quote: "May", replacement: "June", summary: "Slip a month", sources: [], by: "Bot", requestId: "p1", senderId: "x" })).toEqual({ blip: expect.objectContaining({ id: p.blip.id }), seq: p.seq, duplicate: true });
    expect(await wave.propose({ targetId: B(1), replacement: "x" })).toMatchObject({ error: "unknown_blip" });
    expect(await wave.propose({ targetId: root.id })).toMatchObject({ error: "invalid_argument" });
    const d = await wave.recordDecision({ threadId: root.id, text: "Done", rationale: "r" });
    expect(await wave.propose({ targetId: d.blip.id, replacement: "x" })).toMatchObject({ error: "locked" });
  });

  it("accept applies the replacement as one text update by the reviewer; a second accept conflicts", async () => {
    const { wave, root, texts, events } = await proposalSetup();
    const p = await wave.propose({ targetId: root.id, quote: "May", replacement: "June", summary: "s", sources: [] });
    texts.length = 0;
    events.length = 0;
    const r = await wave.reviewProposal({ proposalId: p.blip.id, decision: "accept", expectedVersion: 1, by: "Ann", senderId: "c9" });
    expect(r).toMatchObject({ status: "applied", blip: { version: 2, proposal: { state: "accepted", reviewedBy: "Ann", reviewedAt: expect.any(Number) } } });
    expect(await textOf(wave, root.id)).toBe("# Brief\n\nShip in June.\n\nMore.");
    // Server-made text: no senderId, so the reviewer's client cannot mistake it for its own echo.
    expect(texts).toEqual([expect.objectContaining({ blipId: root.id, senderId: "", prevTextSeq: 2 })]);
    expect(events).toHaveLength(1);
    expect(events[0].events.map((e) => [e.kind, e.by])).toEqual([["proposal.accept", "Ann"], ["text", "Ann"]]);
    expect(events[0].upserts.map((b) => b.id).sort()).toEqual([p.blip.id, root.id].sort());
    const target = (await wave.getWave()).blips[root.id];
    expect(target).toMatchObject({ textSeq: r.seq, version: 1, preview: "# Brief Ship in June. More." });
    // The update record carries the reviewer.
    const pb = await wave.getPlayback({ blipId: root.id });
    expect(pb.updates.at(-1)).toMatchObject({ seq: r.seq, by: "Ann" });
    // Second accept: the version moved and the state is no longer review.
    const again = await wave.reviewProposal({ proposalId: p.blip.id, decision: "accept", expectedVersion: 1 });
    expect(again).toMatchObject({ status: "conflict", blip: { proposal: { state: "accepted" } } });
    const again2 = await wave.reviewProposal({ proposalId: p.blip.id, decision: "accept", expectedVersion: 2 });
    expect(again2.status).toBe("conflict");
    expect(await textOf(wave, root.id)).toBe("# Brief\n\nShip in June.\n\nMore.");
  });

  it("only a client's own pushText carries its senderId; server-made text carries none, so dropping own echoes loses nothing", async () => {
    const { wave, texts } = setup();
    // Seeded text (applyOperation creates, which is also how a template's blips arrive, and reply)
    // is not broadcast as text at all: the create upsert carries textSeq and openers fetch the state.
    const root = await create(wave, { text: "# Brief\n\nShip in May.", senderId: "c9" });
    await wave.reply({ parentId: root.id, text: "Seeded reply", senderId: "c9", by: "Ann", requestId: "reply-1" });
    expect(texts).toEqual([]);
    // Ann (client c9) edits: her echo carries c9.
    const doc = new Y.Doc();
    Y.applyUpdateV2(doc, decodeBytes((await wave.openBlip({ blipId: root.id })).update));
    await edit(wave, root.id, (t) => t.insert(t.length, " Soon."), { senderId: "c9", doc });
    expect(texts.map((t) => t.senderId)).toEqual(["c9"]);
    // Ann accepts a proposal: the replacement is new to her client too, so it carries no senderId.
    const p = await wave.propose({ targetId: root.id, quote: "May", replacement: "June", summary: "s", sources: [], senderId: "agent", by: "Assistant" });
    texts.length = 0;
    const r = await wave.reviewProposal({ proposalId: p.blip.id, decision: "accept", expectedVersion: p.blip.version, by: "Ann", senderId: "c9" });
    expect(r.status).toBe("applied");
    expect(texts).toHaveLength(1);
    expect(texts[0].senderId).toBe("");
    // A client that skips events carrying its own senderId still reaches the server's text.
    for (const ev of texts) if (ev.senderId !== "c9") Y.applyUpdateV2(doc, decodeBytes(ev.update));
    expect(doc.getText("t").toString()).toBe(await textOf(wave, root.id));
    expect(doc.getText("t").toString()).toBe("# Brief\n\nShip in June. Soon.");
  });

  it("an empty quote replaces the whole text; a missing quote or a moved target is stale; reject rejects", async () => {
    const { wave, root } = await proposalSetup();
    const whole = await wave.propose({ targetId: root.id, quote: "", replacement: "New text", summary: "s", sources: [] });
    const gone = await wave.propose({ targetId: root.id, quote: "Nowhere", replacement: "x", summary: "s", sources: [] });
    const later = await wave.propose({ targetId: root.id, quote: "More", replacement: "Less", summary: "s", sources: [] });
    const rej = await wave.propose({ targetId: root.id, quote: "More", replacement: "Less", summary: "s", sources: [] });
    const r1 = await wave.reviewProposal({ proposalId: gone.blip.id, decision: "accept", expectedVersion: 1 });
    expect(r1).toMatchObject({ status: "stale", blip: { proposal: { state: "stale" } } });
    const r2 = await wave.reviewProposal({ proposalId: rej.blip.id, decision: "reject", expectedVersion: 1, by: "Bob" });
    expect(r2).toMatchObject({ status: "rejected", blip: { proposal: { state: "rejected", reviewedBy: "Bob" } } });
    const r3 = await wave.reviewProposal({ proposalId: whole.blip.id, decision: "accept", expectedVersion: 1 });
    expect(r3.status).toBe("applied");
    expect(await textOf(wave, root.id)).toBe("New text");
    // The target's text moved past baseSeq: stale, even though "Less" would still not apply anyway.
    const r4 = await wave.reviewProposal({ proposalId: later.blip.id, decision: "accept", expectedVersion: 1 });
    expect(r4).toMatchObject({ status: "stale" });
    expect(await textOf(wave, root.id)).toBe("New text");
    expect(await wave.reviewProposal({ proposalId: root.id, decision: "accept", expectedVersion: 1 })).toMatchObject({ error: "unknown_blip" });
    expect(await wave.reviewProposal({ proposalId: later.blip.id, decision: "maybe", expectedVersion: 1 })).toMatchObject({ error: "invalid_argument" });
    // Typing does not make a proposal stale until the target's text changes... it does change it.
    const p5 = await wave.propose({ targetId: root.id, quote: "New", replacement: "Old", summary: "s", sources: [] });
    await edit(wave, root.id, (t) => t.insert(0, "!"));
    expect((await wave.reviewProposal({ proposalId: p5.blip.id, decision: "accept", expectedVersion: 1 })).status).toBe("stale");
  });
});

describe("decisions", () => {
  it("records a locked decision at the end of the thread's root, supersedes an older one, cleans fields", async () => {
    const { wave } = setup();
    const root = await create(wave, { text: "Question" });
    const reply = await create(wave, { parentId: root.id, text: "Option A" });
    const d1 = await wave.recordDecision({ threadId: reply.id, text: "  Choose A ", rationale: "cheap", by: "Ann", requestId: "d1", senderId: "s" });
    expect(d1.blip).toMatchObject({
      kind: "decision", parentId: root.id, anchor: { type: "end" }, locked: true, by: "Ann", preview: "Choose A",
      decision: { recordedBy: "Ann", recordedAt: expect.any(Number), rationale: "cheap", dissent: "", nextSteps: "" },
    });
    expect(d1.blip.decision.supersedes).toBeUndefined();
    expect(await textOf(wave, d1.blip.id)).toBe("Choose A");
    expect(await wave.recordDecision({ threadId: reply.id, text: "x", rationale: "", requestId: "d1", senderId: "s" })).toMatchObject({ blip: { id: d1.blip.id }, duplicate: true });
    const d2 = await wave.recordDecision({ threadId: root.id, text: "Choose B", rationale: "r", dissent: "Ann", nextSteps: "go", supersedes: d1.blip.id, by: "Bob" });
    expect(d2.blip.decision).toMatchObject({ supersedes: d1.blip.id, dissent: "Ann", nextSteps: "go" });
    const w = await wave.getWave();
    expect(w.blips[d1.blip.id]).toMatchObject({ version: 2, decision: { supersededBy: d2.blip.id } });
    expect(w.meta.rootOrder).toEqual([root.id]);
    const t = await wave.getThread({ rootId: root.id });
    expect(t.blips.map((b) => b.kind)).toEqual(["note", "note", "decision", "decision"]);
    expect(await wave.recordDecision({ threadId: root.id, text: "C", rationale: "", supersedes: d1.blip.id })).toMatchObject({ error: "invalid_argument" });
    expect(await wave.recordDecision({ threadId: root.id, text: "C", rationale: "", supersedes: reply.id })).toMatchObject({ error: "invalid_argument" });
    expect(await wave.recordDecision({ threadId: root.id, text: "   ", rationale: "" })).toMatchObject({ error: "invalid_argument" });
    expect(await wave.recordDecision({ threadId: B(5), text: "x" })).toMatchObject({ error: "unknown_blip" });
    const other = await create(wave, {});
    expect(await wave.recordDecision({ threadId: other.id, text: "x", supersedes: d2.blip.id })).toMatchObject({ error: "invalid_argument", message: expect.stringContaining("same thread") });
  });
});

describe("markdown", () => {
  it("getWaveMarkdown anchors every blip by id, labels kinds, filters by thread and sinceSeq", async () => {
    const { wave } = setup();
    await wave.applyOperation({ structure: { title: "Launch" } });
    const brief = await create(wave, { kind: "brief", text: "# Brief\n\nGoal." });
    const q = await create(wave, { text: "Question?" });
    const a = await create(wave, { parentId: q.id, text: "Answer citing " + brief.id, by: "Ann" });
    const p = await wave.propose({ targetId: brief.id, quote: "Goal.", replacement: "Aim.", summary: "Reword", sources: [a.id], by: "Bot" });
    const d = await wave.recordDecision({ threadId: q.id, text: "Yes", rationale: "Because", dissent: "None", nextSteps: "Ship", by: "Cat" });
    const md = await wave.getWaveMarkdown();
    expect(md.startsWith("# Launch\n")).toBe(true);
    expect(md).toContain(`### [${brief.id}] brief · Tester ·`);
    expect(md).toContain(`### [${q.id}] note · Tester ·`);
    expect(md).toContain(`#### ↳ [${a.id}] note · Ann ·`);
    expect(md).toContain(`#### ↳ [${p.blip.id}] proposal (review) for [${brief.id}] · Bot ·`);
    expect(md).toContain("**Quote**:\n\n> Goal.\n\n**Replacement**:\n\n> Aim.");
    expect(md).toContain(`**Sources**: [${a.id}]`);
    expect(md).toContain(`#### ↳ [${d.blip.id}] decision (recorded by Cat, unverified) · Cat ·`);
    expect(md).toContain("**Rationale**:\n\nBecause");
    expect(md.indexOf(`[${brief.id}]`)).toBeLessThan(md.indexOf(`[${q.id}]`));
    const thread = await wave.getWaveMarkdown({ threadId: a.id });
    expect(thread).toContain(`[${q.id}]`);
    expect(thread).not.toContain(`### [${brief.id}]`);
    const since = await wave.getWaveMarkdown({ sinceSeq: d.seq - 2 });
    expect(since).toContain(`[${d.blip.id}] decision`);
    expect(since).toContain(`[${q.id}] note`);
    expect(since).toContain("(context: unchanged)");
    expect(since).not.toContain(`[${a.id}] note`);
    // Deleted blips are left out.
    await wave.applyOperation({ blipOps: [{ op: "delete", blipId: a.id, baseVersion: 1 }] });
    expect(await wave.getWaveMarkdown()).not.toContain(`[${a.id}] note`);
  });

  it("exportMarkdown renders decision records and caps the size", async () => {
    const { wave } = setup();
    const brief = await create(wave, { kind: "brief", text: "# Brief\n\nContext here." });
    const q = await create(wave, { text: "Which option?" });
    const optA = await create(wave, { parentId: q.id, text: "Option A: cheap" });
    const optB = await create(wave, { parentId: q.id, text: "Option B: fast" });
    const d1 = await wave.recordDecision({ threadId: q.id, text: "Take A", rationale: "See " + optA.id, dissent: "Bob wants B", nextSteps: "Do it", by: "Ann" });
    const d2 = await wave.recordDecision({ threadId: q.id, text: "Take B after all", rationale: "r", supersedes: d1.blip.id, by: "Bob" });
    const md = await wave.exportMarkdown({ decisions: true });
    expect(md).toContain("# Decisions: Untitled wave");
    expect(md).toContain("## Decision: Take A");
    expect(md).toContain(`[${d1.blip.id}] recorded by Ann (unverified)`);
    expect(md).toContain(`status: superseded by [${d2.blip.id}]`);
    expect(md).toContain(`supersedes [${d1.blip.id}]`);
    expect(md).toContain("### Context\n\nBrief [" + brief.id + "]:\n\n> # Brief\n> \n> Context here.");
    expect(md).toContain(`- [${optA.id}]: Option A: cheap`);
    expect(md).toContain(`- [${optB.id}]: Option B: fast`);
    expect(md).toContain("### Decision\n\nTake A\n\n### Rationale\n\nSee " + optA.id + "\n\n### Dissent\n\nBob wants B\n\n### Next steps\n\nDo it");
    expect(md).toContain(`### Sources\n\n[${q.id}], [${optA.id}], [${brief.id}]`);
    expect(md.indexOf("Take A")).toBeLessThan(md.indexOf("Take B after all"));
    const whole = await wave.exportMarkdown({});
    expect(whole).toContain(`[${q.id}] note`);
    expect(whole).toContain(`[${d2.blip.id}] decision`);
    const capped = setup({ limits: { exportBytes: 400 } });
    for (let i = 0; i < 5; i++) await create(capped.wave, { text: "x".repeat(150) });
    const cut = await capped.wave.exportMarkdown({});
    expect(cut).toContain("(Cut at 0 KiB; ");
    expect(cut.length).toBeLessThan(600);
    const none = setup();
    expect(await none.wave.exportMarkdown({ decisions: true })).toContain("No decision has been recorded yet.");
  });
});

describe("agent runs", () => {
  /** A wave with a brief, a thread and a fake model. */
  async function agentSetup(modelOptions = {}, waveOptions = {}) {
    const fake = createFakeModel(modelOptions);
    const s = setup({ model: () => fake, ...waveOptions });
    const brief = await create(s.wave, { kind: "brief", text: "# Brief\n\nGoal: ship." });
    const q = await create(s.wave, { text: "Options?" });
    const a = await create(s.wave, { parentId: q.id, text: "Option A" });
    const b = await create(s.wave, { parentId: q.id, text: "Option B" });
    return { ...s, fake, brief, q, a, b };
  }

  it("no_model without a binding; invalid op is invalid_argument", async () => {
    const { wave } = setup();
    const root = await create(wave, { text: "x" });
    expect(await wave.askAgent({ op: "summarise", blipIds: [root.id] })).toMatchObject({ error: "no_model" });
    expect((await wave.getWave()).capabilities.model).toBe(false);
    const withModel = setup({ model: () => createFakeModel() });
    expect(await withModel.wave.askAgent({ op: "frob" })).toMatchObject({ error: "invalid_argument" });
    expect((await withModel.wave.getWave()).capabilities.model).toBe(true);
  });

  it("summarise: queued → running → done with an agent blip at the end of the scoped thread", async () => {
    const { wave, fake, q, a, b, events } = await agentSetup();
    const ask = await wave.askAgent({ op: "summarise", blipIds: [a.id], instructions: "  short\nplease ", by: "Ann", requestId: "k1", senderId: "s" });
    expect(ask.run).toMatchObject({
      op: "summarise", by: "Ann", instructions: "short please", state: "queued", generation: 1,
      scope: { blipIds: [q.id, a.id], sinceSeq: 0, snapshotSeq: expect.any(Number), inputBytes: expect.any(Number), omitted: [] },
    });
    expect(await wave.askAgent({ op: "summarise", requestId: "k1", senderId: "s" })).toMatchObject({ run: { id: ask.run.id }, duplicate: true });
    await wave.settled();
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].systemPrompt).toContain("Every claim cites");
    expect(fake.calls[0].prompt).toContain("<<<WAVE_CONTENT");
    expect(fake.calls[0].prompt).toContain(`[${a.id}]`);
    expect(fake.calls[0].prompt).not.toContain(`[${b.id}]`);
    expect(fake.calls[0].prompt).toContain("short please");
    const { run } = await wave.getRun({ runId: ask.run.id });
    expect(run).toMatchObject({ state: "done", startedAt: expect.any(Number), finishedAt: expect.any(Number), outputBytes: expect.any(Number), resultBlipId: expect.stringMatching(/^b_/) });
    expect(run.result).toBeUndefined();
    const w = await wave.getWave();
    const blip = w.blips[run.resultBlipId];
    expect(blip).toMatchObject({ kind: "agent", parentId: q.id, by: AGENT_NAME, runId: run.id, anchor: { type: "end" } });
    expect(blip.order > a.blip.order && blip.order > b.blip.order).toBe(true);
    const text = await textOf(wave, blip.id);
    expect(text).toContain("## Evidence");
    expect(text).toContain(`[${a.id}]`);
    expect(w.runs.map((r) => r.id)).toEqual([run.id]);
    const kinds = (await wave.getChanges({ afterSeq: ask.seq - 1 })).events.map((e) => e.kind);
    expect(kinds).toEqual(["run.queued", "run.started", "blip.create", "text", "run.done"]);
    // Run changes are broadcast with `runs`.
    expect(events.filter((e) => e.runs).map((e) => e.runs[0].state)).toEqual(["queued", "running", "done"]);
    // A whole-wave summary lands as a new root.
    const all = await wave.askAgent({ op: "compare", by: "Ann" });
    await wave.settled();
    const done = (await wave.getRun({ runId: all.run.id })).run;
    expect(done.state).toBe("done");
    expect((await wave.getWave()).blips[done.resultBlipId]).toMatchObject({ kind: "agent", parentId: null });
    expect((await wave.getWave()).meta.rootOrder.at(-1)).toBe(done.resultBlipId);
  });

  it("refresh_brief yields a proposal against the brief; catch_up yields a result and no blip", async () => {
    const { wave, brief, q } = await agentSetup();
    const r = await wave.askAgent({ op: "refresh_brief", by: "Ann" });
    await wave.settled();
    const run = (await wave.getRun({ runId: r.run.id })).run;
    expect(run.state).toBe("done");
    const w = await wave.getWave();
    const p = w.blips[run.resultBlipId];
    expect(p).toMatchObject({ kind: "proposal", parentId: brief.id, runId: run.id, by: AGENT_NAME, proposal: { targetId: brief.id, state: "review", quote: "" } });
    // Based on the brief's version as the model saw it (what the card compares against), not the snapshot sequence.
    expect(p.proposal.baseSeq).toBe(w.blips[brief.id].seq);
    expect(p.proposal.baseSeq).toBeLessThanOrEqual(r.run.scope.snapshotSeq);
    expect(p.proposal.replacement).toContain("Refreshed by the fake model");
    expect(p.proposal.sources.length).toBeGreaterThan(0);
    const accepted = await wave.reviewProposal({ proposalId: p.id, decision: "accept", expectedVersion: 1, by: "Ann" });
    expect(accepted.status).toBe("applied");
    expect(await textOf(wave, brief.id)).toContain("Refreshed by the fake model");
    const c = await wave.askAgent({ op: "catch_up", sinceSeq: q.result.seq, by: "Ann" });
    expect(c.run.scope.sinceSeq).toBe(q.result.seq);
    await wave.settled();
    const cu = (await wave.getRun({ runId: c.run.id })).run;
    expect(cu).toMatchObject({ state: "done", result: { summary: expect.any(String), body: expect.any(String), sources: expect.any(Array), questions: ["What happens next?"] } });
    expect(cu.resultBlipId).toBeUndefined();
    expect(Object.keys((await wave.getWave()).blips)).toHaveLength(Object.keys(w.blips).length);
    // Without a brief, refresh_brief is refused up front.
    const bare = setup({ model: () => createFakeModel() });
    await create(bare.wave, { text: "no brief" });
    expect(await bare.wave.askAgent({ op: "refresh_brief" })).toMatchObject({ error: "invalid_argument" });
  });

  it("garbage output and a rejecting model fail the run with a short message and no blip", async () => {
    for (const mode of ["garbage", "fail"]) {
      const { wave, q } = await agentSetup({ mode });
      const before = Object.keys((await wave.getWave()).blips).length;
      const r = await wave.askAgent({ op: "summarise", blipIds: [q.id] });
      await wave.settled();
      const run = (await wave.getRun({ runId: r.run.id })).run;
      expect(run.state).toBe("failed");
      expect(run.error).toBe(mode === "fail" ? "model failed" : "The model's reply did not contain a JSON object.");
      expect(run.resultBlipId).toBeUndefined();
      expect(Object.keys((await wave.getWave()).blips)).toHaveLength(before);
      expect((await wave.getChanges({ afterSeq: r.seq })).events.map((e) => e.kind)).toEqual(["run.started", "run.failed"]);
    }
    // Output that cites no blip from the input fails too.
    const { wave, q } = await agentSetup({ reply: { summary: "s", body: "no citations", sources: [], questions: [] } });
    const r = await wave.askAgent({ op: "summarise", blipIds: [q.id] });
    await wave.settled();
    expect((await wave.getRun({ runId: r.run.id })).run).toMatchObject({ state: "failed", error: expect.stringContaining("cited no blip") });
  });

  describe("with fake timers", () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });
    const timers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t) };

    it("busy beyond one running and three queued; cancel discards a hung run's result", async () => {
      const { wave, fake, q } = await agentSetup({ mode: "hang", timers }, { timers });
      const runs = [];
      for (let i = 0; i < 4; i++) runs.push(await wave.askAgent({ op: "summarise", blipIds: [q.id] }));
      await vi.advanceTimersByTimeAsync(0);
      expect(runs.every((r) => r.run)).toBe(true);
      expect(await wave.askAgent({ op: "summarise" })).toMatchObject({ error: "busy" });
      expect((await wave.getWave()).runs.map((r) => r.state)).toEqual(["running", "queued", "queued", "queued"]);
      expect(fake.pending()).toBe(1);
      const c = await wave.cancelRun({ runId: runs[0].run.id, by: "Ann" });
      expect(c.run.state).toBe("cancelled");
      await vi.advanceTimersByTimeAsync(0);
      // The cancelled run stays cancelled; the next queued one starts.
      const states = () => (Object.fromEntries((await0 => await0)([]))); // placeholder to keep lint quiet
      void states;
      await vi.advanceTimersByTimeAsync(0);
      const w = await wave.getWave();
      expect(w.runs.map((r) => r.state)).toEqual(["cancelled", "running", "queued", "queued"]);
      expect(fake.calls).toHaveLength(2);
      // Cancelling a queued run never calls the model; cancelling a finished run returns it unchanged.
      const c2 = await wave.cancelRun({ runId: runs[3].run.id });
      expect(c2.run.state).toBe("cancelled");
      expect((await wave.cancelRun({ runId: runs[3].run.id })).run.state).toBe("cancelled");
      expect(await wave.cancelRun({ runId: "r_000000000000" })).toMatchObject({ error: "unknown_run" });
      // Let the rest finish: switch the fake to ok and cancel the hung one.
      fake.setMode("ok");
      await wave.cancelRun({ runId: runs[1].run.id });
      await vi.advanceTimersByTimeAsync(0);
      await wave.settled();
      const final = (await wave.getWave()).runs.map((r) => r.state);
      expect(final).toEqual(["cancelled", "cancelled", "done", "cancelled"]);
      expect(Object.values((await wave.getWave()).blips).filter((b) => b.kind === "agent")).toHaveLength(1);
    });

    it("a run that does not answer within the timeout fails", async () => {
      const { wave, q } = await agentSetup({ mode: "hang", timers }, { timers });
      const r = await wave.askAgent({ op: "summarise", blipIds: [q.id] });
      await vi.advanceTimersByTimeAsync(0);
      expect((await wave.getRun({ runId: r.run.id })).run.state).toBe("running");
      await vi.advanceTimersByTimeAsync(LIMITS.runs.timeoutMs - 1);
      expect((await wave.getRun({ runId: r.run.id })).run.state).toBe("running");
      await vi.advanceTimersByTimeAsync(2);
      await wave.settled();
      expect((await wave.getRun({ runId: r.run.id })).run).toMatchObject({ state: "failed", error: expect.stringContaining("90 s") });
    });

    it("rate limit per hour and the kept-runs bound", async () => {
      const { wave, q } = await agentSetup({}, { limits: { runs: { ...LIMITS.runs, perHour: 2, keep: 2 } } });
      const r1 = await wave.askAgent({ op: "summarise", blipIds: [q.id] });
      await wave.settled();
      const r2 = await wave.askAgent({ op: "summarise", blipIds: [q.id] });
      await wave.settled();
      expect(await wave.askAgent({ op: "summarise", blipIds: [q.id] })).toMatchObject({ error: "limit" });
      const w = await wave.getWave();
      expect(w.runs.map((r) => r.id)).toEqual([r1.run.id, r2.run.id]);
      // A third run (after the hour) drops the oldest finished one.
      const s3 = setup({ repo: (await agentSetup())?.repo });
      void s3;
      const later = await agentSetup({}, { limits: { runs: { ...LIMITS.runs, perHour: 100, keep: 2 } } });
      const ids = [];
      for (let i = 0; i < 3; i++) { ids.push((await later.wave.askAgent({ op: "summarise", blipIds: [later.q.id] })).run.id); await later.wave.settled(); }
      expect((await later.wave.getWave()).runs.map((r) => r.id)).toEqual(ids.slice(1));
      expect(await later.wave.getRun({ runId: ids[0] })).toMatchObject({ run: null });
    });
  });

  it("restart: a running run becomes unknown with the note; a queued run is resumed", async () => {
    const fake = createFakeModel({ mode: "hang" });
    const first = setup({ model: () => fake });
    const root = await create(first.wave, { text: "x" });
    const r1 = await first.wave.askAgent({ op: "summarise", blipIds: [root.id] });
    const r2 = await first.wave.askAgent({ op: "summarise", blipIds: [root.id] });
    await first.wave.getWave();
    expect((await first.wave.getRun({ runId: r1.run.id })).run.state).toBe("running");
    // A new instance over the same storage, with a model that answers.
    const ok = createFakeModel();
    const second = setup({ repo: first.repo, model: () => ok });
    const w = await second.wave.getWave();
    expect(w.blips).toHaveProperty(root.id);
    const u = (await second.wave.getRun({ runId: r1.run.id })).run;
    expect(u).toMatchObject({ state: "unknown", generation: 2, error: RESTART_NOTE, finishedAt: expect.any(Number) });
    expect((await second.wave.getChanges({ afterSeq: r2.seq })).events[0]).toMatchObject({ kind: "run.unknown", runId: r1.run.id });
    await second.wave.settled();
    expect((await second.wave.getRun({ runId: r2.run.id })).run.state).toBe("done");
    expect(ok.calls).toHaveLength(1);
    expect(ok.calls[0].prompt).toContain(`[${root.id}]`);
    // The old instance's late result (if it ever came) would be discarded: its state is no longer running.
    const late = await first.wave.getRun({ runId: r1.run.id });
    expect(late.run.state).toBe("running"); // the stale cache of the dead instance; storage says unknown
    expect((await first.repo.getRuns()).find((r) => r.id === r1.run.id).state).toBe("unknown");
  });

  it("the input is capped at inputBytes with the rest listed as omitted", async () => {
    const fake = createFakeModel();
    const { wave } = setup({ model: () => fake, limits: { runs: { ...LIMITS.runs, inputBytes: 700 } } });
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push((await create(wave, { text: "Paragraph " + i + " " + "x".repeat(120) })).id);
    const r = await wave.askAgent({ op: "summarise" });
    expect(r.run.scope.inputBytes).toBeLessThanOrEqual(700);
    expect(r.run.scope.blipIds.length + r.run.scope.omitted.length).toBe(6);
    expect(r.run.scope.omitted.length).toBeGreaterThan(0);
    expect(r.run.scope.blipIds).toEqual(ids.slice(0, r.run.scope.blipIds.length));
    await wave.settled();
    expect(fake.calls[0].prompt).not.toContain(`[${ids[5]}]`);
  });
});

describe("state and settled", () => {
  it("seqNow is null before the first load and the cached seq after; settled waits for the queue", async () => {
    const repo = new InMemoryRepository();
    const wave = createWave(repo);
    expect(wave.seqNow()).toBeNull();
    expect(await wave.getSeq()).toBe(0);
    expect(wave.seqNow()).toBe(0);
    const p = create(wave, {});
    await wave.settled();
    expect(wave.seqNow()).toBe(1);
    await p;
  });

  it("a failing commit drops the cache so the next call reloads from storage", async () => {
    const repo = new InMemoryRepository();
    const wave = createWave(repo);
    const root = await create(wave, { text: "keep" });
    const original = repo.commit.bind(repo);
    repo.commit = async () => { throw new Error("disk full"); };
    await expect(edit(wave, root.id, (t) => t.insert(0, "lost "))).rejects.toThrow("disk full");
    repo.commit = original;
    expect(await textOf(wave, root.id)).toBe("keep");
    expect((await wave.getWave()).blips[root.id].textSeq).toBe(2);
  });
});
