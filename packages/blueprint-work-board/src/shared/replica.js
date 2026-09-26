// @ts-check
// A local replica of a Records datastore: a bounded snapshot plus journal pages pulled by cursor
// and permission epoch. Applying a page is idempotent (entries at or below a record's revision are
// ignored), so retries and overlapping pulls are harmless. Used by the client store and by the
// gadget server's query cache.
//
// It also keeps a compact activity history per record (field diffs with actor and, when known,
// time) from the journal pages it sees, and can backfill that history from the start of the
// journal in the background.

/** @typedef {import("./model/index.js").RawRecord} RawRecord */
/**
 * @typedef {{ seq: number, ordinal?: number, entity: string, record_id: string, revision: number, actor?: string,
 *   created_at?: string, at?: string, data: Record<string, any> }} JournalEntry
 * @typedef {{ changes: JournalEntry[], cursor: number, permission_epoch: number }} JournalPage
 * @typedef {{ seq: number, revision: number, actor: string|null, at: number|null, created: boolean,
 *   diff: Record<string, [unknown, unknown]> }} HistoryEntry
 * @typedef {{ snapshot: (limit?: number) => Promise<{ records: RawRecord[], seq: number, permission_epoch: number }>,
 *   changes: (after?: number, epoch?: number) => Promise<JournalPage> }} ReplicaSource
 */

const HISTORY_PER_RECORD = 200;

/** @param {unknown} a @param {unknown} b */
export function sameValue(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Field-level differences between two versions of a record's data. @param {Record<string, any>} before @param {Record<string, any>} after */
export function diffData(before, after) {
  /** @type {Record<string, [unknown, unknown]>} */
  const diff = {};
  for (const key of new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])) {
    const a = before?.[key] ?? null, b = after?.[key] ?? null;
    if (!sameValue(a, b)) diff[key] = [a, b];
  }
  return diff;
}

/** @param {unknown} err */
function code(err) {
  const m = /^([a-z_]+):/.exec(err instanceof Error ? err.message : String(err ?? ""));
  return m ? m[1] : null;
}

/**
 * @param {{ limit?: number, maxPagesPerPull?: number, now?: () => number }} [options]
 */
