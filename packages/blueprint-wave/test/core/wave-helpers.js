// Helpers for the core tests: a wave over the in-memory repository with a fake clock and
// deterministic ids, plus a local Y.Doc client that opens a blip and pushes edits.
import * as Y from "yjs";
import { InMemoryRepository } from "../../src/core/repository.js";
import { createWave } from "../../src/core/wave.js";
import { decodeBytes, encodeBytes } from "../../src/shared/protocol.js";

let counter = 0;
/** A fresh, valid id of the given kind ("blip" | "run"). */
export function nextId(kind = "blip") {
  return (kind === "run" ? "r_" : "b_") + (0x100000000000 + counter++).toString(16);
}

/**
 * @param {object} [options]  createWave options (limits, model, timers) plus `repo` to reuse one
 */
export function setup(options = {}) {
  const { repo = new InMemoryRepository(), ...rest } = options;
  const clock = { t: 1_700_000_000_000 };
  const events = [];
  const texts = [];
  const wave = createWave(repo, {
    now: () => (clock.t += 1000),
    newId: (kind) => nextId(kind),
    onEvent: (e) => events.push(e),
    onText: (t) => texts.push(...t),
    ...rest,
  });
  return { repo, wave, events, texts, clock };
}

let reqCounter = 0;
export const rid = () => "req:" + (reqCounter++).toString(36);

/** Creates one blip through applyOperation and returns it as stored. */
export async function create(wave, { parentId = null, text, kind, anchor, order, id = nextId(), by = "Tester", senderId = "s1" } = {}) {
  const op = { op: "create", blipId: id, parentId };
  if (text !== undefined) op.text = text;
  if (kind) op.kind = kind;
  if (anchor) op.anchor = anchor;
  if (order) op.order = order;
  const result = await wave.applyOperation({ by, senderId, requestId: rid(), blipOps: [op] });
  const blip = result.upserts.find((b) => b.id === id) ?? null;
  return { id, result, blip };
}

/** Opens a blip into a local Y.Doc (full state). */
export async function openDoc(wave, blipId) {
  const r = await wave.openBlip({ blipId });
  if (r.error) throw new Error(r.error);
  const doc = new Y.Doc();
  Y.applyUpdateV2(doc, decodeBytes(r.update));
  return { doc, text: doc.getText("t"), textSeq: r.textSeq, seq: r.seq };
}

/**
 * Edits a blip through a local doc: `mutate(ytext)` runs in a transaction and the resulting
 * update is pushed. Returns the pushText result and the doc.
 */
export async function edit(wave, blipId, mutate, { senderId = "s1", by = "Tester", doc: existing } = {}) {
  const local = existing ?? (await openDoc(wave, blipId)).doc;
  const before = Y.encodeStateVector(local);
  local.transact(() => mutate(local.getText("t")));
  const update = Y.encodeStateAsUpdateV2(local, before);
  const result = await wave.pushText({ senderId, by, blipId, update: encodeBytes(update), requestId: rid() });
  return { result, doc: local, update };
}

/** The text of a blip as the server has it. */
export async function textOf(wave, blipId) {
  return (await openDoc(wave, blipId)).text.toString();
}

/** Base + updates from getPlayback applied to an empty doc, as text. */
export async function playbackText(wave, blipId, range = {}) {
  const pb = await wave.getPlayback({ blipId, ...range });
  if (pb.error) throw new Error(pb.error);
  const doc = new Y.Doc();
  const base = decodeBytes(pb.base.state);
  if (base.length) Y.applyUpdateV2(doc, base);
  for (const u of pb.updates) Y.applyUpdateV2(doc, decodeBytes(u.update));
  return { text: doc.getText("t").toString(), pb };
}
