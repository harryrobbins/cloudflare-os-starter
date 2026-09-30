// @ts-check
// Server side of the embeddable whiteboard. Another gadget (Docs) keeps any number of drawings in
// its own Durable Object: each drawing is an ordinary whiteboard (src/core/whiteboard.js) over a
// key-prefixed repository, with its own Hub for live updates and presence. The host owns the
// drawings, so they are copied, exported, shared and deleted with the host document.
//
// Storage layout inside the host (P = "drawing:<id>:"):
//   "drawings"                 {[id]: {createdAt}}   the index (at most LIMITS.drawings entries)
//   P + "meta" | "obj:<id>" | "history" | "requests"   the board, as in src/server/do-repository.js
//   P + "preview"              {revision, title, chunks, length, tooLarge?}
//   P + "preview:<n>"          the SVG preview, in chunks of PREVIEW_CHUNK characters

import { createWhiteboard } from "../core/whiteboard.js";
import { Hub } from "../core/hub.js";
import { exportData, importData } from "../core/backup.js";
import { DoStorageRepository } from "../server/do-repository.js";
import { DEFAULT_TITLE, LIMITS as BOARD_LIMITS } from "../shared/protocol.js";

export const DRAWING_ID_RE = /^d_[0-9a-f]{12}$/;
export const INDEX_KEY = "drawings";
export const LIMITS = Object.freeze({
  /** Drawings one host keeps. */
  drawings: 100,
  /** SVG characters kept as a preview; a larger drawing shows a placeholder instead. */
  previewChars: 4_000_000,
});
/** Characters per stored preview chunk: at most 120 KB even as two-byte V8 strings. */
export const PREVIEW_CHUNK = 60_000;

/**
 * Whiteboard methods an agent may call on a drawing through the host (`drawing(id, method, args)`).
 * The same names and results as the Whiteboard gadget's RPC surface (its README).
 */
export const AGENT_METHODS = Object.freeze([
  "getBoard", "getHistory", "findObjects", "getFrame", "findIcons", "exportSvg", "exportData",
  "applyOperation", "undo", "addObjects", "addStickies", "updateObjects", "moveObjects",
  "arrangeGrid", "deleteObjects", "addFrame", "connectObjects", "importData", "addIcons", "addCode",
]);

/** @param {unknown} id */
export function isDrawingId(id) {
  return typeof id === "string" && DRAWING_ID_RE.test(id);
}

export function newDrawingId() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return "d_" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The RPC-shaped methods of one board: what the Whiteboard gadget exposes and what a host passes
 * through for an embedded drawing. Results are plain data.
 * @param {ReturnType<typeof createWhiteboard>} board
 */
export function whiteboardMethods(board) {
  const any = /** @type {any} */ (board);
  return {
    getBoard: () => board.getBoard(),
    /** @param {number} [limit] */
    getHistory: (limit = 50) => board.getHistory(limit),
    /** @param {any} [filter] */
    findObjects: (filter) => board.findObjects(filter),
    /** @param {string} frame */
    getFrame: (frame) => board.getFrame(frame),
    /** @param {any} [args] */
    findIcons: (args) => board.findIcons(args),
    /** @param {any} [args] */
    exportSvg: (args) => board.exportSvg(args),
    exportData: () => exportData(board),
    /** @param {any} args */
    importData: (args) => importData(board, args),
    /** @param {any} request */
    applyOperation: async (request) => (await board.applyOperation(request)).result,
    /** @param {any} args */
    undo: async (args) => (await board.undo(args)).result,
    /** @param {any} args */
    addObjects: async (args) => { const { created, errors } = await any.addObjects(args); return { created, errors }; },
    /** @param {any} args */
    addStickies: async (args) => { const { created, errors } = await any.addStickies(args); return { created, errors }; },
    /** @param {any} args */
    updateObjects: async (args) => (await any.updateObjects(args)).result,
    /** @param {any} args */
    moveObjects: async (args) => (await any.moveObjects(args)).result,
    /** @param {any} args */
    arrangeGrid: async (args) => (await any.arrangeGrid(args)).result,
    /** @param {any} args */
    deleteObjects: async (args) => (await any.deleteObjects(args)).result,
    /** @param {any} args */
    addFrame: async (args) => { const { frame, result } = await any.addFrame(args); return { frame, result }; },
    /** @param {any} args */
    connectObjects: async (args) => { const { connector, errors } = await any.connect(args); return { connector, errors }; },
    /** @param {any} args */
    addIcons: async (args) => { const { created, errors } = await any.addIcons(args); return { created, errors }; },
    /** @param {any} args */
    addCode: async (args) => { const { block, errors } = await any.addCode(args); return { block, errors }; },
  };
}

