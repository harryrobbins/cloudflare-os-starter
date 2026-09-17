// @ts-check
// The client sync engine for the Wave: subscription and re-subscription (generations, verbatim
// replay of a request whose outcome is unknown, heartbeat restart and gap detection, self-reload
// signalling through onUnrecoverable), the optimistic structure queue (creates, soft deletes,
// restores, title, participant upsert, template), the text channel (src/client/sync/text.js)
// and presence. Implements Store from src/client/store-contract.js.
//
// What the UI can rely on:
//   - `state.blips` is one long-lived record mutated in place; `state.blips[id]` is replaced (new
//     identity) iff that blip's optimistic value changed, and every such id is listed in the
//     "blips" (or "snapshot") change. Blip records are never mutated after being stored.
//   - `state.meta` is replaced (new identity) when any of its fields change.
//   - `state.text` is one long-lived record; entries are replaced when a blip's TextState changes.

import {
  DEFAULT_COLOR, DEFAULT_NAME, LIMITS, PRESENCE_HEARTBEAT_MS, PRESENCE_SEND_MS, PRESENCE_STALE_MS,
  cleanColor, cleanLine, cleanName, cleanText, compareBlips, isBlipId, newId, previewOf,
} from "../../shared/protocol.js";
import { keyBetween } from "../../shared/order.js";
import { templateOperation } from "../../shared/templates.js";
import { createTextChannel } from "./text.js";

/** @typedef {import("../store-contract.js").Store} Store */
/** @typedef {import("../store-contract.js").StoreOptions} StoreOptions */
/** @typedef {import("../store-contract.js").ClientState} ClientState */
/** @typedef {import("../store-contract.js").Change} Change */
/** @typedef {import("../store-contract.js").Viewer} Viewer */
/** @typedef {import("../store-contract.js").Peer} Peer */
/** @typedef {import("../store-contract.js").TextState} TextState */
/** @typedef {import("../../shared/protocol.js").WaveSnapshot} WaveSnapshot */
/** @typedef {import("../../shared/protocol.js").WaveMeta} WaveMeta */
/** @typedef {import("../../shared/protocol.js").WaveOperationEvent} WaveOperationEvent */
/** @typedef {import("../../shared/protocol.js").PresenceEvent} PresenceEvent */
/** @typedef {import("../../shared/protocol.js").PresenceState} PresenceState */
/** @typedef {import("../../shared/protocol.js").OperationResult} OperationResult */
/** @typedef {import("../../shared/protocol.js").Blip} Blip */
/** @typedef {import("../../shared/protocol.js").Run} Run */
/** @typedef {import("../../shared/protocol.js").WaveEvent} WaveEvent */
/** @typedef {import("../../shared/protocol.js").OpError} OpError */

/** How long a sequence gap reported by the heartbeat may persist before a resync. */
export const GAP_GRACE_MS = 1000;
/** A request with no result after this long is treated as failed. */
export const REQUEST_TIMEOUT_MS = 30000;
/** Failed requests (rejected or timed out) an op survives before it is dropped. */
export const MAX_SEND_FAILURES = 3;
export const BACKOFF_BASE_MS = 500;
export const BACKOFF_MAX_MS = 10000;
/** Automatic re-sends of a delete or restore rejected as stale. */
export const MAX_CONFLICT_RETRIES = 5;
/** New client ids tried in a row when the server says ours is held by another session. */
export const MAX_CLIENT_ID_RENAMES = 3;
/**
 * `onUnrecoverable` fires after this many subscribe attempts in a row have failed. On the
 * platform a facet restart (code edit) leaves the iframe's `gadget` stub permanently broken, so
 * retrying on it cannot succeed; only a reload of the frame gets a new stub.
 */
export const UNRECOVERABLE_FAILURES = 3;
/**
 * ... or after the connection has been non-live this long without any call succeeding. Time spent
 * waiting on a subscribe call that has not failed is not counted; see SUBSCRIBE_HANG_MS for that.
 */
export const UNRECOVERABLE_AFTER_MS = 8000;
/** ... or when one subscribe call has been left unsettled this long. */
export const SUBSCRIBE_HANG_MS = 45000;
/** Peers not re-confirmed this long after a re-subscribe went live (and no presence came) are dropped. */
export const PRESENCE_CONFIRM_MS = 2000;
/** Peers are checked for staleness this often. */
export const PEER_EXPIRY_CHECK_MS = 1000;
/** An updatePresence call not settled after this long counts as one presence failure. */
export const PRESENCE_TIMEOUT_MS = 10000;
/** Presence failures in a row (timeouts or rejections) after which the store re-subscribes. */
export const PRESENCE_FAILURES_TO_RESUBSCRIBE = 3;
/** After a rejected updatePresence, the next one is sent this soon rather than at the next heartbeat. */
export const PRESENCE_RETRY_MS = 500;
/** Request ids are `${secret}:${n}` (see nextRequestId), at most this long, of [A-Za-z0-9:_-]. */
export const REQUEST_ID_MAX = 64;

const PRESENCE_KEYS = /** @type {const} */ (["blipId", "editing", "anchor", "head"]);
const META_KEYS = /** @type {const} */ (["title", "rootOrder", "participants", "template", "earliestSeq"]);
/** How many delivered event sequences the store remembers to drop echoes of. */
const SEEN_EVENT_SEQS = 1024;

