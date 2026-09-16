// @ts-check
// The client sync engine: subscription and re-subscription, the optimistic pending-op queue,
// acknowledgement and conflict handling, and presence. Implements Store from
// src/client/store-contract.js. Pure state logic lives in src/client/model/.

import {
  LIMITS, PRESENCE_HEARTBEAT_MS, PRESENCE_STALE_MS, cleanLine, newId,
} from "../../shared/protocol.js";
import { diffBoards } from "../model/diff.js";
import { deepEqual } from "../model/equal.js";
import {
  alreadyApplied, buildRequest, cardIdOf, dependsOn, deriveBoard, mergeOps, pickCardFields,
} from "../model/ops.js";
import { placeCard } from "../model/placement.js";
import { decidePatchConflict } from "../model/rebase.js";
import {
  applyCardState, applyColumnState, applyUpdate, createServerModel,
} from "../model/server-model.js";

/** @typedef {import("../store-contract.js").Store} Store */
/** @typedef {import("../store-contract.js").StoreOptions} StoreOptions */
/** @typedef {import("../store-contract.js").ClientState} ClientState */
/** @typedef {import("../store-contract.js").Change} Change */
/** @typedef {import("../store-contract.js").Viewer} Viewer */
/** @typedef {import("../store-contract.js").Peer} Peer */
/** @typedef {import("../../shared/protocol.js").BoardSnapshot} BoardSnapshot */
/** @typedef {import("../../shared/protocol.js").BoardEvent} BoardEvent */
/** @typedef {import("../../shared/protocol.js").PresenceEvent} PresenceEvent */
/** @typedef {import("../../shared/protocol.js").OperationResult} OperationResult */
/** @typedef {import("../../shared/protocol.js").HistoryEntry} HistoryEntry */
/** @typedef {import("../../shared/protocol.js").Card} Card */
/** @typedef {import("../../shared/protocol.js").Column} Column */
/** @typedef {import("../model/ops.js").OpBody} OpBody */
/** @typedef {import("../model/ops.js").PendingOp} PendingOp */
/** @typedef {import("../model/ops.js").WireRef} WireRef */
/** @typedef {import("../model/server-model.js").ServerModel} ServerModel */

