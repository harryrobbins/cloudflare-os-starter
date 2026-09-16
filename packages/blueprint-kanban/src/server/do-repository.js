// @ts-check
// Repository over Durable Object storage (ctx.storage). Layout, as documented in README.md:
//
//   "meta"                                     BoardMeta
//   "labels"                                   {labelId: Label}
//   "card:<cardId>"                            Card
//   "comment:<cardId>:<13-digit ms>:<id>"      Comment (key order = oldest first)
//   "history"                                  HistoryEntry[]
//   "requests"                                 RequestRecord[] (recent requestIds, newest last)
//
// commit() runs inside storage.transaction(), so a multi-key write lands entirely or not at all.
// The board bounds what one commit may touch (LIMITS.cards card keys, LIMITS.columnDeleteComments
// comment keys), so a single transaction stays small; keys are still written and deleted in
// batches of 128 and comments are listed a page at a time so no call holds a whole thread.

/** @typedef {import("../core/repository.js").Commit} Commit */
/** @typedef {import("../shared/protocol.js").Card} Card */
/** @typedef {import("../shared/protocol.js").Comment} Comment */

/** storage.put/delete accept at most this many keys per call. */
const BATCH = 128;
/** Comments listed per page when collecting keys to delete. */
const LIST_PAGE = 256;

/** @param {string} cardId */
export const cardKey = (cardId) => "card:" + cardId;

/** @param {string} cardId */
export const commentPrefix = (cardId) => "comment:" + cardId + ":";

/** @param {Comment} comment */
export const commentKey = (comment) =>
  commentPrefix(comment.cardId) + String(Math.max(0, Math.trunc(comment.at))).padStart(13, "0") + ":" + comment.id;

/**
 * @template T
 * @param {T[]} items
 * @returns {T[][]}
 */
function chunks(items) {
  const out = [];
  for (let i = 0; i < items.length; i += BATCH) out.push(items.slice(i, i + BATCH));
  return out;
}

/** @implements {import("../core/repository.js").Repository} */
export class DoStorageRepository {
  /** @param {any} storage DurableObjectStorage */
  constructor(storage) {
    this.storage = storage;
  }

  async getMeta() {
    return (await this.storage.get("meta")) ?? null;
  }

  async getLabels() {
    return (await this.storage.get("labels")) ?? {};
  }

  async getCards() {
    /** @type {Map<string, Card>} */
    const entries = await this.storage.list({ prefix: "card:" });
    /** @type {Record<string, Card>} */
    const cards = {};
    for (const card of entries.values()) cards[card.id] = card;
    return cards;
  }

  /** @param {string} cardId */
  async getCard(cardId) {
    return (await this.storage.get(cardKey(cardId))) ?? null;
  }

  /** @param {string} cardId */
  async getComments(cardId) {
    /** @type {Map<string, Comment>} */
    const entries = await this.storage.list({ prefix: commentPrefix(cardId) });
    return [...entries.values()];
  }

  /** @param {string} cardId */
  async countComments(cardId) {
    return (await this.storage.list({ prefix: commentPrefix(cardId) })).size;
  }

  async getHistory() {
    return (await this.storage.get("history")) ?? [];
  }

  async getRequests() {
    return (await this.storage.get("requests")) ?? [];
  }

  /** @param {Commit} commit */
  async commit(commit) {
    await this.storage.transaction(async (/** @type {any} */ txn) => {
      /** @type {Record<string, unknown>} */
      const puts = {};
      if (commit.meta) puts.meta = commit.meta;
      if (commit.labels) puts.labels = commit.labels;
      if (commit.history) puts.history = commit.history;
      if (commit.requests) puts.requests = commit.requests;
      for (const card of commit.putCards ?? []) puts[cardKey(card.id)] = card;
      for (const comment of commit.putComments ?? []) puts[commentKey(comment)] = comment;

      /** @type {string[]} */
      const deletes = (commit.deleteCards ?? []).map(cardKey);
      for (const cardId of commit.deleteCommentsFor ?? []) {
        const prefix = commentPrefix(cardId);
        /** @type {string|undefined} */
        let startAfter;
        for (;;) {
          /** @type {Map<string, unknown>} */
          const page = await txn.list({ prefix, limit: LIST_PAGE, ...(startAfter ? { startAfter } : {}) });
          for (const key of page.keys()) deletes.push((startAfter = key));
          if (page.size < LIST_PAGE) break;
        }
      }

      const putDeletes = new Set(Object.keys(puts));
      for (const batch of chunks(deletes.filter((k) => !putDeletes.has(k)))) await txn.delete(batch);
      for (const batch of chunks(Object.entries(puts))) await txn.put(Object.fromEntries(batch));
    });
  }
}
