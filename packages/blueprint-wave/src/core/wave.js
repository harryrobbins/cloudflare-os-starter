// @ts-check
// The Wave's rules, storage-agnostic: blips, text commits, proposals, decisions, agent runs,
// events, compaction and retention. Everything that writes goes through ONE mutation queue
// (enqueue), including pushText, so a commit sees a consistent cached state and no two commits
// interleave. Model calls are the one thing that runs outside the queue (the dispatcher), and
// their results are committed back inside it only if the run is still `running` with the
// generation the dispatcher started.
//
// Cached state (loaded once, kept in memory, replaced after every commit): meta, every blip
// record, every run record, the event index (seq and size only) and request records per sender.
// Text lives in Yjs documents: one Y.Doc per blip in a bounded cache (LIMITS.cache), hydrated
// from "text:<id>" plus the "upd:" records after it and evicted when idle or over the bounds.
//
// Sequences: meta.seq is the global event sequence. Every event takes one number; a text push is
// one "text" event whose seq is also the key of its "upd:<id>:<seq>" record and the blip's new
// textSeq. Timestamps are for display only.
//
// Never log blip text, prompts or model replies here; sizes and sequences only.

import * as Y from "yjs";
import {
  DEFAULT_NAME, DEFAULT_TITLE, LIMITS, RUN_OP_LABELS, SCHEMA_VERSION, cleanAnchor, cleanBlipIds, cleanBlipOp,
  cleanDecisionFields, cleanLine, cleanName, cleanParticipantOp, cleanProposalFields, cleanSeq, cleanText, compareBlips,
  decodeBytes, encodeBytes, isBlipId, isObject, isRequestId, isRunId, isRunOp, isTemplateId, newId as protocolNewId,
  previewOf, rootOf, storedBytes,
} from "../shared/protocol.js";
import { keyBetween } from "../shared/order.js";
import { getTemplate } from "../shared/templates.js";
import { citedBlipIds, firstLine } from "../shared/markdown.js";
import { buildPrompt, buildSystemPrompt, parseAgentOutput, resultKind, scopeFor } from "./runs.js";

/** @typedef {import("../shared/protocol.js").WaveMeta} WaveMeta */
/** @typedef {import("../shared/protocol.js").Blip} Blip */
/** @typedef {import("../shared/protocol.js").BlipOp} BlipOp */
/** @typedef {import("../shared/protocol.js").Anchor} Anchor */
/** @typedef {import("../shared/protocol.js").WaveEvent} WaveEvent */
/** @typedef {import("../shared/protocol.js").EventKind} EventKind */
/** @typedef {import("../shared/protocol.js").Run} Run */
/** @typedef {import("../shared/protocol.js").RunOp} RunOp */
/** @typedef {import("../shared/protocol.js").AgentOutput} AgentOutput */
/** @typedef {import("../shared/protocol.js").RequestRecord} RequestRecord */
/** @typedef {import("../shared/protocol.js").OperationResult} OperationResult */
/** @typedef {import("../shared/protocol.js").OpError} OpError */
/** @typedef {import("../shared/protocol.js").Conflict} Conflict */
/** @typedef {import("../shared/protocol.js").WaveOperationEvent} WaveOperationEvent */
/** @typedef {import("../shared/protocol.js").TextEvent} TextEvent */
/** @typedef {import("../shared/protocol.js").WaveSnapshot} WaveSnapshot */
/** @typedef {import("../shared/protocol.js").ErrorResult} ErrorResult */
/** @typedef {import("../shared/protocol.js").ErrorCode} ErrorCode */
/** @typedef {import("./repository.js").Repository} Repository */
/** @typedef {import("./repository.js").Commit} Commit */
/** @typedef {import("./repository.js").UpdateRecord} UpdateRecord */
/** @typedef {import("./repository.js").TextRecord} TextRecord */
/** @typedef {import("./repository.js").BaseRecord} BaseRecord */

/** The Y.Text every blip's text lives in. */
export const TEXT_KEY = "t";
/** The name model output is attributed to. */
export const AGENT_NAME = "agent";
/** The note an interrupted run carries (README, "Restart"). */
export const RESTART_NOTE = "the server restarted during this run; retry to run it again";
const SERVER_ORIGIN = "server";
const encoder = new TextEncoder();

/**
 * @typedef {object} ModelClient
 * @property {(args: {prompt: string, systemPrompt: string}, options: {signal: AbortSignal}) => Promise<string>} run
 */

/**
 * @typedef {object} WaveOptions
 * @property {() => number} [now]
 * @property {(kind: "blip"|"run"|"history") => string} [newId]
 * @property {(event: WaveOperationEvent) => void} [onEvent]  called inside the queue after each commit
 * @property {(events: TextEvent[]) => void} [onText]         called inside the queue after each text commit
 * @property {(() => ModelClient|null)|null} [model]          evaluated per askAgent and per dispatch
 * @property {Partial<typeof LIMITS> & {runs?: Partial<typeof LIMITS.runs>, compaction?: Partial<typeof LIMITS.compaction>, cache?: Partial<typeof LIMITS.cache>}} [limits]
 * @property {{setTimeout: Function, clearTimeout: Function}} [timers]
 */

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
function clone(value) {
  return value == null ? value : structuredClone(value);
}

/** @param {ErrorCode} error @param {string} message @returns {ErrorResult} */
const fail = (error, message) => ({ error, message });

/** storedBytes per item, cached: records are never mutated once measured. */
const itemBytes = new WeakMap();
/** @param {object} item */
function bytesOf(item) {
  let n = itemBytes.get(item);
  if (n === undefined) itemBytes.set(item, n = storedBytes(item));
  return n;
}

/**
 * Drops the oldest items (keeping at least one) until storedBytes(list) fits `max`.
 * @template {object} T
 * @param {T[]} list @param {number} max
 * @returns {T[]}
 */
function trimToBytes(list, max) {
  const empty = storedBytes([]);
  const perItem = storedBytes([0]) - empty - storedBytes(0);
  let total = empty;
  for (const item of list) total += bytesOf(item) + perItem;
  let drop = 0;
  while (list.length - drop > 1 && total > max) total -= bytesOf(list[drop++]) + perItem;
  return drop ? list.slice(drop) : list;
}

/** @param {number} ms */
function iso(ms) {
  const d = new Date(Number.isFinite(ms) ? ms : 0);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 19).replace("T", " ") + " UTC";
}

/** @param {string} text  a Markdown block quote of the text */
function quoteBlock(text) {
  return text.split("\n").map((l) => "> " + l).join("\n");
}

/** @param {string} v */
const utf8Bytes = (v) => encoder.encode(v).length;

const newDoc = () => new Y.Doc({ gc: true });
/** @param {Y.Doc} doc */
const docText = (doc) => doc.getText(TEXT_KEY).toString();
/** @param {Y.Doc} doc */
const docState = (doc) => Y.encodeStateAsUpdateV2(doc);
/** @param {Y.Doc} doc */
function cloneDoc(doc) {
  const d = newDoc();
  Y.applyUpdateV2(d, docState(doc));
  return d;
}

/**
 * A base64 relative position re-encoded by Yjs' own parser, or null when it does not decode.
 * @param {string} pos
 */
function canonicalPosition(pos) {
  const bytes = decodeBytes(pos, LIMITS.caretBytes);
  if (!bytes || !bytes.length) return null;
  try {
    const rel = Y.decodeRelativePosition(bytes);
    if (!rel || typeof rel !== "object") return null;
    return encodeBytes(Y.encodeRelativePosition(rel));
  } catch {
    return null;
  }
}

/**
 * Validates an anchor for storage: "end" as is, "para" with its position re-encoded. Null when
 * the position is not a Yjs relative position.
 * @param {Anchor|null|undefined} anchor
 * @returns {Anchor|null}
 */
function storableAnchor(anchor) {
  if (!anchor) return null;
  if (anchor.type === "end") return { type: "end" };
  const pos = canonicalPosition(anchor.pos);
  return pos ? { type: "para", pos } : null;
}

/**
 * Upgrades stored meta to SCHEMA_VERSION and repairs its shape. Returns the same object when
 * nothing needed changing.
 * @param {any} meta
 * @param {number} at
 * @returns {WaveMeta}
 */
export function migrate(meta, at) {
  const m = isObject(meta) ? meta : {};
  const fixed = {
    schemaVersion: SCHEMA_VERSION,
    seq: cleanSeq(m.seq) ?? 0,
    title: cleanLine(m.title, LIMITS.title) || DEFAULT_TITLE,
    rootOrder: Array.isArray(m.rootOrder) ? m.rootOrder.filter(isBlipId) : [],
    participants: Array.isArray(m.participants) ? m.participants.filter((p) => isObject(p) && typeof p.id === "string") : [],
    earliestSeq: Math.max(1, cleanSeq(m.earliestSeq) ?? 1),
    retainedBytes: cleanSeq(m.retainedBytes) ?? 0,
    lastModified: typeof m.lastModified === "number" ? m.lastModified : at,
    template: isTemplateId(m.template) ? m.template : null,
  };
  for (const k of Object.keys(fixed)) {
    if (JSON.stringify(/** @type {any} */ (fixed)[k]) !== JSON.stringify(m[k])) return fixed;
  }
  return Object.keys(m).length === Object.keys(fixed).length ? /** @type {WaveMeta} */ (m) : fixed;
}

// ---------------------------------------------------------------------------------------------
// The factory
// ---------------------------------------------------------------------------------------------

/**
 * @param {Repository} repo
 * @param {WaveOptions} [options]
 */
