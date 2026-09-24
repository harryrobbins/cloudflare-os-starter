// @ts-check
// The client sync engine: subscription with paged snapshots, the optimistic pending-op queue with
// one serial send, acknowledgement and per-field conflict rebase, server undo/redo, presence and
// heartbeat, gap detection and resync, and the connection/save status (./connection.js).
//
// Model the UI reads (never mutate it):
//   store.objects      Map id -> object: the server state with pending ops applied (optimistic)
//   store.positions    Map layout -> Map id -> {x, y, pin, v}: optimistic positions
//   store.meta         the map's meta (title, description, defaultViewId, revision, ...)
//   store.peers        Map clientId -> presence state of everyone else
//   store.history      newest-first history entries seen so far (loaded on demand, then pushed)
//   store.changesets   Map id -> changeset manifest
//   store.status       {connection, pendingCount, riskOfLoss}
// Listeners get changes: {type: "snapshot"} | {type: "objects", ids} | {type: "positions", layout, ids}
//   | {type: "meta"} | {type: "presence"} | {type: "status"} | {type: "history"} | {type: "changesets"}
//   | {type: "conflict", id, field, mine, theirs, name} | {type: "error", message}
//
// Requests: each carries a requestId `${secret}:${n}`, where `secret` is random per page load (a
// clientId is public, so ids built from it alone could be pre-recorded by a peer). A request whose
// outcome is unknown (the call failed or timed out) is re-sent verbatim, with the same requestId,
// before anything else; the server recognises it and reports the original outcome.
//
// Conflicts: an update whose baseVersion is stale comes back as a conflict. For every field it
// changed, if the server's current value still equals the value the edit started from, the edit is
// re-sent on the new version; otherwise the other person's value stands and a "conflict" change
// carries this user's value so the UI can offer to apply it again. A conflicting delete is dropped
// with a notice. Moves without a base are last-writer-wins.

import { PRESENCE_HEARTBEAT_MS, PRESENCE_STALE_MS, canonicalJson, isId, isObject } from "../../shared/protocol.js";
import { SLOW_SAVE_MS, deriveState, riskOfLoss } from "./connection.js";

export const REQUEST_TIMEOUT_MS = 30_000;
export const BACKOFF_BASE_MS = 500;
export const BACKOFF_MAX_MS = 10_000;
export const GAP_GRACE_MS = 1500;
export const UNRECOVERABLE_FAILURES = 3;
export const PRESENCE_MIN_MS = 50;
export const MAX_REBASES = 5;
export const MAX_BUFFERED_EVENTS = 2000;

