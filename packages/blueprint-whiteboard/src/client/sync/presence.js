// @ts-check
// The client presence session: adaptive send policy for this viewer's cursor, viewport, selection,
// gesture ghosts and editing state. Split from the sync store; it knows nothing of the board.
//
// Heartbeat health is separate from visual-state publication:
//   - boundaries are sent at once: join, selection or editing changes, gesture start/end
//     (transforms/stroke appearing or clearing), pointer leave/re-entry (cursor null <-> set),
//     visibility changes and explicit flushes;
//   - continuous movement (cursor, viewport, transforms, stroke points) is capped at
//     PRESENCE_MOVE_MS (about 20 Hz), and a state equal to the last one sent once rounded is skipped;
//   - the gap widens with the number of peers, while an operation request is in flight, and with
//     the measured round trip of presence calls (the gadget serves calls one at a time);
//   - idle, only the heartbeat is sent, and not even that when a send happened recently;
//   - a hidden tab clears its cursor and gesture ghosts once, then sends heartbeats only.
// At most one updatePresence is in flight: a gadget serves inbound calls one at a time, so
// unawaited sends would queue for seconds on the real platform. All server-side protections (token
// bucket, coalescing, byte cap, slow-subscriber eviction, session validation) stay in the hub.

import { PRESENCE_HEARTBEAT_MS } from "../../shared/protocol.js";

/** @typedef {import("../../shared/protocol.js").PresenceState} PresenceState */
/** @typedef {Omit<PresenceState, "clientId"|"name"|"color">} LocalPresence */

/** Minimum gap between movement sends (about 20 Hz). */
export const PRESENCE_MOVE_MS = 50;
/** [peer count, multiplier]: with at least that many peers the movement gap is multiplied. */
export const PRESENCE_CROWD_STEPS = /** @type {const} */ ([[50, 8], [25, 4], [10, 2]]);
/** The round-trip backoff never widens the movement gap beyond this. */
export const PRESENCE_BACKOFF_MAX_MS = 1000;
/**
 * An updatePresence call not settled after this long counts as one presence failure (heartbeats
 * keep skipping while it is outstanding); so does a rejected call.
 */
export const PRESENCE_TIMEOUT_MS = 10000;
/** Presence failures in a row (timeouts or rejections) after which the store re-subscribes. */
export const PRESENCE_FAILURES_TO_RESUBSCRIBE = 3;
/** After a rejected updatePresence, the next one is sent this soon rather than at the next heartbeat. */
export const PRESENCE_RETRY_MS = 500;
/** A heartbeat is skipped when any send happened within this long (it already proved liveness). */
export const PRESENCE_HEARTBEAT_SKIP_MS = PRESENCE_HEARTBEAT_MS / 2;

export const PRESENCE_KEYS = /** @type {const} */ (["cursor", "viewport", "selection", "transforms", "stroke", "editingId"]);

/** @returns {LocalPresence} */
export function emptyPresence() {
  return { cursor: null, viewport: null, selection: [], transforms: [], stroke: null, editingId: null };
}

/**
 * The state peers see: a hidden tab shows no cursor and no gesture ghosts.
 * @param {LocalPresence} p
 * @param {boolean} visible
 * @returns {LocalPresence}
 */
export function visiblePart(p, visible) {
  return visible ? p : { ...p, cursor: null, transforms: [], stroke: null };
}

/**
 * A key equal for states that look the same to peers: numbers rounded to 0.1 board units.
 * @param {any} payload
 */
export function presenceKey(payload) {
  return JSON.stringify(payload, (_k, v) => (typeof v === "number" ? Math.round(v * 10) / 10 : v));
}