/** Minimum gap between presence sends. */
export const PRESENCE_THROTTLE_MS = 70;
/** How long a revision gap reported by the heartbeat may persist before a resync. */
export const GAP_GRACE_MS = 1000;
/** A request with no result after this long is treated as failed. */
export const REQUEST_TIMEOUT_MS = 30000;
/** Failed requests (rejected or timed out) an op survives before it is dropped. */
export const MAX_SEND_FAILURES = 3;
export const BACKOFF_BASE_MS = 500;
export const BACKOFF_MAX_MS = 10000;
const HISTORY_MAX = LIMITS.historyEntries;

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
  const { gadget, RpcTarget } = options;
  const timers = /** @type {any} */ (options.timers ?? defaultTimers());

  /** @type {Viewer} */
  const viewer = { ...options.viewer };
  const clientId = viewer.clientId;

  /** @type {ServerModel} */
  let model = createServerModel({
    schemaVersion: 1, revision: 0, title: "", columnOrder: [], columns: {}, cards: {}, labels: {},
    lastModified: 0,
  });
  /** @type {PendingOp[]} */
  let queue = [];
  let seq = 0;
  /** @type {{token: number, ops: PendingOp[], refs: Map<PendingOp, WireRef>, timer: any}|null} */
  let inflight = null;
  let requestToken = 0;

  // Revisions: `lastRevision` is the highest revision up to which this client has seen every
  // change (from snapshots and events, plus acks of its own changes when contiguous).
  let lastRevision = 0;
  /** @type {Set<number>} */
  const ackedRevisions = new Set();
  /** @type {Set<string>} card ids ever present in server state */
  const everSeen = new Set();
  /** @type {Set<string>} */
  const seenComments = new Set();

  // Subscription generations. Events from an older generation's callbacks are ignored; events
  // for the current generation that arrive before its snapshot is installed are buffered.
  let generation = 0;
  let generationReady = false;
  /** @type {BoardEvent[]} */
  let buffered = [];
  let resubscribing = false;
  let failures = 0;
  /** @type {any} */
  let retryTimer = null;
  /** @type {any} */
  let gapTimer = null;
  let gapTarget = 0;
  let disposed = false;

  /** @type {{openCardId: string|null, dragCardId: string|null, hoverColumnId: string|null}} */
  const presence = { openCardId: null, dragCardId: null, hoverColumnId: null };
  let lastPresenceSent = -Infinity;
  /** @type {any} */
  let presenceTimer = null;
  /** @type {any} */
  let heartbeat = null;

  /** @type {ClientState} */
  const state = {
    board: model.board,
    viewer,
    peers: new Map(),
    connection: "connecting",
    conflicts: new Map(),
    pending: 0,
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
        console.error("kanban store listener failed", err);
      }
    }
  }

  /**
   * Re-derives the optimistic board and emits the difference. Emits nothing when neither the
   * board nor the pending count changed, unless `force`.
   * @param {Change["kind"]} kind
   * @param {boolean} [force]
   */
  function refresh(kind, force = false) {
    const prev = state.board;
    state.board = deriveBoard(model.board, queue);
    const d = diffBoards(prev, state.board);
    const pendingChanged = state.pending !== queue.length;
    state.pending = queue.length;
    if (!force && !d.all && d.cards.length === 0 && !pendingChanged) return;
    /** @type {Change} */
    const change = { kind, columns: d.columns, cards: d.cards };
    if (d.all) change.all = true;
    emit(change);
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

  /** @param {(HistoryEntry|null|undefined)[]} entries */
  function appendHistory(entries) {
    let added = false;
    for (const entry of entries) {
      if (!entry || state.history.some((h) => h.id === entry.id)) continue;
      state.history.push(entry);
      added = true;
    }
    if (!added) return;
    if (state.history.length > HISTORY_MAX) state.history.splice(0, state.history.length - HISTORY_MAX);
    emit({ kind: "history" });
  }

  // -----------------------------------------------------------------------------------------
  // Revisions and server state
  // -----------------------------------------------------------------------------------------

  /** @param {number} revision */
  function advanceRevision(revision) {
    if (revision > lastRevision) lastRevision = revision;
    while (ackedRevisions.has(lastRevision + 1)) ackedRevisions.delete(++lastRevision);
    for (const r of ackedRevisions) if (r <= lastRevision) ackedRevisions.delete(r);
  }

  /** @param {number} revision  revision of a change this client made itself */
  function noteOwnRevision(revision) {
    if (revision <= lastRevision) return;
    if (revision === lastRevision + 1) advanceRevision(revision);
    else ackedRevisions.add(revision);
  }

  /** @param {string[]} cardIds */
  function refreshConflicts(cardIds) {
    let changed = false;
    for (const id of cardIds) {
      const conflict = state.conflicts.get(id);
      if (!conflict) continue;
      const theirs = model.board.cards[id] ?? null;
      if (theirs === conflict.theirs) continue;
      state.conflicts.set(id, { ...conflict, theirs });
      changed = true;
    }
    return changed;
  }

  /** @param {BoardSnapshot} snapshot */
  function installSnapshot(snapshot) {
    model = createServerModel(snapshot);
    for (const id of Object.keys(model.board.cards)) everSeen.add(id);
    lastRevision = model.board.revision;
    ackedRevisions.clear();
    refreshConflicts([...state.conflicts.keys()]);
    const prev = state.board;
    state.board = deriveBoard(model.board, queue);
    state.pending = queue.length;
    emit({ kind: "snapshot", all: true, columns: [], cards: diffBoards(prev, state.board).cards });
  }

  /**
   * @param {{upserts?: Card[], deletes?: {cardId: string}[], structure?: any, labels?: any,
   *   lastModified?: number}} update
   * @param {number} revision
   */
  function applyServerUpdate(update, revision) {
    const res = applyUpdate(model, update, revision);
    for (const c of update.upserts ?? []) everSeen.add(c.id);
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
    if (event.type === "comment") {
      const comment = event.comment;
      if (!comment || seenComments.has(comment.id)) return;
      if (event.senderId === clientId) return; // addComment's result reports it
      seenComments.add(comment.id);
      emit({ kind: "comment", comment, cards: [comment.cardId] });
      return;
    }
    if (event.type === "operation") {
      const res = applyServerUpdate(event, event.revision);
      advanceRevision(event.revision);
      if (refreshConflicts(res.cards)) emit({ kind: "conflict", cards: res.cards });
      refresh("operation");
      appendHistory([event.history]);
    }
  }

  // -----------------------------------------------------------------------------------------
  // Subscription
  // -----------------------------------------------------------------------------------------

  function clientInfo() {
    return { clientId, name: viewer.name, color: viewer.color };
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

    /** @param {PresenceEvent} event */
    presence(event) {
      if (disposed || this.#gen !== generation) return;
      applyPresence(event);
    }

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
    try {
      const snapshot = await gadget.subscribe(new Callbacks(gen), clientInfo());
      if (disposed || gen !== generation) return;
      generationReady = true;
      const events = buffered;
      buffered = [];
      resubscribing = false;
      installSnapshot(snapshot);
      for (const event of events) applyEvent(event);
      setConnection("live");
      onFirstLive?.();
      onFirstLive = null;
      pump();
    } catch {
      if (disposed || gen !== generation) return;
      scheduleSubscribe();
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
    scheduleSubscribe();
  }

  // -----------------------------------------------------------------------------------------
  // Sending
  // -----------------------------------------------------------------------------------------

  /**
   * Local checks before (re)sending an op. Returns false when the op must not be sent.
   * @param {PendingOp} op
   */
  function shouldSend(op) {
    const server = model.board;
    if (op.replayed && alreadyApplied(op, server)) return false;
    const cardId = cardIdOf(op);
    if (cardId && op.type !== "card.create" && !server.cards[cardId]) {
      if (op.type === "card.patch" && everSeen.has(cardId)) {
        addConflict(cardId, op.patch, null);
      }
      return false;
    }
    if ((op.type === "column.rename" || op.type === "column.collapse" ||
      op.type === "column.move" || op.type === "column.delete") && !server.columns[op.columnId]) {
      return false;
    }
    return true;
  }

  function pump() {
    if (disposed || inflight || state.connection !== "live" || !generationReady) return;
    /** @type {PendingOp[]} */
    const batch = [];
    let dropped = false;
    for (let i = 0; i < queue.length && batch.length < LIMITS.opsPerRequest;) {
      const op = queue[i];
      if (batch.some((b) => dependsOn(b, op))) break;
      if (!shouldSend(op)) {
        queue.splice(i, 1);
        dropped = true;
        continue;
      }
      batch.push(op);
      i++;
    }
    if (dropped) refresh("operation");
    if (batch.length === 0) return;

    for (const op of batch) {
      op.inflight = true;
      const cardId = cardIdOf(op);
      op.baseCard = cardId ? model.board.cards[cardId] ?? null : null;
    }
    const { request, refs } = buildRequest(batch, {
      senderId: clientId,
      by: viewer.name,
      cardVersion: (id) => model.board.cards[id]?.version ?? 0,
      columnVersion: (id) => model.board.columns[id]?.version ?? 0,
    });
    const token = ++requestToken;
    const timer = timers.setTimeout(() => {
      if (inflight?.token === token) onSendFailure(token);
    }, REQUEST_TIMEOUT_MS);
    inflight = { token, ops: batch, refs, timer };
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
    timers.clearTimeout(inflight.timer);
    /** @type {Set<PendingOp>} */
    const abandoned = new Set();
    for (const op of inflight.ops) {
      op.inflight = false;
      op.replayed = true;
      op.sendFailures = (op.sendFailures ?? 0) + 1;
      if (op.sendFailures > MAX_SEND_FAILURES) abandoned.add(op);
    }
    inflight = null;
    if (disposed) return;
    if (abandoned.size) {
      // A request that keeps failing is more likely rejected than lost; stop retrying it.
      queue = queue.filter((op) => !abandoned.has(op));
      refresh("operation");
      setError("A change could not be saved and was undone.");
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
      applyServerUpdate(result, result.revision);
      refresh("operation");
      return;
    }
    const { ops, refs } = inflight;
    timers.clearTimeout(inflight.timer);
    inflight = null;
    failures = 0;

    const revision = result.revision;
    applyServerUpdate(result, revision);
    const changedSomething = (result.upserts?.length ?? 0) > 0 || (result.deletes?.length ?? 0) > 0 ||
      Boolean(result.structure) || Boolean(result.labels);
    if (changedSomething) noteOwnRevision(revision);

    /** @type {Map<string, import("../../shared/protocol.js").OpError>} */
    const errors = new Map();
    const arrayOfKind = { card: "cardOps", column: "columnOps", label: "labelOps", structure: "structure" };
    for (const e of result.errors ?? []) {
      errors.set(arrayOfKind[e.kind] + ":" + (e.kind === "structure" ? -1 : e.index), e);
    }
    // A structure error when no title change was sent rejects the whole request (e.g. "limit").
    const requestError = errors.get("structure:-1");
    const wholeRequest = requestError && !ops.some((op) => op.type === "title") ? requestError : undefined;
    /** @type {Map<string, Card|Column|null>} */
    const conflicts = new Map();
    for (const c of result.conflicts ?? []) conflicts.set(c.kind + ":" + c.id, c.current ?? null);

    /** @type {Set<PendingOp>} */
    const done = new Set();
    /** @type {string|null} */
    let errorMessage = null;
    const conflictCards = [];

    for (const op of ops) {
      op.inflight = false;
      const ref = refs.get(op);
      const error = wholeRequest ?? (ref ? errors.get(ref.array + ":" + ref.index) : undefined);
      if (error) {
        done.add(op);
        const benign = op.replayed && (error.code === "exists" ||
          (error.code === "unknown_card" && op.type === "card.delete"));
        if (benign) continue;
        if (op.type === "card.patch" && error.code === "unknown_card") {
          addConflict(op.cardId, op.patch, null);
          conflictCards.push(op.cardId);
        } else {
          errorMessage = error.message || error.code;
        }
        continue;
      }
      const cardId = cardIdOf(op);
      const key = cardId ? "card:" + cardId : "columnId" in op ? "column:" + op.columnId : null;
      if (!key || !conflicts.has(key)) {
        done.add(op);
        continue;
      }
      const current = conflicts.get(key) ?? null;
      if (cardId) applyCardState(model, cardId, /** @type {Card|null} */ (current), revision);
      else applyColumnState(model, /** @type {any} */ (op).columnId, /** @type {Column|null} */ (current));
      if (!handleConflict(op, current)) done.add(op);
      else if (cardId) conflictCards.push(cardId);
    }

    queue = queue.filter((op) => !done.has(op));
    refreshConflicts(conflictCards);
    refresh("operation");
    appendHistory([result.history]);
    if (errorMessage) setError(errorMessage);
    pump();
  }

  /**
   * Decides what happens to an op the server rejected as stale. Returns true to keep it queued
   * for another attempt (mutating it as needed), false to drop it.
   * @param {PendingOp} op
   * @param {Card|Column|null} current
   */
  function handleConflict(op, current) {
    const server = model.board;
    if (op.type !== "card.patch" && alreadyApplied(op, server)) return false;
    switch (op.type) {
      case "card.create":
      case "column.create":
      case "column.rename": // renames: take theirs silently
      case "column.collapse":
      case "column.move":
        return false;
      case "card.patch": {
        const theirs = server.cards[op.cardId] ?? null;
        if (op.pinnedBase != null) {
          const same = theirs && Object.entries(op.patch)
            .every(([k, v]) => deepEqual(/** @type {any} */ (theirs)[k], v));
          if (!same) addConflict(op.cardId, op.patch, theirs);
          return false;
        }
        const decision = decidePatchConflict(op.patch, op.baseCard ?? null, theirs, op.retries);
        if (decision.action === "retry") {
          op.patch = decision.patch;
          op.retries++;
          op.replayed = false;
          return true;
        }
        if (decision.action === "conflict") addConflict(op.cardId, op.patch, theirs);
        return false;
      }
      case "card.move":
      case "card.delete":
      case "column.delete":
        if (!current || op.retries > 0) return false;
        op.retries++;
        op.replayed = false;
        return true;
      default:
        return false;
    }
  }

  /**
   * @param {string} cardId
   * @param {Partial<Card>} mine
   * @param {Card|null} theirs
   */
  function addConflict(cardId, mine, theirs) {
    const existing = state.conflicts.get(cardId);
    state.conflicts.set(cardId, {
      cardId,
      mine: { ...(existing?.mine ?? {}), ...mine },
      theirs,
    });
    emit({ kind: "conflict", cards: [cardId] });
  }

  // -----------------------------------------------------------------------------------------
  // Local actions
  // -----------------------------------------------------------------------------------------

  /** @param {OpBody} body */
  function enqueueOne(body) {
    for (let i = queue.length - 1; i >= 0; i--) {
      const target = queue[i];
      if (target.inflight) break;
      const merged = target.replayed ? null : mergeOps(target, body);
      if (merged === "cancel") {
        queue.splice(i, 1);
        return;
      }
      if (merged) {
        queue[i] = /** @type {PendingOp} */ ({ ...target, ...merged });
        return;
      }
      if (dependsOn(target, body)) break;
    }
    queue.push(/** @type {PendingOp} */ ({
      ...body, seq: ++seq, inflight: false, retries: 0, replayed: false,
    }));
  }

  /** @param {OpBody[]} bodies */
  function enqueue(...bodies) {
    if (disposed) return;
    for (const body of bodies) enqueueOne(body);
    refresh("operation");
    pump();
  }

  /**
   * @param {string} columnId
   * @param {string|null|undefined} beforeCardId
   * @param {string|null} movingCardId
   */
  function place(columnId, beforeCardId, movingCardId) {
    const { order, rekey } = placeCard(state.board.cards, columnId, beforeCardId, movingCardId);
    /** @type {OpBody[]} */
    const moves = rekey.map((r) => ({ type: "card.move", cardId: r.cardId, toColumnId: columnId, order: r.order }));
    return { order, moves };
  }

  // -----------------------------------------------------------------------------------------
  // Presence
  // -----------------------------------------------------------------------------------------

  /** @param {PresenceEvent} event */
  function applyPresence(event) {
    if (!event || typeof event.clientId !== "string" || event.clientId === clientId) return;
    if (event.type === "leave") {
      if (state.peers.delete(event.clientId)) emit({ kind: "presence" });
      return;
    }
    const prev = state.peers.get(event.clientId);
    /** @type {Peer} */
    const peer = {
      clientId: event.clientId,
      name: event.name ?? prev?.name ?? "",
      color: event.color ?? prev?.color ?? "#888888",
      openCardId: event.openCardId !== undefined ? event.openCardId : prev?.openCardId ?? null,
      dragCardId: event.dragCardId !== undefined ? event.dragCardId : prev?.dragCardId ?? null,
      hoverColumnId: event.hoverColumnId !== undefined ? event.hoverColumnId : prev?.hoverColumnId ?? null,
      lastSeen: timers.now(),
    };
    state.peers.set(event.clientId, peer);
    emit({ kind: "presence" });
  }

  function expirePeers() {
    const now = timers.now();
    let removed = false;
    for (const [id, peer] of state.peers) {
      if (now - peer.lastSeen > PRESENCE_STALE_MS) {
        state.peers.delete(id);
        removed = true;
      }
    }
    if (removed) emit({ kind: "presence" });
  }

  function sendPresence() {
    if (presenceTimer) {
      timers.clearTimeout(presenceTimer);
      presenceTimer = null;
    }
    if (disposed || state.connection !== "live") return;
    lastPresenceSent = timers.now();
    const gen = generation;
    Promise.resolve()
      .then(() => gadget.updatePresence({ ...clientInfo(), ...presence }))
      .then(
        (/** @type {{known: boolean, revision: number}} */ res) => onPresenceResult(gen, res),
        () => {
          if (gen === generation) resubscribe();
        },
      );
  }

  /**
   * @param {number} gen
   * @param {{known: boolean, revision: number}} res
   */
  function onPresenceResult(gen, res) {
    if (disposed || gen !== generation || state.connection !== "live") return;
    if (!res || res.known === false) {
      resubscribe();
      return;
    }
    failures = 0;
    if (typeof res.revision === "number" && res.revision > lastRevision && !inflight) {
      gapTarget = Math.max(gapTarget, res.revision);
      if (!gapTimer) {
        gapTimer = timers.setTimeout(() => {
          gapTimer = null;
          if (disposed || state.connection !== "live") return;
          if (lastRevision < gapTarget && !inflight) resubscribe();
        }, GAP_GRACE_MS);
      }
    }
  }

  function schedulePresence() {
    if (disposed) return;
    const wait = lastPresenceSent + PRESENCE_THROTTLE_MS - timers.now();
    if (wait <= 0) sendPresence();
    else if (!presenceTimer) presenceTimer = timers.setTimeout(sendPresence, wait);
  }

  // -----------------------------------------------------------------------------------------
  // Startup
  // -----------------------------------------------------------------------------------------

  // Resolves once the first subscribe succeeds; failures retry with backoff.
  await new Promise((resolve) => {
    onFirstLive = () => resolve(undefined);
    resubscribing = true;
    scheduleSubscribe();
  });
  failures = 0;

  heartbeat = timers.setInterval(() => {
    expirePeers();
    sendPresence();
  }, PRESENCE_HEARTBEAT_MS);

  // -----------------------------------------------------------------------------------------
  // Store
  // -----------------------------------------------------------------------------------------

  /** @type {Store} */
  const store = {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    createCard(columnId, fields, beforeCardId = null) {
      const cardId = newId("card");
      const { order, moves } = place(columnId, beforeCardId, null);
      enqueue(...moves, {
        type: "card.create", cardId, columnId,
        fields: { ...pickCardFields(fields ?? {}), order },
        createdAt: timers.now(), createdBy: viewer.name,
      });
      return cardId;
    },

    updateCard(cardId, patch) {
      const fields = pickCardFields(patch ?? {});
      if (!state.board.cards[cardId] || Object.keys(fields).length === 0) return;
      enqueue({ type: "card.patch", cardId, patch: fields });
    },

    moveCard(cardId, toColumnId, beforeCardId) {
      if (!state.board.cards[cardId] || beforeCardId === cardId) return;
      const { order, moves } = place(toColumnId, beforeCardId, cardId);
      enqueue(...moves, { type: "card.move", cardId, toColumnId, order });
    },

    deleteCard(cardId) {
      if (!state.board.cards[cardId]) return;
      enqueue({ type: "card.delete", cardId });
    },

    createColumn(name, index) {
      const columnId = newId("column");
      /** @type {OpBody} */
      const body = { type: "column.create", columnId, name: cleanLine(name, LIMITS.columnName) };
      if (index != null) body.index = index;
      enqueue(body);
      return columnId;
    },

    renameColumn(columnId, name) {
      if (!state.board.columns[columnId]) return;
      enqueue({ type: "column.rename", columnId, name: cleanLine(name, LIMITS.columnName) });
    },

    moveColumn(columnId, index) {
      if (!state.board.columns[columnId]) return;
      enqueue({ type: "column.move", columnId, index });
    },

    setColumnCollapsed(columnId, collapsed) {
      if (!state.board.columns[columnId]) return;
      enqueue({ type: "column.collapse", columnId, collapsed });
    },

    deleteColumn(columnId) {
      if (!state.board.columns[columnId]) return;
      enqueue({ type: "column.delete", columnId });
    },

    setTitle(title) {
      enqueue({ type: "title", title: cleanLine(title, LIMITS.boardTitle) });
    },

    upsertLabel(labelId, name, color) {
      const id = labelId ?? newId("label");
      enqueue({ type: "label.upsert", labelId: id, label: { name: cleanLine(name, LIMITS.labelName), color } });
      return id;
    },

    deleteLabel(labelId) {
      enqueue({ type: "label.delete", labelId });
    },

    async loadComments(cardId) {
      const comments = await gadget.getComments(cardId);
      for (const c of comments ?? []) seenComments.add(c.id);
      return comments ?? [];
    },

    async addComment(cardId, text) {
      const comment = await gadget.addComment({ senderId: clientId, cardId, author: viewer.name, text });
      if (comment && !seenComments.has(comment.id)) {
        seenComments.add(comment.id);
        emit({ kind: "comment", comment, cards: [comment.cardId] });
      }
      return comment;
    },

    async loadHistory(limit) {
      const entries = /** @type {HistoryEntry[]} */ (await gadget.getHistory(limit) ?? []);
      const ids = new Set(entries.map((e) => e.id));
      state.history = [...entries, ...state.history.filter((h) => !ids.has(h.id))].slice(-HISTORY_MAX);
      emit({ kind: "history" });
      return state.history;
    },

    async undo(historyId) {
      /** @type {OperationResult} */
      const result = await gadget.undo({ senderId: clientId, by: viewer.name, historyId });
      if (disposed || !result) return;
      const res = applyServerUpdate(result, result.revision);
      if (res.cards.length || res.structure || res.labels) noteOwnRevision(result.revision);
      refreshConflicts(res.cards);
      refresh("operation");
      appendHistory([result.history]);
      const error = result.errors?.[0];
      if (error) setError(error.message || error.code);
    },

    resolveConflict(cardId, choice) {
      const conflict = state.conflicts.get(cardId);
      if (!conflict) return;
      state.conflicts.delete(cardId);
      emit({ kind: "conflict", cards: [cardId] });
      if (choice === "overwrite" && conflict.theirs) {
        enqueue({
          type: "card.patch", cardId, patch: pickCardFields(conflict.mine),
          pinnedBase: conflict.theirs.version,
        });
      }
    },

    setPresence(p) {
      let changed = false;
      for (const key of /** @type {const} */ (["openCardId", "dragCardId", "hoverColumnId"])) {
        if (p && key in p && p[key] !== undefined && presence[key] !== p[key]) {
          presence[key] = p[key] ?? null;
          changed = true;
        }
      }
      if (changed) schedulePresence();
    },

    setViewer(name, color) {
      viewer.name = cleanLine(name, LIMITS.displayName);
      if (color) viewer.color = color;
      emit({ kind: "viewer" });
      schedulePresence();
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      for (const t of [retryTimer, gapTimer, presenceTimer, inflight?.timer]) {
        if (t) timers.clearTimeout(t);
      }
      if (heartbeat) timers.clearInterval(heartbeat);
      heartbeat = retryTimer = gapTimer = presenceTimer = null;
      listeners.clear();
      Promise.resolve()
        .then(() => gadget.leavePresence(clientId))
        .catch(() => {});
    },
  };
  return store;
}
