// @ts-check
// A scripted, in-memory stand-in for the Gadget RPC surface, for client sync tests. It is NOT the
// real core: it implements just enough version and conflict semantics (per-card versions,
// version-checked column renames and deletes, last-writer-wins order/labels/title) to exercise
// the store. All delays use setTimeout so tests drive it with fake timers.

/** @typedef {import("../../src/shared/protocol.js").Card} Card */
/** @typedef {import("../../src/shared/protocol.js").Column} Column */

export class FakeRpcTarget {}

let idCounter = 0;
/** @param {string} prefix */
function fakeId(prefix) {
  return prefix + "_" + (0x10000000 + ++idCounter).toString(16).slice(-8);
}

/**
 * @typedef {object} Subscriber
 * @property {any} callback
 * @property {{clientId: string, name: string, color: string}} info
 */

export class FakeServer {
  /**
   * @param {{latency?: number, eventLatency?: number}} [opts]
   */
  constructor(opts = {}) {
    this.latency = opts.latency ?? 0;
    this.eventLatency = opts.eventLatency ?? this.latency;
    this.revision = 0;
    this.title = "Board";
    /** @type {string[]} */
    this.columnOrder = [];
    /** @type {Record<string, Column>} */
    this.columns = {};
    /** @type {Record<string, Card>} */
    this.cards = {};
    /** @type {Record<string, any>} */
    this.labels = {};
    this.lastModified = 0;
    /** @type {any[]} */
    this.comments = [];
    /** @type {any[]} */
    this.history = [];
    /** @type {Map<string, Subscriber>} */
    this.subscribers = new Map();
    /** @type {Map<string, number>} */
    this.failures = new Map();
    this.epoch = 0;
    /** @type {{method: string, args: any[]}[]} */
    this.calls = [];
    /** @type {Set<string>} clients whose events are silently discarded */
    this.dropping = new Set();
    /** @type {Map<string, {kind: string, event: any}[]>} clients whose events are held */
    this.held = new Map();
    /** @type {any} */
    this.lastEvent = null;
    this.replayLastEventOnSubscribe = false;
    this.maxOps = 500;
    this.concurrentOps = 0;
    this.maxConcurrentOps = 0;
  }

  // ---------------------------------------------------------------------------------------
  // Test controls
  // ---------------------------------------------------------------------------------------

  /** @param {string} name */
  seedColumn(name) {
    const id = fakeId("k");
    this.columns[id] = { id, name, version: 1, collapsed: false };
    this.columnOrder.push(id);
    return id;
  }

  /**
   * @param {string} columnId
   * @param {Partial<Card>} fields
   */
  seedCard(columnId, fields = {}) {
    const id = fakeId("c");
    const inColumn = Object.values(this.cards).filter((c) => c.columnId === columnId)
      .map((c) => c.order).sort();
    const order = fields.order ?? "a" + String.fromCharCode(48 + inColumn.length);
    this.cards[id] = {
      id, columnId, order, title: "", description: "", labels: [], assignee: "", due: null,
      checklist: [], version: 1, createdAt: 0, updatedAt: 0, createdBy: "seed", ...fields,
    };
    return id;
  }

  /** Drops every subscription without calling dispose (a facet restart). */
  restart() {
    this.epoch++;
    this.subscribers.clear();
    this.held.clear();
  }

  /** @param {string} method */
  failNext(method) {
    this.failures.set(method, (this.failures.get(method) ?? 0) + 1);
  }

  /** Removes a subscriber and calls its callback's dispose, as Cap'n Web does on a broken stub. */
  /** @param {string} clientId */
  disposeSubscriber(clientId) {
    const sub = this.subscribers.get(clientId);
    this.subscribers.delete(clientId);
    sub?.callback[Symbol.dispose]?.();
  }

  /** Removes a subscriber with no leave broadcast and no dispose (e.g. a killed tab). */
  /** @param {string} clientId */
  silentDrop(clientId) {
    this.subscribers.delete(clientId);
  }

  /** @param {string} clientId */
  holdEvents(clientId) {
    if (!this.held.has(clientId)) this.held.set(clientId, []);
  }

  /** @param {string} clientId */
  releaseEvents(clientId) {
    const queued = this.held.get(clientId) ?? [];
    this.held.delete(clientId);
    const sub = this.subscribers.get(clientId);
    for (const { kind, event } of queued) if (sub) this.deliver(sub, kind, event);
  }