/** @param {any[]|null|undefined} a @param {any[]|null|undefined} b */
function sameIds(a, b) {
  const x = a ?? [];
  const y = b ?? [];
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/**
 * Whether going from `prev` to `next` is a boundary peers should see at once.
 * @param {LocalPresence} prev
 * @param {LocalPresence} next
 */
export function isBoundary(prev, next) {
  if (!sameIds(prev.selection, next.selection)) return true;
  if ((prev.editingId ?? null) !== (next.editingId ?? null)) return true;
  if ((prev.cursor === null) !== (next.cursor === null)) return true;
  if (((prev.transforms?.length ?? 0) === 0) !== ((next.transforms?.length ?? 0) === 0)) return true;
  if ((prev.stroke === null) !== (next.stroke === null)) return true;
  return false;
}

/**
 * The movement gap for the current conditions.
 * @param {{peers: number, opBusy: boolean, rttMs: number}} c
 */
export function movementGap({ peers, opBusy, rttMs }) {
  let gap = PRESENCE_MOVE_MS;
  for (const [n, factor] of PRESENCE_CROWD_STEPS) {
    if (peers >= n) {
      gap *= factor;
      break;
    }
  }
  if (opBusy) gap *= 2;
  return Math.max(gap, Math.min(2 * rttMs, PRESENCE_BACKOFF_MAX_MS));
}

/**
 * @typedef {object} PresenceSessionOptions
 * @property {{setTimeout: (fn: () => void, ms: number) => any, clearTimeout: (id: any) => void, now: () => number}} timers
 * @property {(payload: any) => Promise<any>} call   sends one updatePresence
 * @property {() => Record<string, any>} identity    clientId, name, color and session
 * @property {() => boolean} canSend                 the subscription is live
 * @property {() => number} generation               the current subscription generation
 * @property {(gen: number, res: any) => boolean} onResult  handles a settled call; true when healthy
 * @property {() => void} onDead                     presence keeps failing: re-subscribe
 * @property {() => boolean} [opBusy]                an operation request is in flight
 */

/**
 * @param {PresenceSessionOptions} options
 */
export function createPresenceSession(options) {
  const { timers, call, identity, canSend, generation, onResult, onDead } = options;
  const opBusy = options.opBusy ?? (() => false);

  /** @type {LocalPresence} */
  let local = emptyPresence();
  let visible = true;
  let peers = 0;
  let rttMs = 0;
  let lastSentAt = -Infinity;
  /** @type {string|null} key of the last state sent (null: send the next one whatever it is) */
  let lastKey = null;
  /** @type {any} */
  let timer = null;
  /** @type {{token: number, gen: number, sentAt: number, timer: any}|null} */
  let inflight = null;
  let dirty = false;
  let urgent = false;
  let token = 0;
  let failuresInRow = 0;
  let disposed = false;
  let sends = 0;

  function clearTimer() {
    if (timer) timers.clearTimeout(timer);
    timer = null;
  }

  /**
   * Sends the current state now if nothing is in flight (otherwise marks it for sending once the
   * call settles).
   * @param {boolean} force  send even when equal to the last state sent (flush, heartbeat, retry)
   */
  function sendNow(force) {
    clearTimer();
    if (disposed || !canSend()) return;
    if (inflight) {
      dirty = true;
      if (force) urgent = true;
      return;
    }
    const shown = visiblePart(local, visible);
    /** @type {Record<string, any>} */
    const payload = { ...identity(), ...shown };
    const { session: _s, clientId: _c, ...keyed } = payload;
    const key = presenceKey(keyed);
    if (!force && key === lastKey) return;
    dirty = false;
    urgent = false;
    lastKey = key;
    const now = timers.now();
    lastSentAt = now;
    sends++;
    const gen = generation();
    const t = ++token;
    inflight = { token: t, gen, sentAt: now, timer: timers.setTimeout(() => timedOut(t, gen), PRESENCE_TIMEOUT_MS) };
    Promise.resolve()
      .then(() => call(payload))
      .then(
        (res) => settle(t, gen, res, false),
        () => settle(t, gen, null, true),
      );
  }

  /**
   * Asks for a send: at once for a boundary, else no sooner than the movement gap allows.
   * @param {boolean} boundary
   */
  function request(boundary) {
    if (disposed || !canSend()) return;
    if (inflight) {
      dirty = true;
      if (boundary) urgent = true;
      return;
    }
    if (boundary) {
      sendNow(true);
      return;
    }
    const wait = lastSentAt + movementGap({ peers, opBusy: opBusy(), rttMs }) - timers.now();
    if (wait <= 0) sendNow(false);
    else if (!timer) timer = timers.setTimeout(() => { timer = null; sendNow(false); }, wait);
  }

  /**
   * A call has been outstanding for another PRESENCE_TIMEOUT_MS. A slow server is not a dead one:
   * the call stays outstanding (so heartbeats keep skipping rather than queueing more calls behind
   * it) until it settles or PRESENCE_FAILURES_TO_RESUBSCRIBE timeouts in a row, when it is
   * abandoned and the store re-subscribes.
   * @param {number} t @param {number} gen
   */
  function timedOut(t, gen) {
    if (!inflight || inflight.token !== t || disposed) return;
    if (gen === generation() && canSend() && failuresInRow + 1 < PRESENCE_FAILURES_TO_RESUBSCRIBE) {
      failuresInRow++;
      inflight.timer = timers.setTimeout(() => timedOut(t, gen), PRESENCE_TIMEOUT_MS);
      return;
    }
    settle(t, gen, null, true);
  }

  /**
   * @param {number} t
   * @param {number} gen
   * @param {any} res
   * @param {boolean} failed  rejected or not settled within PRESENCE_TIMEOUT_MS
   */
  function settle(t, gen, res, failed) {
    if (!inflight || inflight.token !== t) return; // late, after a timeout
    timers.clearTimeout(inflight.timer);
    rttMs = timers.now() - inflight.sentAt;
    inflight = null;
    if (disposed) return;
    if (failed) {
      lastKey = null; // whatever it carried may not have landed
      if (gen === generation() && canSend() && ++failuresInRow >= PRESENCE_FAILURES_TO_RESUBSCRIBE) {
        failuresInRow = 0;
        onDead();
      } else if (gen === generation() && !timer) {
        timer = timers.setTimeout(() => { timer = null; sendNow(true); }, PRESENCE_RETRY_MS);
      }
    } else if (onResult(gen, res)) {
      failuresInRow = 0;
    }
    if (dirty) {
      const wasUrgent = urgent;
      dirty = false;
      urgent = false;
      request(wasUrgent);
    }
  }

  return {
    /** @returns {LocalPresence} this viewer's latest presence (unmasked) */
    get state() { return local; },
    get inflight() { return inflight !== null; },
    get visible() { return visible; },
    /** updatePresence calls made so far (for tests and counters) */
    get sends() { return sends; },

    /**
     * Fields left out keep their value; undefined values are ignored.
     * @param {Partial<LocalPresence>} p
     */
    set(p) {
      if (disposed || !p || typeof p !== "object") return;
      /** @type {any} */
      const next = { ...local };
      let any = false;
      for (const key of PRESENCE_KEYS) {
        if (Object.hasOwn(p, key) && /** @type {any} */ (p)[key] !== undefined) {
          next[key] = /** @type {any} */ (p)[key];
          any = true;
        }
      }
      if (!any) return;
      const prev = local;
      local = next;
      const boundary = isBoundary(visiblePart(prev, visible), visiblePart(local, visible));
      if (!visible && !boundary) return; // hidden: heartbeat-only
      request(boundary);
    },

    /** The name or colour changed: peers should see it soon, like a boundary. */
    identityChanged() {
      request(true);
    },

    /** Sends the current state now (e.g. on pointer up, or once a subscription goes live). */
    flush() {
      sendNow(true);
    },

    /** Called every PRESENCE_HEARTBEAT_MS. Proves liveness; skipped when a send already did. */
    heartbeat() {
      if (disposed || inflight) return;
      if (timers.now() - lastSentAt < PRESENCE_HEARTBEAT_SKIP_MS) return;
      sendNow(true);
    },

    /** @param {boolean} v  document visibility */
    setVisible(v) {
      const next = Boolean(v);
      if (next === visible) return;
      visible = next;
      // Hiding clears the cursor and ghosts once; showing again republishes at once.
      request(true);
    },

    /** @param {number} n  peers currently present */
    setPeerCount(n) {
      peers = n;
    },

    /** A subscription went live: its failure count starts again. */
    resetFailures() {
      failuresInRow = 0;
    },

    /** Abandons the call in flight (its RPC target was replaced); its late result is ignored. */
    abandon() {
      if (!inflight) return;
      timers.clearTimeout(inflight.timer);
      inflight = null;
      lastKey = null;
    },

    dispose() {
      disposed = true;
      clearTimer();
      if (inflight) timers.clearTimeout(inflight.timer);
    },
  };
}