/**
 * @typedef {object} PreviewMeta
 * @property {number} revision  the board revision the preview shows
 * @property {string} title
 * @property {number} chunks
 * @property {number} length    SVG characters
 * @property {boolean} [tooLarge]  no SVG stored: the drawing exceeds LIMITS.previewChars
 */

/**
 * @typedef {object} DrawingSummary
 * @property {string} id
 * @property {string} title
 * @property {number} revision
 * @property {number} objects     object count
 * @property {number} lastModified
 * @property {string[]} openBy    names of the people who have it open in the editor now
 */

/**
 * Many whiteboards in one Durable Object. The host serialises nothing itself: each board has its
 * own mutation queue, and the index is only written by create/remove, which run in the host's
 * own queue (`enqueue`).
 */
export class DrawingHost {
  /** @type {Map<string, {board: ReturnType<typeof createWhiteboard>, hub: Hub, api: ReturnType<typeof whiteboardMethods>}>} */
  #open = new Map();
  /** @type {Promise<unknown>} */
  #queue = Promise.resolve();

  /**
   * @param {any} storage DurableObjectStorage
   * @param {{onChange?: (id: string) => void, limits?: Partial<typeof LIMITS>, defaultTitle?: string}} [options]
   *   onChange: a drawing committed a change (the host refreshes its preview)
   *   defaultTitle: the title of a drawing created without one (else the whiteboard's own default)
   */
  constructor(storage, { onChange, limits, defaultTitle } = {}) {
    this.storage = storage;
    this.onChange = onChange;
    this.defaultTitle = typeof defaultTitle === "string" && defaultTitle.trim() ? defaultTitle.trim() : null;
    this.limits = { ...LIMITS, ...limits };
  }

  /**
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  #enqueue(fn) {
    const result = this.#queue.then(fn);
    this.#queue = result.catch(() => {});
    return result;
  }

  /** @returns {Promise<Record<string, {createdAt: number}>>} */
  async index() {
    return (await this.storage.get(INDEX_KEY)) ?? {};
  }

  /** @param {unknown} id */
  async exists(id) {
    return isDrawingId(id) && Object.hasOwn(await this.index(), /** @type {string} */ (id));
  }