  /** @param {string} method */
  callsOf(method) {
    return this.calls.filter((c) => c.method === method);
  }

  board() {
    return structuredClone({
      schemaVersion: 1, revision: this.revision, title: this.title, columnOrder: this.columnOrder,
      columns: this.columns, cards: this.cards, labels: this.labels, lastModified: this.lastModified,
    });
  }

  // ---------------------------------------------------------------------------------------
  // Transport
  // ---------------------------------------------------------------------------------------

  /** @param {number} ms */
  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * @param {string} method
   * @param {any[]} args
   * @param {() => any} fn
   */
  async call(method, args, fn) {
    this.calls.push({ method, args: structuredClone(args.filter((a) => !(a instanceof FakeRpcTarget))) });
    const epoch = this.epoch;
    await this.delay(this.latency);
    const failing = this.failures.get(method) ?? 0;
    if (failing > 0) {
      this.failures.set(method, failing - 1);
      throw new Error("injected failure: " + method);
    }
    if (epoch !== this.epoch) throw new Error("connection lost");
    const result = fn();
    await this.delay(this.latency);
    if (epoch !== this.epoch) throw new Error("connection lost"); // response lost in the restart
    return result === undefined ? undefined : structuredClone(result);
  }

  /**
   * @param {Subscriber} sub
   * @param {"operation"|"presence"} kind
   * @param {any} event
   */
  deliver(sub, kind, event) {
    const copy = structuredClone(event);
    const epoch = this.epoch;
    setTimeout(() => {
      if (epoch !== this.epoch || this.subscribers.get(sub.info.clientId) !== sub) return;
      sub.callback[kind](copy);
    }, this.eventLatency);
  }

  /**
   * @param {"operation"|"presence"} kind
   * @param {any} event
   * @param {string|null} [except]
   */
  broadcast(kind, event, except = null) {
    for (const [clientId, sub] of this.subscribers) {
      if (clientId === except || this.dropping.has(clientId)) continue;
      const held = this.held.get(clientId);
      if (held) held.push({ kind, event });
      else this.deliver(sub, kind, event);
    }
  }

  /** A gadget stub for one client. */
  connect() {
    const server = this;
    return {
      getBoard: () => server.call("getBoard", [], () => server.board()),
      /** @param {any} callback @param {any} info */
      subscribe: (callback, info) => server.call("subscribe", [callback, info], () => server.doSubscribe(callback, info)),
      /** @param {any} req */
      applyOperation: (req) => server.trackOps(server.call("applyOperation", [req], () => server.doApply(req))),
      /** @param {any} req */
      addComment: (req) => server.call("addComment", [req], () => server.doAddComment(req)),
      /** @param {string} cardId */
      getComments: (cardId) => server.call("getComments", [cardId], () => server.comments.filter((c) => c.cardId === cardId)),
      /** @param {number} [limit] */
      getHistory: (limit = 50) => server.call("getHistory", [limit], () => server.history.slice(-limit)),
      /** @param {any} req */
      undo: (req) => server.call("undo", [req], () => server.doUndo(req)),
      /** @param {any} p */
      updatePresence: (p) => server.call("updatePresence", [p], () => server.doPresence(p)),
      /** @param {string} clientId */
      leavePresence: (clientId) => server.call("leavePresence", [clientId], () => server.doLeave(clientId)),
    };
  }

  /** @param {Promise<any>} promise */
  async trackOps(promise) {
    this.concurrentOps++;
    this.maxConcurrentOps = Math.max(this.maxConcurrentOps, this.concurrentOps);
    try {
      return await promise;
    } finally {
      this.concurrentOps--;
    }
  }

  // ---------------------------------------------------------------------------------------
  // RPC implementations
  // ---------------------------------------------------------------------------------------

  /** @param {any} callback @param {any} info */
  doSubscribe(callback, info) {
    /** @type {Subscriber} */
    const sub = { callback, info: { ...info } };
    for (const [id, other] of this.subscribers) {
      if (id !== info.clientId) this.deliver(sub, "presence", { type: "join", ...other.info, at: Date.now() });
    }
    this.subscribers.set(info.clientId, sub);
    // Like the real server: everyone, the newcomer included, hears the join.
    this.broadcast("presence", { type: "join", ...info, at: Date.now() });
    // The real server registers before reading the snapshot, so events at or below the
    // snapshot's revision can reach the newcomer before subscribe() resolves.
    if (this.replayLastEventOnSubscribe && this.lastEvent) this.deliver(sub, "operation", this.lastEvent);
    return this.board();
  }