function randomHex(/** @type {number} */ n) {
  const bytes = new Uint8Array(n);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function defaultTimers() {
  return {
    setTimeout: (/** @type {() => void} */ fn, /** @type {number} */ ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (/** @type {any} */ id) => globalThis.clearTimeout(id),
    setInterval: (/** @type {() => void} */ fn, /** @type {number} */ ms) => globalThis.setInterval(fn, ms),
    clearInterval: (/** @type {any} */ id) => globalThis.clearInterval(id),
    now: () => Date.now(),
  };
}

/** @returns {WaveMeta} */
function emptyMeta() {
  return {
    schemaVersion: 1, seq: 0, title: "", rootOrder: [], participants: [], earliestSeq: 1, retainedBytes: 0,
    lastModified: 0, template: null,
  };
}

/**
 * One queued structure change.
 * @typedef {{seq: number, inflight: boolean, replayed: boolean, retries: number, sendFailures: number} & (
 *   {kind: "create", blipId: string, body: {op: any, blip: Blip}}
 * | {kind: "delete"|"restore", blipId: string}
 * | {kind: "title", title: string}
 * | {kind: "participant", participant: {id: string, name: string, color: string}}
 * | {kind: "template", body: any, resolve: (r: any) => void}
 * )} PendingOp
 */

/**
 * @param {StoreOptions} options
 * @returns {Promise<Store>}
 */
export async function createStore(options) {
  const { gadget, RpcTarget } = options;
  const timers = /** @type {any} */ (options.timers ?? defaultTimers());

  /** @type {Viewer} */
  const viewer = { ...options.viewer };
  let clientId = viewer.clientId;
  /** @type {string|null} issued by the server on first subscribe, sent back on every later call */
  let session = null;
  let clientIdRenames = 0;

  // Authoritative server state.
  /** @type {{meta: WaveMeta, blips: Record<string, Blip>, runs: Record<string, Run>}} */
  const server = { meta: emptyMeta(), blips: {}, runs: {} };

  /** @type {PendingOp[]} */
  let queue = [];
  /** @type {Map<string, PendingOp[]>} */
  const opsById = new Map();
  let opSeq = 0;
  let requestSeq = 0;
  const requestSecret = randomHex(12);

  /**
   * One request as sent. A request whose outcome is unknown (it failed or timed out) is kept as
   * `replay` and re-sent verbatim, with the same requestId and base versions, before anything
   * else: the server recognises the id and reports the original outcome instead of applying it twice.
   * @typedef {{requestId: string, ops: PendingOp[], refs: Map<PendingOp, number>, request: any}} Batch
   */
  /** @type {(Batch & {token: number, timer: any})|null} */
  let inflight = null;
  /** @type {Batch|null} */
  let replay = null;
  let requestToken = 0;

  // Sequences: `lastSeq` is the highest sequence this client has seen through snapshots, events
  // and results; `snapshotSeq` is the seq of the installed snapshot (older events are ignored).
  let lastSeq = 0;
  /** Event sequences already emitted, oldest first (see noteEventSeq). @type {Set<number>} */
  const seenEventSeqs = new Set();
  let snapshotSeq = 0;

  // Subscription generations. Events from an older generation's callbacks are ignored; events
  // for the current generation that arrive before its snapshot is installed are buffered.
  let generation = 0;
  let generationReady = false;
  /** @type {{kind: "operation"|"text", event: any}[]} */
  let buffered = [];
  let resubscribing = false;
  let failures = 0;
  let subscribeFailuresInRow = 0;
  /** @type {any} */
  let unrecoverableTimer = null;
  let unrecoverableFired = false;
  let nonLiveMs = 0;
  /** @type {number|null} */
  let nonLiveSince = null;
  /** @type {number|null} */
  let subscribeSentAt = null;
  /** @type {any} */
  let retryTimer = null;
  /** @type {any} */
  let gapTimer = null;
  let gapTarget = 0;
  let disposed = false;
  let everLive = false;

  /** @type {Pick<PresenceState, "blipId"|"editing"|"anchor"|"head">} */
  const presence = { blipId: null, editing: false, anchor: null, head: null };
  let lastPresenceSent = -Infinity;
  /** @type {any} */
  let presenceTimer = null;
  /** @type {{token: number, timer: any}|null} */
  let presenceInflight = null;
  let presenceDirty = false;
  let presenceToken = 0;
  let presenceFailuresInRow = 0;
  /** @type {{gen: number, ids: Set<string>, deadline: number|null}|null} */
  let unconfirmedPeers = null;
  /** @type {any} */
  let heartbeat = null;
  /** @type {any} */
  let expiryTimer = null;

  /** @type {ClientState} */
  const state = {
    meta: emptyMeta(),
    blips: {},
    runs: {},
    seq: 0,
    capabilities: { model: false },
    viewer,
    peers: new Map(),
    connection: "connecting",
    pending: 0,
    text: {},
    saving: "saved",
    lastError: null,
  };
  /** @type {Set<(state: ClientState, change: Change) => void>} */
  const listeners = new Set();

  // -----------------------------------------------------------------------------------------
  // Emission
  // -----------------------------------------------------------------------------------------

  /** @param {Change} change */
  function emit(change) {
    for (const listener of [...listeners]) {
      try {
        listener(state, change);
      } catch (err) {
        console.error("wave store listener failed", err);
      }
    }
  }

  /** @param {ClientState["connection"]} connection */
  function setConnection(connection) {
    if (state.connection === connection) return;
    state.connection = connection;
    emit({ kind: "connection" });
  }

  /** @param {string} message */
  function setError(message) {
    state.lastError = message;
    emit({ kind: "error" });
  }

  /** @param {number} seq */
  function noteSeq(seq) {
    if (typeof seq === "number" && seq > lastSeq) lastSeq = seq;
    if (lastSeq !== state.seq) state.seq = lastSeq;
  }

  /**
   * Recomputes the overall saving state; emits "saving" when it (or a listed blip) changed.
   * @param {string[]} blips
   */
  function syncSaving(blips = []) {
    let saving = text.overall();
    if (saving === "saved" && queue.length) saving = "saving";
    const changed = saving !== state.saving;
    state.saving = saving;
    if (changed || blips.length) emit({ kind: "saving", blips });
  }

  // -----------------------------------------------------------------------------------------
  // Optimistic view
  // -----------------------------------------------------------------------------------------

  /**
   * The optimistic value of one blip: the server's record with pending ops folded in.
   * @param {string} id
   */
  function optimistic(id) {
    /** @type {Blip|undefined} */
    let value = server.blips[id];
    const ops = opsById.get(id);
    if (!ops?.length) return value;
    for (const op of ops) {
      if (op.kind === "create") {
        if (!value) value = op.body.blip;
      } else if (op.kind === "delete") {
        if (value && !value.deleted) value = { ...value, deleted: true };
      } else if (op.kind === "restore") {
        if (value && value.deleted) value = { ...value, deleted: false };
      }
    }
    return value;
  }

  /** The optimistic meta: server meta plus pending title, participant and root creates. */
  function optimisticMeta() {
    /** @type {WaveMeta} */
    const meta = { ...server.meta };
    /** @type {string[]|null} */
    let rootOrder = null;
    for (const op of queue) {
      if (op.kind === "title") meta.title = op.title;
      else if (op.kind === "participant") {
        const list = meta.participants.filter((p) => p.id !== op.participant.id);
        list.push(op.participant);
        meta.participants = list;
      } else if (op.kind === "create" && op.body.blip.parentId === null) {
        rootOrder = rootOrder ?? [...server.meta.rootOrder];
        if (!rootOrder.includes(op.blipId)) {
          const roots = rootOrder.map((rid) => state.blips[rid] ?? server.blips[rid]);
          let at = roots.findIndex((b) => b && compareBlips(op.body.blip, b) < 0);
          if (at < 0) at = rootOrder.length;
          rootOrder.splice(at, 0, op.blipId);
        }
      }
    }
    if (rootOrder) meta.rootOrder = rootOrder;
    return meta;
  }

  /**
   * @param {WaveMeta} a
   * @param {WaveMeta} b
   */
  function metaDiffers(a, b) {
    for (const k of META_KEYS) {
      if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return true;
    }
    return false;
  }

  /**
   * Recomputes the optimistic value of `ids` and the meta, and emits what changed.
   * @param {Iterable<string>} ids
   * @param {{events?: WaveEvent[], runs?: string[]}} [extra]
   */
  function refresh(ids, extra = {}) {
    /** @type {string[]} */
    const changed = [];
    for (const id of new Set(ids)) {
      const next = optimistic(id);
      const prev = state.blips[id];
      if (next === prev) continue;
      if (next) state.blips[id] = next;
      else delete state.blips[id];
      changed.push(id);
    }
    const meta = optimisticMeta();
    const metaChanged = metaDiffers(meta, state.meta);
    state.meta = meta;
    const pendingChanged = state.pending !== queue.length;
    state.pending = queue.length;
    if (changed.length) emit({ kind: "blips", blips: changed });
    if (metaChanged) emit({ kind: "meta" });
    if (extra.runs?.length) emit({ kind: "runs", runs: extra.runs });
    if (extra.events?.length) emit({ kind: "events", events: extra.events });
    if (pendingChanged) syncSaving();
  }

  // -----------------------------------------------------------------------------------------
  // Server state
  // -----------------------------------------------------------------------------------------

  /**
   * Puts a blip record unless a newer one is held. Returns true when stored.
   * @param {Blip} blip
   */
  function putBlip(blip) {
    if (!blip || typeof blip !== "object" || !isBlipId(blip.id)) return false;
    const existing = server.blips[blip.id];
    if (existing && typeof blip.seq === "number" && typeof existing.seq === "number") {
      if (blip.seq < existing.seq) return false;
      // The same commit again (a result and its echo): keep the held object so identity holds.
      if (blip.seq === existing.seq && blip.version === existing.version) return false;
    }
    server.blips[blip.id] = blip;
    return true;
  }

  /** @param {Run} run */
  function putRun(run) {
    if (!run || typeof run !== "object" || typeof run.id !== "string") return false;
    server.runs[run.id] = run;
    state.runs[run.id] = run;
    return true;
  }

  /**
   * Applies an operation result or event to the server state. Returns the touched blip ids and
   * the runs and events it carried.
   * @param {any} update
   */
  function applyServerUpdate(update) {
    /** @type {string[]} */
    const touched = [];
    /** @type {string[]} */
    const runs = [];
    const upserts = Array.isArray(update.upserts) ? update.upserts : [];
    for (const b of upserts) if (putBlip(b)) touched.push(b.id);
    for (const id of Array.isArray(update.deletes) ? update.deletes : []) {
      const b = typeof id === "string" ? server.blips[id] : undefined;
      if (b && !b.deleted && !upserts.some((/** @type {Blip} */ u) => u?.id === id)) {
        server.blips[id] = { ...b, deleted: true };
        touched.push(id);
      }
    }
    if (update.meta && typeof update.meta === "object") {
      const { seq: _seq, ...rest } = update.meta;
      server.meta = { ...server.meta, ...rest };
      if (typeof update.meta.seq === "number" && update.meta.seq > server.meta.seq) server.meta.seq = update.meta.seq;
    }
    for (const r of Array.isArray(update.runs) ? update.runs : []) if (putRun(r)) runs.push(r.id);
    if (typeof update.seq === "number") {
      if (update.seq > server.meta.seq) server.meta.seq = update.seq;
      noteSeq(update.seq);
    }
    const events = Array.isArray(update.events)
      ? update.events.filter((/** @type {any} */ e) => e && typeof e.seq === "number" && noteEventSeq(e.seq))
      : [];
    return { touched, runs, events };
  }

  /**
   * Records an event sequence as delivered; false when it already was (a result and its echo carry
   * the same events). A bounded window, not a high-water mark: other clients' events may arrive
   * after our own later results.
   * @param {number} seq
   */
  function noteEventSeq(seq) {
    if (seenEventSeqs.has(seq)) return false;
    seenEventSeqs.add(seq);
    if (seenEventSeqs.size > SEEN_EVENT_SEQS) {
      const oldest = seenEventSeqs.values().next().value;
      if (oldest !== undefined) seenEventSeqs.delete(oldest);
    }
    return true;
  }

  /** @param {WaveSnapshot} snapshot */
  function installSnapshot(snapshot) {
    const wave = /** @type {any} */ (snapshot ?? {});
    server.meta = { ...emptyMeta(), ...(wave.meta ?? {}) };
    server.blips = {};
    for (const b of Object.values(wave.blips ?? {})) putBlip(/** @type {Blip} */ (b));
    server.runs = {};
    for (const r of Array.isArray(wave.runs) ? wave.runs : []) if (r && typeof r.id === "string") server.runs[r.id] = r;
    state.runs = { ...server.runs };
    state.capabilities = { model: wave.capabilities?.model === true };
    snapshotSeq = typeof wave.seq === "number" ? wave.seq : server.meta.seq;
    lastSeq = Math.max(lastSeq, snapshotSeq);
    state.seq = lastSeq;
    // Rebuild the optimistic view for every id known on either side.
    const ids = new Set([...Object.keys(state.blips), ...Object.keys(server.blips), ...opsById.keys()]);
    for (const id of ids) {
      const next = optimistic(id);
      if (next) state.blips[id] = next;
      else delete state.blips[id];
    }
    state.meta = optimisticMeta();
    state.pending = queue.length;
    emit({ kind: "snapshot" });
  }

  /** @param {WaveOperationEvent} event */
  function applyEvent(event) {
    if (!event || typeof event !== "object") return;
    if (event.type === "snapshot") {
      installSnapshot(event.wave);
      pump();
      return;
    }
    if (event.type === "operation") {
      if (typeof event.seq === "number" && event.seq <= snapshotSeq) return;
      const res = applyServerUpdate(event);
      refresh(res.touched, { runs: res.runs, events: res.events });
    }
  }

  // -----------------------------------------------------------------------------------------
  // Subscription
  // -----------------------------------------------------------------------------------------

  function clientInfo() {
    /** @type {{clientId: string, name: string, color: string, session?: string}} */
    const info = { clientId, name: viewer.name, color: viewer.color };
    if (session) info.session = session;
    return info;
  }

  /**
   * `${secret}:${n}`: a random secret of 96 bits (24 hex), made once per store and never sent
   * except inside requestIds, plus a counter. Request records are keyed by senderId, which is
   * broadcast, so an id built from it could be predicted and recorded first by a peer.
   */
  function nextRequestId() {
    return (requestSecret + ":" + ++requestSeq).slice(0, REQUEST_ID_MAX);
  }

  /** Our clientId is held by another session: take a fresh identity. */
  function renameClient() {
    clientId = randomHex(8);
    viewer.clientId = clientId;
    session = null;
    emit({ kind: "viewer" });
  }

  class Callbacks extends RpcTarget {
    #gen;
    /** @param {number} gen */
    constructor(gen) {
      super();
      this.#gen = gen;
    }

    /** @param {WaveOperationEvent} event */
    operation(event) {
      if (disposed || this.#gen !== generation) return;
      if (!generationReady) buffered.push({ kind: "operation", event });
      else applyEvent(event);
    }

    /** @param {import("../../shared/protocol.js").TextEvent[]} events */
    text(events) {
      if (disposed || this.#gen !== generation) return;
      if (!generationReady) buffered.push({ kind: "text", event: events });
      else text.applyEvents(events);
    }

    /** @param {PresenceEvent[]|PresenceEvent} events */
    presence(events) {
      if (disposed || this.#gen !== generation) return;
      applyPresence(events);
    }

    // The server disposes its callback stub when it drops or replaces a subscription, so only the
    // current generation's disposal means anything. (On the real platform this never fired; the
    // heartbeat's known:false is the reliable signal.)
    [Symbol.dispose]() {
      if (disposed || this.#gen !== generation || resubscribing) return;
      resubscribe();
    }
  }

  /** @type {(() => void)|null} */
  let onFirstLive = null;

  async function attemptSubscribe() {
    retryTimer = null;
    if (disposed) return;
    const gen = ++generation;
    generationReady = false;
    buffered = [];
    unconfirmedPeers = state.peers.size ? { gen, ids: new Set(state.peers.keys()), deadline: null } : null;
    subscribeStarted();
    try {
      const snapshot = await gadget.subscribe(new Callbacks(gen), clientInfo());
      if (disposed || gen !== generation) return;
      const issued = /** @type {any} */ (snapshot)?.session;
      if (typeof issued === "string" && issued) session = issued;
      clientIdRenames = 0;
      subscribeFailuresInRow = 0;
      presenceFailuresInRow = 0;
      if (unrecoverableTimer) {
        timers.clearTimeout(unrecoverableTimer);
        unrecoverableTimer = null;
      }
      nonLiveMs = 0;
      nonLiveSince = null;
      subscribeSentAt = null;
      generationReady = true;
      const events = buffered;
      buffered = [];
      resubscribing = false;
      installSnapshot(snapshot);
      for (const { kind, event } of events) {
        if (kind === "operation") applyEvent(event);
        else text.applyEvents(event);
      }
      if (unconfirmedPeers?.gen === gen) unconfirmedPeers.deadline = timers.now() + PRESENCE_CONFIRM_MS;
      setConnection("live");
      const first = !everLive;
      everLive = true;
      onFirstLive?.();
      onFirstLive = null;
      if (first) joinParticipant();
      pump();
      if (!first) text.resyncAll();
      text.kick();
      sendPresence();
    } catch (err) {
      if (disposed || gen !== generation) return;
      subscribeSettled();
      const message = String(/** @type {any} */ (err)?.message ?? err);
      if (message.includes("clientId in use") && clientIdRenames < MAX_CLIENT_ID_RENAMES) {
        clientIdRenames++;
        renameClient();
        void attemptSubscribe();
        return;
      }
      subscribeFailuresInRow++;
      if (subscribeFailuresInRow >= UNRECOVERABLE_FAILURES) giveUp();
      scheduleSubscribe();
    }
  }

  /**
   * Arms the "non-live for too long" check. Only a successful subscribe makes the connection
   * live again, so still being non-live when the budget runs out means no call has succeeded in
   * that time. Time waiting on an outstanding subscribe is not counted; that call instead gets
   * SUBSCRIBE_HANG_MS before it counts as hung.
   */
  function watchUnrecoverable() {
    if (!options.onUnrecoverable || unrecoverableFired || unrecoverableTimer || disposed) return;
    if (nonLiveSince === null && subscribeSentAt === null) nonLiveSince = timers.now();
    armUnrecoverable();
  }

  function armUnrecoverable() {
    if (unrecoverableTimer) timers.clearTimeout(unrecoverableTimer);
    unrecoverableTimer = null;
    if (unrecoverableFired || disposed) return;
    const now = timers.now();
    const wait = subscribeSentAt !== null
      ? subscribeSentAt + SUBSCRIBE_HANG_MS - now
      : UNRECOVERABLE_AFTER_MS - nonLiveMs - (nonLiveSince === null ? 0 : now - nonLiveSince);
    if (wait <= 0) {
      giveUp();
      return;
    }
    unrecoverableTimer = timers.setTimeout(() => {
      unrecoverableTimer = null;
      if (!disposed && state.connection !== "live") armUnrecoverable();
    }, wait);
  }

  function subscribeStarted() {
    const now = timers.now();
    if (nonLiveSince !== null) nonLiveMs += now - nonLiveSince;
    nonLiveSince = null;
    subscribeSentAt = now;
    if (unrecoverableTimer) armUnrecoverable();
  }

  function subscribeSettled() {
    subscribeSentAt = null;
    nonLiveSince = timers.now();
    if (unrecoverableTimer) armUnrecoverable();
  }

  /** Tells the owner, once, that this connection is not coming back. Retries continue. */
  function giveUp() {
    if (unrecoverableFired || disposed || !options.onUnrecoverable) return;
    unrecoverableFired = true;
    if (unrecoverableTimer) {
      timers.clearTimeout(unrecoverableTimer);
      unrecoverableTimer = null;
    }
    try {
      options.onUnrecoverable();
    } catch (err) {
      console.error("wave onUnrecoverable failed", err);
    }
  }

  function scheduleSubscribe() {
    const delay = failures === 0 ? 0 : Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
    failures++;
    if (delay === 0) void attemptSubscribe();
    else retryTimer = timers.setTimeout(attemptSubscribe, delay);
  }

  function resubscribe() {
    if (disposed || resubscribing) return;
    resubscribing = true;
    generationReady = false;
    if (gapTimer) {
      timers.clearTimeout(gapTimer);
      gapTimer = null;
    }
    setConnection("reconnecting");
    watchUnrecoverable();
    scheduleSubscribe();
  }

  // -----------------------------------------------------------------------------------------
  // Queue
  // -----------------------------------------------------------------------------------------

  /** @param {Set<PendingOp>} ops */
  function removeOps(ops) {
    if (!ops.size) return;
    queue = queue.filter((op) => !ops.has(op));
    for (const op of ops) {
      if (!("blipId" in op)) continue;
      const list = opsById.get(op.blipId);
      if (!list) continue;
      const next = list.filter((o) => !ops.has(o));
      if (next.length) opsById.set(op.blipId, next);
      else opsById.delete(op.blipId);
    }
  }

  /**
   * Queues one op, merging into or cancelling against the last unsent op on the same target.
   * @param {any} body
   * @returns {PendingOp|null}
   */
  function enqueue(body) {
    if (body.kind === "title" || body.kind === "participant") {
      const target = queue.findLast((op) => op.kind === body.kind && !op.inflight && !op.replayed);
      if (target) {
        Object.assign(target, body);
        return target;
      }
    } else if (body.kind === "delete" || body.kind === "restore") {
      const list = opsById.get(body.blipId);
      const target = list?.at(-1);
      if (target && !target.inflight && !target.replayed) {
        if (target.kind === body.kind) return target;
        if ((target.kind === "create" && body.kind === "delete") ||
            (target.kind === "delete" && body.kind === "restore") ||
            (target.kind === "restore" && body.kind === "delete")) {
          removeOps(new Set([target]));
          return null;
        }
      }
    }
    /** @type {PendingOp} */
    const op = { ...body, seq: ++opSeq, inflight: false, replayed: false, retries: 0, sendFailures: 0 };
    queue.push(op);
    if ("blipId" in op) {
      const list = opsById.get(op.blipId);
      if (list) list.push(op);
      else opsById.set(op.blipId, [op]);
    }
    return op;
  }

  function pump() {
    if (disposed || inflight || state.connection !== "live" || !generationReady) return;
    if (replay) {
      // The outcome of this exact request is unknown; settle it before sending anything new.
      send(replay);
      return;
    }
    /** @type {PendingOp[]} */
    const batch = [];
    /** @type {Set<string>} */
    const ids = new Set();
    /** @type {Set<PendingOp>} */
    const dropped = new Set();
    let hasTitle = false;
    let hasParticipant = false;
    for (const op of queue) {
      if (batch.length >= LIMITS.opsPerRequest) break;
      if (op.kind === "template") {
        if (batch.length) break;
        batch.push(op);
        break;
      }
      if (op.kind === "title") {
        if (hasTitle) break;
        hasTitle = true;
        batch.push(op);
        continue;
      }
      if (op.kind === "participant") {
        if (hasParticipant) break;
        hasParticipant = true;
        batch.push(op);
        continue;
      }
      // Two ops on one blip never share a request: each is checked against its own base.
      if (ids.has(op.blipId)) break;
      if (op.kind === "create") {
        if (server.blips[op.blipId]) {
          dropped.add(op);
          continue;
        }
      } else if (!server.blips[op.blipId]) {
        dropped.add(op); // nothing to delete or restore (the create was refused, or it never existed)
        continue;
      }
      ids.add(op.blipId);
      batch.push(op);
    }
    if (dropped.size) {
      removeOps(dropped);
      refresh([...dropped].map((op) => /** @type {any} */ (op).blipId));
    }
    if (batch.length === 0) return;

    /** @type {any[]} */
    const blipOps = [];
    /** @type {Map<PendingOp, number>} */
    const refs = new Map();
    /** @type {any} */
    let structure = null;
    /** @type {any[]} */
    const participantOps = [];
    for (const op of batch) {
      if (op.kind === "title") {
        structure = { ...(structure ?? {}), title: op.title };
      } else if (op.kind === "participant") {
        participantOps.push({ op: "upsert", participant: op.participant });
      } else if (op.kind === "template") {
        blipOps.push(...op.body.blipOps);
        structure = { ...(structure ?? {}), ...op.body.structure };
      } else if (op.kind === "create") {
        refs.set(op, blipOps.length);
        blipOps.push(op.body.op);
      } else {
        refs.set(op, blipOps.length);
        blipOps.push({ op: op.kind, blipId: op.blipId, baseVersion: server.blips[op.blipId]?.version ?? 0 });
      }
    }
    const requestId = nextRequestId();
    /** @type {any} */
    const request = { senderId: clientId, by: viewer.name, requestId };
    if (blipOps.length) request.blipOps = blipOps;
    if (structure) request.structure = structure;
    if (participantOps.length) request.participantOps = participantOps;
    send({ requestId, ops: batch, refs, request });
  }

  /** @param {Batch} batch */
  function send(batch) {
    replay = null;
    for (const op of batch.ops) op.inflight = true;
    const token = ++requestToken;
    const timer = timers.setTimeout(() => {
      if (inflight?.token === token) onSendFailure(token);
    }, REQUEST_TIMEOUT_MS);
    inflight = { ...batch, token, timer };
    const request = batch.request;
    Promise.resolve()
      .then(() => gadget.applyOperation(request))
      .then(
        (/** @type {OperationResult} */ result) => onResult(token, result),
        () => onSendFailure(token),
      );
  }

  /** @param {number} token */
  function onSendFailure(token) {
    if (!inflight || inflight.token !== token) return;
    const { timer, token: _token, ...batch } = inflight;
    timers.clearTimeout(timer);
    inflight = null;
    let abandon = false;
    for (const op of batch.ops) {
      // Still marked in flight: nothing may merge into an op whose request will be re-sent as is.
      op.replayed = true;
      op.sendFailures++;
      if (op.sendFailures > MAX_SEND_FAILURES) abandon = true;
    }
    if (disposed) return;
    if (abandon) {
      // A request that keeps failing is more likely rejected than lost; stop retrying it.
      for (const op of batch.ops) {
        op.inflight = false;
        if (op.kind === "template") op.resolve({ error: "invalid_argument", message: "The template could not be applied." });
        if (op.kind === "create") text.blipFailed(op.blipId, "invalid_argument");
      }
      removeOps(new Set(batch.ops));
      refresh(batch.ops.flatMap((op) => ("blipId" in op ? [op.blipId] : [])));
      setError("A change could not be saved and was undone.");
    } else {
      replay = batch;
    }
    resubscribe();
  }

  /**
   * @param {number} token
   * @param {OperationResult} result
   */
  function onResult(token, result) {
    if (disposed) return;
    if (!result || typeof result !== "object") {
      onSendFailure(token);
      return;
    }
    if (!inflight || inflight.token !== token) {
      // A late result after a timeout: its ops were already requeued. Keep the state it reports.
      const res = applyServerUpdate(result);
      refresh(res.touched, { runs: res.runs, events: res.events });
      return;
    }
    const { ops, refs } = inflight;
    timers.clearTimeout(inflight.timer);
    inflight = null;
    failures = 0;

    // A duplicate is the server's record of a request it had already applied (we re-sent it after
    // losing the result). Its effects reach us through the snapshot or events; only its per-op
    // outcome (errors, conflicts with present values) is used.
    const duplicate = /** @type {any} */ (result).duplicate === true;
    /** @type {string[]} */
    const touched = [];
    /** @type {string[]} */
    let runs = [];
    /** @type {WaveEvent[]} */
    let events = [];
    if (!duplicate) {
      const res = applyServerUpdate(result);
      touched.push(...res.touched);
      runs = res.runs;
      events = res.events;
    } else if (typeof result.seq === "number") {
      noteSeq(result.seq);
    }

    /** @type {Map<number, OpError>} */
    const errors = new Map();
    for (const e of Array.isArray(result.errors) ? result.errors : []) if (e && typeof e.index === "number") errors.set(e.index, e);
    /** @type {Set<string>} */
    const conflicts = new Set();
    for (const c of Array.isArray(result.conflicts) ? result.conflicts : []) {
      if (!c || typeof c.blipId !== "string") continue;
      conflicts.add(c.blipId);
      if (c.current) {
        if (putBlip(c.current)) touched.push(c.blipId);
      } else if (server.blips[c.blipId]) {
        delete server.blips[c.blipId];
        touched.push(c.blipId);
      }
    }

    /** @type {Set<PendingOp>} */
    const done = new Set();
    /** @type {string|null} */
    let errorMessage = null;
    for (const op of ops) {
      op.inflight = false;
      if (op.kind === "template") {
        done.add(op);
        op.resolve(result);
        continue;
      }
      if (op.kind === "title" || op.kind === "participant") {
        done.add(op);
        const e = errors.get(-1);
        if (e) errorMessage = e.message || e.code;
        continue;
      }
      touched.push(op.blipId);
      const index = refs.get(op);
      const error = index !== undefined ? errors.get(index) : undefined;
      if (error) {
        done.add(op);
        const benign = op.replayed && ((error.code === "exists" && op.kind === "create") ||
          (error.code === "unknown_blip" && op.kind !== "create"));
        if (benign) {
          if (op.kind === "create") text.blipAcked(op.blipId);
          continue;
        }
        if (op.kind === "create") text.blipFailed(op.blipId, error.code);
        errorMessage = error.code;
        continue;
      }
      if (!conflicts.has(op.blipId)) {
        done.add(op);
        if (op.kind === "create") text.blipAcked(op.blipId);
        continue;
      }
      // A stale baseVersion on a delete or restore. The authoritative record is in place now.
      const current = server.blips[op.blipId];
      const wanted = op.kind === "delete";
      if (!current || current.deleted === wanted || duplicate || op.retries >= MAX_CONFLICT_RETRIES) {
        done.add(op);
        if (current && current.deleted !== wanted) errorMessage = "A change could not be saved because the blip kept changing.";
        continue;
      }
      op.retries++;
      op.replayed = false;
    }

    removeOps(done);
    refresh(touched, { runs, events });
    if (errorMessage) setError(errorMessage);
    pump();
  }

  // -----------------------------------------------------------------------------------------
  // Text channel
  // -----------------------------------------------------------------------------------------

  const text = createTextChannel({
    gadget,
    timers,
    states: state.text,
    senderId: () => clientId,
    by: () => viewer.name,
    nextRequestId,
    canSend: () => !disposed && state.connection === "live" && generationReady,
    blipStatus: (id) => {
      const b = server.blips[id];
      if (b) return b.deleted ? "missing" : "server"; // the channel opens only live or pending blips
      return opsById.get(id)?.some((op) => op.kind === "create") ? "pending" : "missing";
    },
    onRemote: (id) => emit({ kind: "text", blips: [id] }),
    onSaving: (ids) => syncSaving(ids),
    onSeq: (seq) => noteSeq(seq),
    onError: (code) => setError(code),
    onTransportFailure: () => resubscribe(),
  });

  // -----------------------------------------------------------------------------------------
  // Presence
  // -----------------------------------------------------------------------------------------

  /** @param {PresenceEvent[]|PresenceEvent} events */
  function applyPresence(events) {
    const list = Array.isArray(events) ? events : [events];
    /** @type {Set<string>} */
    const changed = new Set();
    const now = timers.now();
    for (const ev of list) {
      if (!ev || typeof ev !== "object" || typeof ev.clientId !== "string" || ev.clientId === clientId) continue;
      if (ev.type === "leave") {
        if (state.peers.delete(ev.clientId)) changed.add(ev.clientId);
        continue;
      }
      if (ev.type !== "join" && ev.type !== "update") continue;
      const e = /** @type {any} */ (ev);
      /** @type {Peer} */
      const peer = {
        clientId: e.clientId,
        name: typeof e.name === "string" ? e.name : "",
        color: typeof e.color === "string" ? e.color : "#888888",
        blipId: isBlipId(e.blipId) ? e.blipId : null,
        editing: e.editing === true,
        anchor: typeof e.anchor === "string" ? e.anchor : null,
        head: typeof e.head === "string" ? e.head : null,
        lastSeen: now,
      };
      state.peers.set(e.clientId, peer);
      changed.add(e.clientId);
      unconfirmedPeers?.ids.delete(e.clientId);
    }
    if (unconfirmedPeers?.gen === generation) {
      for (const id of unconfirmedPeers.ids) if (state.peers.delete(id)) changed.add(id);
      unconfirmedPeers = null;
    }
    if (changed.size) emit({ kind: "presence", peers: [...changed] });
  }

  function expirePeers() {
    const now = timers.now();
    /** @type {string[]} */
    const removed = [];
    if (unconfirmedPeers?.deadline != null && now >= unconfirmedPeers.deadline) {
      for (const id of unconfirmedPeers.ids) if (state.peers.delete(id)) removed.push(id);
      unconfirmedPeers = null;
    }
    for (const [id, peer] of state.peers) {
      if (now - peer.lastSeen > PRESENCE_STALE_MS) {
        state.peers.delete(id);
        removed.push(id);
      }
    }
    if (removed.length) emit({ kind: "presence", peers: removed });
  }

  /**
   * Sends the current presence. At most one updatePresence is in flight per client (a gadget
   * serves inbound calls one at a time, so unawaited 30 Hz sends queue up for seconds on the real
   * platform): while one is in flight the presence is only marked dirty, and the latest state is
   * sent once it settles, still at most one send per PRESENCE_SEND_MS.
   */
  function sendPresence() {
    if (presenceTimer) {
      timers.clearTimeout(presenceTimer);
      presenceTimer = null;
    }
    if (disposed || state.connection !== "live") return;
    if (presenceInflight) {
      presenceDirty = true;
      return;
    }
    presenceDirty = false;
    lastPresenceSent = timers.now();
    const gen = generation;
    const token = ++presenceToken;
    const payload = { ...clientInfo(), ...presence };
    const timer = timers.setTimeout(() => presenceTimedOut(token, gen), PRESENCE_TIMEOUT_MS);
    presenceInflight = { token, timer };
    Promise.resolve()
      .then(() => gadget.updatePresence(payload))
      .then(
        (/** @type {{known: boolean, seq: number}} */ res) => settlePresence(token, gen, res, false),
        () => settlePresence(token, gen, null, true),
      );
  }

  /**
   * An updatePresence call has been outstanding for another PRESENCE_TIMEOUT_MS. A slow server
   * is not a dead one: the call stays outstanding until it settles or
   * PRESENCE_FAILURES_TO_RESUBSCRIBE timeouts in a row, when it is abandoned and the store re-subscribes.
   * @param {number} token
   * @param {number} gen
   */
  function presenceTimedOut(token, gen) {
    if (!presenceInflight || presenceInflight.token !== token || disposed) return;
    if (gen === generation && state.connection === "live" && presenceFailuresInRow + 1 < PRESENCE_FAILURES_TO_RESUBSCRIBE) {
      presenceFailuresInRow++;
      presenceInflight.timer = timers.setTimeout(() => presenceTimedOut(token, gen), PRESENCE_TIMEOUT_MS);
      return;
    }
    settlePresence(token, gen, null, true);
  }

  /**
   * @param {number} token
   * @param {number} gen
   * @param {{known: boolean, seq: number}|null} res
   * @param {boolean} failed  rejected or not settled within PRESENCE_TIMEOUT_MS
   */
  function settlePresence(token, gen, res, failed) {
    if (!presenceInflight || presenceInflight.token !== token) return; // late, after a timeout
    timers.clearTimeout(presenceInflight.timer);
    presenceInflight = null;
    if (disposed) return;
    if (failed) {
      if (gen === generation && state.connection === "live" && ++presenceFailuresInRow >= PRESENCE_FAILURES_TO_RESUBSCRIBE) {
        presenceFailuresInRow = 0;
        resubscribe();
      } else if (gen === generation && !presenceTimer) {
        presenceTimer = timers.setTimeout(sendPresence, PRESENCE_RETRY_MS);
      }
    } else {
      onPresenceResult(gen, /** @type {any} */ (res));
    }
    if (presenceDirty) {
      presenceDirty = false;
      schedulePresence();
    }
  }

  /**
   * @param {number} gen
   * @param {{known: boolean, seq: number}} res
   */
  function onPresenceResult(gen, res) {
    if (disposed || gen !== generation || state.connection !== "live") return;
    if (!res || res.known === false) {
      resubscribe();
      return;
    }
    presenceFailuresInRow = 0;
    failures = 0;
    if (typeof res.seq === "number" && res.seq > lastSeq && !inflight) {
      gapTarget = Math.max(gapTarget, res.seq);
      if (!gapTimer) {
        gapTimer = timers.setTimeout(() => {
          gapTimer = null;
          if (disposed || state.connection !== "live") return;
          if (lastSeq < gapTarget && !inflight) resubscribe();
        }, GAP_GRACE_MS);
      }
    }
  }

  function schedulePresence() {
    if (disposed) return;
    const wait = lastPresenceSent + PRESENCE_SEND_MS - timers.now();
    if (wait <= 0) sendPresence();
    else if (!presenceTimer) presenceTimer = timers.setTimeout(sendPresence, wait);
  }

  // -----------------------------------------------------------------------------------------
  // Convenience RPCs
  // -----------------------------------------------------------------------------------------

  /**
   * Calls an RPC (a write carries the client's identity and a request id), folds any blip, run or
   * seq it returns into the state, and returns the result. A transport failure rejects and
   * triggers a re-subscribe (on the platform a rejected call means the stub is dead).
   * @param {string} method
   * @param {any} args
   * @param {{write?: boolean}} [opts]
   */
  async function rpc(method, args, { write = true } = {}) {
    const request = write ? { ...args, senderId: clientId, by: viewer.name, requestId: nextRequestId() } : args;
    let result;
    try {
      result = await gadget[method](request);
    } catch (err) {
      if (!disposed) resubscribe();
      throw err;
    }
    if (disposed || !result || typeof result !== "object") return result;
    /** @type {string[]} */
    const touched = [];
    /** @type {string[]} */
    const runs = [];
    if (result.blip && putBlip(result.blip)) touched.push(result.blip.id);
    if (result.run && putRun(result.run)) runs.push(result.run.id);
    if (typeof result.seq === "number") noteSeq(result.seq);
    if (touched.length || runs.length) refresh(touched, { runs });
    return result;
  }

  /** Upserts the viewer as a participant when the server does not list them as they are now. */
  function joinParticipant() {
    if (!viewer.name || !viewer.participantId) return;
    const listed = state.meta.participants.find((p) => p.id === viewer.participantId);
    if (listed && listed.name === viewer.name && listed.color === viewer.color) return;
    enqueue({ kind: "participant", participant: { id: viewer.participantId, name: viewer.name, color: viewer.color } });
    refresh([]);
    pump();
  }

  // -----------------------------------------------------------------------------------------
  // Startup
  // -----------------------------------------------------------------------------------------

  // Resolves once the first subscribe succeeds; failures retry with backoff.
  await new Promise((resolve) => {
    onFirstLive = () => resolve(undefined);
    resubscribing = true;
    watchUnrecoverable();
    scheduleSubscribe();
  });
  failures = 0;

  heartbeat = timers.setInterval(() => {
    if (!presenceInflight) sendPresence(); // a call still in flight already proves liveness
  }, PRESENCE_HEARTBEAT_MS);
  expiryTimer = timers.setInterval(expirePeers, PEER_EXPIRY_CHECK_MS);

  // -----------------------------------------------------------------------------------------
  // Store
  // -----------------------------------------------------------------------------------------

  /** @type {Store} */
  const store = {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },

    createBlip(args) {
      if (disposed || !args || typeof args !== "object") return "";
      const { parentId, anchor, kind, text: seed, after } = args;
      const parent = parentId === null || parentId === undefined ? null : state.blips[parentId];
      if (parentId && (!parent || parent.deleted)) {
        setError("unknown_blip");
        return "";
      }
      const pid = parent ? parent.id : null;
      const id = newId("blip");
      const siblings = Object.values(state.blips).filter((b) => b.parentId === pid && !b.deleted).sort(compareBlips);
      let at = siblings.length - 1;
      if (after === null) at = -1;
      else if (typeof after === "string") {
        const i = siblings.findIndex((b) => b.id === after);
        if (i >= 0) at = i;
      }
      let order;
      try {
        order = keyBetween(siblings[at]?.order ?? null, siblings[at + 1]?.order ?? null);
      } catch {
        try {
          order = keyBetween(siblings.at(-1)?.order ?? null, null);
        } catch {
          order = "a0";
        }
      }
      const text0 = typeof seed === "string" ? cleanText(seed, LIMITS.textChars) : "";
      const now = timers.now();
      const kind0 = kind === "brief" ? "brief" : "note";
      /** @type {Blip} */
      const blip = {
        id, parentId: pid, anchor: pid === null ? null : anchor ?? { type: "end" }, kind: kind0, order, by: viewer.name,
        createdAt: now, updatedAt: now, version: 0, seq: 0, textSeq: 0, textChars: text0.length,
        log: { count: 0, bytes: 0, sinceCompaction: 0, sinceCompactionBytes: 0 }, deleted: false, locked: false,
        preview: previewOf(text0),
      };
      /** @type {any} */
      const op = { op: "create", blipId: id, parentId: pid, kind: kind0, order };
      if (pid !== null) op.anchor = blip.anchor;
      if (text0) op.text = text0;
      enqueue({ kind: "create", blipId: id, body: { op, blip } });
      refresh([id]);
      pump();
      return id;
    },

    deleteBlip(id) {
      if (disposed) return;
      const blip = state.blips[id];
      if (!blip || blip.deleted) return;
      if (blip.locked) {
        setError("locked");
        return;
      }
      enqueue({ kind: "delete", blipId: id });
      refresh([id]);
      pump();
    },

    restoreBlip(id) {
      if (disposed) return;
      const blip = state.blips[id];
      if (!blip || !blip.deleted) return;
      enqueue({ kind: "restore", blipId: id });
      refresh([id]);
      pump();
    },

    setTitle(title) {
      if (disposed) return;
      const clean = cleanLine(title, LIMITS.title);
      if (clean === state.meta.title) return;
      enqueue({ kind: "title", title: clean });
      refresh([]);
      pump();
    },

    applyTemplate(templateId) {
      if (disposed) return Promise.resolve({ error: "invalid_argument", message: "disposed" });
      const body = templateOperation(templateId);
      if (!body) return Promise.resolve({ error: "invalid_argument", message: "unknown template" });
      if (state.meta.template !== null) return Promise.resolve({ error: "invalid_argument", message: "a template was already applied" });
      return new Promise((resolve) => {
        enqueue({ kind: "template", body, resolve });
        refresh([]);
        pump();
      });
    },

    openBlip: (id) => text.open(id),
    flushText: (id) => text.flush(id),
    pendingText: (id) => text.pendingText(id),
    pendingUpdate: (id) => text.pendingUpdate(id),

    askAgent: (args) => rpc("askAgent", args),
    cancelRun: (runId) => rpc("cancelRun", { runId }),
    async retryRun(runId) {
      const run = state.runs[runId];
      if (!run) return { error: "unknown_run", message: "no such run" };
      /** @type {any} */
      const args = { op: run.op, blipIds: run.scope?.blipIds ?? [], instructions: run.instructions ?? "" };
      if (run.scope?.sinceSeq) args.sinceSeq = run.scope.sinceSeq;
      return rpc("askAgent", args);
    },
    async reviewProposal(proposalId, decision) {
      const blip = state.blips[proposalId];
      if (!blip) return { error: "unknown_blip", message: "no such proposal" };
      return rpc("reviewProposal", { proposalId, decision, expectedVersion: blip.version });
    },
    recordDecision: (args) => rpc("recordDecision", args),
    reply: (args) => rpc("reply", args),

    getChanges: (afterSeq, limit) => rpc("getChanges", limit === undefined ? { afterSeq } : { afterSeq, limit }, { write: false }),
    getPlayback: (blipId, fromSeq, toSeq) => {
      /** @type {any} */
      const req = { blipId };
      if (fromSeq !== undefined) req.fromSeq = fromSeq;
      if (toSeq !== undefined) req.toSeq = toSeq;
      return rpc("getPlayback", req, { write: false });
    },
    exportMarkdown: (args = {}) => rpc("exportMarkdown", args, { write: false }),
    getWaveMarkdown: (args = {}) => rpc("getWaveMarkdown", args, { write: false }),

    setPresence(p) {
      if (disposed || !p || typeof p !== "object") return;
      let any = false;
      for (const key of PRESENCE_KEYS) {
        if (Object.hasOwn(p, key) && /** @type {any} */ (p)[key] !== undefined) {
          /** @type {any} */ (presence)[key] = /** @type {any} */ (p)[key];
          any = true;
        }
      }
      if (presence.blipId === null) {
        presence.editing = false;
        presence.anchor = null;
        presence.head = null;
      }
      if (any) schedulePresence();
    },

    flushPresence() {
      sendPresence();
    },

    setViewer(name, color) {
      if (disposed) return;
      viewer.name = cleanName(name, DEFAULT_NAME);
      const c = color ? cleanColor(color) : null;
      if (c) viewer.color = c;
      else if (!viewer.color) viewer.color = DEFAULT_COLOR;
      emit({ kind: "viewer" });
      joinParticipant();
      schedulePresence();
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      for (const t of [retryTimer, gapTimer, presenceTimer, unrecoverableTimer, inflight?.timer, presenceInflight?.timer]) {
        if (t) timers.clearTimeout(t);
      }
      if (heartbeat) timers.clearInterval(heartbeat);
      if (expiryTimer) timers.clearInterval(expiryTimer);
      heartbeat = expiryTimer = retryTimer = gapTimer = presenceTimer = unrecoverableTimer = null;
      text.dispose();
      listeners.clear();
      Promise.resolve()
        .then(() => gadget.leavePresence(clientId, session ?? undefined))
        .catch(() => {});
    },
  };
  return store;
}