  /**
   * Creates an empty drawing (optionally titled, optionally filled from a whiteboard backup).
   * `id` lets a client pick the id of a figure it already inserted; it must be new.
   * @param {{id?: string, title?: string, data?: any, by?: string}} [args]
   * @returns {Promise<{id: string, title: string, imported?: any}>}
   */
  create(args = {}) {
    return this.#enqueue(async () => {
      const a = args && typeof args === "object" ? args : {};
      const index = await this.index();
      const id = a.id === undefined || a.id === null ? newDrawingId() : a.id;
      if (!isDrawingId(id)) throw new Error("createDrawing: id must look like d_ followed by 12 hex digits");
      if (Object.hasOwn(index, id)) throw new Error(`createDrawing: ${id} already exists`);
      if (Object.keys(index).length >= this.limits.drawings) {
        throw new Error(`createDrawing: a document holds at most ${this.limits.drawings} drawings`);
      }
      await this.storage.put(INDEX_KEY, { ...index, [id]: { createdAt: Date.now() } });
      const { api } = this.#board(id);
      const given = typeof a.title === "string" && a.title.trim() ? a.title.trim().slice(0, BOARD_LIMITS.boardTitle) : null;
      const hasData = a.data !== undefined && a.data !== null;
      // A backup's own title wins over the default, never over an explicit one.
      const title = given ?? (hasData ? null : this.defaultTitle);
      if (title) await api.applyOperation({ by: a.by, structure: { title } });
      let imported;
      if (hasData) imported = await api.importData({ data: a.data, by: a.by, structure: !given });
      const board = await api.getBoard();
      return imported === undefined ? { id, title: board.title } : { id, title: board.title, imported };
    });
  }

  /**
   * Removes a drawing and all its keys. Open editors are left subscribed to nothing.
   * @param {string} id
   */
  remove(id) {
    return this.#enqueue(async () => {
      const index = await this.index();
      if (!isDrawingId(id) || !Object.hasOwn(index, id)) return { removed: false };
      const { [id]: _gone, ...rest } = index;
      const keys = [...(await this.storage.list({ prefix: prefixOf(id) })).keys()];
      for (let i = 0; i < keys.length; i += 128) await this.storage.delete(keys.slice(i, i + 128));
      await this.storage.put(INDEX_KEY, rest);
      this.#open.delete(id);
      return { removed: true };
    });
  }

  /** @returns {Promise<DrawingSummary[]>} */
  async list() {
    const index = await this.index();
    const out = [];
    for (const id of Object.keys(index)) {
      const board = await this.#board(id).api.getBoard();
      out.push({
        id,
        title: board.title || DEFAULT_TITLE,
        revision: board.revision,
        objects: Object.keys(board.objects ?? {}).length,
        lastModified: board.lastModified,
        openBy: this.openBy(id),
      });
    }
    return out;
  }

  /** @param {string} id */
  openBy(id) {
    const hub = this.#open.get(id)?.hub;
    if (!hub) return [];
    return [...new Set(hub.list().map((p) => p.name).filter(Boolean))];
  }

  /**
   * The board for a drawing that exists (checked against the index), opened on first use.
   * @param {unknown} id
   */
  async open(id) {
    if (!(await this.exists(id))) throw new Error(`No drawing ${String(id).slice(0, 40)} in this document`);
    return this.#board(/** @type {string} */ (id));
  }

  /** @param {string} id */
  #board(id) {
    let entry = this.#open.get(id);
    if (entry) return entry;
    const hub = new Hub();
    const board = createWhiteboard(new DoStorageRepository(this.storage, { prefix: prefixOf(id) }), {
      onEvent: (event) => {
        hub.broadcast(event);
        try { this.onChange?.(id); } catch { /* the host's listener never fails a commit */ }
      },
    });
    entry = { board, hub, api: whiteboardMethods(board) };
    this.#open.set(id, entry);
    return entry;
  }

  /**
   * An agent call: one of AGENT_METHODS on one drawing.
   * @param {string} id
   * @param {string} method
   * @param {any} args
   */
  async call(id, method, args) {
    if (!AGENT_METHODS.includes(method)) {
      throw new Error(`drawing(): unknown method ${String(method).slice(0, 40)}; use one of ${AGENT_METHODS.join(", ")}`);
    }
    const { api } = await this.open(id);
    return /** @type {any} */ (api)[method](args);
  }

  // --- The editor's channel: the Whiteboard gadget's live surface, scoped to one drawing ------

  /**
   * @param {string} id
   * @param {any} callback RpcTarget with operation(event) and presence(events)
   * @param {any} client {clientId, name, color, session?}
   */
  async subscribe(id, callback, client) {
    const { hub, api } = await this.open(id);
    const stub = typeof callback?.dup === "function" ? callback.dup() : callback;
    let session;
    try {
      ({ session } = hub.add(stub, client));
    } catch (e) {
      if (stub !== callback) {
        try { stub?.[Symbol.dispose]?.(); } catch { /* ignore */ }
      }
      throw e;
    }
    return { ...(await api.getBoard()), session };
  }

  /** @param {string} id @param {any} presence */
  async updatePresence(id, presence) {
    const { hub, board } = await this.open(id);
    const { known } = hub.updatePresence(presence);
    return { known, revision: board.revisionNow() ?? await board.getRevision() };
  }

  /** @param {string} id @param {string} clientId @param {string} session */
  async leavePresence(id, clientId, session) {
    if (!(await this.exists(id))) return;
    this.#open.get(id)?.hub.leave(clientId, session);
  }

  // --- Previews -------------------------------------------------------------------------------

  /**
   * Renders the drawing and stores it as its preview, unless the stored one is already at this
   * revision. Returns the preview's metadata.
   * @param {string} id
   * @returns {Promise<PreviewMeta>}
   */
  async refreshPreview(id) {
    const { api } = await this.open(id);
    const board = await api.getBoard();
    const current = await this.previewMeta(id);
    if (current && current.revision === board.revision && current.title === board.title) return current;
    const svg = await api.exportSvg({});
    const p = prefixOf(id);
    const old = current?.chunks ?? 0;
    /** @type {PreviewMeta} */
    let meta;
    /** @type {Record<string, unknown>} */
    const puts = {};
    if (svg.length > this.limits.previewChars) {
      meta = { revision: board.revision, title: board.title, chunks: 0, length: svg.length, tooLarge: true };
    } else {
      const chunks = Math.ceil(svg.length / PREVIEW_CHUNK);
      for (let i = 0; i < chunks; i++) puts[p + "preview:" + i] = svg.slice(i * PREVIEW_CHUNK, (i + 1) * PREVIEW_CHUNK);
      meta = { revision: board.revision, title: board.title, chunks, length: svg.length };
    }
    puts[p + "preview"] = meta;
    const stale = [];
    for (let i = meta.chunks; i < old; i++) stale.push(p + "preview:" + i);
    await this.storage.transaction(async (/** @type {any} */ txn) => {
      const entries = Object.entries(puts);
      for (let i = 0; i < entries.length; i += 128) await txn.put(Object.fromEntries(entries.slice(i, i + 128)));
      for (let i = 0; i < stale.length; i += 128) await txn.delete(stale.slice(i, i + 128));
    });
    return meta;
  }

  /** @param {string} id @returns {Promise<PreviewMeta|null>} */
  async previewMeta(id) {
    return (await this.storage.get(prefixOf(id) + "preview")) ?? null;
  }

  /**
   * The drawing's current preview: {revision, title, svg} (svg null when the drawing is too large
   * to preview), from storage when it is up to date, else rendered and stored first.
   * @param {string} id
   */
  async getPreview(id) {
    if (!(await this.exists(id))) return null;
    const { board } = this.#board(id);
    const revision = board.revisionNow() ?? await board.getRevision();
    let meta = await this.previewMeta(id);
    // Stale when the board moved on since (its refresh is debounced): render now instead.
    if (!meta || meta.revision !== revision) meta = await this.refreshPreview(id);
    if (meta.tooLarge) return { revision: meta.revision, title: meta.title, svg: null, tooLarge: true };
    const keys = Array.from({ length: meta.chunks }, (_, i) => prefixOf(id) + "preview:" + i);
    /** @type {Map<string, string>} */
    const got = new Map();
    for (let i = 0; i < keys.length; i += 128) {
      for (const [k, v] of await this.storage.get(keys.slice(i, i + 128))) got.set(k, v);
    }
    const svg = keys.map((k) => got.get(k) ?? "").join("");
    return { revision: meta.revision, title: meta.title, svg };
  }
}

/** @param {string} id */
export function prefixOf(id) {
  return `drawing:${id}:`;
}