  /** @param {any} p */
  doPresence(p) {
    const sub = this.subscribers.get(p.clientId);
    if (!sub) return { known: false, revision: this.revision };
    sub.info = { clientId: p.clientId, name: p.name, color: p.color };
    this.broadcast("presence", { type: "update", ...p, at: Date.now() }, p.clientId);
    return { known: true, revision: this.revision };
  }

  /** @param {string} clientId */
  doLeave(clientId) {
    if (!this.subscribers.delete(clientId)) return;
    this.broadcast("presence", { type: "leave", clientId, at: Date.now() });
  }

  /** @param {any} req */
  doAddComment(req) {
    const comment = { id: fakeId("m"), cardId: req.cardId, author: req.author, text: req.text, at: Date.now() };
    this.comments.push(comment);
    this.broadcast("operation", { type: "comment", senderId: req.senderId ?? "", comment });
    return comment;
  }

  /** @param {any} req */
  doUndo(req) {
    const entry = this.history.find((h) => h.id === req.historyId);
    if (!entry?.inverse) return this.doApply({ senderId: req.senderId, by: req.by });
    const cardOps = entry.inverse.cardOps.map((/** @type {any} */ op) => ({
      ...op, baseVersion: this.cards[op.cardId]?.version ?? 0,
    }));
    return this.doApply({ senderId: req.senderId, by: req.by, cardOps });
  }

  /** @param {string} columnId */
  endOrder(columnId) {
    const orders = Object.values(this.cards).filter((c) => c.columnId === columnId).map((c) => c.order).sort();
    const last = orders[orders.length - 1];
    return last ? last + "V" : "a0";
  }

