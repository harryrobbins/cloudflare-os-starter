// @ts-check
// The text channel: one Y.Doc per OPEN blip, hydrated through openBlip, local updates batched
// into pushText (TEXT_IDLE_MS idle, TEXT_FLUSH_BYTES pending or TEXT_MAX_WAIT_MS since the oldest
// pending change, one push in flight per client
// across every blip, oldest pending first), every text event applied with origin "remote" (own
// echoes are no-ops; server-made text such as an accepted proposal carries an empty senderId, and
// older servers tagged it with the reviewer's) and advancing textSeq, gaps (prevTextSeq ahead of what we know) repaired through
// openBlip with our state vector, and every open blip resynced after a re-subscribe. The store
// owns connection state and request ids; this module owns docs, batching and per-blip saving.
//
// Blips whose create is still pending (the store has not had the ack) are opened locally at once:
// the doc starts empty, typing queues, and hydration plus pushing wait for the store to call
// blipAcked(id). A refused create fails the text state (the local text is kept; pendingText
// hands it back to the person).

import * as Y from "yjs";
import { TEXT_FLUSH_BYTES, TEXT_IDLE_MS, TEXT_MAX_WAIT_MS, decodeBytes, encodeBytes } from "../../shared/protocol.js";

/** @typedef {import("../store-contract.js").TextState} TextState */
/** @typedef {import("../store-contract.js").TextHandle} TextHandle */
/** @typedef {import("../../shared/protocol.js").TextEvent} TextEvent */
/** @typedef {import("../../shared/protocol.js").ErrorResult} ErrorResult */

export const REMOTE_ORIGIN = "remote";
/** Origin of a carried update re-applied by restoreUpdate (a local change: it is pushed). */
export const RESTORE_ORIGIN = "reinsert";

/**
 * Re-applies unacknowledged local updates carried across a reload (text channel pendingUpdate)
 * to an open blip's doc, as a local change that is then pushed.
 *
 * Why the Yjs update and not the text: the carried updates are the old session's own items, so
 * applying them is idempotent. A push that did reach the server before the reload (its result was
 * simply never seen) changes nothing; edits made by anyone since keep their place, because Yjs
 * items are positioned relative to their neighbours, not by offset; and deletions come back too.
 * Re-inserting the editor's text (or a text diff by offset) duplicates whatever the server already
 * had and misplaces the rest under concurrent edits.
 *
 * The update is first applied to a scratch copy: if it depends on an item the server never
 * received (a push refused outright, whose later edits built on it), nothing is applied and the
 * result is "incomplete" so the caller can hand the text back to the person instead.
 *
 * @param {Y.Doc} doc   the open blip's doc (hydrated from the server)
 * @param {string} update  base64 Yjs V2 update
 * @returns {"applied"|"unchanged"|"incomplete"|"invalid"}
 */
export function restoreUpdate(doc, update) {
  const bytes = decodeBytes(update);
  if (!bytes) return "invalid";
  const scratch = new Y.Doc();
  try {
    Y.applyUpdateV2(scratch, Y.encodeStateAsUpdateV2(doc));
    try {
      Y.applyUpdateV2(scratch, bytes);
    } catch {
      return "invalid";
    }
    if (scratch.store.pendingStructs || scratch.store.pendingDs) return "incomplete";
    const before = doc.getText("t").toString();
    const diff = Y.encodeStateAsUpdateV2(scratch, Y.encodeStateVector(doc));
    Y.applyUpdateV2(doc, diff, RESTORE_ORIGIN);
    return doc.getText("t").toString() === before ? "unchanged" : "applied";
  } finally {
    scratch.destroy();
  }
}

/** A pushText call with no result after this long is treated as failed (and replayed verbatim). */
export const PUSH_TIMEOUT_MS = 30000;
/** Failed sends (rejected or timed out) of one push before the blip's text is marked failed. */
export const MAX_PUSH_FAILURES = 5;
/** Error codes after which a refused push is kept and retried on the next local change. */
const RETRYABLE = new Set(["blip_full", "busy", "limit"]);

/**
 * @typedef {object} Entry
 * @property {string} id
 * @property {Y.Doc} doc
 * @property {Y.Text} text
 * @property {number} refs
 * @property {boolean} hydrated
 * @property {Promise<void>|null} hydrating
 * @property {TextEvent[]} buffered    events received while hydrating
 * @property {Uint8Array[]} pending    local updates not yet sent
 * @property {number} pendingBytes
 * @property {number} pendingSince    when the oldest pending byte was queued
 * @property {number} readyAt         when the pending batch may be sent
 * @property {{requestId: string, update: string, bytes: number, failures: number, token: number, timer: any}|null} inflight
 * @property {{requestId: string, update: string, bytes: number, failures: number}|null} replay  a push whose outcome is unknown
 * @property {boolean} resyncing
 * @property {boolean} resyncAgain
 * @property {boolean} waitingAck    the create is not yet acknowledged
 * @property {boolean} released
 * @property {(() => void)[]} waiters
 * @property {TextState} state
 */

