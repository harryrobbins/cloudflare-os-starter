// @ts-check
// A small, gadget-local log of Records change notifications, so browser tabs can ask "what changed
// since N?" cheaply instead of re-reading the datastore.
//
// Only identifiers and revisions are kept (never record bodies). Delivery from the Records hook is
// at-least-once and may be out of order; clients refetch and ignore obsolete revisions. A
// `resync` from the hook, a restarted log or a gap older than the retained window all tell the
// client to refetch everything it shows.

export const FEED_KEY = "records-feed";
export const MAX_RETAINED = 200;

/**
 * @typedef {{seq: number, entityType: string, entityId: string, revision: number, eventType: string}} FeedEntry
 * @typedef {{epoch: string, seq: number, resyncSeq: number, requested: boolean, requestedAt: string|null,
 *   lastDeliveryAt: string|null, entries: FeedEntry[]}} FeedState
 * @typedef {{get(key: string): any, put(key: string, value: any): void}} SyncKv
 */

/** @returns {FeedState} */
function fresh() {
  return {
    epoch: crypto.randomUUID(), seq: 0, resyncSeq: 0, requested: false, requestedAt: null,
    lastDeliveryAt: null, entries: [],
  };
}

export class ChangeFeed {
  /** @param {SyncKv} kv @param {() => Date} [now] */
  constructor(kv, now = () => new Date()) {
    this.kv = kv;
    this.now = now;
  }

  /** @returns {FeedState} */
  state() {
    const saved = this.kv.get(FEED_KEY);
    if (saved && typeof saved.seq === "number") return saved;
    const created = fresh();
    this.#save(created); // the epoch must be stable from the first read
    return created;
  }

  /** @param {FeedState} state */
  #save(state) {
    this.kv.put(FEED_KEY, state);
  }

  markRequested() {
    const state = this.state();
    state.requested = true;
    state.requestedAt = this.now().toISOString();
    this.#save(state);
  }

  /** @param {unknown} changes RecordsChange[] from the hook; untrusted shape, so filtered. */
  record(changes) {
    const state = this.state();
    const list = Array.isArray(changes) ? changes.slice(0, 500) : [];
    for (const c of list) {
      if (!c || typeof c !== "object") continue;
      const { entityType, entityId, revision, eventType } = /** @type {any} */ (c);
      if (typeof entityType !== "string" || typeof entityId !== "string") continue;
      state.seq += 1;
      state.entries.push({
        seq: state.seq, entityType, entityId,
        revision: typeof revision === "number" ? revision : 0,
        eventType: typeof eventType === "string" ? eventType : "",
      });
    }
    if (state.entries.length > MAX_RETAINED) state.entries = state.entries.slice(-MAX_RETAINED);
    state.lastDeliveryAt = this.now().toISOString();
    this.#save(state);
  }

  resync() {
    const state = this.state();
    state.seq += 1;
    state.resyncSeq = state.seq;
    state.lastDeliveryAt = this.now().toISOString();
    this.#save(state);
  }

  /**
   * @param {{epoch?: string, seq?: number}} [since]
   * @returns {{epoch: string, seq: number, live: "off"|"requested"|"active", lastDeliveryAt: string|null,
   *   refetchAll: boolean, changes: FeedEntry[]}}
   */
  since(since = {}) {
    const state = this.state();
    const live = state.lastDeliveryAt ? "active" : state.requested ? "requested" : "off";
    const base = { epoch: state.epoch, seq: state.seq, live, lastDeliveryAt: state.lastDeliveryAt };
    const from = typeof since.seq === "number" ? since.seq : null;
    if (from === null || since.epoch !== state.epoch || from > state.seq) {
      return { ...base, refetchAll: from !== null, changes: [] };
    }
    const oldest = state.entries[0]?.seq ?? state.seq + 1;
    const gap = from + 1 < oldest && from < state.seq;
    const resynced = state.resyncSeq > from;
    if (gap || resynced) return { ...base, refetchAll: true, changes: [] };
    return { ...base, refetchAll: false, changes: state.entries.filter((e) => e.seq > from) };
  }
}