export function createWave(repo, { now = Date.now, newId = protocolNewId, onEvent, onText, model = null, limits, timers } = {}) {
  /** @type {typeof LIMITS} */
  const L = {
    ...LIMITS, ...(limits ?? {}),
    runs: { ...LIMITS.runs, ...(limits?.runs ?? {}) },
    compaction: { ...LIMITS.compaction, ...(limits?.compaction ?? {}) },
    cache: { ...LIMITS.cache, ...(limits?.cache ?? {}) },
  };
  const clock = timers ?? {
    setTimeout: (/** @type {any} */ fn, /** @type {number} */ ms) => setTimeout(fn, ms),
    clearTimeout: (/** @type {any} */ t) => clearTimeout(t),
  };

  // --- Mutation queue ------------------------------------------------------------------------
  let queue = /** @type {Promise<unknown>} */ (Promise.resolve());
  let jobs = 0;
  /**
   * @template T
   * @param {() => Promise<T>|T} fn
   * @returns {Promise<T>}
   */
  function enqueue(fn) {
    jobs++;
    const result = queue.then(fn);
    queue = result.then(() => { jobs--; }, () => { jobs--; });
    return result;
  }

  /** @param {WaveOperationEvent|null} event */
  function emit(event) {
    if (!event || !onEvent) return;
    try { onEvent(event); } catch { /* a broken listener must not fail a committed write */ }
  }
  /** @param {TextEvent[]} events */
  function emitText(events) {
    if (!events.length || !onText) return;
    try { onText(events); } catch { /* as above */ }
  }

  // --- Cached state --------------------------------------------------------------------------
  /**
   * @typedef {object} State
   * @property {WaveMeta} meta
   * @property {Map<string, Blip>} blips
   * @property {Map<string, Run>} runs
   * @property {{seq: number, bytes: number}[]} events   retained events, ascending
   * @property {number} eventBytes
   * @property {Map<string, RequestRecord[]|null>} requests  null: has a record, not loaded yet
   */
  /** @type {State|null} */
  let state = null;

  /**
   * @typedef {object} DocEntry
   * @property {Y.Doc} doc
   * @property {number} lastTouched
   * @property {number} bytes        encoded state size, for the cache bound
   * @property {number} compactedSeq textSeq of the "text:" record it was hydrated from (0: none)
   */
  /** @type {Map<string, DocEntry>} insertion order = least recently touched first */
  const docs = new Map();
  let docBytes = 0;

  /** @param {string} id */
  function dropDoc(id) {
    const entry = docs.get(id);
    if (!entry) return;
    docs.delete(id);
    docBytes -= entry.bytes;
    try { entry.doc.destroy(); } catch { /* ignore */ }
  }

  function dropAllDocs() {
    for (const id of [...docs.keys()]) dropDoc(id);
  }

  /** Evicts idle docs, then least recently used ones beyond the bounds (never `keep`). @param {string} [keep] */
  function evictDocs(keep) {
    const at = now();
    for (const [id, entry] of [...docs]) {
      if (id !== keep && at - entry.lastTouched > L.cache.idleMs) dropDoc(id);
    }
    for (const id of [...docs.keys()]) {
      if (docs.size <= L.cache.docs && docBytes <= L.cache.bytes) break;
      if (id !== keep) dropDoc(id);
    }
  }

  /**
   * Hydrates a doc from storage: "text:<id>" then every "upd:" record after it.
   * @param {string} id
   * @returns {Promise<{doc: Y.Doc, compactedSeq: number}>}
   */
  async function hydrate(id) {
    const doc = newDoc();
    const text = await repo.getText(id);
    let compactedSeq = 0;
    if (text && text.state instanceof Uint8Array && text.state.length) {
      try { Y.applyUpdateV2(doc, text.state); } catch { /* a corrupt state: rebuilt from updates below */ }
      compactedSeq = cleanSeq(text.textSeq) ?? 0;
    }
    const updates = await repo.listUpdates(id, { fromSeq: compactedSeq + 1 });
    for (const rec of updates) {
      if (!(rec.update instanceof Uint8Array)) continue;
      try { Y.applyUpdateV2(doc, rec.update); } catch { /* skip a corrupt record */ }
    }
    return { doc, compactedSeq };
  }

  /**
   * The cached doc for a blip, hydrating on first touch. Moves it to the most recently used end.
   * @param {string} id
   * @returns {Promise<DocEntry>}
   */
  async function docFor(id) {
    let entry = docs.get(id);
    if (entry) {
      docs.delete(id);
      entry.lastTouched = now();
      docs.set(id, entry);
      return entry;
    }
    const { doc, compactedSeq } = await hydrate(id);
    const bytes = docState(doc).length;
    // A concurrent hydrate cannot happen (everything runs in the queue), but be safe.
    if (docs.has(id)) dropDoc(id);
    entry = { doc, lastTouched: now(), bytes, compactedSeq };
    docs.set(id, entry);
    docBytes += bytes;
    evictDocs(id);
    return entry;
  }

  /** @param {DocEntry} entry */
  function remeasure(entry) {
    const bytes = docState(entry.doc).length;
    docBytes += bytes - entry.bytes;
    entry.bytes = bytes;
  }

  /**
   * The text of a blip without necessarily caching its doc (reads for Markdown do not churn the
   * cache): the cached doc when present, else a throwaway hydration.
   * @param {string} id
   */
  async function textOf(id) {
    const entry = docs.get(id);
    if (entry) return docText(entry.doc);
    const { doc } = await hydrate(id);
    const text = docText(doc);
    doc.destroy();
    return text;
  }

  /** @returns {Promise<State>} */
  async function load() {
    if (state) return state;
    const at = now();
    const stored = await repo.getMeta();
    /** @type {WaveMeta} */
    let meta;
    if (!stored) {
      meta = {
        schemaVersion: SCHEMA_VERSION, seq: 0, title: DEFAULT_TITLE, rootOrder: [], participants: [],
        earliestSeq: 1, retainedBytes: 0, lastModified: at, template: null,
      };
      await repo.commit({ meta });
    } else {
      meta = migrate(stored, at);
      if (meta !== stored) await repo.commit({ meta });
    }
    const [blipsRaw, runsRaw, eventsRaw, senders] = await Promise.all([
      repo.getBlips(), repo.getRuns(), repo.listEvents(), repo.listRequestSenders(),
    ]);
    const blips = new Map(Object.entries(blipsRaw));
    const runs = new Map(runsRaw.map((r) => [r.id, r]));
    const events = eventsRaw.map((e) => ({ seq: e.seq, bytes: storedBytes(e) }));
    /** @type {State} */
    const s = {
      meta, blips, runs, events, eventBytes: events.reduce((n, e) => n + e.bytes, 0),
      requests: new Map(senders.map((id) => [id, null])),
    };
    state = s;

    // Restart handling: a run that was running when the previous instance died cannot finish.
    const interrupted = [...runs.values()].filter((r) => r.state === "running");
    if (interrupted.length) {
      const txn = beginTxn(s, { senderId: "", by: AGENT_NAME, at });
      for (const run of interrupted) {
        const next = { ...run, state: /** @type {Run["state"]} */ ("unknown"), generation: run.generation + 1, finishedAt: at, error: RESTART_NOTE };
        txn.runs.set(run.id, next);
        txn.event("run.unknown", { runId: run.id, detail: RUN_OP_LABELS[run.op] ?? run.op });
      }
      await commitTxn(txn, {});
    }
    if ([...runs.values()].some((r) => r.state === "queued")) kick();
    return s;
  }

  // --- Snapshots and reads -------------------------------------------------------------------

  function modelAvailable() {
    try { return typeof model === "function" && model() != null; } catch { return false; }
  }

  /** @param {State} s @returns {Run[]} the most recent runs, oldest first */
  function recentRuns(s) {
    return [...s.runs.values()].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1)).slice(-L.runs.keep);
  }

  /** @param {State} s @returns {WaveSnapshot} */
  function snapshot(s) {
    return clone({
      meta: s.meta, blips: Object.fromEntries(s.blips), runs: recentRuns(s), seq: s.meta.seq,
      capabilities: { model: modelAvailable() },
    });
  }

  /**
   * Ids in tree order under `rootId` (or every root when null): each parent before its replies,
   * siblings by order. Deleted blips (and their subtrees) are skipped unless `all`.
   * @param {Map<string, Blip>} blips @param {string|null} rootId @param {boolean} [all]
   * @returns {Blip[]}
   */
  function treeOrder(blips, rootId, all = false) {
    /** @type {Map<string|null, Blip[]>} */
    const children = new Map();
    for (const b of blips.values()) {
      if (!all && b.deleted) continue;
      const parent = b.parentId !== null && blips.has(b.parentId) ? b.parentId : null;
      let list = children.get(parent);
      if (!list) children.set(parent, list = []);
      list.push(b);
    }
    for (const list of children.values()) list.sort(compareBlips);
    /** @type {Blip[]} */
    const out = [];
    /** @type {string[]} */
    const stack = [];
    if (rootId === null) {
      for (const b of (children.get(null) ?? []).slice().reverse()) stack.push(b.id);
    } else if (blips.has(rootId) && (all || !blips.get(rootId)?.deleted)) {
      stack.push(rootId);
    }
    while (stack.length) {
      const id = /** @type {string} */ (stack.pop());
      const b = blips.get(id);
      if (!b) continue;
      out.push(b);
      const kids = children.get(id) ?? [];
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i].id);
    }
    return out;
  }

  /** @param {Map<string, Blip>} blips @param {string} id */
  function depthIn(blips, id) {
    let depth = 1;
    let cur = blips.get(id);
    while (cur && cur.parentId !== null && blips.has(cur.parentId) && depth < 10_000) {
      depth++;
      cur = blips.get(cur.parentId);
    }
    return depth;
  }

  // --- Markdown ------------------------------------------------------------------------------

  /**
   * One blip as a Markdown section: a heading with its id as an anchor, its kind, author and
   * time, then its content. Replies nest by heading level (capped at 6) with a "↳" per level.
   * @param {Blip} blip @param {string} text @param {number} depth @param {string} [note]
   */
  function blipSection(blip, text, depth, note) {
    const level = Math.min(2 + Math.max(1, depth), 6);
    const marks = depth > 1 ? "↳ ".repeat(depth - 1) : "";
    let label = /** @type {string} */ (blip.kind);
    if (blip.kind === "proposal" && blip.proposal) label = `proposal (${blip.proposal.state}) for [${blip.proposal.targetId}]`;
    else if (blip.kind === "decision" && blip.decision) label = `decision (recorded by ${blip.decision.recordedBy}, unverified)`;
    else if (blip.kind === "agent") label = `agent${blip.runId ? " · run " + blip.runId : ""}`;
    const lines = [`${"#".repeat(level)} ${marks}[${blip.id}] ${label} · ${blip.by} · ${iso(blip.updatedAt)}`];
    if (note) lines.push("", `_${note}_`);
    const body = text.trim();
    if (blip.kind === "proposal" && blip.proposal) {
      const p = blip.proposal;
      lines.push("", `**Summary**: ${p.summary || body.split("\n")[0] || "(none)"}`);
      if (body && body !== p.summary) lines.push("", body);
      lines.push("", "**Quote**:", "", p.quote ? quoteBlock(p.quote) : "> (the whole text)");
      lines.push("", "**Replacement**:", "", quoteBlock(p.replacement));
      lines.push("", `**Sources**: ${p.sources.length ? p.sources.map((id) => `[${id}]`).join(", ") : "none"}`);
      if (p.reviewedBy) lines.push("", `**Reviewed by**: ${p.reviewedBy} (unverified)${p.reviewedAt ? " · " + iso(p.reviewedAt) : ""}`);
    } else if (blip.kind === "decision" && blip.decision) {
      const d = blip.decision;
      lines.push("", body || "(empty)");
      if (d.rationale) lines.push("", "**Rationale**:", "", d.rationale);
      if (d.dissent) lines.push("", "**Dissent**:", "", d.dissent);
      if (d.nextSteps) lines.push("", "**Next steps**:", "", d.nextSteps);
      if (d.supersedes) lines.push("", `**Supersedes**: [${d.supersedes}]`);
      if (d.supersededBy) lines.push("", `**Superseded by**: [${d.supersededBy}]`);
    } else {
      lines.push("", body || "(empty)");
    }
    return lines.join("\n");
  }

  /**
   * The Wave (or a subset) as Markdown sections in tree order, each blip's text read from its
   * doc. `include` limits the blips whose text is shown (others are skipped entirely unless in
   * `context`, which shows them marked as context). `budget` (UTF-8 bytes) stops the walk; the
   * ids left out are returned.
   * @param {State} s
   * @param {{rootId?: string|null, include?: Set<string>|null, context?: Set<string>|null, budget?: number, header?: string}} options
   * @returns {Promise<{markdown: string, included: string[], omitted: string[], bytes: number, cut: boolean}>}
   */
  async function renderMarkdown(s, { rootId = null, include = null, context = null, budget = L.exportBytes, header = "" }) {
    const parts = header ? [header] : [];
    let bytes = utf8Bytes(header);
    /** @type {string[]} */
    const included = [];
    /** @type {string[]} */
    const omitted = [];
    let cut = false;
    for (const blip of treeOrder(s.blips, rootId)) {
      const inInclude = !include || include.has(blip.id);
      const isContext = !inInclude && (context?.has(blip.id) ?? false);
      if (!inInclude && !isContext) continue;
      if (cut) { omitted.push(blip.id); continue; }
      const section = blipSection(blip, await textOf(blip.id), depthIn(s.blips, blip.id), isContext ? "(context: unchanged)" : undefined);
      const size = utf8Bytes(section) + 2;
      if (bytes + size > budget) { cut = true; omitted.push(blip.id); continue; }
      parts.push(section);
      bytes += size;
      included.push(blip.id);
    }
    return { markdown: parts.join("\n\n"), included, omitted, bytes, cut };
  }

  /** @param {State} s @param {string} [subtitle] */
  function waveHeader(s, subtitle) {
    const lines = [`# ${s.meta.title}`, "", `_Wave at sequence ${s.meta.seq}${s.meta.template ? ", template " + s.meta.template : ""}. Blip ids in square brackets are anchors; cite them as [b_…]._`];
    if (subtitle) lines.push("", `_${subtitle}_`);
    return lines.join("\n");
  }

  /**
   * getWaveMarkdown: the whole Wave, one thread, or only what changed after sinceSeq (ancestors
   * as context).
   * @param {State} s @param {any} args
   */
  async function waveMarkdown(s, args) {
    const a = isObject(args) ? args : {};
    const sinceSeq = cleanSeq(a.sinceSeq);
    const threadId = isBlipId(a.threadId) && s.blips.has(a.threadId) ? rootOf(a.threadId, Object.fromEntries(s.blips)) : null;
    /** @type {Set<string>|null} */
    let include = null;
    /** @type {Set<string>|null} */
    let context = null;
    if (sinceSeq !== null) {
      include = new Set();
      context = new Set();
      for (const b of s.blips.values()) {
        if (b.deleted || b.seq <= sinceSeq) continue;
        include.add(b.id);
        let cur = b.parentId !== null ? s.blips.get(b.parentId) : undefined;
        for (let guard = 0; cur && guard < 10_000; guard++) {
          if (!include.has(cur.id)) context.add(cur.id);
          cur = cur.parentId !== null ? s.blips.get(cur.parentId) : undefined;
        }
      }
      for (const id of include) context.delete(id);
    }
    const subtitle = sinceSeq !== null ? `Changes after sequence ${sinceSeq}; unchanged parents shown as context.` : threadId ? `Thread [${threadId}].` : undefined;
    const r = await renderMarkdown(s, { rootId: threadId, include, context, budget: L.exportBytes, header: waveHeader(s, subtitle) });
    return r.cut ? r.markdown + `\n\n_(Cut at ${Math.round(L.exportBytes / 1024)} KiB; ${r.omitted.length} blips left out.)_` : r.markdown;
  }

  /**
   * exportMarkdown: the Wave as a document, or decision records only.
   * @param {State} s @param {any} args
   */
  async function exportMarkdownOf(s, args) {
    const decisionsOnly = isObject(args) && args.decisions === true;
    if (!decisionsOnly) {
      const r = await renderMarkdown(s, { budget: L.exportBytes, header: waveHeader(s) });
      return r.cut ? r.markdown + `\n\n_(Cut at ${Math.round(L.exportBytes / 1024)} KiB; ${r.omitted.length} blips left out.)_` : r.markdown;
    }
    const all = Object.fromEntries(s.blips);
    const decisions = [...s.blips.values()]
      .filter((b) => b.kind === "decision" && b.decision && !b.deleted)
      .sort((a, b) => (a.decision?.recordedAt ?? 0) - (b.decision?.recordedAt ?? 0) || a.seq - b.seq);
    const brief = [...s.blips.values()].filter((b) => b.kind === "brief" && !b.deleted).sort(compareBlips)[0] ?? null;
    const briefText = brief ? await textOf(brief.id) : "";
    const parts = [`# Decisions: ${s.meta.title}`, "", `_${decisions.length} decision${decisions.length === 1 ? "" : "s"} at sequence ${s.meta.seq}. Names are unverified._`];
    let bytes = utf8Bytes(parts.join("\n"));
    let cut = false;
    for (const d of decisions) {
      const dec = /** @type {import("../shared/protocol.js").Decision} */ (d.decision);
      const text = await textOf(d.id);
      const rootId = rootOf(d.id, all);
      const root = s.blips.get(rootId);
      const rootText = root && root.id !== brief?.id ? await textOf(rootId) : "";
      const lines = [
        `## Decision: ${firstLine(text, 120) || d.id}`,
        "",
        `[${d.id}] recorded by ${dec.recordedBy} (unverified) · ${iso(dec.recordedAt)} · thread [${rootId}] · status: ${dec.supersededBy ? `superseded by [${dec.supersededBy}]` : "current"}${dec.supersedes ? ` · supersedes [${dec.supersedes}]` : ""}`,
        "",
        "### Context",
        "",
      ];
      if (briefText.trim()) lines.push(`Brief [${brief?.id}]:`, "", quoteBlock(briefText.trim()), "");
      if (rootText.trim()) lines.push(`Thread [${rootId}]:`, "", quoteBlock(rootText.trim()), "");
      if (!briefText.trim() && !rootText.trim()) lines.push("(none)", "");
      // Options: the thread's direct replies other than the decision itself, one line each.
      const options = root ? [...s.blips.values()].filter((b) => b.parentId === root.id && !b.deleted && b.id !== d.id && b.kind !== "decision").sort(compareBlips) : [];
      lines.push("### Options considered", "");
      if (options.length) {
        for (const o of options) {
          const first = firstLine(await textOf(o.id), 160) || "(empty)";
          const state = o.kind === "proposal" && o.proposal ? ` (proposal, ${o.proposal.state})` : o.kind === "agent" ? " (agent)" : "";
          lines.push(`- [${o.id}]${state}: ${first}`);
        }
      } else {
        lines.push("(none recorded in the thread)");
      }
      lines.push("", "### Decision", "", text.trim() || "(empty)");
      lines.push("", "### Rationale", "", dec.rationale || "(none)");
      lines.push("", "### Dissent", "", dec.dissent || "(none)");
      lines.push("", "### Next steps", "", dec.nextSteps || "(none)");
      const cited = new Set([rootId, ...citedBlipIds([text, dec.rationale, dec.dissent, dec.nextSteps].join("\n"))]);
      if (brief) cited.add(brief.id);
      lines.push("", "### Sources", "", [...cited].map((id) => `[${id}]`).join(", "));
      const section = lines.join("\n");
      const size = utf8Bytes(section) + 2;
      if (bytes + size > L.exportBytes) { cut = true; break; }
      parts.push("", section);
      bytes += size;
    }
    if (!decisions.length) parts.push("", "No decision has been recorded yet.");
    if (cut) parts.push("", `_(Cut at ${Math.round(L.exportBytes / 1024)} KiB.)_`);
    return parts.join("\n");
  }

  // --- Request records (idempotency) ---------------------------------------------------------

  /** @param {unknown} v */
  const cleanSender = (v) => (typeof v === "string" || typeof v === "number" ? cleanLine(v, 64) : "");

  /**
   * @param {State} s @param {string} senderId
   * @returns {Promise<RequestRecord[]>}
   */
  async function requestsFor(s, senderId) {
    const cached = s.requests.get(senderId);
    if (cached) return cached;
    if (cached === undefined) return [];
    const loaded = await repo.getRequests(senderId);
    const list = Array.isArray(loaded) ? loaded.filter((r) => isObject(r) && isRequestId(r.requestId)) : [];
    s.requests.set(senderId, list);
    return list;
  }

  /**
   * @param {State} s @param {string} senderId @param {string} requestId
   * @returns {Promise<RequestRecord|null>}
   */
  async function findRecord(s, senderId, requestId) {
    const list = await requestsFor(s, senderId);
    return list.find((r) => r.requestId === requestId) ?? null;
  }

  /**
   * The sender's list with `record` appended (replacing an older record of the same id), bounded.
   * @param {State} s @param {string} senderId @param {RequestRecord} record
   */
  async function withRecord(s, senderId, record) {
    const list = await requestsFor(s, senderId);
    const next = [...list.filter((r) => r.requestId !== record.requestId), record];
    return trimToBytes(next.slice(Math.max(0, next.length - L.requestRecords)), L.requestRecordBytes);
  }

  /**
   * Sender ids to drop so that a new sender fits LIMITS.requestSenders: the least recently
   * written ones. Loads unloaded lists only when eviction is needed (rare).
   * @param {State} s @param {string} senderId
   * @returns {Promise<string[]>}
   */
  async function sendersToEvict(s, senderId) {
    if (s.requests.has(senderId) || s.requests.size < L.requestSenders) return [];
    /** @type {{id: string, at: number}[]} */
    const ages = [];
    for (const id of s.requests.keys()) {
      const list = await requestsFor(s, id);
      ages.push({ id, at: list.length ? list[list.length - 1].at : 0 });
    }
    ages.sort((a, b) => a.at - b.at);
    return ages.slice(0, s.requests.size - L.requestSenders + 1).map((a) => a.id);
  }

  // --- Transactions --------------------------------------------------------------------------

  /**
   * @typedef {object} Txn
   * @property {State} s
   * @property {string} senderId
   * @property {string} by
   * @property {number} at
   * @property {number} seq                          the last assigned sequence
   * @property {Map<string, Blip>} upserts
   * @property {WaveEvent[]} events
   * @property {UpdateRecord[]} putUpdates
   * @property {Map<string, TextRecord>} putText
   * @property {BaseRecord[]} putBase
   * @property {{blipId: string, seq: number}[]} deleteUpdates
   * @property {Map<string, Run>} runs
   * @property {string[]} deleteRuns
   * @property {TextEvent[]} textEvents
   * @property {Partial<WaveMeta>} metaPatch
   * @property {number} retainedDelta
   * @property {Set<string>} bumped                   blips whose version this request bumped
   * @property {(id: string) => Blip|undefined} get
   * @property {(blip: Blip) => void} put
   * @property {(kind: EventKind, fields?: Partial<WaveEvent>) => WaveEvent} event
   */

  /**
   * @param {State} s @param {{senderId: string, by: string, at: number}} who
   * @returns {Txn}
   */
  function beginTxn(s, { senderId, by, at }) {
    /** @type {Txn} */
    const txn = {
      s, senderId, by, at, seq: s.meta.seq, upserts: new Map(), events: [], putUpdates: [], putText: new Map(), putBase: [],
      deleteUpdates: [], runs: new Map(), deleteRuns: [], textEvents: [], metaPatch: {}, retainedDelta: 0, bumped: new Set(),
      get: (id) => txn.upserts.get(id) ?? s.blips.get(id),
      put: (blip) => { txn.upserts.set(blip.id, blip); },
      event: (kind, fields = {}) => {
        /** @type {WaveEvent} */
        const ev = { seq: ++txn.seq, at, by, kind, ...fields };
        if (ev.detail !== undefined) {
          const detail = cleanLine(ev.detail, L.eventDetail);
          if (detail) ev.detail = detail; else delete ev.detail;
        }
        txn.events.push(ev);
        return ev;
      },
    };
    return txn;
  }

  /**
   * Bumps a blip's version once per request and returns the record to modify.
   * @param {Txn} txn @param {Blip} blip @param {number} seq
   * @returns {Blip}
   */
  function touched(txn, blip, seq) {
    const next = { ...blip, seq, updatedAt: txn.at };
    if (!txn.bumped.has(blip.id)) {
      txn.bumped.add(blip.id);
      next.version = blip.version + 1;
    }
    return next;
  }

  /** @param {Txn} txn @param {Blip} blip @param {number} baseVersion */
  function versionMatches(txn, blip, baseVersion) {
    if (baseVersion === blip.version) return true;
    return txn.bumped.has(blip.id) && baseVersion === blip.version - 1;
  }

  /**
   * Records a committed text update on a blip: the "upd:" record, the "text" event, the blip's
   * text fields and log, compaction when due, and (when `broadcast`) the TextEvent for
   * subscribers. `doc` is the blip's cached doc AFTER the update was applied.
   *
   * The TextEvent's senderId is empty unless `fromClient` (pushText: the update is the client's
   * own, so it may treat the event as its echo). Text the server makes (an accepted proposal's
   * replacement, a seed) is new to every client, the requester included, so it carries none.
   * @param {Txn} txn @param {Blip} blip @param {Uint8Array} update @param {DocEntry} entry
   * @param {{by?: string, fromClient?: boolean, broadcast: boolean}} options
   * @returns {Blip}
   */
  function addTextUpdate(txn, blip, update, entry, { by = txn.by, fromClient = false, broadcast }) {
    const senderId = fromClient ? txn.senderId : "";
    const ev = txn.event("text", { blipId: blip.id, by, bytes: update.length });
    /** @type {UpdateRecord} */
    const rec = { blipId: blip.id, seq: ev.seq, by, at: txn.at, update };
    const recBytes = storedBytes(rec);
    txn.putUpdates.push(rec);
    txn.retainedDelta += recBytes;
    const text = docText(entry.doc);
    const log = {
      count: blip.log.count + 1, bytes: blip.log.bytes + recBytes,
      sinceCompaction: blip.log.sinceCompaction + 1, sinceCompactionBytes: blip.log.sinceCompactionBytes + recBytes,
    };
    /** @type {Blip} */
    const next = { ...blip, seq: ev.seq, textSeq: ev.seq, updatedAt: txn.at, textChars: text.length, preview: previewOf(text), log };
    if (log.sinceCompaction >= L.compaction.updates || log.sinceCompactionBytes >= L.compaction.bytes) {
      txn.putText.set(blip.id, { id: blip.id, textSeq: ev.seq, state: docState(entry.doc) });
      next.log = { ...log, sinceCompaction: 0, sinceCompactionBytes: 0 };
    }
    remeasure(entry);
    if (broadcast) {
      txn.textEvents.push({ blipId: blip.id, senderId, seq: ev.seq, prevTextSeq: blip.textSeq, textSeq: ev.seq, update: encodeBytes(update) });
    }
    txn.put(next);
    return next;
  }

  /**
   * A new blip record (no text yet).
   * @param {Txn} txn @param {{id: string, parentId: string|null, anchor: Anchor|null, kind: Blip["kind"], order: string, by?: string, seq: number}} f
   * @returns {Blip}
   */
  function newBlip(txn, { id, parentId, anchor, kind, order, by = txn.by, seq }) {
    return {
      id, parentId, anchor, kind, order, by, createdAt: txn.at, updatedAt: txn.at, version: 1, seq, textSeq: 0, textChars: 0,
      log: { count: 0, bytes: 0, sinceCompaction: 0, sinceCompactionBytes: 0 }, deleted: false, locked: false, preview: "",
    };
  }

  /**
   * Seeds a new blip's text in the same commit (a "text" event and update record, no broadcast:
   * the create upsert carries textSeq and preview, and openers fetch the state).
   * @param {Txn} txn @param {Blip} blip @param {string} text @param {string} [by]
   * @returns {Blip}
   */
  function seedText(txn, blip, text, by) {
    if (!text) return blip;
    const doc = newDoc();
    doc.getText(TEXT_KEY).insert(0, text);
    const update = docState(doc);
    if (docs.has(blip.id)) dropDoc(blip.id);
    /** @type {DocEntry} */
    const entry = { doc, lastTouched: txn.at, bytes: update.length, compactedSeq: 0 };
    docs.set(blip.id, entry);
    docBytes += update.length;
    evictDocs(blip.id);
    return addTextUpdate(txn, blip, update, entry, { by, broadcast: false });
  }

  /** The order key after the last sibling under `parentId`. @param {Txn} txn @param {string|null} parentId */
  function lastOrder(txn, parentId) {
    let last = null;
    for (const raw of txn.s.blips.values()) {
      const b = txn.get(raw.id) ?? raw;
      if (b.parentId === parentId && (last === null || b.order > last)) last = b.order;
    }
    for (const b of txn.upserts.values()) {
      if (b.parentId === parentId && (last === null || b.order > last)) last = b.order;
    }
    try { return keyBetween(last, null); } catch { return keyBetween(null, null); }
  }

  /**
   * The parent a reply attaches to so that it sits no deeper than LIMITS.replyDepth: the given
   * parent, or its ancestor at depth replyDepth - 1. Returns the parent id and whether it moved.
   * @param {Txn} txn @param {string} parentId
   */
  function clampParent(txn, parentId) {
    const view = new Map(txn.s.blips);
    for (const b of txn.upserts.values()) view.set(b.id, b);
    let id = parentId;
    let depth = depthIn(view, id);
    while (depth >= L.replyDepth) {
      const p = view.get(id)?.parentId;
      if (p === null || p === undefined || !view.has(p)) break;
      id = p;
      depth--;
    }
    return { parentId: id, clamped: id !== parentId, anchor: id !== parentId ? /** @type {Anchor} */ ({ type: "end" }) : null };
  }

  /** @param {Txn} txn @param {string} id @param {string} candidateParent  true when candidateParent is id or below it */
  function isDescendant(txn, id, candidateParent) {
    let cur = txn.get(candidateParent);
    for (let guard = 0; cur && guard < 10_000; guard++) {
      if (cur.id === id) return true;
      cur = cur.parentId !== null ? txn.get(cur.parentId) : undefined;
    }
    return false;
  }

  /**
   * Retention trimming, at most LIMITS.trimBlipsPerCommit blips per commit: folds the oldest
   * retained updates of the largest blip into its "base:" when the blip or the Wave is over cap.
   * Updates added by this transaction are not in storage yet and are never folded.
   * @param {Txn} txn @param {number} retained  meta.retainedBytes after this transaction
   * @returns {Promise<{retained: number, earliestSeq: number}>}
   */
  async function trimRetention(txn, retained) {
    let earliestSeq = txn.s.meta.earliestSeq;
    for (let n = 0; n < L.trimBlipsPerCommit; n++) {
      /** @type {Blip|null} */
      let largest = null;
      for (const raw of txn.s.blips.values()) {
        const b = txn.get(raw.id) ?? raw;
        if (b.log.count > 0 && (!largest || b.log.bytes > largest.log.bytes)) largest = b;
      }
      for (const b of txn.upserts.values()) {
        if (b.log.count > 0 && (!largest || b.log.bytes > largest.log.bytes)) largest = b;
      }
      if (!largest) break;
      const overBlip = largest.log.bytes > L.updBytesPerBlip;
      const overWave = retained > L.updBytesPerWave;
      if (!overBlip && !overWave) break;
      const need = Math.max(
        overBlip ? largest.log.bytes - L.updBytesPerBlip / 2 : 0,
        overWave ? retained - (L.updBytesPerWave * 3) / 4 : 0,
      );
      const stored = await repo.listUpdates(largest.id);
      /** @type {UpdateRecord[]} */
      const fold = [];
      let folded = 0;
      for (const rec of stored) {
        if (folded >= need) break;
        fold.push(rec);
        folded += storedBytes(rec);
      }
      if (!fold.length) break;
      const base = await repo.getBase(largest.id);
      const scratch = newDoc();
      if (base && base.state instanceof Uint8Array && base.state.length) {
        try { Y.applyUpdateV2(scratch, base.state); } catch { /* corrupt base: start empty */ }
      }
      for (const rec of fold) {
        try { Y.applyUpdateV2(scratch, rec.update); } catch { /* skip */ }
      }
      const lastSeq = fold[fold.length - 1].seq;
      txn.putBase.push({ id: largest.id, seq: lastSeq, state: docState(scratch) });
      scratch.destroy();
      for (const rec of fold) txn.deleteUpdates.push({ blipId: rec.blipId, seq: rec.seq });
      retained -= folded;
      /** @type {Blip} */
      const next = { ...largest, log: { ...largest.log, count: largest.log.count - fold.length, bytes: largest.log.bytes - folded } };
      // Hydration must never need a folded update: the compacted state must be at or past the base.
      const entry = await docFor(largest.id);
      const compactedAt = txn.putText.get(largest.id)?.textSeq ?? entry.compactedSeq;
      if (compactedAt < lastSeq) {
        txn.putText.set(largest.id, { id: largest.id, textSeq: next.textSeq, state: docState(entry.doc) });
        next.log = { ...next.log, sinceCompaction: 0, sinceCompactionBytes: 0 };
      }
      txn.put(next);
      earliestSeq = Math.max(earliestSeq, lastSeq);
    }
    return { retained, earliestSeq };
  }

  /**
   * Commits a transaction: retention, event retention, the request record, the repository
   * write, the cached state, then the listeners. A transaction with no events (nothing changed)
   * writes only the request record. Never called concurrently: everything is in the queue.
   * @param {Txn} txn
   * @param {{requestId?: string|null, method?: RequestRecord["method"], outcome?: unknown}} record
   * @returns {Promise<{changed: boolean, seq: number, meta: Partial<WaveMeta>|null}>}
   */
  async function commitTxn(txn, { requestId = null, method, outcome }) {
    const s = txn.s;
    if (txn.events.length === 0) {
      if (requestId && method) {
        const record = clone({ requestId, seq: s.meta.seq, at: txn.at, method, outcome: outcome ?? null });
        const evict = await sendersToEvict(s, txn.senderId);
        const records = await withRecord(s, txn.senderId, record);
        try {
          await repo.commit({ putRequests: [{ senderId: txn.senderId, records }], ...(evict.length ? { deleteRequests: evict } : {}) });
        } catch (e) {
          state = null;
          dropAllDocs();
          throw e;
        }
        for (const id of evict) s.requests.delete(id);
        s.requests.set(txn.senderId, records);
      }
      return { changed: false, seq: s.meta.seq, meta: null };
    }

    // Retention of text updates, then of events.
    let retained = s.meta.retainedBytes + txn.retainedDelta;
    let earliestSeq = s.meta.earliestSeq;
    if (txn.putUpdates.length || retained > L.updBytesPerWave) {
      const r = await trimRetention(txn, retained);
      retained = r.retained;
      earliestSeq = r.earliestSeq;
    }
    const events = [...s.events, ...txn.events.map((e) => ({ seq: e.seq, bytes: storedBytes(e) }))];
    let eventBytes = s.eventBytes + events.slice(s.events.length).reduce((n, e) => n + e.bytes, 0);
    /** @type {number[]} */
    const deleteEvents = [];
    while (events.length > 1 && (events.length > L.events || eventBytes > L.eventBytes)) {
      const dropped = /** @type {{seq: number, bytes: number}} */ (events.shift());
      eventBytes -= dropped.bytes;
      deleteEvents.push(dropped.seq);
    }
    if (deleteEvents.length && events.length) earliestSeq = Math.max(earliestSeq, events[0].seq);

    // Meta.
    const view = new Map(s.blips);
    for (const b of txn.upserts.values()) view.set(b.id, b);
    const rootOrder = [...view.values()].filter((b) => b.parentId === null && !b.deleted).sort(compareBlips).map((b) => b.id);
    /** @type {WaveMeta} */
    const meta = { ...s.meta, ...txn.metaPatch, seq: txn.seq, lastModified: txn.at, rootOrder, retainedBytes: retained, earliestSeq };
    /** @type {Partial<WaveMeta>} */
    const metaDelta = { seq: meta.seq, lastModified: meta.lastModified };
    for (const key of /** @type {(keyof WaveMeta)[]} */ (["title", "template", "participants", "rootOrder", "earliestSeq", "retainedBytes"])) {
      if (JSON.stringify(meta[key]) !== JSON.stringify(s.meta[key])) /** @type {any} */ (metaDelta)[key] = clone(meta[key]);
    }

    // Runs beyond the kept count: drop the oldest finished ones.
    const runView = new Map(s.runs);
    for (const r of txn.runs.values()) runView.set(r.id, r);
    for (const id of txn.deleteRuns) runView.delete(id);
    const deleteRuns = [...txn.deleteRuns];
    const sorted = [...runView.values()].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
    for (const r of sorted) {
      if (runView.size <= L.runs.keep) break;
      if (r.state === "queued" || r.state === "running") continue;
      runView.delete(r.id);
      deleteRuns.push(r.id);
    }

    // Request record.
    /** @type {RequestRecord[]|null} */
    let records = null;
    /** @type {string[]} */
    let evict = [];
    if (requestId && method) {
      evict = await sendersToEvict(s, txn.senderId);
      records = await withRecord(s, txn.senderId, clone({ requestId, seq: meta.seq, at: txn.at, method, outcome: outcome ?? null }));
    }

    /** @type {Commit} */
    const commit = { meta, putEvents: txn.events };
    if (txn.upserts.size) commit.putBlips = [...txn.upserts.values()];
    if (txn.putText.size) commit.putText = [...txn.putText.values()];
    if (txn.putBase.length) commit.putBase = txn.putBase;
    if (txn.putUpdates.length) commit.putUpdates = txn.putUpdates;
    if (txn.deleteUpdates.length) commit.deleteUpdates = txn.deleteUpdates;
    if (deleteEvents.length) commit.deleteEvents = deleteEvents;
    if (txn.runs.size) commit.putRuns = [...txn.runs.values()].filter((r) => runView.has(r.id));
    if (deleteRuns.length) commit.deleteRuns = deleteRuns;
    if (records) commit.putRequests = [{ senderId: txn.senderId, records }];
    if (evict.length) commit.deleteRequests = evict;
    try {
      await repo.commit(commit);
    } catch (e) {
      // The cache may have doc changes that were never stored: drop everything and reload.
      state = null;
      dropAllDocs();
      throw e;
    }

    // Apply to the cached state.
    s.meta = meta;
    for (const b of txn.upserts.values()) s.blips.set(b.id, b);
    s.runs = runView;
    s.events = events;
    s.eventBytes = eventBytes;
    for (const [id, text] of txn.putText) {
      const entry = docs.get(id);
      if (entry) entry.compactedSeq = text.textSeq;
    }
    if (records) {
      for (const id of evict) s.requests.delete(id);
      s.requests.set(txn.senderId, records);
    }

    // Listeners: text first (so a client advances textSeq before it sees the blip upsert).
    emitText(clone(txn.textEvents));
    /** @type {WaveOperationEvent} */
    const event = clone({
      type: "operation", senderId: txn.senderId, seq: meta.seq, upserts: [...txn.upserts.values()],
      deletes: txn.events.filter((e) => e.kind === "blip.delete" && e.blipId).map((e) => /** @type {string} */ (e.blipId)),
      meta: metaDelta, events: txn.events, ...(txn.runs.size ? { runs: [...txn.runs.values()].filter((r) => runView.has(r.id)) } : {}),
    });
    emit(event);
    return { changed: true, seq: meta.seq, meta: metaDelta };
  }

  // --- applyOperation ------------------------------------------------------------------------

  /**
   * @param {any} rawReq
   * @returns {Promise<OperationResult>}
   */
  async function applyOperationLocked(rawReq) {
    const s = await load();
    const req = isObject(rawReq) ? rawReq : {};
    const requestId = isRequestId(req.requestId) ? req.requestId : null;
    const senderId = cleanSender(req.senderId);
    const by = cleanName(req.by, DEFAULT_NAME);
    const at = now();

    if (requestId) {
      const rec = await findRecord(s, senderId, requestId);
      if (rec && rec.method === "applyOperation") {
        const o = /** @type {any} */ (isObject(rec.outcome) ? rec.outcome : {});
        return clone({
          status: o.status ?? "unchanged", seq: s.meta.seq, upserts: [], deletes: [], meta: null, events: [],
          conflicts: (Array.isArray(o.conflicts) ? o.conflicts : []).map((/** @type {string} */ id) => ({ blipId: id, current: s.blips.get(id) ?? null })),
          errors: Array.isArray(o.errors) ? o.errors : [], duplicate: true,
        });
      }
    }

    const txn = beginTxn(s, { senderId, by, at });
    /** @type {OpError[]} */
    const errors = [];
    /** @type {Conflict[]} */
    const conflicts = [];
    let blipCount = s.blips.size;

    // ---- blipOps ----
    const rawOps = Array.isArray(req.blipOps) ? req.blipOps : [];
    if (rawOps.length > L.opsPerRequest) errors.push({ index: -1, code: "limit", message: `at most ${L.opsPerRequest} blipOps per request` });
    for (let i = 0; i < Math.min(rawOps.length, L.opsPerRequest); i++) {
      const cleaned = cleanBlipOp(rawOps[i]);
      if (!cleaned.ok) { errors.push({ index: i, code: cleaned.code, message: cleaned.message }); continue; }
      const op = cleaned.op;
      const existing = txn.get(op.blipId);
      switch (op.op) {
        case "create": {
          if (existing) { errors.push({ index: i, code: "exists", message: "blipId already exists" }); break; }
          if (blipCount >= L.blips) { errors.push({ index: i, code: "limit", message: `at most ${L.blips} blips` }); break; }
          let parentId = op.parentId;
          /** @type {Anchor|null} */
          let anchor = null;
          if (parentId !== null) {
            const parent = txn.get(parentId);
            if (!parent) { errors.push({ index: i, code: "unknown_blip", message: "parentId does not exist" }); break; }
            if (parent.deleted) { errors.push({ index: i, code: "invalid_ref", message: "parentId is deleted" }); break; }
            anchor = storableAnchor(op.anchor ?? { type: "end" });
            if (!anchor) { errors.push({ index: i, code: "invalid_ref", message: "anchor position does not decode" }); break; }
            const c = clampParent(txn, parentId);
            if (c.clamped) { parentId = c.parentId; anchor = { type: "end" }; }
          }
          const ev = txn.event("blip.create", { blipId: op.blipId, detail: op.text ? previewOf(op.text) : op.kind ?? "note" });
          let blip = newBlip(txn, { id: op.blipId, parentId, anchor, kind: op.kind ?? "note", order: op.order ?? lastOrder(txn, parentId), seq: ev.seq });
          txn.bumped.add(blip.id);
          txn.put(blip);
          blipCount++;
          if (op.text) {
            const seeded = seedText(txn, blip, op.text);
            if (seeded.log.bytes > L.textStateBytes) {
              // Cannot happen within LIMITS.textChars, but keep the cap honest.
              errors.push({ index: i, code: "limit", message: "text state exceeds the stored size cap" });
            }
            blip = seeded;
          }
          break;
        }
        case "delete":
        case "restore": {
          if (!existing) { errors.push({ index: i, code: "unknown_blip", message: "blip does not exist" }); break; }
          if (existing.locked) { errors.push({ index: i, code: "locked", message: "decisions cannot be deleted or restored" }); break; }
          if (!versionMatches(txn, existing, op.baseVersion)) { conflicts.push({ blipId: existing.id, current: clone(existing) }); break; }
          const deleted = op.op === "delete";
          if (existing.deleted === deleted) break; // already so: nothing to do
          const ev = txn.event(deleted ? "blip.delete" : "blip.restore", { blipId: existing.id, detail: existing.preview });
          txn.put({ ...touched(txn, existing, ev.seq), deleted });
          break;
        }
        case "move": {
          if (!existing) { errors.push({ index: i, code: "unknown_blip", message: "blip does not exist" }); break; }
          if (existing.locked) { errors.push({ index: i, code: "locked", message: "decisions cannot be moved" }); break; }
          let parentId = op.parentId;
          /** @type {Anchor|null} */
          let anchor = null;
          if (parentId !== null) {
            const parent = txn.get(parentId);
            if (!parent) { errors.push({ index: i, code: "unknown_blip", message: "parentId does not exist" }); break; }
            if (parent.deleted) { errors.push({ index: i, code: "invalid_ref", message: "parentId is deleted" }); break; }
            if (isDescendant(txn, existing.id, parentId)) { errors.push({ index: i, code: "invalid_ref", message: "a blip cannot move under itself" }); break; }
            anchor = storableAnchor(op.anchor ?? { type: "end" });
            if (!anchor) { errors.push({ index: i, code: "invalid_ref", message: "anchor position does not decode" }); break; }
            const c = clampParent(txn, parentId);
            if (c.clamped) { parentId = c.parentId; anchor = { type: "end" }; }
          }
          if (!versionMatches(txn, existing, op.baseVersion)) { conflicts.push({ blipId: existing.id, current: clone(existing) }); break; }
          const sameParent = parentId === existing.parentId;
          const order = op.order ?? (sameParent ? existing.order : lastOrder(txn, parentId));
          const sameAnchor = JSON.stringify(anchor) === JSON.stringify(existing.anchor);
          if (sameParent && sameAnchor && order === existing.order) break;
          const ev = txn.event("blip.move", { blipId: existing.id, detail: existing.preview });
          txn.put({ ...touched(txn, existing, ev.seq), parentId, anchor, order });
          break;
        }
        default:
          errors.push({ index: i, code: "invalid_op", message: "unknown op" });
      }
    }

    // ---- structure ----
    if (isObject(req.structure)) {
      const st = /** @type {Record<string, unknown>} */ (req.structure);
      /** @type {string[]} */
      const details = [];
      if (st.title !== undefined) {
        const title = cleanLine(st.title, L.title) || DEFAULT_TITLE;
        if (title !== s.meta.title) { txn.metaPatch.title = title; details.push(`title: ${title}`); }
      }
      if (st.template !== undefined) {
        if (!isTemplateId(st.template) || !getTemplate(st.template)) {
          errors.push({ index: -1, code: "invalid_op", message: "unknown template" });
        } else if (s.meta.template !== null) {
          errors.push({ index: -1, code: "invalid_op", message: "a template has already been applied" });
        } else {
          txn.metaPatch.template = st.template;
          details.push(`template: ${st.template}`);
        }
      }
      if (details.length) txn.event("structure", { detail: details.join("; ") });
    }

    // ---- participantOps ----
    const rawParts = Array.isArray(req.participantOps) ? req.participantOps : [];
    if (rawParts.length > L.opsPerRequest) errors.push({ index: -1, code: "limit", message: `at most ${L.opsPerRequest} participantOps per request` });
    if (rawParts.length) {
      let participants = s.meta.participants.map((p) => ({ ...p }));
      let changed = false;
      /** @type {string[]} */
      const details = [];
      for (let i = 0; i < Math.min(rawParts.length, L.opsPerRequest); i++) {
        const op = cleanParticipantOp(rawParts[i]);
        if (!op) { errors.push({ index: i, code: "invalid_op", message: "participant op must be upsert {participant} or remove {id}" }); continue; }
        if (op.op === "remove") {
          const before = participants.length;
          participants = participants.filter((p) => p.id !== op.id);
          if (participants.length !== before) { changed = true; details.push("participant left"); }
          continue;
        }
        const idx = participants.findIndex((p) => p.id === op.participant.id);
        if (idx >= 0) {
          const cur = participants[idx];
          // An upsert that omits the colour keeps the participant's colour (a rename, say).
          const next = rawParts[i].participant.color === undefined ? { ...op.participant, color: cur.color } : op.participant;
          if (cur.name !== next.name || cur.color !== next.color) {
            participants[idx] = next;
            changed = true;
            details.push(`${next.name} updated`);
          }
        } else if (participants.length >= L.participants) {
          errors.push({ index: i, code: "limit", message: `at most ${L.participants} participants` });
        } else {
          participants.push(op.participant);
          changed = true;
          details.push(`${op.participant.name} joined`);
        }
      }
      if (changed) {
        txn.metaPatch.participants = participants;
        txn.event("structure", { detail: details.join("; ") });
      }
    }

    const events = clone(txn.events);
    const upserts = clone([...txn.upserts.values()]);
    const deletes = events.filter((e) => e.kind === "blip.delete" && e.blipId).map((e) => /** @type {string} */ (e.blipId));
    /** @type {OperationResult["status"]} */
    const status = conflicts.length ? "conflict" : events.length ? "applied" : "unchanged";
    const outcome = { status, conflicts: conflicts.map((c) => c.blipId), errors };
    const committed = await commitTxn(txn, { requestId, method: "applyOperation", outcome });
    return clone({ status, seq: committed.seq, upserts, deletes, meta: committed.meta, events, conflicts, errors });
  }

  // --- Text ----------------------------------------------------------------------------------

  /** @param {any} rawReq @returns {Promise<import("../shared/protocol.js").PushTextResult>} */
  async function pushTextLocked(rawReq) {
    const s = await load();
    const req = isObject(rawReq) ? rawReq : {};
    if (!isBlipId(req.blipId)) return fail("invalid_argument", "blipId must be b_ plus 12 hex");
    const requestId = isRequestId(req.requestId) ? req.requestId : null;
    const senderId = cleanSender(req.senderId);
    const by = cleanName(req.by, DEFAULT_NAME);
    if (requestId) {
      const rec = await findRecord(s, senderId, requestId);
      if (rec && rec.method === "pushText") {
        const o = /** @type {any} */ (isObject(rec.outcome) ? rec.outcome : {});
        return { seq: cleanSeq(o.seq) ?? rec.seq, textSeq: cleanSeq(o.textSeq) ?? rec.seq, duplicate: true };
      }
    }
    const blip = s.blips.get(req.blipId);
    if (!blip) return fail("unknown_blip", "no such blip");
    if (blip.locked) return fail("locked", "decisions cannot be edited");
    const update = decodeBytes(req.update, L.pushBytes);
    if (!update || !update.length) return fail("invalid_update", `update must be base64 of at most ${L.pushBytes} bytes`);

    const entry = await docFor(blip.id);
    // Validate on a scratch copy before the cached doc changes.
    const scratch = cloneDoc(entry.doc);
    try {
      Y.decodeUpdateV2(update);
      Y.applyUpdateV2(scratch, update);
    } catch {
      scratch.destroy();
      return fail("invalid_update", "the update is not a Yjs V2 update for this blip");
    }
    const chars = docText(scratch).length;
    const stateBytes = storedBytes(docState(scratch));
    scratch.destroy();
    if (chars > L.textChars) return fail("blip_full", `text would be ${chars} characters, over ${L.textChars}; reply instead`);
    if (stateBytes > L.textStateBytes) return fail("blip_full", `text state would be ${Math.round(stateBytes / 1024)} KiB, over ${Math.round(L.textStateBytes / 1024)} KiB; reply instead`);

    Y.applyUpdateV2(entry.doc, update);
    const txn = beginTxn(s, { senderId, by, at: now() });
    const next = addTextUpdate(txn, blip, update, entry, { fromClient: true, broadcast: true });
    const outcome = { seq: next.textSeq, textSeq: next.textSeq };
    await commitTxn(txn, { requestId, method: "pushText", outcome });
    return { seq: next.textSeq, textSeq: next.textSeq };
  }

  /** @param {any} rawReq @returns {Promise<import("../shared/protocol.js").OpenBlipResult>} */
  async function openBlipLocked(rawReq) {
    const s = await load();
    const req = isObject(rawReq) ? rawReq : {};
    if (!isBlipId(req.blipId)) return fail("invalid_argument", "blipId must be b_ plus 12 hex");
    const blip = s.blips.get(req.blipId);
    if (!blip) return fail("unknown_blip", "no such blip");
    const entry = await docFor(blip.id);
    let sv = null;
    if (req.stateVector !== undefined && req.stateVector !== null && req.stateVector !== "") {
      sv = decodeBytes(req.stateVector, L.stateVectorBytes);
      if (!sv) return fail("invalid_argument", `stateVector must be base64 of at most ${L.stateVectorBytes} bytes`);
    }
    let update;
    try {
      update = sv ? Y.encodeStateAsUpdateV2(entry.doc, sv) : docState(entry.doc);
    } catch {
      return fail("invalid_argument", "stateVector does not decode");
    }
    return { update: encodeBytes(update), seq: s.meta.seq, textSeq: blip.textSeq };
  }

  /** @param {any} rawReq @returns {Promise<import("../shared/protocol.js").GetPlaybackResult>} */
  async function playbackLocked(rawReq) {
    const s = await load();
    const req = isObject(rawReq) ? rawReq : {};
    if (!isBlipId(req.blipId)) return fail("invalid_argument", "blipId must be b_ plus 12 hex");
    if (!s.blips.has(req.blipId)) return fail("unknown_blip", "no such blip");
    const base = await repo.getBase(req.blipId);
    const baseSeq = base ? cleanSeq(base.seq) ?? 0 : 0;
    const baseState = base && base.state instanceof Uint8Array ? base.state : new Uint8Array(0);
    const fromSeq = Math.max(cleanSeq(req.fromSeq) ?? 0, baseSeq + 1);
    const toSeq = cleanSeq(req.toSeq) ?? s.meta.seq;
    const updates = fromSeq <= toSeq ? await repo.listUpdates(req.blipId, { fromSeq, toSeq }) : [];
    return {
      base: { seq: baseSeq, state: encodeBytes(baseState) },
      updates: updates.map((u) => ({ seq: u.seq, at: u.at, by: u.by, update: encodeBytes(u.update) })),
      seq: s.meta.seq,
    };
  }

  // --- Convenience writes --------------------------------------------------------------------

  /**
   * Shared prologue of the convenience writes: the sender, author, request id and any replay.
   * @param {State} s @param {any} req @param {RequestRecord["method"]} method
   */
  async function prologue(s, req, method) {
    const requestId = isRequestId(req.requestId) ? req.requestId : null;
    const senderId = cleanSender(req.senderId);
    const by = cleanName(req.by, DEFAULT_NAME);
    const replay = requestId ? await findRecord(s, senderId, requestId) : null;
    return { requestId, senderId, by, replay: replay && replay.method === method ? replay : null };
  }

  /** @param {State} s @param {RequestRecord} rec @returns {any} */
  function replayBlip(s, rec) {
    const o = /** @type {any} */ (isObject(rec.outcome) ? rec.outcome : {});
    const blip = typeof o.blipId === "string" ? s.blips.get(o.blipId) ?? null : null;
    return clone({ ...(o.status ? { status: o.status } : {}), blip, seq: s.meta.seq, duplicate: true });
  }

  /**
   * Creates a reply blip of `kind` under `parentId` (depth clamped) seeded with `text`.
   * @param {Txn} txn @param {{parentId: string, anchor: Anchor, kind: Blip["kind"], text: string, by?: string, eventKind?: EventKind, detail?: string, extra?: Partial<Blip>}} f
   * @returns {Blip}
   */
  function createReply(txn, { parentId, anchor, kind, text, by, eventKind = "blip.create", detail, extra = {} }) {
    const c = clampParent(txn, parentId);
    const id = newId("blip");
    const ev = txn.event(eventKind, { blipId: id, by: by ?? txn.by, detail: detail ?? previewOf(text) });
    let blip = newBlip(txn, { id, parentId: c.parentId, anchor: c.clamped ? { type: "end" } : anchor, kind, order: lastOrder(txn, c.parentId), by, seq: ev.seq });
    blip = { ...blip, ...extra };
    txn.bumped.add(id);
    txn.put(blip);
    return seedText(txn, blip, text, by);
  }

  /** @param {any} rawReq @returns {Promise<import("../shared/protocol.js").BlipResult>} */
  async function replyLocked(rawReq) {
    const s = await load();
    const req = isObject(rawReq) ? rawReq : {};
    const { requestId, senderId, by, replay } = await prologue(s, req, "reply");
    if (replay) return replayBlip(s, replay);
    if (!isBlipId(req.parentId)) return fail("invalid_argument", "parentId must be a blip id");
    const parent = s.blips.get(req.parentId);
    if (!parent || parent.deleted) return fail("unknown_blip", "no such blip");
    const text = cleanText(req.text, L.textChars + 1);
    if (text.length > L.textChars) return fail("limit", `text exceeds ${L.textChars} characters`);
    if (!text.trim()) return fail("invalid_argument", "text is required");
    const anchor = req.anchor == null ? { type: "end" } : storableAnchor(cleanAnchor(req.anchor));
    if (!anchor) return fail("invalid_argument", "anchor must be {type: end} or {type: para, pos} with a Yjs relative position");
    const txn = beginTxn(s, { senderId, by, at: now() });
    const blip = createReply(txn, { parentId: parent.id, anchor: /** @type {Anchor} */ (anchor), kind: "note", text });
    const committed = await commitTxn(txn, { requestId, method: "reply", outcome: { blipId: blip.id } });
    return clone({ blip: txn.get(blip.id), seq: committed.seq });
  }

  /** @param {any} rawReq @returns {Promise<import("../shared/protocol.js").BlipResult>} */
  async function proposeLocked(rawReq) {
    const s = await load();
    const req = isObject(rawReq) ? rawReq : {};
    const { requestId, senderId, by, replay } = await prologue(s, req, "propose");
    if (replay) return replayBlip(s, replay);
    const fields = cleanProposalFields(req);
    if (!fields) return fail("invalid_argument", "targetId (a blip id) and replacement (a string) are required");
    if (!fields.replacement.trim() && fields.quote) return fail("invalid_argument", "replacement is empty");
    const target = s.blips.get(fields.targetId);
    if (!target || target.deleted) return fail("unknown_blip", "no such blip");
    if (target.locked) return fail("locked", "decisions cannot be changed");
    const txn = beginTxn(s, { senderId, by, at: now() });
    const blip = createProposal(txn, { target, ...fields, text: fields.summary, by });
    const committed = await commitTxn(txn, { requestId, method: "propose", outcome: { blipId: blip.id } });
    return clone({ blip: txn.get(blip.id), seq: committed.seq });
  }

  /**
   * @param {Txn} txn
   * @param {{target: Blip, quote: string, replacement: string, summary: string, sources: string[], text: string, by?: string, baseSeq?: number, runId?: string}} f
   */
  function createProposal(txn, { target, quote, replacement, summary, sources, text, by, baseSeq, runId }) {
    const known = sources.filter((id) => txn.get(id) !== undefined);
    /** @type {import("../shared/protocol.js").Proposal} */
    const proposal = { targetId: target.id, baseSeq: baseSeq ?? target.seq, quote, replacement, summary, sources: known, state: "review" };
    return createReply(txn, {
      parentId: target.id, anchor: { type: "end" }, kind: "proposal", text, by, detail: summary || previewOf(replacement),
      extra: { proposal, ...(runId ? { runId } : {}) },
    });
  }

  /** @param {any} rawReq @returns {Promise<import("../shared/protocol.js").ReviewProposalResult>} */
  async function reviewProposalLocked(rawReq) {
    const s = await load();
    const req = isObject(rawReq) ? rawReq : {};
    const { requestId, senderId, by, replay } = await prologue(s, req, "reviewProposal");
    if (replay) return replayBlip(s, replay);
    if (!isBlipId(req.proposalId)) return fail("invalid_argument", "proposalId must be a blip id");
    if (req.decision !== "accept" && req.decision !== "reject") return fail("invalid_argument", "decision must be accept or reject");
    const expectedVersion = cleanSeq(req.expectedVersion);
    if (expectedVersion === null) return fail("invalid_argument", "expectedVersion is required");
    const blip = s.blips.get(req.proposalId);
    if (!blip || blip.kind !== "proposal" || !blip.proposal) return fail("unknown_blip", "no such proposal");
    if (blip.deleted) return fail("unknown_blip", "the proposal was deleted");
    if (expectedVersion !== blip.version || blip.proposal.state !== "review") {
      return clone({ status: "conflict", blip, seq: s.meta.seq });
    }
    const target = s.blips.get(blip.proposal.targetId);
    const at = now();
    const txn = beginTxn(s, { senderId, by, at });
    /** @param {import("../shared/protocol.js").ProposalState} state @param {EventKind} kind */
    const settle = (state, kind) => {
      const ev = txn.event(kind, { blipId: blip.id, detail: blip.proposal?.summary });
      const next = { ...touched(txn, blip, ev.seq), proposal: { .../** @type {import("../shared/protocol.js").Proposal} */ (blip.proposal), state, reviewedBy: by, reviewedAt: at } };
      txn.put(next);
      return next;
    };
    if (req.decision === "reject") {
      const next = settle("rejected", "proposal.reject");
      const committed = await commitTxn(txn, { requestId, method: "reviewProposal", outcome: { status: "rejected", blipId: blip.id } });
      return clone({ status: "rejected", blip: next, seq: committed.seq });
    }
    if (!target || target.deleted) return fail("unknown_blip", "the proposal's target no longer exists");
    if (target.locked) return fail("locked", "the proposal's target is a decision");
    if (target.textSeq > blip.proposal.baseSeq) {
      const next = settle("stale", "proposal.reject");
      const committed = await commitTxn(txn, { requestId, method: "reviewProposal", outcome: { status: "stale", blipId: blip.id } });
      return clone({ status: "stale", blip: next, seq: committed.seq });
    }
    // Apply the replacement on a scratch copy first.
    const entry = await docFor(target.id);
    const scratch = cloneDoc(entry.doc);
    const ytext = scratch.getText(TEXT_KEY);
    const current = ytext.toString();
    let start = 0;
    let length = current.length;
    if (blip.proposal.quote) {
      start = current.indexOf(blip.proposal.quote);
      if (start < 0) {
        scratch.destroy();
        const next = settle("stale", "proposal.reject");
        const committed = await commitTxn(txn, { requestId, method: "reviewProposal", outcome: { status: "stale", blipId: blip.id } });
        return clone({ status: "stale", blip: next, seq: committed.seq });
      }
      length = blip.proposal.quote.length;
    }
    const before = Y.encodeStateVector(scratch);
    const replacement = blip.proposal.replacement;
    scratch.transact(() => {
      if (length) ytext.delete(start, length);
      if (replacement) ytext.insert(start, replacement);
    }, SERVER_ORIGIN);
    const chars = ytext.toString().length;
    const stateBytes = storedBytes(docState(scratch));
    const update = Y.encodeStateAsUpdateV2(scratch, before);
    scratch.destroy();
    if (chars > L.textChars || stateBytes > L.textStateBytes) return fail("blip_full", "applying the replacement would exceed the blip's size cap");
    Y.applyUpdateV2(entry.doc, update);
    const next = settle("accepted", "proposal.accept");
    addTextUpdate(txn, target, update, entry, { by, broadcast: true });
    const committed = await commitTxn(txn, { requestId, method: "reviewProposal", outcome: { status: "applied", blipId: blip.id } });
    return clone({ status: "applied", blip: next, seq: committed.seq });
  }

  /** @param {any} rawReq @returns {Promise<import("../shared/protocol.js").BlipResult>} */
  async function recordDecisionLocked(rawReq) {
    const s = await load();
    const req = isObject(rawReq) ? rawReq : {};
    const { requestId, senderId, by, replay } = await prologue(s, req, "recordDecision");
    if (replay) return replayBlip(s, replay);
    const fields = cleanDecisionFields(req);
    if (!fields) return fail("invalid_argument", "threadId (a blip id) and a non-empty text are required");
    const anchorBlip = s.blips.get(fields.threadId);
    if (!anchorBlip || anchorBlip.deleted) return fail("unknown_blip", "no such blip");
    const rootId = rootOf(fields.threadId, Object.fromEntries(s.blips));
    const root = /** @type {Blip} */ (s.blips.get(rootId));
    /** @type {Blip|null} */
    let older = null;
    if (fields.supersedes) {
      older = s.blips.get(fields.supersedes) ?? null;
      if (!older || older.kind !== "decision" || !older.decision || older.deleted) return fail("invalid_argument", "supersedes must name a decision");
      if (rootOf(older.id, Object.fromEntries(s.blips)) !== rootId) return fail("invalid_argument", "supersedes must name a decision in the same thread");
      if (older.decision.supersededBy) return fail("invalid_argument", "that decision has already been superseded");
    }
    const at = now();
    const txn = beginTxn(s, { senderId, by, at });
    /** @type {import("../shared/protocol.js").Decision} */
    const decision = {
      ...(older ? { supersedes: older.id } : {}), recordedBy: by, recordedAt: at,
      rationale: fields.rationale, dissent: fields.dissent, nextSteps: fields.nextSteps,
    };
    const blip = createReply(txn, {
      parentId: root.id, anchor: { type: "end" }, kind: "decision", text: fields.text, eventKind: "decision.record",
      detail: firstLine(fields.text, L.eventDetail) || fields.text, extra: { locked: true, decision },
    });
    if (older) {
      const ev = txn.event("decision.record", { blipId: older.id, detail: `superseded by ${blip.id}` });
      txn.put({ ...touched(txn, older, ev.seq), decision: { .../** @type {import("../shared/protocol.js").Decision} */ (older.decision), supersededBy: blip.id } });
    }
    const committed = await commitTxn(txn, { requestId, method: "recordDecision", outcome: { blipId: blip.id } });
    return clone({ blip: txn.get(blip.id), seq: committed.seq });
  }

  // --- Agent runs ----------------------------------------------------------------------------

  /** Prompts of queued runs, built when they were asked for (memory only; rebuilt after a restart). */
  /** @type {Map<string, {prompt: string, systemPrompt: string}>} */
  const prompts = new Map();
  /** @type {{runId: string, controller: AbortController}|null} */
  let active = null;
  /** @type {Promise<void>|null} */
  let dispatchPromise = null;
  let wake = false;

  /**
   * The run's input: the scope's blips as Markdown within LIMITS.runs.inputBytes.
   * @param {State} s @param {Run["op"]} op @param {{blipIds: string[], sinceSeq: number}} scope
   */
  async function buildInput(s, op, scope) {
    const selected = scopeFor(op, { blipIds: scope.blipIds, blips: Object.fromEntries(s.blips), sinceSeq: scope.sinceSeq });
    const include = new Set(selected.blipIds);
    const header = op === "catch_up" ? waveHeader(s, `Changes after sequence ${scope.sinceSeq}.`) : waveHeader(s);
    const r = await renderMarkdown(s, { include, budget: L.runs.inputBytes, header });
    return { markdown: r.markdown, blipIds: r.included, omitted: [...r.omitted, ...selected.omitted], inputBytes: r.bytes };
  }

  /** @param {any} rawReq @returns {Promise<import("../shared/protocol.js").RunResult>} */
  async function askAgentLocked(rawReq) {
    const s = await load();
    const req = isObject(rawReq) ? rawReq : {};
    const { requestId, senderId, by, replay } = await prologue(s, req, "askAgent");
    if (replay) {
      const o = /** @type {any} */ (isObject(replay.outcome) ? replay.outcome : {});
      return clone({ run: s.runs.get(o.runId) ?? null, seq: s.meta.seq, duplicate: true });
    }
    if (!isRunOp(req.op)) return fail("invalid_argument", "op must be summarise, compare, next_steps, refresh_brief or catch_up");
    const op = req.op;
    const blipIds = cleanBlipIds(req.blipIds, L.runs.scopeBlips).filter((id) => s.blips.has(id));
    const sinceSeq = op === "catch_up" ? cleanSeq(req.sinceSeq) ?? 0 : 0;
    const instructions = cleanLine(req.instructions, L.instructions);
    const at = now();
    if (!modelAvailable()) return fail("no_model", "no Model binding is configured; add one in Connections");
    const runs = [...s.runs.values()];
    const queued = runs.filter((r) => r.state === "queued").length;
    const running = runs.filter((r) => r.state === "running").length;
    if (queued >= L.runs.queued) {
      return fail("busy", `${running} run running and ${queued} queued; try again when one finishes`);
    }
    const recent = runs.filter((r) => r.createdAt > at - 3_600_000).length;
    if (recent >= L.runs.perHour) return fail("limit", `${L.runs.perHour} runs an hour; try again later`);
    if (op === "refresh_brief" && ![...s.blips.values()].some((b) => b.kind === "brief" && !b.deleted)) {
      return fail("invalid_argument", "refresh_brief needs a brief blip");
    }

    const input = await buildInput(s, op, { blipIds, sinceSeq });
    const id = newId("run");
    /** @type {Run} */
    const run = {
      id, op, by, instructions,
      scope: { blipIds: input.blipIds, sinceSeq, snapshotSeq: s.meta.seq, inputBytes: input.inputBytes, omitted: input.omitted },
      state: "queued", generation: 1, createdAt: at,
    };
    prompts.set(id, { prompt: buildPrompt({ op, markdown: input.markdown, instructions, sinceSeq }), systemPrompt: buildSystemPrompt(op) });
    const txn = beginTxn(s, { senderId, by, at });
    txn.runs.set(id, run);
    txn.event("run.queued", { runId: id, detail: `${RUN_OP_LABELS[op]}${instructions ? " · " + instructions : ""}` });
    const committed = await commitTxn(txn, { requestId, method: "askAgent", outcome: { runId: id } });
    kick();
    return clone({ run: s.runs.get(id) ?? run, seq: committed.seq });
  }

  /** @param {any} rawReq @returns {Promise<import("../shared/protocol.js").RunResult>} */
  async function cancelRunLocked(rawReq) {
    const s = await load();
    const req = isObject(rawReq) ? rawReq : {};
    const { requestId, senderId, by, replay } = await prologue(s, req, "cancelRun");
    if (replay) {
      const o = /** @type {any} */ (isObject(replay.outcome) ? replay.outcome : {});
      return clone({ run: s.runs.get(o.runId) ?? null, seq: s.meta.seq, duplicate: true });
    }
    if (!isRunId(req.runId)) return fail("invalid_argument", "runId must be r_ plus 12 hex");
    const run = s.runs.get(req.runId);
    if (!run) return fail("unknown_run", "no such run");
    if (run.state !== "queued" && run.state !== "running") return clone({ run, seq: s.meta.seq });
    const at = now();
    const txn = beginTxn(s, { senderId, by, at });
    txn.runs.set(run.id, { ...run, state: "cancelled", finishedAt: at });
    txn.event("run.cancelled", { runId: run.id, detail: RUN_OP_LABELS[run.op] });
    const committed = await commitTxn(txn, { requestId, method: "cancelRun", outcome: { runId: run.id } });
    prompts.delete(run.id);
    if (active?.runId === run.id) {
      const err = new Error("cancelled");
      err.name = "AbortError";
      active.controller.abort(err);
    }
    return clone({ run: s.runs.get(run.id), seq: committed.seq });
  }

  /** Starts the dispatcher unless one is looping; a looping one re-checks the queue. */
  function kick() {
    wake = true;
    if (dispatchPromise) return;
    dispatchPromise = dispatcher().catch(() => {}).then(() => {
      dispatchPromise = null;
      if (wake) kick();
    });
  }

  async function dispatcher() {
    while (wake) {
      wake = false;
      const started = await enqueue(startNextRun).catch(() => null);
      if (!started) continue;
      wake = true; // another run may be waiting behind this one
      await runModel(started);
    }
  }

  /**
   * Inside the queue: takes the oldest queued run when none is running, marks it running and
   * returns what the model call needs. Null when nothing is to be done.
   * @returns {Promise<{run: Run, prompt: string, systemPrompt: string}|null>}
   */
  async function startNextRun() {
    const s = await load();
    const runs = [...s.runs.values()];
    if (runs.some((r) => r.state === "running")) return null;
    const next = runs.filter((r) => r.state === "queued").sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))[0];
    if (!next) return null;
    let prompt = prompts.get(next.id);
    if (!prompt) {
      // After a restart the queued run's input is rebuilt from its scope as it stands now.
      const input = await buildInput(s, next.op, { blipIds: next.scope.blipIds, sinceSeq: next.scope.sinceSeq });
      prompt = { prompt: buildPrompt({ op: next.op, markdown: input.markdown, instructions: next.instructions, sinceSeq: next.scope.sinceSeq }), systemPrompt: buildSystemPrompt(next.op) };
      prompts.set(next.id, prompt);
    }
    const at = now();
    const txn = beginTxn(s, { senderId: "", by: AGENT_NAME, at });
    /** @type {Run} */
    const run = { ...next, state: "running", startedAt: at };
    txn.runs.set(run.id, run);
    txn.event("run.started", { runId: run.id, detail: RUN_OP_LABELS[run.op] });
    await commitTxn(txn, {});
    return { run, ...prompt };
  }

  /**
   * Outside the queue: the model call with its timeout, then the commit of its outcome.
   * @param {{run: Run, prompt: string, systemPrompt: string}} started
   */
  async function runModel({ run, prompt, systemPrompt }) {
    const controller = new AbortController();
    active = { runId: run.id, controller };
    /** @type {{ok: true, text: string} | {ok: false, error: string}} */
    let outcome;
    /** @type {any} */
    let timer = null;
    try {
      const client = typeof model === "function" ? model() : null;
      if (!client) throw new Error("no Model binding is configured");
      const timeout = new Promise((_, reject) => {
        timer = clock.setTimeout(() => {
          const err = new Error(`the model did not answer within ${Math.round(L.runs.timeoutMs / 1000)} s`);
          err.name = "TimeoutError";
          controller.abort(err);
          reject(err);
        }, L.runs.timeoutMs);
      });
      const aborted = new Promise((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason ?? new Error("aborted")), { once: true });
      });
      const text = await Promise.race([Promise.resolve().then(() => client.run({ prompt, systemPrompt }, { signal: controller.signal })), timeout, aborted]);
      outcome = { ok: true, text: typeof text === "string" ? text : String(text ?? "") };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      outcome = { ok: false, error: cleanLine(message, 200) || "the model call failed" };
    } finally {
      if (timer !== null) clock.clearTimeout(timer);
      if (active?.runId === run.id) active = null;
    }
    await enqueue(() => commitRun(run.id, run.generation, outcome)).catch(() => {});
  }

  /**
   * Inside the queue: commits a model outcome if the run is still running with the same
   * generation; otherwise the result is discarded (cancelled, or a restart happened).
   * @param {string} runId @param {number} generation
   * @param {{ok: true, text: string} | {ok: false, error: string}} outcome
   */
  async function commitRun(runId, generation, outcome) {
    const s = await load();
    const run = s.runs.get(runId);
    prompts.delete(runId);
    if (!run || run.state !== "running" || run.generation !== generation) return;
    const at = now();
    const txn = beginTxn(s, { senderId: "", by: AGENT_NAME, at });
    /** @param {string} error */
    const failed = (error) => {
      txn.runs.set(run.id, { ...run, state: "failed", finishedAt: at, error, ...(outcome.ok ? { outputBytes: utf8Bytes(outcome.text) } : {}) });
      txn.event("run.failed", { runId: run.id, detail: error });
    };
    if (!outcome.ok) {
      failed(outcome.error);
      await commitTxn(txn, {});
      return;
    }
    const outputBytes = utf8Bytes(outcome.text);
    const parsed = parseAgentOutput(outcome.text, { knownIds: run.scope.blipIds, op: run.op });
    if (!parsed.ok) {
      failed(parsed.reason);
      await commitTxn(txn, {});
      return;
    }
    const output = parsed.output;
    const kind = resultKind(run.op);
    /** @type {Run} */
    const done = { ...run, state: "done", finishedAt: at, outputBytes };
    if (kind === "result") {
      done.result = output;
    } else if (kind === "proposal") {
      const brief = [...s.blips.values()].filter((b) => b.kind === "brief" && !b.deleted).sort(compareBlips)[0];
      if (!brief) { failed("the Wave has no brief to refresh"); await commitTxn(txn, {}); return; }
      const blip = createProposal(txn, {
        target: brief, quote: output.quote ?? "", replacement: output.replacement ?? "", summary: output.summary, sources: output.sources,
        text: output.body, by: AGENT_NAME, baseSeq: Math.min(brief.seq, run.scope.snapshotSeq), runId: run.id,
      });
      done.resultBlipId = blip.id;
    } else {
      // An agent blip at the end of the scoped thread, or a new root when the scope spans threads.
      const all = Object.fromEntries(s.blips);
      const roots = new Set(run.scope.blipIds.filter((id) => s.blips.has(id) && !s.blips.get(id)?.deleted).map((id) => rootOf(id, all)));
      const parentId = roots.size === 1 ? /** @type {string} */ ([...roots][0]) : null;
      const cited = new Set(citedBlipIds(output.body));
      const missing = output.sources.filter((id) => !cited.has(id));
      const text = missing.length ? `${output.body}\n\nSources: ${missing.join(", ")}` : output.body;
      let blip;
      if (parentId !== null && s.blips.get(parentId) && !s.blips.get(parentId)?.deleted) {
        blip = createReply(txn, { parentId, anchor: { type: "end" }, kind: "agent", text, by: AGENT_NAME, detail: output.summary, extra: { runId: run.id } });
      } else {
        const id = newId("blip");
        const ev = txn.event("blip.create", { blipId: id, by: AGENT_NAME, detail: output.summary });
        blip = { ...newBlip(txn, { id, parentId: null, anchor: null, kind: "agent", order: lastOrder(txn, null), by: AGENT_NAME, seq: ev.seq }), runId: run.id };
        txn.bumped.add(id);
        txn.put(blip);
        blip = seedText(txn, blip, text, AGENT_NAME);
      }
      done.resultBlipId = blip.id;
    }
    txn.runs.set(run.id, done);
    txn.event("run.done", { runId: run.id, detail: output.summary, ...(done.resultBlipId ? { blipId: done.resultBlipId } : {}) });
    await commitTxn(txn, {});
  }

  // --- Public surface ------------------------------------------------------------------------

  return {
    /** The current snapshot. */
    getWave: () => enqueue(async () => snapshot(await load())),

    /** @param {any} args {rootId} */
    getThread: (args) => enqueue(async () => {
      const s = await load();
      const a = isObject(args) ? args : {};
      if (!isBlipId(a.rootId) || !s.blips.has(a.rootId)) return fail("unknown_blip", "no such blip");
      const rootId = rootOf(a.rootId, Object.fromEntries(s.blips));
      return clone({ blips: treeOrder(s.blips, rootId, true), seq: s.meta.seq });
    }),

    /** @param {any} [args] {sinceSeq?, threadId?} */
    getWaveMarkdown: (args) => enqueue(async () => waveMarkdown(await load(), args)),

    /** @param {any} [args] {decisions?} */
    exportMarkdown: (args) => enqueue(async () => exportMarkdownOf(await load(), args)),

    /** @param {any} args {blipId, stateVector?} */
    openBlip: (args) => enqueue(() => openBlipLocked(args)),

    /** @param {any} args {afterSeq, limit?} */
    getChanges: (args) => enqueue(async () => {
      const s = await load();
      const a = isObject(args) ? args : {};
      const afterSeq = cleanSeq(a.afterSeq) ?? 0;
      const limit = Math.min(1000, Math.max(1, cleanSeq(a.limit) ?? 200));
      const events = await repo.listEvents({ afterSeq, limit });
      return { events, seq: s.meta.seq, earliestSeq: s.meta.earliestSeq };
    }),

    /** @param {any} args {blipId, fromSeq?, toSeq?} */
    getPlayback: (args) => enqueue(() => playbackLocked(args)),

    /** @param {any} args {runId} */
    getRun: (args) => enqueue(async () => {
      const s = await load();
      const a = isObject(args) ? args : {};
      return clone({ run: isRunId(a.runId) ? s.runs.get(a.runId) ?? null : null, seq: s.meta.seq });
    }),

    /** @param {any} args PushTextRequest */
    pushText: (args) => enqueue(() => pushTextLocked(args)),

    /** @param {any} args OperationRequest */
    applyOperation: (args) => enqueue(() => applyOperationLocked(args)),

    /** @param {any} args ReplyRequest */
    reply: (args) => enqueue(() => replyLocked(args)),

    /** @param {any} args ProposeRequest */
    propose: (args) => enqueue(() => proposeLocked(args)),

    /** @param {any} args ReviewProposalRequest */
    reviewProposal: (args) => enqueue(() => reviewProposalLocked(args)),

    /** @param {any} args RecordDecisionRequest */
    recordDecision: (args) => enqueue(() => recordDecisionLocked(args)),

    /** @param {any} args AskAgentRequest */
    askAgent: (args) => enqueue(() => askAgentLocked(args)),

    /** @param {any} args CancelRunRequest */
    cancelRun: (args) => enqueue(() => cancelRunLocked(args)),

    /** The cached seq without touching storage, or null before the first load. */
    seqNow: () => (state ? state.meta.seq : null),

    getSeq: () => enqueue(async () => (await load()).meta.seq),

    /** Resolves when the queue is empty and no dispatcher work is pending. */
    settled: async () => {
      for (let guard = 0; guard < 100_000; guard++) {
        if (jobs === 0 && !dispatchPromise) return;
        await queue;
        if (dispatchPromise) await dispatchPromise;
      }
    },

    /** Test hook: the number of cached docs and their decoded bytes. */
    cacheStats: () => ({ docs: docs.size, bytes: docBytes }),
  };
}