/**
 * @param {object} options
 * @param {any} options.gadget
 * @param {{setTimeout: Function, clearTimeout: Function, now: () => number}} options.timers
 * @param {() => string} options.senderId
 * @param {() => string} options.by
 * @param {() => string} options.nextRequestId
 * @param {() => boolean} options.canSend       the structure channel is live and ready
 * @param {(id: string) => "server"|"pending"|"missing"} options.blipStatus
 * @param {(id: string) => void} options.onRemote        the blip's Y.Text changed remotely
 * @param {(ids: string[]) => void} options.onSaving      per-blip saving state changed
 * @param {(seq: number) => void} options.onSeq          a sequence number was seen
 * @param {(code: string) => void} options.onError
 * @param {() => void} options.onTransportFailure        a call was rejected or timed out
 * @param {Record<string, TextState>} options.states     the store's state.text (mutated in place)
 */
export function createTextChannel(options) {
  const { gadget, timers, states } = options;
  /** @type {Map<string, Entry>} */
  const entries = new Map();
  /** @type {Entry|null} */
  let sending = null;
  /** @type {any} */
  let kickTimer = null;
  let token = 0;
  let disposed = false;

  /** @param {Entry} entry */
  function publish(entry) {
    const s = entry.state;
    const saving = s.lastError ? "failed" : entry.pending.length || entry.inflight || entry.replay ? "saving" : "saved";
    const next = { textSeq: s.textSeq, saving, resyncing: entry.resyncing, lastError: s.lastError };
    const prev = states[entry.id];
    if (prev && prev.saving === next.saving && prev.resyncing === next.resyncing && prev.lastError === next.lastError && prev.textSeq === next.textSeq) return;
    states[entry.id] = next;
    entry.state = next;
    options.onSaving([entry.id]);
  }

  /** @param {Entry} entry */
  function settleWaiters(entry) {
    if (entry.pending.length || entry.inflight || entry.replay) return;
    const waiters = entry.waiters;
    entry.waiters = [];
    for (const w of waiters) w();
    if (entry.refs === 0) release(entry);
  }

  /** @param {Entry} entry */
  function release(entry) {
    if (entry.released) return;
    entry.released = true;
    entries.delete(entry.id);
    if (entry.inflight) timers.clearTimeout(entry.inflight.timer);
    entry.doc.destroy();
    if (states[entry.id]) {
      delete states[entry.id];
      options.onSaving([entry.id]);
    }
  }

  /**
   * @param {Entry} entry
   * @param {Uint8Array} update
   */
  function queueLocal(entry, update) {
    const now = timers.now();
    if (!entry.pending.length) entry.pendingSince = now;
    entry.pending.push(update);
    entry.pendingBytes += update.length;
    // Idle, or at the latest TEXT_MAX_WAIT_MS after the oldest pending change: a typist who never
    // pauses for TEXT_IDLE_MS must still be seen by others.
    entry.readyAt = entry.pendingBytes >= TEXT_FLUSH_BYTES ? now : Math.min(now + TEXT_IDLE_MS, entry.pendingSince + TEXT_MAX_WAIT_MS);
    if (entry.state.lastError && RETRYABLE.has(entry.state.lastError)) entry.state = { ...entry.state, lastError: null };
    publish(entry);
    scheduleKick();
  }

  function scheduleKick() {
    if (disposed) return;
    if (kickTimer) {
      timers.clearTimeout(kickTimer);
      kickTimer = null;
    }
    if (sending) return;
    const now = timers.now();
    let soonest = Infinity;
    for (const e of entries.values()) {
      if ((!e.pending.length && !e.replay) || !sendable(e)) continue;
      if (e.replay) { soonest = now; break; }
      soonest = Math.min(soonest, e.readyAt);
    }
    if (soonest === Infinity) return;
    if (soonest <= now) kick();
    else kickTimer = timers.setTimeout(() => { kickTimer = null; kick(); }, soonest - now);
  }

  /** @param {Entry} e */
  function sendable(e) {
    return !e.waitingAck && !e.resyncing && !e.hydrating && options.blipStatus(e.id) === "server";
  }

  /** Sends the oldest ready batch, if nothing is in flight. */
  function kick() {
    if (disposed || sending || !options.canSend()) return;
    const now = timers.now();
    /** @type {Entry|null} */
    let pick = null;
    for (const e of entries.values()) {
      if (!sendable(e)) continue;
      if (e.replay) { pick = e; break; }
      if (!e.pending.length || e.readyAt > now) continue;
      if (!pick || e.pendingSince < pick.pendingSince) pick = e;
    }
    if (!pick) return; // whoever makes an entry sendable or ready schedules the next kick
    if (pick.replay) {
      send(pick, pick.replay);
      pick.replay = null;
      return;
    }
    const merged = pick.pending.length === 1 ? pick.pending[0] : Y.mergeUpdatesV2(pick.pending);
    pick.pending = [];
    pick.pendingBytes = 0;
    send(pick, { requestId: options.nextRequestId(), update: encodeBytes(merged), bytes: merged.length, failures: 0 });
  }

  /**
   * @param {Entry} entry
   * @param {{requestId: string, update: string, bytes: number, failures: number}} push
   */
  function send(entry, push) {
    const t = ++token;
    const timer = timers.setTimeout(() => onFailure(entry, t), PUSH_TIMEOUT_MS);
    entry.inflight = { ...push, token: t, timer };
    sending = entry;
    publish(entry);
    const request = { senderId: options.senderId(), blipId: entry.id, update: push.update, requestId: push.requestId, by: options.by() };
    Promise.resolve()
      .then(() => gadget.pushText(request))
      .then((res) => onResult(entry, t, res), () => onFailure(entry, t));
  }

  /** @param {Entry} entry @param {number} t */
  function takeInflight(entry, t) {
    if (!entry.inflight || entry.inflight.token !== t) return null;
    const inflight = entry.inflight;
    timers.clearTimeout(inflight.timer);
    entry.inflight = null;
    if (sending === entry) sending = null;
    return inflight;
  }

  /** @param {Entry} entry @param {number} t */
  function onFailure(entry, t) {
    const inflight = takeInflight(entry, t);
    if (!inflight || disposed) return;
    const { token: _t, timer: _timer, ...push } = inflight;
    push.failures++;
    if (push.failures > MAX_PUSH_FAILURES || entry.released) {
      entry.state = { ...entry.state, lastError: "invalid_update" };
      options.onError("invalid_update");
    } else {
      entry.replay = push; // re-sent verbatim after the store has reconnected
    }
    publish(entry);
    settleWaiters(entry);
    options.onTransportFailure();
  }

  /**
   * @param {Entry} entry
   * @param {number} t
   * @param {any} res
   */
  function onResult(entry, t, res) {
    const inflight = takeInflight(entry, t);
    if (!inflight || disposed) return;
    if (!res || typeof res !== "object") {
      onFailure(entry, t);
      return;
    }
    if (typeof res.error === "string") {
      entry.state = { ...entry.state, lastError: res.error };
      if (RETRYABLE.has(res.error)) {
        // Keep the text: the push is retried on the next local change (a deletion may make it fit).
        const bytes = decodeBytes(inflight.update);
        if (bytes) {
          entry.pending.unshift(bytes);
          entry.pendingBytes += bytes.length;
          entry.pendingSince = timers.now();
          entry.readyAt = Infinity;
        }
      }
      options.onError(res.error);
      publish(entry);
      settleWaiters(entry);
      scheduleKick();
      return;
    }
    // textSeq is NOT advanced from the result: results and events travel separately, so a peer's
    // earlier event may still be on its way, and a textSeq past it would make applyEvents skip it
    // as "already have it". The own echo advances textSeq in order (and a lost one shows as a gap).
    if (typeof res.seq === "number") options.onSeq(res.seq);
    entry.state = { ...entry.state, lastError: null };
    publish(entry);
    settleWaiters(entry);
    scheduleKick();
  }

  /**
   * Fetches the blip's state (or the diff against ours) and applies it.
   * @param {Entry} entry
   * @param {boolean} diff  send our state vector
   */
  async function hydrate(entry, diff) {
    /** @type {{blipId: string, stateVector?: string}} */
    const req = { blipId: entry.id };
    if (diff) req.stateVector = encodeBytes(Y.encodeStateVector(entry.doc));
    const res = await gadget.openBlip(req);
    if (disposed || entry.released) return;
    if (!res || typeof res !== "object" || typeof res.error === "string") {
      throw Object.assign(new Error(res?.message ?? "openBlip failed"), { result: res ?? { error: "invalid_argument", message: "no result" } });
    }
    const bytes = decodeBytes(res.update);
    if (!bytes) throw Object.assign(new Error("bad update"), { result: { error: "invalid_update", message: "openBlip returned no update" } });
    applyRemote(entry, bytes);
    if (typeof res.textSeq === "number" && res.textSeq > entry.state.textSeq) entry.state = { ...entry.state, textSeq: res.textSeq };
    if (typeof res.seq === "number") options.onSeq(res.seq);
  }

  /**
   * @param {Entry} entry
   * @param {Uint8Array} bytes
   */
  function applyRemote(entry, bytes) {
    let changed = false;
    const mark = (/** @type {Y.Transaction} */ txn) => { if (txn.changed.size) changed = true; };
    entry.doc.on("afterTransaction", mark);
    try {
      Y.applyUpdateV2(entry.doc, bytes, REMOTE_ORIGIN);
    } finally {
      entry.doc.off("afterTransaction", mark);
    }
    if (changed) options.onRemote(entry.id);
    return changed;
  }

  /** @param {Entry} entry */
  function startHydration(entry) {
    entry.hydrating = hydrate(entry, false).then(() => {
      entry.hydrated = true;
      entry.hydrating = null;
      const buffered = entry.buffered;
      entry.buffered = [];
      applyEvents(buffered);
      publish(entry);
      scheduleKick();
    }, (err) => {
      entry.hydrating = null;
      throw err;
    });
    return entry.hydrating;
  }

  /** @param {Entry} entry */
  function resync(entry) {
    if (disposed || entry.released || !entry.hydrated) return;
    if (entry.resyncing) {
      entry.resyncAgain = true;
      return;
    }
    entry.resyncing = true;
    publish(entry);
    hydrate(entry, true).then(() => {
      entry.resyncing = false;
      if (entry.resyncAgain) {
        entry.resyncAgain = false;
        resync(entry);
      } else {
        publish(entry);
        scheduleKick();
      }
    }, () => {
      entry.resyncing = false;
      publish(entry);
      options.onTransportFailure();
    });
  }

  /** @param {TextEvent[]} events */
  function applyEvents(events) {
    if (disposed) return;
    for (const ev of Array.isArray(events) ? events : [events]) {
      if (!ev || typeof ev !== "object" || typeof ev.blipId !== "string") continue;
      if (typeof ev.seq === "number") options.onSeq(ev.seq);
      const entry = entries.get(ev.blipId);
      if (!entry) continue;
      if (entry.hydrating || !entry.hydrated) {
        entry.buffered.push(ev);
        continue;
      }
      if (entry.resyncing) continue; // the resync's diff covers it
      if (typeof ev.prevTextSeq !== "number" || typeof ev.textSeq !== "number") continue;
      if (ev.textSeq <= entry.state.textSeq) continue; // already have it
      if (ev.prevTextSeq > entry.state.textSeq) {
        resync(entry);
        continue;
      }
      // Own echoes are applied too, not only counted. The server now sends server-made text (an
      // accepted proposal's replacement) with an empty senderId, but a server from before that
      // fix tagged it with the reviewer's, and applying is harmless: Yjs updates are idempotent,
      // so a real echo changes nothing and emits no text change.
      const bytes = decodeBytes(ev.update);
      if (!bytes) {
        resync(entry);
        continue;
      }
      try {
        applyRemote(entry, bytes);
      } catch {
        resync(entry);
        continue;
      }
      entry.state = { ...entry.state, textSeq: ev.textSeq };
      publish(entry);
    }
  }

  /** @param {Entry} entry */
  function makeHandle(entry) {
    let closed = false;
    /** @type {TextHandle} */
    const handle = {
      doc: entry.doc,
      text: entry.text,
      blipId: entry.id,
      whenSaved: () => whenSaved(entry.id),
      close() {
        if (closed) return;
        closed = true;
        entry.refs--;
        if (entry.refs <= 0) {
          entry.refs = 0;
          if (entry.state.lastError && !entry.inflight) {
            // A refused push is not retried once nobody holds the blip; the text is given up.
            entry.pending = [];
            entry.pendingBytes = 0;
            entry.replay = null;
          }
          settleWaiters(entry);
        }
      },
    };
    return handle;
  }

  /** @param {string} id */
  function whenSaved(id) {
    const entry = entries.get(id);
    if (!entry || (!entry.pending.length && !entry.inflight && !entry.replay)) return Promise.resolve();
    return new Promise((resolve) => { entry.waiters.push(resolve); });
  }

  return {
    /**
     * @param {string} id
     * @returns {Promise<TextHandle>}
     */
    async open(id) {
      if (disposed) throw { error: "invalid_argument", message: "disposed" };
      let entry = entries.get(id);
      if (!entry) {
        const status = options.blipStatus(id);
        if (status === "missing") throw { error: "unknown_blip", message: "unknown or deleted blip" };
        const doc = new Y.Doc();
        const text = doc.getText("t");
        /** @type {Entry} */
        const e = entry = {
          id, doc, text, refs: 0, hydrated: status === "pending", hydrating: null, buffered: [], pending: [], pendingBytes: 0,
          pendingSince: 0, readyAt: 0, inflight: null, replay: null, resyncing: false, resyncAgain: false,
          waitingAck: status === "pending", released: false, waiters: [],
          state: { textSeq: 0, saving: "saved", resyncing: false, lastError: null },
        };
        entries.set(id, e);
        doc.on("updateV2", (/** @type {Uint8Array} */ update, /** @type {unknown} */ origin) => {
          if (origin === REMOTE_ORIGIN || e.released) return;
          queueLocal(e, update);
        });
        publish(e);
        if (!e.waitingAck) {
          try {
            await startHydration(e);
          } catch (err) {
            release(e);
            throw /** @type {any} */ (err)?.result ?? { error: "invalid_argument", message: String(err) };
          }
        }
      } else if (entry.hydrating) {
        try {
          await entry.hydrating;
        } catch (err) {
          throw /** @type {any} */ (err)?.result ?? { error: "invalid_argument", message: String(err) };
        }
      }
      entry.refs++;
      return makeHandle(entry);
    },

    /** The create of a locally opened blip was acknowledged: hydrate (merging any seed) and push. */
    blipAcked(/** @type {string} */ id) {
      const entry = entries.get(id);
      if (!entry || !entry.waitingAck) return;
      entry.waitingAck = false;
      entry.hydrated = false;
      startHydration(entry).catch(() => {
        entry.hydrated = true; // keep the local doc usable; the next event or resubscribe resyncs
        publish(entry);
        scheduleKick();
      });
    },

    /** The create of a locally opened blip was refused. */
    blipFailed(/** @type {string} */ id, /** @type {string} */ code) {
      const entry = entries.get(id);
      if (!entry) return;
      entry.state = { ...entry.state, lastError: code };
      publish(entry);
      const waiters = entry.waiters;
      entry.waiters = [];
      for (const w of waiters) w();
    },

    applyEvents,

    /** After a re-subscribe: replay an unsettled push, then resync every open blip. */
    resyncAll() {
      for (const entry of entries.values()) if (entry.hydrated && !entry.waitingAck) resync(entry);
      scheduleKick();
    },

    /** The connection went live (or a blip became sendable): try to send. */
    kick() {
      scheduleKick();
    },

    /** @param {string} id */
    flush(id) {
      const entry = entries.get(id);
      if (entry && entry.pending.length) {
        entry.readyAt = timers.now();
        scheduleKick();
      }
      return whenSaved(id);
    },

    whenSaved,

    /** @param {string} id */
    pendingText(id) {
      const entry = entries.get(id);
      if (!entry) return null;
      if (entry.pending.length || entry.inflight || entry.replay || entry.state.lastError) return entry.text.toString();
      return null;
    },

    /**
     * Every local update of an open blip the server has not acknowledged (the push in flight or
     * awaiting replay, whose outcome is unknown, then the queued ones), merged into one base64 Yjs
     * V2 update; null when there is none. main.js carries it across a reload of the frame so
     * "Re-insert unsaved text" restores exactly the unacknowledged edits (restoreUpdate).
     * @param {string} id
     */
    pendingUpdate(id) {
      const entry = entries.get(id);
      if (!entry) return null;
      /** @type {Uint8Array[]} */
      const parts = [];
      for (const push of [entry.inflight, entry.replay]) {
        const bytes = push ? decodeBytes(push.update) : null;
        if (bytes) parts.push(bytes);
      }
      parts.push(...entry.pending);
      if (!parts.length) return null;
      return encodeBytes(parts.length === 1 ? parts[0] : Y.mergeUpdatesV2(parts));
    },

    /** @param {string} id */
    has(id) {
      return entries.has(id);
    },

    /** The worst saving state across open blips. */
    overall() {
      let worst = "saved";
      for (const s of Object.values(states)) {
        if (s.saving === "failed") return "failed";
        if (s.saving === "saving") worst = "saving";
      }
      return /** @type {"saved"|"saving"|"failed"} */ (worst);
    },

    dispose() {
      disposed = true;
      if (kickTimer) timers.clearTimeout(kickTimer);
      kickTimer = null;
      for (const entry of [...entries.values()]) {
        entry.refs = 0;
        release(entry);
      }
    },
  };
}