export function createReplica(options = {}) {
  const limit = options.limit ?? 5000;
  const maxPages = options.maxPagesPerPull ?? 50;
  const now = options.now ?? (() => Date.now());

  /** @type {Map<string, RawRecord>} */
  let records = new Map();
  let cursor = 0;
  /** @type {number|null} */
  let epoch = null;
  /** The snapshot's watermark: history before it comes from the backfill. */
  let base = 0;
  let version = 0;
  /** Bumped whenever history changes (including backfill pages, which leave records alone). */
  let historyVersion = 0;
  /** @type {Map<string, HistoryEntry[]>} */
  let history = new Map();
  /** @type {Map<string, { created: number|null, updated: number|null }>} */
  let times = new Map();
  /** Backfill progress: the journal is read from 0 up to `base`. */
  let backfill = { done: false, cursor: 0, running: false };
  /** Records whose data is being tracked for backfill diffs (older versions than the replica's). */
  /** @type {Map<string, Record<string, any>>} */
  let backfillData = new Map();

  function reset() {
    records = new Map(); cursor = 0; epoch = null; base = 0; history = new Map(); times = new Map();
    backfill = { done: false, cursor: 0, running: false }; backfillData = new Map(); version++;
  }

  /** @param {{ records: RawRecord[], seq: number, permission_epoch: number }} snap */
  function loadSnapshot(snap) {
    reset();
    for (const r of snap.records ?? []) if (r && typeof r.id === "string") records.set(r.id, r);
    cursor = snap.seq ?? 0;
    base = cursor;
    epoch = snap.permission_epoch ?? null;
    backfill.done = base === 0;
    version++;
  }

  /** @param {JournalEntry} change @returns {number|null} */
  function timeOf(change) {
    const t = Date.parse(String(change.created_at ?? change.at ?? ""));
    return Number.isNaN(t) ? null : t;
  }

  /** @param {string} id @param {HistoryEntry} entry */
  function remember(id, entry) {
    let list = history.get(id);
    if (!list) history.set(id, list = []);
    if (list.some((e) => e.seq === entry.seq)) return;
    list.push(entry);
    list.sort((a, b) => a.seq - b.seq);
    if (list.length > HISTORY_PER_RECORD) list.splice(0, list.length - HISTORY_PER_RECORD);
    const t = times.get(id) ?? { created: null, updated: null };
    if (entry.at !== null) {
      if (entry.created) t.created = entry.at;
      if (t.updated === null || entry.at > t.updated) t.updated = entry.at;
    }
    times.set(id, t);
  }

  /**
   * Applies one journal page. Returns whether anything changed.
   * @param {JournalPage} page @param {{ live?: boolean }} [opts] live: entries are new (stamp receipt time if none)
   */
  function applyPage(page, opts = {}) {
    let changed = false;
    for (const change of page.changes ?? []) {
      if (!change || typeof change.record_id !== "string") continue;
      const current = records.get(change.record_id);
      if (current && current.revision >= change.revision) continue;
      const at = timeOf(change) ?? (opts.live ? now() : null);
      remember(change.record_id, {
        seq: change.seq, revision: change.revision, actor: change.actor ?? null, at, created: !current,
        diff: diffData(current?.data ?? {}, change.data ?? {}),
      });
      records.set(change.record_id, {
        id: change.record_id, entity: change.entity, revision: change.revision,
        created_by: current ? current.created_by : change.actor, updated_by: change.actor ?? current?.updated_by,
        created_at: current?.created_at, updated_at: change.created_at ?? change.at ?? current?.updated_at,
        data: change.data ?? {},
      });
      changed = true;
    }
    if (changed) historyVersion++;
    if (typeof page.cursor === "number" && page.cursor > cursor) cursor = page.cursor;
    if (typeof page.permission_epoch === "number") epoch = page.permission_epoch;
    if (changed) version++;
    return changed;
  }

  /**
   * Applies a page of the journal from before the snapshot: history only, never records.
   * @param {JournalPage} page
   */
  function applyBackfill(page) {
    for (const change of page.changes ?? []) {
      if (!change || change.seq > base) continue;
      const before = backfillData.get(change.record_id);
      remember(change.record_id, {
        seq: change.seq, revision: change.revision, actor: change.actor ?? null, at: timeOf(change), created: !before,
        diff: diffData(before ?? {}, change.data ?? {}),
      });
      backfillData.set(change.record_id, change.data ?? {});
    }
    backfill.cursor = Math.max(backfill.cursor, Math.min(page.cursor ?? 0, base));
    historyVersion++;
    if (!page.changes?.length || backfill.cursor >= base) { backfill.done = true; backfillData = new Map(); version++; }
  }

  return {
    get records() { return records; },
    get cursor() { return cursor; },
    get epoch() { return epoch; },
    get version() { return version; },
    get historyVersion() { return historyVersion; },
    get history() { return history; },
    get times() { return times; },
    get backfill() { return backfill; },
    get loaded() { return epoch !== null; },
    reset, loadSnapshot, applyPage, applyBackfill,

    /** Takes a fresh snapshot. @param {ReplicaSource} source */
    async load(source) {
      loadSnapshot(await source.snapshot(limit));
    },

    /**
     * Pulls journal pages until one is empty (bounded). A permission-epoch reset reloads the
     * snapshot. Other errors propagate.
     * @param {ReplicaSource} source @returns {Promise<{ changed: boolean, reset: boolean }>}
     */
    async pull(source) {
      let changed = false;
      try {
        for (let i = 0; i < maxPages; i++) {
          const page = await source.changes(cursor, epoch ?? undefined);
          if (applyPage(page, { live: true })) changed = true;
          if (!page.changes?.length || page.changes.length < 100) break;
        }
        return { changed, reset: false };
      } catch (err) {
        if (code(err) !== "reset_required") throw err;
        loadSnapshot(await source.snapshot(limit));
        return { changed: true, reset: true };
      }
    },

    /**
     * Reads up to `pages` pages of pre-snapshot journal into history. Resolves with whether the
     * backfill is complete. Safe to call repeatedly.
     * @param {ReplicaSource} source @param {number} [pages]
     */
    async backfillHistory(source, pages = 5) {
      if (backfill.done || backfill.running) return backfill.done;
      backfill.running = true;
      const myVersionEpoch = epoch;
      try {
        for (let i = 0; i < pages && !backfill.done; i++) {
          const page = await source.changes(backfill.cursor, epoch ?? undefined);
          if (epoch !== myVersionEpoch) return false;
          applyBackfill(page);
        }
      } finally {
        backfill.running = false;
      }
      return backfill.done;
    },
  };
}
