// @ts-check
// The client sync engine: subscription and re-subscription, the optimistic pending-op queue,
// acknowledgement and conflict handling, local undo/redo, and the connection/save status. Implements
// Store from src/client/store-contract.js. Pure state logic lives in src/client/model/, the status
// state machine in ./connection.js and the presence send policy in ./presence.js.
//
// Replaceable target: the RPC stub (`gadget`) can be swapped with replaceTarget(). The queue, its
// request ids and the undo stacks survive; the store re-subscribes on the new target, reconciles
// from its snapshot and replays only unacknowledged requests, verbatim, so the server's requestId
// records make each apply at most once.
//
// What the UI can rely on in `state.board`:
//   - `state.board` and `state.board.objects` are long-lived objects mutated in place (the same
//     references for the store's whole life, snapshots included).
//   - `state.board.objects[id]` is replaced (new identity) iff that object's optimistic value
//     changed, and every such id is listed in the "objects" (or "snapshot") change. Objects are
//     never mutated after being stored; the UI must not mutate them either.
//   - An "objects" change with an empty `objects` list means only `state.pending` changed.
//
// Cost: a remote event or an acknowledgement touching k objects costs O(k + connectors attached
// to them + pending ops naming them); only snapshots (initial load, re-subscribe) are O(board).

import {
  BACKGROUNDS, LIMITS, PRESENCE_HEARTBEAT_MS, PRESENCE_STALE_MS,
  cleanLine, cleanObjectPatch, compareObjects, isId, newId, normalizeNewObject,
} from "../../shared/protocol.js";
import { RECOVERY_FORMAT, RECOVERY_VERSION, SLOW_SAVE_MS, deriveState, riskOfLoss } from "./connection.js";
import { createPresenceSession } from "./presence.js";
import { isValidOrderKey, keysBetween } from "../../shared/order.js";
import { mergeOps, refsOf, wireOp } from "../model/ops.js";
import { rebasePatch, shiftPatch } from "../model/rebase.js";
import { applyObjectState, applyUpdate, createServerModel } from "../model/server-model.js";
import { UNDO_LIMIT, effectivePatch, previousValues } from "../model/undo.js";
import { OptimisticView } from "../model/view.js";

/** @typedef {import("../store-contract.js").Store} Store */
/** @typedef {import("../store-contract.js").StoreOptions} StoreOptions */
/** @typedef {import("../store-contract.js").ClientState} ClientState */
/** @typedef {import("../store-contract.js").Change} Change */
/** @typedef {import("../store-contract.js").Viewer} Viewer */
/** @typedef {import("../store-contract.js").Peer} Peer */
/** @typedef {import("../../shared/protocol.js").BoardSnapshot} BoardSnapshot */
/** @typedef {import("../../shared/protocol.js").BoardEvent} BoardEvent */
/** @typedef {import("../../shared/protocol.js").PresenceEvent} PresenceEvent */
/** @typedef {import("../../shared/protocol.js").PresenceState} PresenceState */
/** @typedef {import("../../shared/protocol.js").OperationResult} OperationResult */
/** @typedef {import("../../shared/protocol.js").HistoryEntry} HistoryEntry */
/** @typedef {import("../../shared/protocol.js").WhiteboardObject} WhiteboardObject */
/** @typedef {import("../../shared/protocol.js").OpError} OpError */
/** @typedef {import("../model/ops.js").OpBody} OpBody */
/** @typedef {import("../model/ops.js").PendingOp} PendingOp */
/** @typedef {import("../model/undo.js").Action} Action */
/** @typedef {import("../model/server-model.js").ServerModel} ServerModel */

/** How long a revision gap reported by the heartbeat may persist before a resync. */
export const GAP_GRACE_MS = 1000;
/** A request with no result after this long is treated as failed. */
export const REQUEST_TIMEOUT_MS = 30000;
/** Failed requests (rejected or timed out) an op survives before it is dropped. */
export const MAX_SEND_FAILURES = 3;
export const BACKOFF_BASE_MS = 500;
export const BACKOFF_MAX_MS = 10000;
/** Automatic re-sends of an update or delete rejected as stale. */
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
 * waiting on a subscribe call that has not failed is not counted (a slow server or a large
 * snapshot is not a dead connection); see SUBSCRIBE_HANG_MS for that.
 */
export const UNRECOVERABLE_AFTER_MS = 8000;
/** ... or when one subscribe call has been left unsettled this long. */
export const SUBSCRIBE_HANG_MS = 45000;
/** Peers not re-confirmed this long after a re-subscribe went live (and no presence came) are dropped. */
export const PRESENCE_CONFIRM_MS = 2000;
/** Peers are checked for staleness this often. */
export const PEER_EXPIRY_CHECK_MS = 1000;
export { PRESENCE_FAILURES_TO_RESUBSCRIBE, PRESENCE_RETRY_MS, PRESENCE_TIMEOUT_MS } from "./presence.js";
/** Request ids are `${secret}:${seq}` (see nextRequestId), at most this long, of [A-Za-z0-9:_-]. */
export const REQUEST_ID_MAX = 64;