  /** @param {any} req */
  doApply(req) {
    const total = (req.cardOps?.length ?? 0) + (req.columnOps?.length ?? 0) + (req.labelOps?.length ?? 0);
    if (total > this.maxOps) {
      return {
        status: "unchanged", revision: this.revision, upserts: [], deletes: [], moved: [], structure: null,
        labels: null, history: null, conflicts: [],
        errors: [{ kind: "structure", index: -1, code: "limit", message: "too many ops" }],
      };
    }
    /** @type {any} */
    const result = {
      status: "unchanged", revision: this.revision, upserts: [], deletes: [], moved: [],
      structure: null, labels: null, history: null, conflicts: [], errors: [],
    };
    /** @type {Map<string, Card>} */
    const upserts = new Map();
    let changed = false;
    let structure = false;
    let labels = false;
    /** @type {any} */
    let inverse = null;
    /** @param {"card"|"column"} kind @param {string} id @param {any} current */
    const conflict = (kind, id, current) => result.conflicts.push({ kind, id, current: structuredClone(current ?? null) });
    /** @param {string} kind @param {number} index @param {string} code */
    const error = (kind, index, code) => result.errors.push({ kind, index, code, message: `${kind} op ${index}: ${code}` });

    (req.columnOps ?? []).forEach((/** @type {any} */ op, /** @type {number} */ i) => {
      const col = this.columns[op.columnId];
      if (op.op === "upsert") {
        if (!col) {
          if (op.baseVersion) return conflict("column", op.columnId, null);
          if (!/^k_[0-9a-f]{8}$/.test(op.columnId)) return error("column", i, "invalid_id");
          this.columns[op.columnId] = { id: op.columnId, name: op.column?.name ?? "Untitled", version: 1, collapsed: false };
          const at = op.index == null ? this.columnOrder.length : Math.min(op.index, this.columnOrder.length);
          this.columnOrder.splice(at, 0, op.columnId);
        } else {
          if (op.baseVersion === 0) return error("column", i, "exists");
          let next = col;
          if (op.column && "name" in op.column) {
            if (op.baseVersion !== col.version) return conflict("column", op.columnId, col);
            next = { ...next, name: op.column.name, version: col.version + 1 };
          }
          if (op.column && "collapsed" in op.column) next = { ...next, collapsed: op.column.collapsed };
          this.columns[op.columnId] = next;
        }
        structure = changed = true;
      } else if (op.op === "move") {
        const from = this.columnOrder.indexOf(op.columnId);
        if (from < 0) return error("column", i, "unknown_column");
        this.columnOrder.splice(from, 1);
        this.columnOrder.splice(Math.min(op.index, this.columnOrder.length), 0, op.columnId);
        structure = changed = true;
      } else if (op.op === "delete") {
        if (!col) return conflict("column", op.columnId, null);
        if (op.baseVersion !== col.version) return conflict("column", op.columnId, col);
        delete this.columns[op.columnId];
        this.columnOrder = this.columnOrder.filter((id) => id !== op.columnId);
        for (const card of Object.values(this.cards)) {
          if (card.columnId === op.columnId) {
            delete this.cards[card.id];
            result.deletes.push({ cardId: card.id, columnId: op.columnId });
          }
        }
        structure = changed = true;
      }
    });

    (req.labelOps ?? []).forEach((/** @type {any} */ op) => {
      if (op.op === "upsert") this.labels[op.labelId] = { id: op.labelId, ...this.labels[op.labelId], ...op.label };
      else delete this.labels[op.labelId];
      labels = changed = true;
    });

    const now = Date.now();
    (req.cardOps ?? []).forEach((/** @type {any} */ op, /** @type {number} */ i) => {
      const card = this.cards[op.cardId];
      if (op.op === "upsert") {
        if (!card) {
          if (op.baseVersion) return conflict("card", op.cardId, null);
          if (!/^c_[0-9a-f]{8}$/.test(op.cardId)) return error("card", i, "invalid_id");
          if (!op.columnId) return error("card", i, "unknown_card");
          if (!this.columns[op.columnId]) return error("card", i, "unknown_column");
          const created = {
            id: op.cardId, columnId: op.columnId, order: op.card?.order ?? this.endOrder(op.columnId),
            title: "", description: "", labels: [], assignee: "", due: null, checklist: [],
            ...op.card, version: 1, createdAt: now, updatedAt: now, createdBy: req.by ?? "",
          };
          this.cards[op.cardId] = created;
          upserts.set(op.cardId, created);
          inverse = { cardOps: [{ op: "delete", cardId: op.cardId }] };
        } else {
          if (op.baseVersion === 0) return error("card", i, "exists");
          if (op.baseVersion !== card.version) return conflict("card", op.cardId, card);
          const same = Object.entries(op.card ?? {}).every(([k, v]) => JSON.stringify(/** @type {any} */ (card)[k]) === JSON.stringify(v));
          if (same) return; // unchanged: no version bump
          const next = { ...card, ...op.card, version: card.version + 1, updatedAt: now };
          this.cards[op.cardId] = next;
          upserts.set(op.cardId, next);
        }
        changed = true;
      } else if (op.op === "move") {
        if (!card) return conflict("card", op.cardId, null);
        if (op.baseVersion !== card.version) return conflict("card", op.cardId, card);
        if (!this.columns[op.toColumnId]) return error("card", i, "unknown_column");
        const next = {
          ...card, columnId: op.toColumnId, order: op.order ?? this.endOrder(op.toColumnId),
          version: card.version + 1, updatedAt: now,
        };
        this.cards[op.cardId] = next;
        upserts.set(op.cardId, next);
        result.moved.push({ cardId: op.cardId, fromColumnId: card.columnId, toColumnId: op.toColumnId });
        inverse = { cardOps: [{ op: "move", cardId: op.cardId, toColumnId: card.columnId, order: card.order }] };
        changed = true;
      } else if (op.op === "delete") {
        if (!card) return conflict("card", op.cardId, null);
        if (op.baseVersion !== card.version) return conflict("card", op.cardId, card);
        delete this.cards[op.cardId];
        upserts.delete(op.cardId);
        result.deletes.push({ cardId: op.cardId, columnId: card.columnId });
        changed = true;
      }
    });

    if (req.structure && typeof req.structure.title === "string") {
      this.title = req.structure.title;
      structure = changed = true;
    }

    if (changed) {
      this.revision++;
      this.lastModified = now;
      result.revision = this.revision;
      result.upserts = [...upserts.values()];
      if (structure) result.structure = { title: this.title, columnOrder: this.columnOrder, columns: this.columns };
      if (labels) result.labels = this.labels;
      result.history = { id: fakeId("h"), at: now, by: req.by ?? "", summary: "change", inverse };
      this.history.push(result.history);
      this.lastEvent = {
        type: "operation", senderId: req.senderId ?? "", revision: this.revision,
        upserts: result.upserts, deletes: result.deletes, moved: result.moved,
        structure: result.structure, labels: result.labels, history: result.history,
        lastModified: now,
      };
      this.broadcast("operation", this.lastEvent);
    }
    result.status = result.conflicts.length ? "conflict" : changed ? "applied" : "unchanged";
    return structuredClone(result);
  }
}
