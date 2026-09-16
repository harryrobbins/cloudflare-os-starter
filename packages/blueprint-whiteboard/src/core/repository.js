// @ts-check
// The storage seam. Whiteboard rules (src/core/whiteboard.js) talk only to a Repository, so the
// same rules run over Durable Object storage (src/server/do-repository.js), in memory for tests
// and the harness, and later over another backend.

/** @typedef {import("../shared/protocol.js").BoardMeta} BoardMeta */
/** @typedef {import("../shared/protocol.js").WhiteboardObject} WhiteboardObject */
/** @typedef {import("../shared/protocol.js").HistoryEntry} HistoryEntry */
/** @typedef {import("../shared/protocol.js").RequestRecord} RequestRecord */

/**
 * One atomic write. Every present field is applied together or not at all.
 * @typedef {object} Commit
 * @property {BoardMeta} [meta]
 * @property {WhiteboardObject[]} [putObjects]
 * @property {string[]} [deleteObjects]     object ids
 * @property {HistoryEntry[]} [history]     replaces the whole list
 * @property {RequestRecord[]} [requests]   replaces the whole list
 */

/**
 * @typedef {object} Repository
 * @property {() => Promise<BoardMeta|null>} getMeta          null for a board never initialised
 * @property {() => Promise<Record<string, WhiteboardObject>>} getObjects  all objects keyed by id
 * @property {() => Promise<HistoryEntry[]>} getHistory       oldest first
 * @property {() => Promise<RequestRecord[]>} getRequests     oldest first
 * @property {(commit: Commit) => Promise<void>} commit
 */

/**
 * Repository over plain maps. Values are deep-copied on the way in and out so callers cannot
 * alias stored state, matching Durable Object storage's structured-clone semantics.
 * @implements {Repository}
 */
export class InMemoryRepository {
  constructor() {
    /** @type {BoardMeta|null} */
    this.meta = null;
    /** @type {Map<string, WhiteboardObject>} */
    this.objects = new Map();
    /** @type {HistoryEntry[]} */
    this.history = [];
    /** @type {RequestRecord[]} */
    this.requests = [];
    /** Number of commits, for tests. */
    this.commits = 0;
  }

  async getMeta() { return clone(this.meta); }
  async getObjects() { return clone(Object.fromEntries(this.objects)); }
  async getHistory() { return clone(this.history); }
  async getRequests() { return clone(this.requests); }

  /** @param {Commit} commit */
  async commit(commit) {
    const c = clone(commit);
    if (c.meta) this.meta = c.meta;
    for (const id of c.deleteObjects ?? []) this.objects.delete(id);
    for (const obj of c.putObjects ?? []) this.objects.set(obj.id, obj);
    if (c.history) this.history = c.history;
    if (c.requests) this.requests = c.requests;
    this.commits++;
  }
}

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
function clone(value) {
  return value == null ? value : structuredClone(value);
}