function randomClientId() {
  const bytes = new Uint8Array(8);
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

/**
 * @param {StoreOptions} options
 * @returns {Promise<Store>}
 */
export async function createStore(options) {
  const { RpcTarget } = options;
  /** The RPC target; replaceTarget() swaps it. */
  let gadget = options.gadget;
  const timers = /** @type {any} */ (options.timers ?? defaultTimers());

  /** @type {Viewer} */
  const viewer = { ...options.viewer };
  // The server may refuse our clientId (held by another live session); we then pick a new one.
  let clientId = viewer.clientId;
  /** @type {string|null} issued by the server on first subscribe, sent back on every later call */
  let session = null;
  let clientIdRenames = 0;

  /** @type {ServerModel} */
  let model = createServerModel(null);
  const view = new OptimisticView();

  // Pending ops, in queue order, with an index by object id (each list in queue order).
  /** @type {PendingOp[]} */
  let queue = [];
  /** @type {Map<string, PendingOp[]>} */
  const opsById = new Map();
  /** @type {PendingOp[]} */
  let structureOps = [];
  /** object id -> highest seq of a pending op referring to it (frameId, from, to); conservative */
  /** @type {Map<string, number>} */
  const lastRefSeq = new Map();
  let seq = 0;
  let requestSeq = 0;

  /**
   * One request as sent. A request whose outcome is unknown (it failed or timed out) is kept
   * as `replay` and re-sent verbatim, with the same requestId and base versions, before anything
   * else: the server recognises the id and reports the original outcome instead of applying it twice.
   * @typedef {{requestId: string, ops: PendingOp[], refs: Map<PendingOp, number>, request: any}} Batch
   */
  /** @type {(Batch & {token: number, timer: any})|null} */
  let inflight = null;
  /** @type {Batch|null} */
  let replay = null;
  let requestToken = 0;

  // Revisions: `lastRevision` is the highest revision up to which this client has seen every
  // change (from snapshots and events, plus acks of its own changes when contiguous).
  let lastRevision = 0;
  /** @type {Set<number>} */
  const ackedRevisions = new Set();
  /** @type {Set<string>} object ids ever present in server state */
  const everSeen = new Set();
  /** @type {Set<string>} object ids our own requests deleted (cascades included) */
  const ownDeleted = new Set();
  /**
   * Connectors our own outstanding request deleted, as they were just before (from its result or
   * its echo, whichever came first), so a local undo of the delete can restore cascaded connectors
   * this client had not seen when it deleted the endpoint. Cleared when the request settles.
   * @type {Map<string, WhiteboardObject>}
   */
  const ownCascade = new Map();

  // Subscription generations. Events from an older generation's callbacks are ignored; events
  // for the current generation that arrive before its snapshot is installed are buffered.
  let generation = 0;
  let generationReady = false;
  /** @type {BoardEvent[]} */
  let buffered = [];
  let resubscribing = false;
  let failures = 0;
  let subscribeFailuresInRow = 0;
  /** @type {any} */
  let unrecoverableTimer = null;
  let unrecoverableFired = false;
  // Non-live time counted towards UNRECOVERABLE_AFTER_MS: `nonLiveMs` from finished stretches plus
  // the current stretch since `nonLiveSince` (null while a subscribe call is outstanding).
  let nonLiveMs = 0;
  /** @type {number|null} */
  let nonLiveSince = null;
  /** @type {number|null} when the outstanding subscribe call was made */
  let subscribeSentAt = null;
  /** @type {any} */
  let retryTimer = null;
  /** @type {any} */
  let gapTimer = null;
  let gapTarget = 0;
  let disposed = false;

  // Connection status. `link` is the transport (see ./connection.js); `recoveryRequired` is set when
  // the automatic recovery budget runs out and cleared when the link is live again.
  /** @type {import("./connection.js").LinkState} */
  let link = "connecting";
  let recoveryRequired = false;
  /** server undo calls (outside the queue) awaiting their result */
  let directPending = 0;
  /** @type {any} re-derives riskOfLoss once the oldest pending change has waited SLOW_SAVE_MS */
  let riskTimer = null;
  /**
   * Peers known before the current (re-)subscribe, not yet confirmed by a join or update from it.
   * The hub's first presence delivery to a new subscription carries a join for everyone present,
   * so whoever it does not name left while we were away and is dropped then (or, if no delivery
   * comes, PRESENCE_CONFIRM_MS after the subscription went live).
   * @type {{gen: number, ids: Set<string>, deadline: number|null}|null}
   */
  let unconfirmedPeers = null;
  /** @type {any} */
  let heartbeat = null;
  /** @type {any} */
  let expiryTimer = null;

  /** @type {Action[][]} */
  const undoStack = [];
  /** @type {Action[][]} */
  const redoStack = [];

  /** @type {Set<string>} */
  const historyIds = new Set();

  /** @type {ClientState} */
  const state = {
    board: {
      schemaVersion: model.board.schemaVersion, revision: 0, title: model.board.title,
      background: model.board.background, objects: view.objects, lastModified: 0,
    },
    viewer,
    peers: new Map(),
    connection: "connecting",
    pending: 0,
    pendingCount: 0,
    oldestPendingAt: null,
    lastAcknowledgedRevision: 0,
    riskOfLoss: false,
    canUndo: false,
    canRedo: false,
    history: [],
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
        console.error("whiteboard store listener failed", err);
      }
    }
  }

  /** Copies server meta and the optimistic title/background into state.board. */
  function syncBoard() {
    const b = state.board;
    const m = model.board;
    b.schemaVersion = m.schemaVersion;
    b.revision = m.revision;
    b.lastModified = m.lastModified;
    let title = m.title;
    let background = m.background;
    for (const op of structureOps) {
      if (op.kind !== "structure") continue;
      if (op.structure.title !== undefined) title = op.structure.title;
      if (op.structure.background !== undefined) background = op.structure.background;
    }
    const changed = title !== b.title || background !== b.background;
    b.title = title;
    b.background = background;
    return changed;
  }

  /**
   * Recomputes the optimistic value of `ids` and emits what changed.
   * @param {Iterable<string>} ids
   * @param {{forceObjects?: boolean}} [opts]
   */
  function refresh(ids, opts = {}) {
    const changed = view.recompute(ids, model.board.objects, opsById);
    const structureChanged = syncBoard();
    const pendingChanged = state.pending !== queue.length;
    state.pending = queue.length;
    if (changed.length || pendingChanged || opts.forceObjects) emit({ kind: "objects", objects: changed });
    if (structureChanged) emit({ kind: "structure" });
    syncStatus();
  }

  /** @param {import("./connection.js").LinkState} next */
  function setLink(next) {
    link = next;
    if (next === "live") recoveryRequired = false;
    syncStatus();
  }

  /**
   * Re-derives the status fields (see ./connection.js) and emits "connection" when the state or
   * riskOfLoss changed. Call after anything that changes the queue, the link or the recovery flag.
   */
  function syncStatus() {
    if (disposed) return;
    const now = timers.now();
    const pendingCount = queue.length;
    const oldestPendingAt = pendingCount ? (queue[0].queuedAt ?? now) : null;
    const connection = deriveState({ link, pendingCount, busy: directPending > 0, recoveryRequired });
    const risk = riskOfLoss({ state: connection, pendingCount, oldestPendingAt, now });
    state.pending = pendingCount;
    state.pendingCount = pendingCount;
    state.oldestPendingAt = oldestPendingAt;
    state.lastAcknowledgedRevision = lastRevision;
    if (riskTimer && (!pendingCount || risk)) {
      timers.clearTimeout(riskTimer);
      riskTimer = null;
    }
    if (pendingCount && !risk && !riskTimer && oldestPendingAt !== null) {
      riskTimer = timers.setTimeout(() => {
        riskTimer = null;
        syncStatus();
      }, Math.max(0, oldestPendingAt + SLOW_SAVE_MS - now));
    }
    if (connection === state.connection && risk === state.riskOfLoss) return;
    state.connection = connection;
    state.riskOfLoss = risk;
    emit({ kind: "connection" });
  }

  /** @param {string} message */
  function setError(message) {
    state.lastError = message;
    emit({ kind: "error" });
  }

  /** @param {Iterable<string>} ids */
  function flash(ids) {
    const list = [...new Set(ids)];
    if (list.length) emit({ kind: "flash", objects: list });
  }

  function syncUndoFlags() {
    const canUndo = undoStack.length > 0;
    const canRedo = redoStack.length > 0;
    if (canUndo === state.canUndo && canRedo === state.canRedo) return;
    state.canUndo = canUndo;
    state.canRedo = canRedo;
    emit({ kind: "undo" });
  }

  /** @param {(HistoryEntry|null|undefined)[]} entries */
  function appendHistory(entries) {
    let added = false;
    for (const entry of entries) {
      if (!entry || typeof entry.id !== "string" || historyIds.has(entry.id)) continue;
      state.history.push(entry);
      historyIds.add(entry.id);
      added = true;
    }
    if (!added) return;
    const max = LIMITS.historyEntries;
    if (state.history.length > max) {
      for (const h of state.history.splice(0, state.history.length - max)) historyIds.delete(h.id);
    }
    emit({ kind: "history" });
  }

  // -----------------------------------------------------------------------------------------
  // Revisions and server state
  // -----------------------------------------------------------------------------------------

  /** @param {number} revision */
  function advanceRevision(revision) {
    if (revision > lastRevision) lastRevision = revision;
    while (ackedRevisions.has(lastRevision + 1)) ackedRevisions.delete(++lastRevision);
    if (ackedRevisions.size) for (const r of ackedRevisions) if (r <= lastRevision) ackedRevisions.delete(r);
  }

  /** @param {number} revision  revision of a change this client made itself */
  function noteOwnRevision(revision) {
    if (revision <= lastRevision) return;
    if (revision === lastRevision + 1) advanceRevision(revision);
    else ackedRevisions.add(revision);
  }

  /** @param {BoardSnapshot} snapshot */
  function installSnapshot(snapshot) {
    const { session: _session, ...board } = /** @type {BoardSnapshot & {session?: string}} */ (snapshot ?? {});
    const before = model.board.objects;
    model = createServerModel(board);
    pinBases(before);
    for (const id in model.board.objects) everSeen.add(id);
    lastRevision = model.board.revision;
    ackedRevisions.clear();
    const changed = view.reset(model.board.objects, opsById);
    syncBoard();
    state.pending = queue.length;
    emit({ kind: "snapshot", objects: changed });
    syncStatus();
  }

  /**
   * Reconciling after a (re-)subscribe: an unsent update was made against the state this client
   * had seen, not against the new snapshot. When the object changed meanwhile, the update is sent
   * against the version it was made on, so the server reports a conflict and the usual rules apply
   * (geometry deltas re-applied, their text and style kept with a flash) instead of the update
   * silently overwriting the other change. Objects with a request of ours in flight or awaiting
   * replay are skipped: their new version may be our own change.
   * @param {Record<string, WhiteboardObject>} before  the objects of the previous server model
   */
  function pinBases(before) {
    for (const op of queue) {
      if (op.kind !== "update" || op.inflight || op.replayed || op.pinnedBase) continue;
      const old = before[op.id];
      const now = model.board.objects[op.id];
      if (!old || !now || old.version === now.version) continue;
      if ((opsById.get(op.id) ?? []).some((o) => o.inflight || o.replayed)) continue;
      op.baseObject = old;
      op.pinnedBase = true;
    }
  }

  /**
   * @param {any} update
   * @param {number} revision
   * @param {boolean} [own]  the result or echo of this client's own request
   */
  function applyServerUpdate(update, revision, own = false) {
    if ((own || (update.senderId && update.senderId === clientId && (inflight || replay))) &&
        Array.isArray(update.deletes)) {
      for (const id of update.deletes) {
        const o = typeof id === "string" ? model.board.objects[id] : undefined;
        if (o && o.type === "connector") ownCascade.set(id, o);
      }
    }
    const res = applyUpdate(model, update, revision);
    for (const o of update.upserts ?? []) if (o && typeof o.id === "string") everSeen.add(o.id);
    return res;
  }

  /** @param {BoardEvent} event */
  function applyEvent(event) {
    if (!event || typeof event !== "object") return;
    if (event.type === "snapshot") {
      installSnapshot(event.board);
      pump();
      return;
    }
    if (event.type === "operation") {
      const res = applyServerUpdate(event, event.revision);
      if (typeof event.revision === "number") advanceRevision(event.revision);
      refresh(res.objects);
      appendHistory([event.history]);
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
   * `${secret}:${seq}`: a random secret of 96 bits (24 hex), made once per store and never sent
   * except inside requestIds, plus a counter. Request records are shared by the whole board and
   * our clientId is broadcast, so an id built from it could be predicted and recorded first by a
   * peer, making the server answer our request as a duplicate without applying it.
   */
  function nextRequestId() {
    let secret = /** @type {any} */ (nextRequestId).secret;
    if (!secret) {
      const bytes = new Uint8Array(12);
      if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
      else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
      secret = /** @type {any} */ (nextRequestId).secret = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    }
    return (secret + ":" + ++requestSeq).slice(0, REQUEST_ID_MAX);
  }

  /** Our clientId is held by another session: take a fresh identity. */
  function renameClient() {
    clientId = randomClientId();
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

    /** @param {BoardEvent} event */
    operation(event) {
      if (disposed || this.#gen !== generation) return;
      if (!generationReady) buffered.push(event);
      else applyEvent(event);
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
      presence.resetFailures();
      if (unrecoverableTimer) {
        timers.clearTimeout(unrecoverableTimer);
        unrecoverableTimer = null;
      }
      unrecoverableFired = false; // the next outage gets its own budget and callback
      nonLiveMs = 0;
      nonLiveSince = null;
      subscribeSentAt = null;
      generationReady = true;
      const events = buffered;
      buffered = [];
      resubscribing = false;
      installSnapshot(snapshot);
      for (const event of events) applyEvent(event);
      if (unconfirmedPeers?.gen === gen) unconfirmedPeers.deadline = timers.now() + PRESENCE_CONFIRM_MS;
      setLink("live");
      onFirstLive?.();
      onFirstLive = null;
      pump();
      presence.flush();
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
   * live again (and nothing else is sent while it is not), so still being non-live when the budget
   * runs out means no call has succeeded in that time. Time waiting on an outstanding subscribe is
   * not counted; that call instead gets SUBSCRIBE_HANG_MS before it counts as hung.
   */
  function watchUnrecoverable() {
    if (unrecoverableFired || unrecoverableTimer || disposed) return;
    if (nonLiveSince === null && subscribeSentAt === null) nonLiveSince = timers.now();
    armUnrecoverable();
  }

  /** (Re)arms the check for whichever limit applies now. Only while watching. */
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
      if (!disposed && link !== "live") armUnrecoverable();
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

  /**
   * The automatic recovery budget is spent: the state becomes recovery-required and the owner is
   * told, once per outage. Retries continue; a later success returns to live.
   */
  function giveUp() {
    if (unrecoverableFired || disposed) return;
    unrecoverableFired = true;
    if (unrecoverableTimer) {
      timers.clearTimeout(unrecoverableTimer);
      unrecoverableTimer = null;
    }
    recoveryRequired = true;
    syncStatus();
    try {
      options.onUnrecoverable?.();
    } catch (err) {
      console.error("whiteboard onUnrecoverable failed", err);
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
    setLink("reconnecting");
    watchUnrecoverable();
    scheduleSubscribe();
  }

  // -----------------------------------------------------------------------------------------
  // Queue
  // -----------------------------------------------------------------------------------------

  /** @param {PendingOp} op */
  function indexRefs(op) {
    for (const r of refsOf(op)) lastRefSeq.set(r, Math.max(lastRefSeq.get(r) ?? 0, op.seq));
  }

  /**
   * Removes ops from the queue and its indexes.
   * @param {Set<PendingOp>} ops
   */
  function removeOps(ops) {
    if (!ops.size) return;
    queue = queue.filter((op) => !ops.has(op));
    for (const op of ops) {
      /** @type {any} */ (op).removed = true;
      if (op.kind === "structure") {
        structureOps = structureOps.filter((o) => o !== op);
        continue;
      }
      const list = opsById.get(op.id);
      if (!list) continue;
      const next = list.filter((o) => !ops.has(o));
      if (next.length) opsById.set(op.id, next);
      else opsById.delete(op.id);
    }
    if (queue.length === 0) lastRefSeq.clear();
  }

  /**
   * Queues one op, merging it into the last pending op on the same object when that one has not
   * been sent and nothing queued after it depends on the order.
   * @param {OpBody} body
   * @returns {PendingOp|null} the queued (or merged-into) op; null when it cancelled out
   */
  function enqueueBody(body) {
    if (body.kind === "structure") {
      const target = structureOps.at(-1);
      if (target && !target.inflight && !target.replayed && target.kind === "structure") {
        target.structure = { ...target.structure, ...body.structure };
        return target;
      }
      /** @type {PendingOp} */
      const op = { ...body, seq: ++seq, inflight: false, retries: 0, replayed: false, queuedAt: timers.now() };
      queue.push(op);
      structureOps.push(op);
      return op;
    }
    const list = opsById.get(body.id);
    const target = list?.at(-1);
    if (target && !target.inflight && !target.replayed && canMergeInto(target, body)) {
      const merged = mergeOps(target, body);
      if (merged === "cancel") {
        removeOps(new Set([target]));
        return null;
      }
      if (merged) {
        const t = /** @type {any} */ (target);
        delete t.object;
        delete t.patch;
        Object.assign(t, merged);
        indexRefs(target);
        return target;
      }
    }
    /** @type {PendingOp} */
    const op = /** @type {PendingOp} */ ({ ...body, seq: ++seq, inflight: false, retries: 0, replayed: false, queuedAt: timers.now() });
    queue.push(op);
    if (list) list.push(op);
    else opsById.set(body.id, [op]);
    indexRefs(op);
    return op;
  }

  /**
   * @param {PendingOp} target  the last pending op on body's object
   * @param {OpBody} body
   */
  function canMergeInto(target, body) {
    if (body.kind === "structure") return false;
    // Something queued after the target refers to this object (a connector to it, a member of it).
    if ((lastRefSeq.get(body.id) ?? 0) > target.seq) return false;
    // The body refers to an object with ops queued after the target (e.g. a frame created later).
    for (const r of refsOf(body)) {
      const last = opsById.get(r)?.at(-1);
      if (last && last.seq > target.seq) return false;
    }
    return true;
  }

  // -----------------------------------------------------------------------------------------
  // Sending
  // -----------------------------------------------------------------------------------------

  /**
   * Local checks before sending an op for the first time (or again after a conflict). May adjust
   * the op. Returns false when it must not be sent.
   * @param {PendingOp} op
   * @param {Set<string>} createdInBatch
   * @param {string[]} flashes
   */
  function prepare(op, createdInBatch, flashes) {
    const server = model.board.objects;
    /** @param {string|null|undefined} id @param {boolean} frame */
    const exists = (id, frame) => {
      if (!id) return false;
      if (createdInBatch.has(id)) return true;
      const o = server[id];
      return Boolean(o) && (frame ? o.type === "frame" : o.type !== "connector");
    };
    if (op.kind === "create") {
      if (server[op.id]) return false; // already there
      const obj = /** @type {any} */ (op.object);
      if (obj.type === "connector" && (!exists(obj.from, false) || !exists(obj.to, false))) return false;
      if (obj.frameId && !exists(obj.frameId, true)) op.object = { ...op.object, frameId: null };
      return true;
    }
    if (op.kind === "update" || op.kind === "delete") {
      if (!server[op.id]) {
        if (op.kind === "update" && everSeen.has(op.id) && !ownDeleted.has(op.id)) flashes.push(op.id);
        return false;
      }
      if (op.kind === "update") {
        const patch = /** @type {any} */ ({ ...op.patch });
        if (typeof patch.frameId === "string" && !exists(patch.frameId, true)) patch.frameId = null;
        for (const end of ["from", "to"]) {
          if (typeof patch[end] === "string" && !exists(patch[end], false)) {
            delete patch[end];
            flashes.push(op.id);
          }
        }
        if (Object.keys(patch).length === 0) return false;
        op.patch = patch;
      }
    }
    return true;
  }

  /** @param {string} id  connectors on the server attached to id (the server deletes them too) */
  function serverConnectorCount(id) {
    let n = 0;
    for (const c of view.attached.get(id) ?? []) {
      const o = model.board.objects[c];
      if (o && o.type === "connector" && (o.from === id || o.to === id)) n++;
    }
    return n;
  }

  function pump() {
    if (disposed || inflight || link !== "live" || !generationReady) return;
    if (replay) {
      // The outcome of this exact request is unknown; settle it before sending anything new.
      send(replay);
      return;
    }
    /** @type {PendingOp[]} */
    const batch = [];
    /** @type {Set<string>} */
    const ids = new Set();
    /** @type {Set<string>} */
    const createdInBatch = new Set();
    /** @type {Set<PendingOp>} */
    const dropped = new Set();
    /** @type {string[]} */
    const flashes = [];
    let hasStructure = false;
    let budget = LIMITS.commitObjects;
    for (const op of queue) {
      if (batch.length >= LIMITS.opsPerRequest) break;
      if (op.kind === "structure") {
        if (hasStructure) break;
        hasStructure = true;
        batch.push(op);
        continue;
      }
      // Two ops on one object never share a request: each is checked against its own base.
      if (ids.has(op.id)) break;
      if (!prepare(op, createdInBatch, flashes)) {
        dropped.add(op);
        continue;
      }
      const cost = op.kind === "delete" ? 1 + serverConnectorCount(op.id) : 1;
      if (batch.length && cost > budget) break;
      budget -= cost;
      ids.add(op.id);
      if (op.kind === "create") createdInBatch.add(op.id);
      batch.push(op);
    }
    if (dropped.size) {
      removeOps(dropped);
      refresh([...dropped].map((op) => /** @type {string} */ (op.id)));
    }
    flash(flashes);
    if (batch.length === 0) return;

    const server = model.board.objects;
    /** @type {any[]} */
    const objectOps = [];
    /** @type {Map<PendingOp, number>} */
    const refs = new Map();
    /** @type {any} */
    let structure = null;
    for (const op of batch) {
      if (op.kind === "structure") {
        structure = { ...op.structure };
        continue;
      }
      const base = op.kind === "create" ? null : (op.pinnedBase ? op.baseObject : server[op.id]) ?? null;
      op.pinnedBase = false;
      op.baseObject = base;
      refs.set(op, objectOps.length);
      objectOps.push(wireOp(op, base?.version ?? 0));
    }
    const requestId = nextRequestId();
    /** @type {any} */
    const request = { senderId: clientId, by: viewer.name, requestId };
    if (objectOps.length) request.objectOps = objectOps;
    if (structure) request.structure = structure;
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
      op.sendFailures = (op.sendFailures ?? 0) + 1;
      if (op.sendFailures > MAX_SEND_FAILURES) abandon = true;
    }
    if (disposed) return;
    if (abandon) {
      // A request that keeps failing is more likely rejected than lost; stop retrying it.
      for (const op of batch.ops) op.inflight = false;
      removeOps(new Set(batch.ops));
      refresh(batch.ops.flatMap((op) => (op.id ? [op.id] : [])));
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
      const res = applyServerUpdate(result, result.revision);
      refresh(res.objects);
      return;
    }
    const { ops, refs } = inflight;
    timers.clearTimeout(inflight.timer);
    inflight = null;
    failures = 0;

    const revision = result.revision;
    /** @type {Set<string>} */
    const touched = new Set();
    // A duplicate is the server's record of a request it had already applied (we re-sent it after
    // losing the result). Its effects reach us through the snapshot or events; only its per-op
    // outcome (errors, conflicts with present values) is used.
    const duplicate = /** @type {any} */ (result).duplicate === true;
    if (!duplicate) {
      const res = applyServerUpdate(result, revision, true);
      for (const id of res.objects) touched.add(id);
      for (const id of result.deletes ?? []) ownDeleted.add(id);
      const changedSomething = (result.upserts?.length ?? 0) > 0 || (result.deletes?.length ?? 0) > 0 ||
        Boolean(result.structure);
      if (changedSomething && typeof revision === "number") noteOwnRevision(revision);
    }

    /** @type {Map<number, OpError>} */
    const errors = new Map();
    for (const e of result.errors ?? []) if (e && typeof e.index === "number") errors.set(e.index, e);
    const requestError = errors.get(-1);
    const objectOpCount = refs.size;
    const hasStructure = ops.some((op) => op.kind === "structure");
    // index -1 is the structure or the whole request; with no structure sent, or nothing at all
    // applied or conflicting, it is the whole request (e.g. "limit").
    const wholeRequest = requestError && objectOpCount > 0 && (!hasStructure ||
      ((result.upserts?.length ?? 0) === 0 && (result.deletes?.length ?? 0) === 0 &&
        (result.conflicts?.length ?? 0) === 0 && errors.size === 1))
      ? requestError : undefined;

    /** @type {Map<string, WhiteboardObject|null>} */
    const conflicts = new Map();
    for (const c of result.conflicts ?? []) if (c && typeof c.id === "string") conflicts.set(c.id, c.current ?? null);

    /** @type {Set<PendingOp>} */
    const done = new Set();
    /** @type {string[]} */
    const flashes = [];
    /** @type {string|null} */
    let errorMessage = null;
    /** @param {string} message */
    const report = (message) => { errorMessage = message; };

    for (const op of ops) {
      op.inflight = false;
      if (op.kind === "structure") {
        done.add(op);
        if (requestError) errorMessage = requestError.message || requestError.code;
        continue;
      }
      touched.add(op.id);
      const index = refs.get(op);
      const error = wholeRequest ?? (index !== undefined ? errors.get(index) : undefined);
      if (error) {
        if (error.code === "invalid_ref" && !op.frameRetried && clearFrameId(op)) {
          // The frame was deleted meanwhile (the server clears a missing frame itself; this covers
          // one that still refuses it): keep the rest of the change and try once more without it.
          op.frameRetried = true;
          op.replayed = false;
          continue;
        }
        done.add(op);
        const benign = op.replayed && ((error.code === "exists" && op.kind === "create") ||
          (error.code === "unknown_object" && op.kind === "delete"));
        if (benign) continue;
        if (error.code === "unknown_object" && op.kind !== "create") {
          if (op.kind === "update") flashes.push(op.id);
          continue;
        }
        // Races, not mistakes. References are checked against the optimistic view when the change
        // is made, so invalid_ref means someone removed the endpoint or frame meanwhile (possibly in
        // an event we have not seen yet), and exists means someone else restored the same id (two
        // undos of one delete). The optimistic view already reverts to the server's state.
        if (error.code === "invalid_ref" || (error.code === "exists" && op.kind === "create")) {
          if (op.kind === "update") flashes.push(op.id);
          continue;
        }
        errorMessage = error.message || error.code;
        continue;
      }
      if (!conflicts.has(op.id)) {
        done.add(op);
        if (op.kind === "delete") restoreCascadeOnUndo(op);
        continue;
      }
      const current = conflicts.get(op.id) ?? null;
      if (typeof revision === "number") applyObjectState(model, op.id, current, revision);
      if (current) everSeen.add(op.id);
      // Rebase against what the model holds now, not the raw `current`: an event newer than this
      // result may already have landed (and `current` was then ignored). The retry is sent against
      // the model's version, so rebasing against an older `current` would overwrite that change.
      const latest = typeof revision === "number" ? (model.board.objects[op.id] ?? null) : current;
      if (!handleConflict(op, latest, flashes, report)) done.add(op);
    }

    ownCascade.clear();
    removeOps(done);
    refresh(touched);
    appendHistory([result.history]);
    flash(flashes);
    if (errorMessage) setError(errorMessage);
    pump();
  }

  /**
   * Decides what happens to an op the server rejected as stale. Returns true to keep it queued
   * for another attempt (mutating it as needed), false to drop it.
   * @param {PendingOp} op
   * @param {WhiteboardObject|null} current
   * @param {string[]} flashes
   * @param {(message: string) => void} report  called when a change is given up for good
   */
  function handleConflict(op, current, flashes, report) {
    switch (op.kind) {
      case "delete":
        if (!current) return false; // already gone
        if (op.retries >= MAX_CONFLICT_RETRIES) {
          report("An object could not be deleted because it kept changing.");
          return false;
        }
        return retry(op);
      case "update": {
        if (!current) {
          flashes.push(op.id); // deleted by someone else
          return false;
        }
        const decision = rebasePatch(op.patch, op.baseObject, current);
        if (decision.flash) flashes.push(op.id);
        if (Object.keys(decision.patch).length === 0) return false;
        if (op.retries >= MAX_CONFLICT_RETRIES) {
          report("A change could not be saved because the object kept changing.");
          return false;
        }
        op.patch = decision.patch;
        if (Object.keys(decision.shifts).length) {
          for (const later of opsById.get(op.id) ?? []) {
            if (later !== op && later.seq > op.seq && later.kind === "update" && !later.inflight && !later.replayed) {
              later.patch = shiftPatch(later.patch, decision.shifts);
              later.pinnedBase = false; // now rebased onto theirs: sent against the current version
            }
          }
        }
        return retry(op);
      }
      default:
        return false;
    }
  }

  /**
   * A delete went through: connectors it cascaded to that its undo entry does not re-create (they
   * were made by someone else after this client last saw the endpoint) are added to that entry,
   * endpoints first, so undoing the delete brings them back as a server undo would.
   * @param {PendingOp} op
   */
  function restoreCascadeOnUndo(op) {
    const entry = op.undoEntry;
    if (!entry || !ownCascade.size) return;
    for (const c of ownCascade.values()) {
      if (c.from !== op.id && c.to !== op.id) continue;
      if (entry.some((a) => a.kind === "create" && a.object.id === c.id)) continue;
      entry.push({ kind: "create", object: c });
    }
  }

  /**
   * Sets a create's or update's frameId to null. Returns false when the op names no frame.
   * @param {PendingOp} op
   */
  function clearFrameId(op) {
    if (op.kind === "create" && typeof op.object.frameId === "string" && op.object.frameId) {
      op.object = { ...op.object, frameId: null };
      return true;
    }
    if (op.kind === "update" && typeof op.patch.frameId === "string" && op.patch.frameId) {
      op.patch = { ...op.patch, frameId: null };
      return true;
    }
    return false;
  }

  /** @param {PendingOp} op */
  function retry(op) {
    op.retries++;
    op.replayed = false;
    return true;
  }

  // -----------------------------------------------------------------------------------------
  // Local changes (each call is one undo step)
  // -----------------------------------------------------------------------------------------

  /** @param {string|null|undefined} id */
  function isEndpoint(id) {
    const o = id ? view.objects[id] : undefined;
    return Boolean(o) && o.type !== "connector";
  }

  /**
   * Applies an action list optimistically and queues it. Returns the list that reverses it.
   * @param {Action[]} actions
   * @returns {Action[]}
   */
  function applyActions(actions) {
    /** @type {Action[]} */
    const inverse = [];
    /** @type {Action[]} */
    const inverseConnectors = [];
    /** @type {PendingOp[]} */
    const deletes = [];
    /** @type {Set<string>} */
    const touched = new Set();
    const now = timers.now();
    /** @param {string} id */
    const touch = (id) => {
      for (const c of view.recompute([id], model.board.objects, opsById)) touched.add(c);
    };
    for (const action of actions) {
      if (!action) continue;
      if (action.kind === "create") {
        const norm = normalizeNewObject(action.object);
        if (!norm || view.objects[norm.id]) continue;
        if (norm.type === "connector" && (!isEndpoint(norm.from) || !isEndpoint(norm.to) || norm.from === norm.to)) continue;
        enqueueBody({ kind: "create", id: norm.id, object: norm, createdAt: now, createdBy: viewer.name });
        touch(norm.id);
        inverse.push({ kind: "delete", id: norm.id });
      } else if (action.kind === "update") {
        const obj = view.objects[action.id];
        if (!obj) continue;
        const patch = effectivePatch(obj, cleanObjectPatch(action.patch, obj.type));
        if (!patch) continue;
        const prev = previousValues(obj, patch);
        enqueueBody({ kind: "update", id: obj.id, patch });
        touch(obj.id);
        inverse.push({ kind: "update", id: obj.id, patch: prev });
      } else if (action.kind === "delete") {
        const obj = view.objects[action.id];
        if (!obj) continue;
        for (const c of view.connectorsOf(obj.id)) {
          inverseConnectors.push({ kind: "create", object: view.objects[c] });
        }
        (obj.type === "connector" ? inverseConnectors : inverse).push({ kind: "create", object: obj });
        const op = enqueueBody({ kind: "delete", id: obj.id });
        if (op) deletes.push(op);
        touch(obj.id);
      }
    }
    syncBoard();
    const pendingChanged = state.pending !== queue.length;
    state.pending = queue.length;
    if (touched.size || pendingChanged) emit({ kind: "objects", objects: [...touched] });
    syncStatus();
    const entry = [...inverse, ...inverseConnectors];
    for (const op of deletes) op.undoEntry = entry;
    pump();
    return entry;
  }

  /** @param {Action[]} actions  a new change: recorded for undo, clears redo */
  function change(actions) {
    if (disposed) return;
    const inverse = applyActions(actions);
    if (inverse.length === 0) return;
    undoStack.push(inverse);
    if (undoStack.length > UNDO_LIMIT) undoStack.splice(0, undoStack.length - UNDO_LIMIT);
    redoStack.length = 0;
    syncUndoFlags();
  }

  /**
   * @param {Action[][]} from
   * @param {Action[][]} to
   */
  function undoRedo(from, to) {
    if (disposed) return;
    const actions = from.pop();
    if (!actions) return;
    const inverse = applyActions(actions);
    if (inverse.length) {
      to.push(inverse);
      if (to.length > UNDO_LIMIT) to.splice(0, to.length - UNDO_LIMIT);
    }
    syncUndoFlags();
  }

  /** The highest valid z key of the objects in the view (null when none). */
  function maxZ(/** @type {(o: WhiteboardObject) => boolean} */ filter = () => true) {
    /** @type {string|null} */
    let max = null;
    for (const id in view.objects) {
      const o = view.objects[id];
      if (!filter(o) || !isValidOrderKey(o.z)) continue;
      if (max === null || o.z > max) max = o.z;
    }
    return max;
  }

  /** @param {(o: WhiteboardObject) => boolean} filter */
  function minZ(filter) {
    /** @type {string|null} */
    let min = null;
    for (const id in view.objects) {
      const o = view.objects[id];
      if (!filter(o) || !isValidOrderKey(o.z)) continue;
      if (min === null || o.z < min) min = o.z;
    }
    return min;
  }

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
        cursor: e.cursor ?? null,
        viewport: e.viewport ?? null,
        selection: Array.isArray(e.selection) ? e.selection : [],
        transforms: Array.isArray(e.transforms) ? e.transforms : [],
        stroke: e.stroke ?? null,
        editingId: e.editingId ?? null,
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
    presence.setPeerCount(state.peers.size);
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
    presence.setPeerCount(state.peers.size);
    if (removed.length) emit({ kind: "presence", peers: removed });
  }

  /**
   * The settled result of an updatePresence call on generation `gen`. Returns true when healthy.
   * @param {number} gen
   * @param {{known: boolean, revision: number}|null} res
   */
  function onPresenceResult(gen, res) {
    if (disposed || gen !== generation || link !== "live") return false;
    if (!res || res.known === false) {
      resubscribe();
      return false;
    }
    failures = 0;
    if (typeof res.revision === "number" && res.revision > lastRevision && !inflight) {
      gapTarget = Math.max(gapTarget, res.revision);
      if (!gapTimer) {
        gapTimer = timers.setTimeout(() => {
          gapTimer = null;
          if (disposed || link !== "live") return;
          if (lastRevision < gapTarget && !inflight) resubscribe();
        }, GAP_GRACE_MS);
      }
    }
    return true;
  }

  const presence = createPresenceSession({
    timers,
    call: (payload) => gadget.updatePresence(payload),
    identity: clientInfo,
    canSend: () => !disposed && link === "live",
    generation: () => generation,
    onResult: onPresenceResult,
    onDead: () => resubscribe(),
    opBusy: () => inflight !== null,
  });

  // -----------------------------------------------------------------------------------------
  // Replaceable target and recovery data
  // -----------------------------------------------------------------------------------------

  /**
   * Swaps the RPC target without touching the queue or the undo stacks, then re-subscribes on it at
   * once. A request in flight on the old target has an unknown outcome: it is kept for a verbatim
   * replay (same requestId and base versions) ahead of anything new, so the server applies it at
   * most once. That is not counted as a send failure, and the new target gets a fresh recovery budget.
   * @param {any} next
   */
  function replaceTarget(next) {
    gadget = next;
    if (inflight) {
      const { timer, token: _token, ...batch } = inflight;
      timers.clearTimeout(timer);
      inflight = null;
      // Still marked in flight: nothing may merge into an op whose request will be re-sent as is.
      for (const op of batch.ops) op.replayed = true;
      replay = batch;
    }
    presence.abandon();
    for (const t of [retryTimer, gapTimer, unrecoverableTimer]) if (t) timers.clearTimeout(t);
    retryTimer = gapTimer = unrecoverableTimer = null;
    unrecoverableFired = false;
    subscribeFailuresInRow = 0;
    failures = 0;
    nonLiveMs = 0;
    nonLiveSince = null;
    subscribeSentAt = null;
    resubscribing = true;
    generationReady = false;
    setLink(link === "connecting" ? "connecting" : "reconnecting");
    watchUnrecoverable();
    failures++; // the immediate attempt below counts as the first; later ones back off
    void attemptSubscribe();
  }

  /**
   * A data-only copy of what a reload could lose: the last acknowledged server state and the
   * pending changes. Never includes request ids (they carry this store's secret) or the session.
   * @returns {import("../store-contract.js").RecoveryData}
   */
  function recoveryData() {
    return /** @type {any} */ (structuredClone({
      format: RECOVERY_FORMAT,
      version: RECOVERY_VERSION,
      savedAt: new Date(timers.now()).toISOString(),
      lastAcknowledgedRevision: lastRevision,
      board: model.board,
      pending: queue.map((op) => {
        /** @type {Record<string, any>} */
        const out = { kind: op.kind, queuedAt: op.queuedAt ?? null, sent: Boolean(op.inflight || op.replayed) };
        if (op.kind === "structure") {
          out.structure = op.structure;
          return out;
        }
        out.id = op.id;
        if (op.kind === "create") out.object = op.object;
        else out.baseVersion = (op.baseObject ?? model.board.objects[op.id])?.version ?? null;
        if (op.kind === "update") out.patch = op.patch;
        return out;
      }),
    }));
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
    presence.heartbeat(); // skipped while a call is in flight or one was sent recently
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

    createObjects(objects) {
      if (disposed || !Array.isArray(objects)) return [];
      const list = objects.filter((o) => o && typeof o === "object");
      const needZ = list.filter((o) => !isValidOrderKey(o.z)).length;
      let keys = [];
      if (needZ) {
        try {
          keys = keysBetween(maxZ(), null, needZ);
        } catch {
          keys = keysBetween(null, null, needZ);
        }
      }
      /** @type {Action[]} */
      const actions = [];
      /** @type {string[]} */
      const ids = [];
      /** @type {Set<string>} */
      const creating = new Set();
      let k = 0;
      for (const raw of list) {
        const id = raw.id ?? newId("object");
        const z = isValidOrderKey(raw.z) ? raw.z : keys[k++];
        if (!isId(id) || view.objects[id] || creating.has(id)) continue;
        creating.add(id);
        actions.push({ kind: "create", object: { ...raw, id, z } });
        ids.push(id);
      }
      const before = new Set(ids.filter((id) => !view.objects[id]));
      change(actions);
      return ids.filter((id) => before.has(id) && view.objects[id]);
    },

    updateObjects(updates) {
      if (disposed || !Array.isArray(updates)) return;
      change(updates
        .filter((u) => u && typeof u.id === "string" && view.objects[u.id] && u.patch && typeof u.patch === "object")
        .map((u) => /** @type {Action} */ ({ kind: "update", id: u.id, patch: u.patch })));
    },

    deleteObjects(ids) {
      if (disposed || !Array.isArray(ids)) return;
      change([...new Set(ids)].filter((id) => view.objects[id]).map((id) => /** @type {Action} */ ({ kind: "delete", id })));
    },

    reorder(ids, where) {
      if (disposed || !Array.isArray(ids)) return;
      const selected = [...new Set(ids)].map((id) => view.objects[id]).filter(Boolean).sort(compareObjects);
      /** @type {Action[]} */
      const actions = [];
      for (const frames of [true, false]) {
        const group = selected.filter((o) => (o.type === "frame") === frames);
        if (!group.length) continue;
        const inGroup = (/** @type {WhiteboardObject} */ o) => (o.type === "frame") === frames;
        let keys;
        try {
          keys = where === "back" ? keysBetween(null, minZ(inGroup), group.length)
            : keysBetween(maxZ(inGroup), null, group.length);
        } catch {
          continue;
        }
        group.forEach((o, i) => actions.push({ kind: "update", id: o.id, patch: { z: keys[i] } }));
      }
      change(actions);
    },

    setStructure(patch) {
      if (disposed || !patch || typeof patch !== "object") return;
      /** @type {{title?: string, background?: "dots"|"grid"|"plain"}} */
      const s = {};
      if (typeof patch.title === "string") s.title = cleanLine(patch.title, LIMITS.boardTitle);
      if (typeof patch.background === "string" && /** @type {readonly string[]} */ (BACKGROUNDS).includes(patch.background)) {
        s.background = patch.background;
      }
      if (!Object.keys(s).length) return;
      enqueueBody({ kind: "structure", structure: s });
      refresh([]);
      pump();
    },

    undo() {
      undoRedo(undoStack, redoStack);
    },

    redo() {
      undoRedo(redoStack, undoStack);
    },

    async loadHistory(limit) {
      const entries = /** @type {HistoryEntry[]} */ (await gadget.getHistory(limit) ?? []);
      const ids = new Set(entries.map((e) => e.id));
      state.history = [...entries, ...state.history.filter((h) => !ids.has(h.id))].slice(-LIMITS.historyEntries);
      historyIds.clear();
      for (const h of state.history) historyIds.add(h.id);
      emit({ kind: "history" });
      return state.history;
    },

    async undoHistory(historyId) {
      directPending++;
      syncStatus();
      /** @type {OperationResult} */
      let result;
      try {
        result = await gadget.undo({
          senderId: clientId, by: viewer.name, historyId, requestId: nextRequestId(),
        });
      } finally {
        directPending--;
        syncStatus();
      }
      if (disposed || !result) return;
      if (result.duplicate !== true) {
        const res = applyServerUpdate(result, result.revision);
        for (const id of result.deletes ?? []) ownDeleted.add(id);
        if (res.objects.length || res.structure) noteOwnRevision(result.revision);
        refresh(res.objects);
      }
      appendHistory([result.history]);
      const error = result.errors?.[0];
      if (error) setError(error.message || error.code);
    },

    setPresence(p) {
      if (disposed) return;
      presence.set(p);
    },

    flushPresence() {
      presence.flush();
    },

    setVisibility(visible) {
      if (disposed) return;
      presence.setVisible(visible);
    },

    setViewer(name, color) {
      viewer.name = cleanLine(name, LIMITS.displayName);
      if (color) viewer.color = color;
      emit({ kind: "viewer" });
      presence.identityChanged();
    },

    replaceTarget(next) {
      if (disposed || !next) return;
      replaceTarget(next);
    },

    getRecoveryData() {
      return recoveryData();
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      for (const t of [retryTimer, gapTimer, unrecoverableTimer, riskTimer, inflight?.timer]) {
        if (t) timers.clearTimeout(t);
      }
      presence.dispose();
      if (heartbeat) timers.clearInterval(heartbeat);
      if (expiryTimer) timers.clearInterval(expiryTimer);
      heartbeat = expiryTimer = retryTimer = gapTimer = unrecoverableTimer = riskTimer = null;
      listeners.clear();
      Promise.resolve()
        .then(() => gadget.leavePresence(clientId, session ?? undefined))
        .catch(() => {});
    },
  };
  return store;
}
