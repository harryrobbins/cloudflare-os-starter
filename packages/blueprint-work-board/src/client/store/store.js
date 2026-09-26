// @ts-check
// The client store: connection, the replica of the datastore (snapshot + journal pull with
// backoff and permission-epoch reset), the derived index, the viewer's changes (exact-intent
// commands and their approval status: the pending overlay), and the gadget-server documents
// (views, preferences, settings).
//
// Truth model: committed state only ever comes from Records. A change is shown as an overlay until
// the service's version arrives; a pending change never alters a committed item.

import { buildIndex } from "../../shared/model/index.js";
import { hasPlanning, isWorkV1, viewerActor } from "../../shared/model/work.js";
import { createReplica } from "../../shared/replica.js";
import { BINDING_NAME, errorCode, errorDetail } from "../../shared/records.js";
import { intentDigest } from "../intent.js";
import { checkEntityInput, checkItemFields, friendlyReason, inversePatch, updateInput } from "./commands.js";

export const SNAPSHOT_LIMIT = 5000;
const APPLIED_VISIBLE_MS = 8_000;
const MAX_BACKOFF_MS = 60_000;
const PERSIST_KEY = "wb-pending";

/**
 * One change the viewer asked for.
 * @typedef {{
 *   id: number, group: string|null, label: string, itemId: string|null, command: string,
 *   input: Record<string, unknown>, revision: number|undefined, idempotencyKey: string,
 *   status: "saving"|"pending"|"applied"|"conflict"|"rejected", actionId: number|null, message: string,
 *   createdAt: number, settledAt: number|null, resultId: string|null, resultRevision: number|null,
 *   undo: { itemId: string, patch: Record<string, unknown> }|null, undoOf: number|null, mine: true,
 * }} Change
 * @typedef {"loading"|"not_connected"|"forbidden"|"wrong_module"|"too_large"|"error"|"ready"} Phase
 * @typedef {"data"|"changes"|"views"|"prefs"|"sync"|"history"|"phase"} Topic
 */

/**
 * @param {{
 *   gadget: any, viewer?: { id: string, displayName?: string, role?: string } | null,
 *   timers?: { visibleMs?: number, hiddenMs?: number, outcomeMs?: number, historyMs?: number },
 *   doc?: Document, randomUUID?: () => string, now?: () => number, persist?: { get: () => string, set: (v: string) => void } | null,
 * }} options
 */
