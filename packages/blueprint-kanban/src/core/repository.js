// @ts-check
// The storage seam. Board rules (src/core/board.js) talk only to a Repository, so the same rules
// run over Durable Object storage (src/server/do-repository.js), in memory for tests and the
// harness, and later over a Gatekeeper-backed store (Jira, Grist, Git, a database).

/** @typedef {import("../shared/protocol.js").BoardMeta} BoardMeta */
/** @typedef {import("../shared/protocol.js").Card} Card */
/** @typedef {import("../shared/protocol.js").Label} Label */
/** @typedef {import("../shared/protocol.js").Comment} Comment */
/** @typedef {import("../shared/protocol.js").HistoryEntry} HistoryEntry */
/** @typedef {import("../shared/protocol.js").RequestRecord} RequestRecord */

/**
 * One atomic write. Every present field is applied together or not at all.
 * @typedef {object} Commit
 * @property {BoardMeta} [meta]
 * @property {Record<string, Label>} [labels]
 * @property {Card[]} [putCards]
 * @property {string[]} [deleteCards]          card ids
 * @property {Comment[]} [putComments]
 * @property {string[]} [deleteCommentsFor]    card ids whose comments are all removed
 * @property {HistoryEntry[]} [history]        replaces the whole list
 * @property {RequestRecord[]} [requests]      replaces the whole list of recent request records
 */

/**
 * @typedef {object} Repository
 * @property {() => Promise<BoardMeta|null>} getMeta          null for a board never initialised
 * @property {() => Promise<Record<string, Label>>} getLabels
 * @property {() => Promise<Record<string, Card>>} getCards   all cards keyed by id
 * @property {(cardId: string) => Promise<Card|null>} getCard
 * @property {(cardId: string) => Promise<Comment[]>} getComments  oldest first
 * @property {(cardId: string) => Promise<number>} countComments
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
    /** @type {Record<string, Label>} */
    this.labels = {};
    /** @type {Map<string, Card>} */
    this.cards = new Map();
    /** @type {Map<string, Comment[]>} */
    this.comments = new Map();
    /** @type {HistoryEntry[]} */
    this.history = [];
    /** @type {RequestRecord[]} */
    this.requests = [];
  }

  async getMeta() { return clone(this.meta); }
  async getLabels() { return clone(this.labels); }
  async getCards() { return clone(Object.fromEntries(this.cards)); }
  async getCard(cardId) { return clone(this.cards.get(cardId) ?? null); }
  async getComments(cardId) { return clone(this.comments.get(cardId) ?? []); }
  async countComments(cardId) { return this.comments.get(cardId)?.length ?? 0; }
  async getHistory() { return clone(this.history); }
  async getRequests() { return clone(this.requests); }

  /** @param {Commit} commit */
  async commit(commit) {
    const c = clone(commit);
    if (c.meta) this.meta = c.meta;
    if (c.labels) this.labels = c.labels;
    for (const id of c.deleteCards ?? []) this.cards.delete(id);
    for (const card of c.putCards ?? []) this.cards.set(card.id, card);
    for (const id of c.deleteCommentsFor ?? []) this.comments.delete(id);
    for (const comment of c.putComments ?? []) {
      const list = this.comments.get(comment.cardId) ?? [];
      list.push(comment);
      this.comments.set(comment.cardId, list);
    }
    if (c.history) this.history = c.history;
    if (c.requests) this.requests = c.requests;
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