/** @param {number} n */
function randomHex(n) {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** @param {unknown} a @param {unknown} b */
const sameValue = (a, b) => canonicalJson(a ?? null) === canonicalJson(b ?? null);

/**
 * Errors that mean the RPC stub itself is dead (the platform replaced the facet), as opposed to a
 * refused call. The platform never repairs such a stub; only a frame reload does. After a code
 * edit the real Workshop fails every call on the old stub with "Gadget restarted due to code
 * update." (overseer.ts bumpVersion -> ctx.facets.abort), hence `restart`.
 * @param {unknown} e
 */
export function isTransportError(e) {
  const m = String(/** @type {any} */ (e)?.message ?? e);
  return /disposed|broken|connection|network|closed|RPC|session|stub|facet|abort|timed out|reset|restart/i.test(m);
}

/**
 * @param {{gadget: any, RpcTarget: any, viewer: {clientId: string, name: string, color: string},
 *   timers?: any, onReloadRequest?: () => boolean}} options
 *   onReloadRequest: called when the stub is dead and nothing is unsaved; returns true if it reloads.
 */
export function createStore(options) {
  const { RpcTarget } = options;
  let gadget = options.gadget;
  const timers = options.timers ?? {
    setTimeout: (/** @type {any} */ f, /** @type {number} */ ms) => globalThis.setTimeout(f, ms),
    clearTimeout: (/** @type {any} */ t) => globalThis.clearTimeout(t),
    now: () => Date.now(),
  };
  const viewer = { ...options.viewer };
  const secret = randomHex(8);
  let requestSeq = 0;
  const nextRequestId = () => `${secret}:${++requestSeq}`;

  // --- Server model (acknowledged state) ---
  /** @type {Map<string, any>} */
  const server = new Map();
  /** @type {Map<string, Map<string, any>>} */
  const serverPos = new Map();
  /** @type {Map<string, Set<string>>} element id -> connection ids (server state) */
  const serverAdj = new Map();
  /** @type {any} */
  let meta = null;
  let revision = 0;

  /** @param {any} o @param {boolean} add */
  function indexConnection(o, add) {
    if (!o || o.id[0] !== "c") return;
    for (const end of [o.from, o.to]) {
      let set = serverAdj.get(end);
      if (!set) { if (!add) continue; serverAdj.set(end, (set = new Set())); }
      if (add) set.add(o.id);
      else { set.delete(o.id); if (!set.size) serverAdj.delete(end); }
    }
  }
  /** @param {string} id @param {any} value */
  function serverSet(id, value) {
    indexConnection(server.get(id), false);
    if (value) { server.set(id, value); indexConnection(value, true); }
    else server.delete(id);
  }

  // --- Optimistic view ---
  /** @type {Map<string, any>} */
  const objects = new Map();
  /** @type {Map<string, Map<string, any>>} */
  const positions = new Map();

  // --- Pending ---
  /**
   * @typedef {{kind: "op", op: any, prev?: Record<string, unknown>, rebases?: number} |
   *   {kind: "structure", structure: any}} Pending
   * @typedef {{requestId: string, items: Pending[], request: any, sentAt: number}} Batch
   */
  /** @type {Pending[]} */
  let queue = [];
  /** @type {Batch|null} */
  let inflight = null;
  /** @type {Batch|null} */
  let replay = null;
  let sendFailures = 0;
  /** @type {any} */
  let retryTimer = null;
  /** @type {number|null} */
  let oldestPendingAt = null;

  // --- Subscription ---
  let generation = 0;
  let ready = false;
  /** @type {any[]} */
  let buffered = [];
  /** @type {string|null} */
  let session = null;
  /** @type {"connecting"|"live"|"reconnecting"} */
  let link = "connecting";
  let recoveryRequired = false;
  let busy = 0;
  let transportFailures = 0;
  /** @type {any} */
  let heartbeat = null;
  /** @type {any} */
  let gapTimer = null;
  let disposed = false;
  /** @type {any} */
  let callbackTarget = null;

  // --- Presence ---
  /** @type {Map<string, any>} */
  const peers = new Map();
  /** @type {Record<string, any>} */
  let presenceWanted = {};
  let presenceDirty = false;
  let presenceInflight = false;
  let lastPresenceAt = 0;
  /** @type {any} */
  let presenceTimer = null;

  // --- Other state ---
  /** @type {any[]} */
  let history = [];
  let historyLoaded = false;
  /** @type {Map<string, any>} */
  const changesets = new Map();

  /** @type {Set<(change: any) => void>} */
  const listeners = new Set();
  /** @param {any} change */
  const notify = (change) => {
    for (const l of [...listeners]) {
      try { l(change); } catch (e) { console.error(e); }
    }
  };

  const status = { connection: /** @type {string} */ ("connecting"), pendingCount: 0, riskOfLoss: false };
  function updateStatus() {
    const pendingCount = queue.length + (inflight?.items.length ?? 0) + (replay?.items.length ?? 0);
    if (!pendingCount) oldestPendingAt = null;
    else if (oldestPendingAt === null) oldestPendingAt = timers.now();
    const connection = deriveState({ link, pendingCount, busy: busy > 0, recoveryRequired });
    const risk = riskOfLoss({ state: /** @type {any} */ (connection), pendingCount, oldestPendingAt, now: timers.now() });
    if (connection !== status.connection || pendingCount !== status.pendingCount || risk !== status.riskOfLoss) {
      status.connection = connection;
      status.pendingCount = pendingCount;
      status.riskOfLoss = risk;
      notify({ type: "status" });
    }
  }
  const riskTicker = timers.setTimeout(function tick() {
    if (disposed) return;
    updateStatus();
    timers.setTimeout(tick, SLOW_SAVE_MS / 2);
  }, SLOW_SAVE_MS / 2);
  void riskTicker;

  // --- Optimistic recomputation ---------------------------------------------------------------

  /** All pending ops in queue order (replay, inflight, queue). */
  function* pendingOps() {
    for (const b of [replay, inflight]) if (b) for (const it of b.items) if (it.kind === "op") yield it.op;
    for (const it of queue) if (it.kind === "op") yield it.op;
  }

  /**
   * Recomputes the optimistic value of `ids` (objects) and `posIds` (layout -> ids).
   * @param {Iterable<string>} ids @param {Map<string, Set<string>>} [posIds]
   * @returns {{ids: Set<string>, pos: Map<string, Set<string>>}} what changed
   */
  function recompute(ids, posIds = new Map()) {
    const want = new Set(ids);
    // An element's connections follow it: hidden with it, back with it.
    for (const id of ids) if (id[0] === "e") for (const c of serverAdj.get(id) ?? []) want.add(c);
    /** @type {Map<string, any>} */
    const next = new Map();
    for (const id of want) next.set(id, server.get(id) ?? null);
    /** @type {Map<string, Map<string, any>>} */
    const nextPos = new Map();
    for (const [layout, set] of posIds) {
      const m = new Map();
      for (const id of set) m.set(id, serverPos.get(layout)?.get(id) ?? null);
      nextPos.set(layout, m);
    }
    for (const op of pendingOps()) {
      if (op.op === "create" && want.has(op.object.id)) next.set(op.object.id, { version: 0, ...op.object });
      else if (op.op === "update" && want.has(op.id)) {
        const cur = next.get(op.id);
        if (cur) next.set(op.id, applyPatch(cur, op.patch));
      } else if (op.op === "delete" && want.has(op.id)) next.set(op.id, null);
      else if (op.op === "move") {
        const m = nextPos.get(op.layout);
        if (!m) continue;
        for (const item of op.items) {
          if (!m.has(item.id)) continue;
          const cur = m.get(item.id);
          m.set(item.id, { x: item.x, y: item.y, pin: typeof item.pin === "boolean" ? item.pin : cur?.pin ?? false, v: cur?.v ?? 0 });
        }
      }
    }
    // A deleted element takes its connections with it (the server cascades the same way).
    const present = (/** @type {string} */ id) => (next.has(id) ? next.get(id) !== null : objects.has(id));
    for (const [id, value] of next) {
      if (value && id[0] === "c" && (!present(value.from) || !present(value.to))) next.set(id, null);
    }
    const changed = new Set();
    for (const [id, value] of next) {
      if (value === null) { if (objects.delete(id)) changed.add(id); }
      else if (objects.get(id) !== value) { objects.set(id, value); changed.add(id); }
    }
    const pos = new Map();
    for (const [layout, m] of nextPos) {
      let target = positions.get(layout);
      if (!target) positions.set(layout, (target = new Map()));
      const set = new Set();
      for (const [id, p] of m) {
        const old = target.get(id);
        if (!p) { if (target.delete(id)) set.add(id); }
        else if (!old || old.x !== p.x || old.y !== p.y || old.pin !== p.pin) { target.set(id, p); set.add(id); }
      }
      if (set.size) pos.set(layout, set);
    }
    return { ids: changed, pos };
  }

  /** @param {any} cur @param {Record<string, any>} patch */
  function applyPatch(cur, patch) {
    const next = { ...cur };
    for (const [k, v] of Object.entries(patch)) {
      if (k === "fields" && isObject(v)) {
        const fields = { ...(cur.fields ?? {}) };
        for (const [fid, fv] of Object.entries(v)) {
          if (fv === null || fv === undefined || fv === "") delete fields[fid];
          else fields[fid] = fv;
        }
        next.fields = fields;
      } else if (v === null || v === undefined) delete next[k];
      else next[k] = v;
    }
    return next;
  }

  /** @param {{ids: Set<string>, pos: Map<string, Set<string>>}} changed */
  function announce(changed) {
    if (changed.ids.size) notify({ type: "objects", ids: changed.ids });
    for (const [layout, ids] of changed.pos) notify({ type: "positions", layout, ids });
  }

  /** @param {Pending[]} items */
  function refsOf(items) {
    const ids = new Set();
    /** @type {Map<string, Set<string>>} */
    const pos = new Map();
    for (const it of items) {
      if (it.kind !== "op") continue;
      const op = it.op;
      if (op.op === "create") ids.add(op.object.id);
      else if (op.op === "move") {
        let set = pos.get(op.layout);
        if (!set) pos.set(op.layout, (set = new Set()));
        for (const item of op.items) set.add(item.id);
      } else ids.add(op.id);
    }
    return { ids, pos };
  }

  // --- Snapshot -------------------------------------------------------------------------------

  /** @param {any} first */
  async function loadSnapshot(first) {
    const all = [...first.objects];
    const pos = [...first.positions];
    let next = first.next;
    while (next !== null && next !== undefined) {
      const page = await gadget.snapshotPage(first.token, next);
      if (page.expired) throw new Error("snapshot expired");
      all.push(...page.objects);
      pos.push(...page.positions);
      next = page.next;
    }
    return { revision: first.revision, meta: first.meta, objects: all, positions: pos };
  }

  /** @param {{revision: number, meta: any, objects: any[], positions: any[]}} snap */
  function installSnapshot(snap) {
    server.clear();
    serverAdj.clear();
    for (const o of snap.objects) serverSet(o.id, o);
    serverPos.clear();
    for (const col of snap.positions) {
      const m = new Map();
      for (let i = 0; i < col.ids.length; i++) m.set(col.ids[i], { x: col.x[i], y: col.y[i], pin: col.pin[i] === "1", v: col.v[i] });
      serverPos.set(col.layout, m);
    }
    meta = snap.meta;
    revision = snap.revision;
    objects.clear();
    positions.clear();
    for (const [id, o] of server) objects.set(id, o);
    for (const [layout, m] of serverPos) positions.set(layout, new Map(m));
    const refs = refsOf([...(replay?.items ?? []), ...(inflight?.items ?? []), ...queue]);
    recompute(refs.ids, refs.pos);
    notify({ type: "snapshot" });
    notify({ type: "meta" });
  }

  // --- Events ---------------------------------------------------------------------------------

  /** @param {any} ev */
  function applyEvent(ev) {
    if (ev.type === "changeset") {
      changesets.set(ev.changeset.id, ev.changeset);
      notify({ type: "changesets" });
      return;
    }
    if (ev.type !== "operation") return;
    if (ev.revision <= revision) return;
    if (ev.revision > revision + 1) {
      // Missed something (should not happen: the hub delivers in order): resync.
      scheduleResync(ev.revision);
      return;
    }
    revision = ev.revision;
    const ids = new Set();
    for (const o of ev.upserts) { serverSet(o.id, o); ids.add(o.id); }
    for (const id of ev.deletes) { serverSet(id, null); ids.add(id); }
    /** @type {Map<string, Set<string>>} */
    const posIds = new Map();
    for (const m of ev.moves ?? []) {
      let target = serverPos.get(m.layout);
      if (!target) serverPos.set(m.layout, (target = new Map()));
      const set = new Set();
      for (let i = 0; i < m.ids.length; i++) { target.set(m.ids[i], { x: m.x[i], y: m.y[i], pin: m.pin[i] === "1", v: m.v[i] }); set.add(m.ids[i]); }
      for (const id of m.unset ?? []) { target.delete(id); set.add(id); }
      posIds.set(m.layout, set);
    }
    if (ev.structure) {
      meta = { ...meta, ...ev.structure, revision: ev.revision };
      notify({ type: "meta" });
    }
    if (meta) meta = { ...meta, revision: ev.revision, graphRevision: ev.graphRevision };
    if (ev.history) {
      history = [ev.history, ...history.filter((h) => h.id !== ev.history.id)].slice(0, 200);
      if (ev.history.undoOf) history = history.map((h) => (h.id === ev.history.undoOf ? { ...h, undoneBy: ev.history.id } : h));
      notify({ type: "history" });
    }
    announce(recompute(ids, posIds));
  }

  let gapTarget = 0;
  /**
   * Resyncs if this client is still behind `target` after GAP_GRACE_MS (an event may simply be on
   * its way). Without a target, resyncs unconditionally.
   * @param {number} [target]
   */
  function scheduleResync(target = Infinity) {
    gapTarget = Math.max(gapTarget, target);
    if (gapTimer) return;
    gapTimer = timers.setTimeout(() => {
      gapTimer = null;
      const t = gapTarget;
      gapTarget = 0;
      if (revision < t) resubscribe();
    }, GAP_GRACE_MS);
  }

  // --- Subscribe ------------------------------------------------------------------------------

  function makeCallback(gen) {
    const Base = RpcTarget ?? class {};
    class Callback extends Base {
      /** @param {any} ev */
      operation(ev) {
        if (gen !== generation || disposed) return;
        if (!ready) {
          // A snapshot that takes too long to page restarts rather than buffering without bound.
          if (buffered.length >= MAX_BUFFERED_EVENTS) { buffered = []; resubscribe(); return; }
          buffered.push(ev);
        }
        else applyEvent(ev);
      }
      /** @param {any[]} events */
      presence(events) {
        if (gen !== generation || disposed) return;
        for (const ev of events) {
          if (ev.clientId === viewer.clientId) continue;
          if (ev.type === "leave") peers.delete(ev.clientId);
          else peers.set(ev.clientId, { ...ev, seenAt: timers.now() });
        }
        notify({ type: "presence" });
      }
    }
    return new Callback();
  }

  let subscribing = false;
  async function subscribe() {
    if (disposed || subscribing) return;
    subscribing = true;
    const gen = ++generation;
    ready = false;
    buffered = [];
    try {
      try { callbackTarget?.[Symbol.dispose]?.(); } catch { /* ignore */ }
      callbackTarget = makeCallback(gen);
      const first = await gadget.subscribe(callbackTarget, { clientId: viewer.clientId, name: viewer.name, color: viewer.color, session });
      if (gen !== generation) return;
      session = first.session;
      const snap = await loadSnapshot(first);
      if (gen !== generation) return;
      installSnapshot(snap);
      ready = true;
      const pendingEvents = buffered;
      buffered = [];
      for (const ev of pendingEvents) applyEvent(ev);
      link = "live";
      recoveryRequired = false;
      transportFailures = 0;
      peers.clear();
      notify({ type: "presence" });
      updateStatus();
      startHeartbeat();
      flush();
      sendPresence();
      loadChangesets();
    } catch (e) {
      if (gen !== generation) return;
      const msg = String(/** @type {any} */ (e)?.message ?? e);
      if (/clientId in use/.test(msg)) viewer.clientId = randomHex(8);
      failTransport(e);
      retrySubscribe();
    } finally {
      subscribing = false;
    }
  }

  let subscribeRetries = 0;
  function retrySubscribe() {
    if (disposed) return;
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** subscribeRetries++);
    timers.setTimeout(() => { subscribe(); }, delay);
  }

  function resubscribe() {
    if (disposed) return;
    link = link === "connecting" ? "connecting" : "reconnecting";
    updateStatus();
    subscribeRetries = 0;
    subscribe();
  }

  /**
   * A call failed. A transport failure on a live link starts a resubscribe; failed subscribes
   * count too, so a dead stub (the facet restarted) reaches UNRECOVERABLE_FAILURES quickly. Then
   * the frame reloads if nothing is unsaved, else the recovery screen holds the unsaved changes
   * (retries continue meanwhile).
   * @param {unknown} e
   */
  function failTransport(e) {
    if (!isTransportError(e)) return;
    transportFailures++;
    if (transportFailures >= UNRECOVERABLE_FAILURES && !recoveryRequired) {
      const pending = queue.length + (inflight?.items.length ?? 0) + (replay?.items.length ?? 0);
      if (!pending && options.onReloadRequest?.()) return;
      recoveryRequired = true;
    }
    if (link === "live") {
      link = "reconnecting";
      timers.setTimeout(() => resubscribe(), 0);
    }
    updateStatus();
  }

  async function loadChangesets() {
    try {
      const list = await gadget.listChangesets();
      for (const m of list) changesets.set(m.id, m);
      notify({ type: "changesets" });
    } catch { /* not critical */ }
  }

  // --- Heartbeat and presence -----------------------------------------------------------------

  function startHeartbeat() {
    if (heartbeat) timers.clearTimeout(heartbeat);
    const beat = async () => {
      if (disposed) return;
      heartbeat = timers.setTimeout(beat, PRESENCE_HEARTBEAT_MS);
      if (link !== "live") return;
      if (timers.now() - lastPresenceAt < PRESENCE_HEARTBEAT_MS / 2) return;
      presenceDirty = true;
      sendPresence();
    };
    heartbeat = timers.setTimeout(beat, PRESENCE_HEARTBEAT_MS);
    // Drop peers that stopped heart-beating.
    const expire = () => {
      if (disposed) return;
      const now = timers.now();
      let changed = false;
      for (const [id, p] of peers) if (now - p.seenAt > PRESENCE_STALE_MS + 4000) { peers.delete(id); changed = true; }
      if (changed) notify({ type: "presence" });
      timers.setTimeout(expire, 2000);
    };
    timers.setTimeout(expire, 2000);
  }

  async function sendPresence() {
    if (presenceInflight || link !== "live" || !session) return;
    const wait = PRESENCE_MIN_MS - (timers.now() - lastPresenceAt);
    if (wait > 0) {
      if (!presenceTimer) presenceTimer = timers.setTimeout(() => { presenceTimer = null; sendPresence(); }, wait);
      return;
    }
    presenceInflight = true;
    presenceDirty = false;
    lastPresenceAt = timers.now();
    try {
      const res = await gadget.updatePresence({ clientId: viewer.clientId, session, name: viewer.name, color: viewer.color, ...presenceWanted });
      transportFailures = 0;
      if (!res.known) resubscribe();
      else if (res.revision > revision) {
        // Behind the server: an event may still be on its way; resync if it does not arrive.
        scheduleResync(res.revision);
      }
    } catch (e) {
      failTransport(e);
    } finally {
      presenceInflight = false;
      if (presenceDirty) sendPresence();
    }
  }

  // --- Sending --------------------------------------------------------------------------------

  function flush() {
    if (disposed || inflight || link !== "live") return;
    /** @type {Batch|null} */
    let batch = replay;
    replay = null;
    if (!batch) {
      if (!queue.length) { updateStatus(); return; }
      // Take ops up to the request limits; a structure change goes alone with them.
      const items = [];
      let moves = 0;
      while (queue.length && items.length < 1000) {
        const it = queue[0];
        if (it.kind === "op" && it.op.op === "move") {
          if (moves + it.op.items.length > 2000 && items.length) break;
          moves += it.op.items.length;
        }
        items.push(/** @type {Pending} */ (queue.shift()));
      }
      const ops = items.filter((i) => i.kind === "op").map((i) => /** @type {any} */ (i).op);
      const structures = items.filter((i) => i.kind === "structure").map((i) => /** @type {any} */ (i).structure);
      const structure = structures.length ? Object.assign({}, ...structures) : undefined;
      const requestId = nextRequestId();
      batch = { requestId, items, request: { senderId: viewer.clientId, by: viewer.name, requestId, ops, structure }, sentAt: timers.now() };
    }
    send(batch);
  }

  /** @param {Batch} batch */
  async function send(batch) {
    inflight = batch;
    updateStatus();
    const timeout = new Promise((_, reject) => timers.setTimeout(() => reject(new Error("request timed out")), REQUEST_TIMEOUT_MS));
    try {
      const result = await Promise.race([gadget.applyOperation(batch.request), timeout]);
      sendFailures = 0;
      transportFailures = 0;
      inflight = null;
      settle(batch, result);
    } catch (e) {
      inflight = null;
      sendFailures++;
      replay = batch; // outcome unknown: re-send verbatim
      failTransport(e);
      if (!isTransportError(e) && sendFailures >= 3) {
        // A refused call (not the transport): drop it and tell the user.
        replay = null;
        const refs = refsOf(batch.items);
        announce(recompute(refs.ids, refs.pos));
        notify({ type: "error", message: `A change could not be saved: ${String(/** @type {any} */ (e)?.message ?? e).slice(0, 200)}` });
        sendFailures = 0;
      }
      updateStatus();
      if (retryTimer) timers.clearTimeout(retryTimer);
      retryTimer = timers.setTimeout(() => { retryTimer = null; flush(); }, Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** sendFailures));
      return;
    }
    updateStatus();
    flush();
  }

  /**
   * Applies a request's result: acknowledged ops leave the queue; conflicts rebase or are dropped.
   * @param {Batch} batch @param {any} result
   */
  function settle(batch, result) {
    // Server state from the result (the echo event may come before or after; both are idempotent).
    // A replayed (duplicate) result carries no data: it must never stand in for the event of its
    // revision, or a later change could be skipped. Its event, or a resync, brings the state.
    if (result.duplicate) {
      if (result.revision > revision) scheduleResync(result.revision);
    } else if (result.revision > revision && result.history && result.revision === revision + 1) {
      applyEvent({ type: "operation", revision: result.revision, graphRevision: meta?.graphRevision, upserts: result.upserts, deletes: result.deletes, moves: result.moves, structure: result.structure, history: result.history });
    } else if (result.revision > revision) scheduleResync(result.revision);
    const byIndex = new Map((result.errors ?? []).filter((/** @type {any} */ e) => e.index >= 0).map((/** @type {any} */ e) => [e.index, e]));
    const conflictIds = new Map((result.conflicts ?? []).filter((/** @type {any} */ c) => c.id && !c.layout).map((/** @type {any} */ c) => [c.id, c]));
    /** @type {Pending[]} */
    const again = [];
    const ops = batch.items.filter((i) => i.kind === "op");
    ops.forEach((it, index) => {
      const op = /** @type {any} */ (it).op;
      const err = byIndex.get(index);
      if (err) {
        notify({ type: "error", message: err.message, id: op.id ?? op.object?.id });
        return;
      }
      if (op.op === "update" && conflictIds.has(op.id)) {
        const c = conflictIds.get(op.id);
        // Events can arrive before results: never go back to an older version.
        const newest = newer(c.current);
        const rebased = rebase(/** @type {any} */ (it), newest);
        if (rebased) again.push(rebased);
      } else if (op.op === "delete" && conflictIds.has(op.id)) {
        const c = conflictIds.get(op.id);
        if (c.current) {
          newer(c.current);
          notify({ type: "error", message: `“${c.current.label ?? c.current.name ?? "An item"}” was changed by someone else, so it was not deleted. Delete it again if you still want to.` });
        }
      }
    });
    if (result.duplicate && result.errors?.some((/** @type {any} */ e) => e.code === "request_reused")) scheduleResync(Infinity);
    if (again.length) queue = [...again, ...queue];
    const refs = refsOf(batch.items);
    announce(recompute(refs.ids, refs.pos));
  }

  /**
   * The newer of a conflict's `current` and what this client already has (which it keeps).
   * @param {any|null} current
   */
  function newer(current) {
    if (!current) return null;
    const known = server.get(current.id);
    if (known && known.version >= current.version) return known;
    serverSet(current.id, current);
    return current;
  }

  /**
   * @param {{kind: "op", op: any, prev?: Record<string, unknown>, rebases?: number}} it
   * @param {any|null} current
   * @returns {Pending|null}
   */
  function rebase(it, current) {
    if (!current) {
      notify({ type: "error", message: "Something you edited was deleted by someone else." });
      return null;
    }
    if ((it.rebases ?? 0) >= MAX_REBASES) return null;
    /** @type {Record<string, any>} */
    const patch = {};
    const prev = it.prev ?? {};
    for (const [k, mine] of Object.entries(it.op.patch)) {
      if (k === "fields" && isObject(mine)) {
        /** @type {Record<string, unknown>} */
        const f = {};
        for (const [fid, v] of Object.entries(mine)) {
          const was = /** @type {any} */ (prev.fields)?.[fid];
          const theirs = current.fields?.[fid];
          if (sameValue(theirs, was)) f[fid] = v;
          else if (!sameValue(theirs, v)) notify({ type: "conflict", id: current.id, field: `fields.${fid}`, mine: v, theirs, name: current.label ?? current.name });
        }
        if (Object.keys(f).length) patch.fields = f;
      } else if (sameValue(current[k], prev[k])) patch[k] = mine;
      else if (!sameValue(current[k], mine)) notify({ type: "conflict", id: current.id, field: k, mine, theirs: current[k], name: current.label ?? current.name });
    }
    if (!Object.keys(patch).length) return null;
    return { kind: "op", op: { op: "update", id: current.id, baseVersion: current.version, patch }, prev: it.prev, rebases: (it.rebases ?? 0) + 1 };
  }

  // --- Public API -----------------------------------------------------------------------------

  /**
   * Queues ops (optimistic). An update may carry the values it started from in `prev` (field ->
   * value); when omitted they are read from the current optimistic object.
   * @param {any[]} ops @param {{structure?: any}} [extra]
   */
  function apply(ops, extra = {}) {
    /** @type {Pending[]} */
    const items = [];
    for (const op of ops) {
      if (op.op === "update") {
        const cur = objects.get(op.id);
        /** @type {Record<string, unknown>} */
        const prev = {};
        for (const k of Object.keys(op.patch)) {
          if (k === "fields") {
            /** @type {Record<string, unknown>} */
            const f = {};
            for (const fid of Object.keys(op.patch.fields ?? {})) f[fid] = cur?.fields?.[fid];
            prev.fields = f;
          } else prev[k] = cur?.[k];
        }
        items.push({ kind: "op", op: { ...op, baseVersion: op.baseVersion ?? cur?.version ?? 0 }, prev });
      } else if (op.op === "delete") {
        const cur = objects.get(op.id);
        items.push({ kind: "op", op: { ...op, baseVersion: op.baseVersion ?? cur?.version ?? 0 } });
      } else items.push({ kind: "op", op });
    }
    if (extra.structure) items.push({ kind: "structure", structure: extra.structure });
    queue.push(...items);
    const refs = refsOf(items);
    announce(recompute(refs.ids, refs.pos));
    if (extra.structure) {
      meta = { ...meta, ...extra.structure };
      notify({ type: "meta" });
    }
    updateStatus();
    flush();
  }

  /** @param {any} partial presence fields */
  function setPresence(partial) {
    presenceWanted = { ...presenceWanted, ...partial };
    presenceDirty = true;
    sendPresence();
  }

  /** Waits until nothing is queued or in flight (or `ms` passes). @param {number} [ms] */
  function settled(ms = 10_000) {
    return new Promise((resolve) => {
      const start = timers.now();
      const check = () => {
        if ((!queue.length && !inflight && !replay) || timers.now() - start > ms) resolve(undefined);
        else timers.setTimeout(check, 30);
      };
      check();
    });
  }

  /**
   * Server undo: the newest undoable change of this user (or `historyId`). Unless `quiet`, the
   * outcome is also announced as an error change (a toast).
   * @param {string} [historyId] @param {{quiet?: boolean}} [opts]
   */
  async function undo(historyId, { quiet = false } = {}) {
    await settled();
    busy++;
    updateStatus();
    try {
      const result = await gadget.undo({ senderId: viewer.clientId, by: viewer.name, requestId: nextRequestId(), historyId });
      if (quiet) return result;
      if (result.errors?.length && result.status === "unchanged") notify({ type: "error", message: result.errors[0].message });
      else if (result.conflicts?.length) notify({ type: "error", message: `Undone, except ${result.conflicts.length} item${result.conflicts.length === 1 ? "" : "s"} changed since (kept as they are now).` });
      return result;
    } catch (e) {
      failTransport(e);
      notify({ type: "error", message: "Undo failed: " + String(/** @type {any} */ (e)?.message ?? e).slice(0, 160) });
      return null;
    } finally {
      busy--;
      updateStatus();
    }
  }

  /** Redo: undo this user's newest undo that is not itself undone. */
  async function redo() {
    await ensureHistory();
    const entry = history.find((h) => h.by === viewer.name && h.undoOf && !h.undoneBy && h.undoable);
    if (!entry) { notify({ type: "error", message: "Nothing to redo" }); return null; }
    return undo(entry.id);
  }

  async function ensureHistory() {
    if (historyLoaded) return history;
    try {
      const list = await gadget.getHistory(200);
      const known = new Set(history.map((h) => h.id));
      history = [...history, ...list.filter((/** @type {any} */ h) => !known.has(h.id))].sort((a, b) => b.revision - a.revision);
      historyLoaded = true;
      notify({ type: "history" });
    } catch (e) { failTransport(e); }
    return history;
  }

  /** @param {string} name @param {...any} args */
  async function call(name, ...args) {
    busy++;
    updateStatus();
    try {
      return await gadget[name](...args);
    } catch (e) {
      failTransport(e);
      throw e;
    } finally {
      busy--;
      updateStatus();
    }
  }

  /** What is unsaved, for the recovery screen. */
  function getRecoveryData() {
    const items = [...(replay?.items ?? []), ...(inflight?.items ?? []), ...queue];
    return {
      format: "network-map-recovery", version: 1, savedAt: new Date(timers.now()).toISOString(),
      title: meta?.title ?? "", ops: items.filter((i) => i.kind === "op").map((i) => /** @type {any} */ (i).op),
    };
  }

  function dispose() {
    disposed = true;
    generation++;
    if (heartbeat) timers.clearTimeout(heartbeat);
    try { gadget.leavePresence(viewer.clientId, session); } catch { /* ignore */ }
    try { callbackTarget?.[Symbol.dispose]?.(); } catch { /* ignore */ }
  }

  const store = {
    objects, positions, peers, changesets, status, viewer,
    get meta() { return meta; },
    get revision() { return revision; },
    get history() { return history; },
    /** @param {(change: any) => void} fn */
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    start: () => subscribe(),
    apply, setPresence, undo, redo, ensureHistory, call, settled, getRecoveryData, dispose, resubscribe,
    /** A fresh id of `kind` (see protocol ID_PREFIX). */
    newId: (/** @type {string} */ prefix) => `${prefix}_${randomHex(6)}`,
    /** @param {any} target */
    replaceTarget(target) { gadget = target; resubscribe(); },
    isId,
  };
  return store;
}