export function createStore(options) {
  const { gadget } = options;
  const doc = options.doc ?? document;
  const now = options.now ?? (() => Date.now());
  const visibleMs = options.timers?.visibleMs ?? 3_000;
  const hiddenMs = options.timers?.hiddenMs ?? 15_000;
  const outcomeMs = options.timers?.outcomeMs ?? 2_000;
  const historyMs = options.timers?.historyMs ?? 1_200;
  const randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
  const viewer = options.viewer ?? null;
  const me = viewerActor(viewer);
  const persist = options.persist === undefined ? windowNamePersist() : options.persist;

  const replica = createReplica({ limit: SNAPSHOT_LIMIT, now });
  /** @type {Map<string, string>} */
  const names = new Map();
  if (me && viewer?.displayName) names.set(me, viewer.displayName);

  const s = {
    /** @type {Phase} */ phase: "loading",
    phaseMessage: "",
    /** @type {any} */ connection: null,
    /** @type {any} */ description: null,
    planning: false,
    /** @type {{ keyPrefix: string|null, version: number }} */ settings: { keyPrefix: null, version: 0 },
    /** @type {any[]} */ views: [],
    /** @type {any} */ prefs: { shortcuts: true, lastViewId: null, draft: null, collapsedColumns: [], collapsedLanes: [], reduceMotion: false, version: 0 },
    /** @type {Change[]} */ changes: [],
    sync: { error: "", lastSync: 0, failures: 0, retryAt: 0, offline: false, reset: 0 },
  };
  let nextChangeId = 1;
  let destroyed = false;
  /** @type {Set<(topics: Set<Topic>) => void>} */
  const listeners = new Set();
  /** @type {Set<Topic>} */
  let dirty = new Set();
  let scheduled = false;
  /** @type {Promise<void>|null} */ let pulling = null;
  /** @type {ReturnType<typeof setTimeout>|null} */ let pollTimer = null;
  /** @type {ReturnType<typeof setTimeout>|null} */ let outcomeTimer = null;
  /** @type {ReturnType<typeof setTimeout>|null} */ let historyTimer = null;
  /** @type {ReturnType<typeof setTimeout>|null} */ let prefsTimer = null;
  let rpcFailures = 0;

  /** @type {{ key: string, index: import("../../shared/model/index.js").WorkIndex }|null} */
  let indexCache = null;

  /** @param {...Topic} topics */
  function notify(...topics) {
    for (const t of topics) dirty.add(t);
    if (scheduled || destroyed) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      const batch = dirty;
      dirty = new Set();
      for (const fn of listeners) {
        try { fn(batch); } catch (err) { console.error(err); }
      }
    });
  }

  function index() {
    const key = `${replica.version}|${s.settings.keyPrefix ?? ""}|${s.planning}|${s.connection?.label ?? ""}`;
    if (!indexCache || indexCache.key !== key) {
      indexCache = { key, index: buildIndex(replica.records.values(), { planning: s.planning, keyPrefix: s.settings.keyPrefix, label: s.connection?.label ?? "", names, times: replica.times }) };
    }
    return indexCache.index;
  }

  const source = {
    /** @param {number} [limit] */
    snapshot: (limit) => rpc(() => gadget.snapshot(limit)),
    /** @param {number} [after] @param {number} [epoch] */
    changes: (after, epoch) => rpc(() => gadget.changes(after, epoch)),
  };

  /**
   * Every gadget call goes through here so a dead stub (the platform keeps rejecting after a
   * facet restart) is noticed: after 3 failures in a row the frame reloads itself when nothing
   * is unsaved.
   * @template T @param {() => Promise<T>} fn @returns {Promise<T>}
   */
  async function rpc(fn) {
    try {
      const out = await fn();
      rpcFailures = 0;
      return out;
    } catch (err) {
      if (!errorCode(err)) {
        rpcFailures++;
        if (rpcFailures >= 3 && /restarted|disposed|broken|disconnected|connection lost/i.test(String(/** @type {any} */ (err)?.message ?? err))) maybeReload();
      }
      throw err;
    }
  }

  function maybeReload() {
    if (s.changes.some((c) => c.status === "saving")) return;
    savePending();
    try { doc.defaultView?.location.reload(); } catch { /* not in a frame we can reload */ }
  }

  // -----------------------------------------------------------------------------------------
  // Loading and sync

  /** @param {unknown} err */
  function stopFor(err) {
    const code = errorCode(err);
    s.phase = code === "not_connected" ? "not_connected" : code === "forbidden" ? "forbidden" : code === "too_large" ? "too_large" : "error";
    s.phaseMessage = errorDetail(err);
    // Never keep showing protected data after a refusal.
    if (s.phase !== "error") { replica.reset(); indexCache = null; }
    notify("phase", "data");
  }

  async function bootstrap() {
    s.phase = "loading";
    notify("phase");
    const setup = await rpc(() => gadget.getSetup());
    if (!setup?.connected) { s.phase = "not_connected"; s.phaseMessage = ""; notify("phase"); return; }
    if (setup.error) { stopFor(new Error(setup.error)); return; }
    s.connection = setup.connection;
    s.description = setup.description;
    if (!isWorkV1(s.description)) { s.phase = "wrong_module"; s.phaseMessage = ""; notify("phase"); return; }
    const [snapshot, settings, views, prefs] = await Promise.all([
      source.snapshot(SNAPSHOT_LIMIT),
      rpc(() => gadget.getSettings()).catch(() => null),
      rpc(() => gadget.listViews()).catch(() => []),
      viewer?.id ? rpc(() => gadget.getPrefs(viewer.id)).catch(() => null) : Promise.resolve(null),
    ]);
    replica.loadSnapshot(snapshot);
    s.planning = hasPlanning({ description: s.description, records: snapshot.records });
    if (settings) s.settings = settings;
    s.views = Array.isArray(views) ? views : [];
    if (prefs) s.prefs = { ...s.prefs, ...prefs };
    s.phase = "ready";
    s.sync.error = ""; s.sync.lastSync = now(); s.sync.failures = 0; s.sync.offline = false;
    restorePending();
    notify("phase", "data", "views", "prefs", "sync");
    scheduleHistory();
  }

  /** Pull journal pages until caught up. Single-flight; errors back off. */
  function pull() {
    if (s.phase !== "ready") return Promise.resolve();
    pulling ??= (async () => {
      try {
        const { changed, reset } = await replica.pull(source);
        if (destroyed) return;
        if (reset) { s.sync.reset++; s.planning = s.planning || hasPlanning({ description: s.description, records: [...replica.records.values()] }); scheduleHistory(); }
        if (!s.planning && changed && [...replica.records.values()].some((r) => r.entity !== "work_item")) s.planning = true;
        s.sync.error = ""; s.sync.lastSync = now(); s.sync.failures = 0; s.sync.offline = false;
        settleCommitted();
        if (changed) notify("data", "history");
        notify("sync");
      } catch (err) {
        const code = errorCode(err);
        if (code === "forbidden" || code === "not_connected" || code === "too_large") { stopFor(err); return; }
        s.sync.failures++;
        s.sync.error = friendlyReason(code ?? "", errorDetail(err) || "The Records service could not be reached.");
        s.sync.offline = s.sync.failures >= 2;
        notify("sync");
      }
    })().finally(() => { pulling = null; });
    return pulling;
  }

  function schedulePoll() {
    if (destroyed) return;
    if (pollTimer) clearTimeout(pollTimer);
    const visible = doc.visibilityState !== "hidden";
    const base = visible ? visibleMs : hiddenMs;
    const delay = s.sync.failures ? Math.min(MAX_BACKOFF_MS, base * 2 ** Math.min(s.sync.failures, 5)) : base;
    s.sync.retryAt = s.sync.failures ? now() + delay : 0;
    pollTimer = setTimeout(async () => { await pull(); schedulePoll(); }, delay);
  }

  function scheduleHistory() {
    if (destroyed || historyTimer || replica.backfill.done) return;
    historyTimer = setTimeout(async () => {
      historyTimer = null;
      if (s.phase !== "ready") return;
      try {
        const done = await replica.backfillHistory(source, 4);
        notify("history");
        if (done) notify("data");
      } catch { /* retried on the next tick */ }
      scheduleHistory();
    }, historyMs);
  }

  // -----------------------------------------------------------------------------------------
  // Writes

  /** Pending changes whose committed version has arrived are settled. */
  function settleCommitted() {
    const ix = index();
    let touched = false;
    for (const c of s.changes) {
      if (c.status !== "applied" || c.settledAt) continue;
      const target = c.resultId ? ix.records.get(c.resultId) ?? replica.records.get(c.resultId) : null;
      if (!c.resultId || (target && target.revision >= (c.resultRevision ?? 0))) {
        c.settledAt = now();
        touched = true;
        const change = c;
        setTimeout(() => { s.changes = s.changes.filter((x) => x !== change); notify("changes"); }, APPLIED_VISIBLE_MS);
      }
    }
    if (touched) notify("changes");
  }

  /**
   * Sends one command. Validation happens before; this handles assertion, retry and outcome.
   * @param {{ label: string, command: string, input: Record<string, unknown>, revision?: number, itemId?: string|null,
   *   group?: string|null, undo?: Change["undo"], undoOf?: number|null }} req
   * @returns {Change}
   */
  function request(req) {
    /** @type {Change} */
    const change = {
      id: nextChangeId++, group: req.group ?? null, label: req.label, itemId: req.itemId ?? null, command: req.command,
      input: req.input, revision: req.revision, idempotencyKey: randomUUID(), status: "saving", actionId: null, message: "",
      createdAt: now(), settledAt: null, resultId: null, resultRevision: null, undo: req.undo ?? null, undoOf: req.undoOf ?? null, mine: true,
    };
    s.changes = [...s.changes, change];
    notify("changes");
    void dispatch(change);
    return change;
  }

  /** @param {Change} change */
  async function dispatch(change) {
    try {
      let outcome;
      try {
        outcome = await send(change);
      } catch (err) {
        // Nothing reached the Workshop's queue: retry once with a fresh assertion, same key and input.
        if (errorCode(err) !== "unavailable") throw err;
        outcome = await send(change);
      }
      handleOutcome(change, outcome);
    } catch (err) {
      const code = errorCode(err);
      if (code === "stale_revision") { change.status = "conflict"; change.message = friendlyReason(code, "", change.command); void pull(); }
      else { change.status = "rejected"; change.message = friendlyReason(code ?? "", errorDetail(err) || "the request could not be sent.", change.command); }
    }
    savePending();
    notify("changes");
    scheduleOutcomes();
  }

  /** @param {Change} change */
  async function send(change) {
    const intent = {
      datastore: s.connection.datastore, binding: s.connection.binding, moduleId: "work", apiMajor: 1,
      command: change.command, input: change.input, expectedRevision: change.revision ?? null, idempotencyKey: change.idempotencyKey,
    };
    const digest = await intentDigest(intent);
    let viewerAssertion;
    try {
      viewerAssertion = await gadget.$createViewerAssertion(BINDING_NAME, digest);
    } catch (err) {
      throw new Error(`forbidden: The Workshop could not confirm this change came from you (${errorDetail(err) || "no reason given"}).`);
    }
    if (typeof viewerAssertion !== "string" || !viewerAssertion) throw new Error("forbidden: Only signed-in viewers can change items.");
    /** @type {{ viewerAssertion: string, idempotencyKey: string, revision?: number }} */
    const commandOptions = { viewerAssertion, idempotencyKey: change.idempotencyKey };
    if (change.revision !== undefined) commandOptions.revision = change.revision;
    return rpc(() => gadget.command(change.command, change.input, commandOptions));
  }

  /** @param {Change} change @param {any} outcome */
  function handleOutcome(change, outcome) {
    if (outcome?.status === "pending") {
      change.status = "pending";
      change.actionId = outcome.actionId;
    } else if (outcome?.status === "applied") {
      change.status = "applied";
      const record = outcome.result?.record;
      change.resultId = typeof record?.id === "string" ? record.id : change.resultId ?? change.itemId;
      change.resultRevision = Number.isFinite(record?.revision) ? record.revision : null;
      void pull();
    } else if (outcome?.status === "rejected") {
      const reason = String(outcome.reason ?? "");
      change.status = /\((412|428)\)/.test(reason) ? "conflict" : "rejected";
      change.message = friendlyReason("", reason, change.command);
      if (change.status === "conflict") void pull();
    }
  }

  function scheduleOutcomes() {
    if (destroyed || outcomeTimer) return;
    if (!s.changes.some((c) => c.status === "pending")) return;
    outcomeTimer = setTimeout(async () => {
      outcomeTimer = null;
      let touched = false;
      for (const change of s.changes.filter((c) => c.status === "pending")) {
        try {
          const outcome = await rpc(() => gadget.getOutcome(change.actionId));
          if (outcome?.status !== "pending") { handleOutcome(change, outcome); touched = true; }
        } catch (err) {
          if (errorCode(err) === "not_found") { change.status = "rejected"; change.message = "The Workshop no longer knows this request."; touched = true; }
        }
      }
      if (touched) { savePending(); notify("changes"); }
      scheduleOutcomes();
    }, outcomeMs);
  }

  /** The newest unsettled change for an item (the overlay shows it). @param {string} itemId */
  function pendingFor(itemId) {
    for (let i = s.changes.length - 1; i >= 0; i--) {
      const c = s.changes[i];
      if (c.itemId === itemId && (c.status === "saving" || c.status === "pending" || (c.status === "applied" && !c.settledAt))) return c;
    }
    return null;
  }

  function canWrite() { return s.connection?.access === "write" && Boolean(viewer?.id); }

  /**
   * Creates an item. Returns the change, or an error message.
   * @param {Record<string, unknown>} fields @param {{ label?: string, group?: string|null }} [opts]
   * @returns {{ ok: true, change: Change } | { ok: false, error: string, field?: string }}
   */
  function createItem(fields, opts = {}) {
    if (!canWrite()) return { ok: false, error: "This board is read-only for you." };
    // Planning datastores accept a client id on create, so the pending card and the saved item
    // share one identity (retries reuse it with the idempotency key).
    const built = checkItemFields(s.planning && !fields.id ? { ...fields, id: randomUUID() } : fields, { planning: s.planning, create: true });
    if (!built.ok) return built;
    const id = typeof built.input.id === "string" ? built.input.id : null;
    const change = request({ label: opts.label ?? `Create “${built.input.title}”`, command: "work.create", input: built.input, group: opts.group });
    if (id) change.resultId = id;
    return { ok: true, change };
  }

  /**
   * Updates an item with the fields in `patch` that differ from its committed data.
   * @param {import("../../shared/model/index.js").ItemView} item @param {Record<string, unknown>} patch
   * @param {{ label?: string, group?: string|null, undoable?: boolean, undoOf?: number|null }} [opts]
   * @returns {{ ok: true, change: Change|null } | { ok: false, error: string, field?: string }}
   */
  function updateItem(item, patch, opts = {}) {
    if (!canWrite()) return { ok: false, error: "This board is read-only for you." };
    if (pendingFor(item.id)?.status === "saving") return { ok: false, error: `${item.key} is still being sent; try again in a moment.` };
    if ("parent" in patch && patch.parent && String(patch.parent).toLowerCase().endsWith(item.id)) return { ok: false, error: "An item cannot be its own parent.", field: "parent" };
    const built = updateInput(item, patch, { planning: s.planning });
    if (!built) return { ok: true, change: null };
    if (!built.ok) return built;
    const undo = opts.undoable === false ? null : { itemId: item.id, patch: inversePatch(item, built.input) };
    const change = request({ label: opts.label ?? `Edit ${item.key}`, command: "work.update", input: built.input, revision: item.revision, itemId: item.id, group: opts.group, undo, undoOf: opts.undoOf });
    return { ok: true, change };
  }

  /**
   * One command per item; returns per-item results.
   * @param {import("../../shared/model/index.js").ItemView[]} items
   * @param {(item: import("../../shared/model/index.js").ItemView) => Record<string, unknown>|null} patchFor
   * @param {string} label
   */
  function bulkUpdate(items, patchFor, label) {
    const group = `bulk-${randomUUID()}`;
    /** @type {{ item: import("../../shared/model/index.js").ItemView, ok: boolean, error?: string, change?: Change|null }[]} */
    const results = [];
    for (const item of items) {
      const patch = patchFor(item);
      if (!patch) { results.push({ item, ok: true, change: null }); continue; }
      const r = updateItem(item, patch, { label: `${label} · ${item.key}`, group, undoable: false });
      results.push(r.ok ? { item, ok: true, change: r.change } : { item, ok: false, error: r.error });
    }
    return { group, results };
  }

  /**
   * A planning-entity command (states, labels, projects, cycles, relations, comments).
   * @param {string} command @param {Record<string, unknown>} input
   * @param {{ label: string, revision?: number, itemId?: string|null }} opts
   * @returns {{ ok: true, change: Change } | { ok: false, error: string, field?: string }}
   */
  function entity(command, input, opts) {
    if (!canWrite()) return { ok: false, error: "This board is read-only for you." };
    if (!s.planning) return { ok: false, error: "This datastore does not have planning entities yet (Records migration 010)." };
    const built = checkEntityInput(command, input);
    if (!built.ok) return built;
    return { ok: true, change: request({ label: opts.label, command, input: built.input, revision: opts.revision, itemId: opts.itemId ?? null }) };
  }

  /** Submits the inverse of one of your own applied changes. @param {Change} change */
  function undo(change) {
    if (!change.undo) return { ok: false, error: "This change cannot be undone." };
    const item = index().items.get(change.undo.itemId);
    if (!item) return { ok: false, error: "The item is no longer on the board." };
    // Only restore fields that still hold the value this change set.
    /** @type {Record<string, unknown>} */
    const patch = {};
    for (const [key, value] of Object.entries(change.undo.patch)) {
      const wanted = change.input[key];
      const now_ = item.raw.data[key] ?? null;
      if (JSON.stringify(now_) === JSON.stringify(wanted ?? null) || change.status !== "applied") patch[key] = value;
    }
    if (!Object.keys(patch).length) return { ok: false, error: "Someone changed this item since; nothing to undo." };
    return updateItem(item, patch, { label: `Undo: ${change.label}`, undoable: false, undoOf: change.id });
  }

  /** Sends a conflicted or failed change again against the current version. @param {Change} change */
  function retry(change) {
    s.changes = s.changes.filter((c) => c !== change);
    notify("changes");
    if (change.command === "work.update" && change.itemId) {
      const item = index().items.get(change.itemId);
      if (!item) return { ok: false, error: "The item is no longer on the board." };
      const { id: _id, ...patch } = change.input;
      return updateItem(item, patch, { label: change.label, group: change.group });
    }
    if (change.command === "work.create") return createItem(change.input, { label: change.label, group: change.group });
    return { ok: true, change: request({ label: change.label, command: change.command, input: change.input, revision: change.revision, itemId: change.itemId }) };
  }

  /** @param {Change} change */
  function dismiss(change) { s.changes = s.changes.filter((c) => c !== change); savePending(); notify("changes"); }

  // Pending changes survive a self-reload of the frame (window.name is the only storage).
  function savePending() {
    if (!persist) return;
    const pending = s.changes.filter((c) => c.status === "pending").map((c) => ({ label: c.label, itemId: c.itemId, command: c.command, input: c.input, revision: c.revision, idempotencyKey: c.idempotencyKey, actionId: c.actionId, group: c.group }));
    try {
      const all = JSON.parse(persist.get() || "{}");
      all[PERSIST_KEY] = pending;
      persist.set(JSON.stringify(all));
    } catch { persist.set(JSON.stringify({ [PERSIST_KEY]: pending })); }
  }
  function restorePending() {
    if (!persist) return;
    try {
      const saved = JSON.parse(persist.get() || "{}")[PERSIST_KEY];
      if (!Array.isArray(saved)) return;
      for (const p of saved) {
        if (typeof p?.actionId !== "number" || s.changes.some((c) => c.actionId === p.actionId)) continue;
        s.changes.push({ id: nextChangeId++, group: p.group ?? null, label: String(p.label), itemId: p.itemId ?? null, command: p.command, input: p.input, revision: p.revision,
          idempotencyKey: p.idempotencyKey, status: "pending", actionId: p.actionId, message: "", createdAt: now(), settledAt: null, resultId: null, resultRevision: null, undo: null, undoOf: null, mine: true });
      }
      scheduleOutcomes();
    } catch { /* ignore corrupt state */ }
  }

  // -----------------------------------------------------------------------------------------
  // Documents

  /** @param {any} view */
  async function saveView(view) {
    const saved = await rpc(() => gadget.saveView(view, { actor: me }));
    s.views = [...s.views.filter((v) => v.id !== saved.id), saved];
    notify("views");
    return saved;
  }
  /** @param {string} id */
  async function deleteView(id) {
    await rpc(() => gadget.deleteView(id));
    s.views = s.views.filter((v) => v.id !== id);
    notify("views");
  }
  async function reloadViews() {
    try { s.views = await rpc(() => gadget.listViews()); notify("views"); } catch { /* keep */ }
  }
  /** Merges into the viewer's preferences and saves them (debounced). @param {Record<string, unknown>} patch */
  function setPrefs(patch) {
    s.prefs = { ...s.prefs, ...patch };
    notify("prefs");
    if (!viewer?.id) return;
    if (prefsTimer) clearTimeout(prefsTimer);
    prefsTimer = setTimeout(() => {
      prefsTimer = null;
      const { version: _v, ...body } = s.prefs;
      rpc(() => gadget.savePrefs(viewer.id, body)).catch((err) => console.warn("Could not save preferences:", errorDetail(err)));
    }, 600);
  }
  /** @param {{ keyPrefix: string|null }} settings */
  async function saveSettings(settings) {
    s.settings = await rpc(() => gadget.saveSettings(settings, { actor: me }));
    notify("data", "views");
    return s.settings;
  }

  // -----------------------------------------------------------------------------------------

  async function refresh() {
    if (s.phase === "ready") { await pull(); return; }
    try { await bootstrap(); } catch (err) { stopFor(err); }
    if (s.phase === "ready") await pull();
  }

  const onVisibility = () => { if (doc.visibilityState !== "hidden") { void pull(); schedulePoll(); } };
  doc.addEventListener("visibilitychange", onVisibility);

  const ready = (async () => {
    try { await bootstrap(); } catch (err) { stopFor(err); }
    if (s.phase === "ready") await pull();
    schedulePoll();
  })();

  return {
    ready,
    get phase() { return s.phase; },
    get phaseMessage() { return s.phaseMessage; },
    get connection() { return s.connection; },
    get description() { return s.description; },
    get planning() { return s.planning; },
    get settings() { return s.settings; },
    get views() { return s.views; },
    get prefs() { return s.prefs; },
    get changes() { return s.changes; },
    get sync() { return s.sync; },
    get viewer() { return viewer; },
    get me() { return me; },
    get replica() { return replica; },
    index, canWrite, pendingFor, refresh, pull, createItem, updateItem, bulkUpdate, entity, undo, retry, dismiss,
    saveView, deleteView, reloadViews, setPrefs, saveSettings,
    /** @param {(topics: Set<Topic>) => void} fn */
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** Test hook: run pending notifications now. */
    notify,
    destroy() {
      destroyed = true;
      for (const t of [pollTimer, outcomeTimer, historyTimer, prefsTimer]) if (t) clearTimeout(t);
      doc.removeEventListener("visibilitychange", onVisibility);
      listeners.clear();
    },
  };
}

/** window.name survives a reload of the sandboxed frame; nothing else does. */
function windowNamePersist() {
  if (typeof window === "undefined") return null;
  return { get: () => { try { return window.name; } catch { return ""; } }, set: (/** @type {string} */ v) => { try { window.name = v; } catch { /* ignore */ } } };
}

/** @typedef {ReturnType<typeof createStore>} Store */
