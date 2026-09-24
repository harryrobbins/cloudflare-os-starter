// @ts-check
// Whiteboard gadget server: the `Gadget` Durable Object (RPC surface in README.md) and the
// `ExportHandler`. Whiteboard rules live in src/core/whiteboard.js, subscriber fan-out and
// presence in src/core/hub.js and storage in src/server/do-repository.js; this file only wires
// them to the platform.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { createWhiteboard } from "../core/whiteboard.js";
import { Hub } from "../core/hub.js";
import { DoStorageRepository } from "./do-repository.js";

// ---------------------------------------------------------------------------------------------
// Gadget: the whiteboard's authoritative coordinator
// ---------------------------------------------------------------------------------------------

export class Gadget extends DurableObject {
  #hub = new Hub();
  /** @type {ReturnType<typeof createWhiteboard>} */
  #board;

  /** @param {DurableObjectState} ctx @param {unknown} env */
  constructor(ctx, env) {
    super(ctx, /** @type {any} */ (env));
    // Events are handed to the hub inside the whiteboard's queue, right after each commit, so
    // deliveries start in revision order. Delivery itself is not awaited: a slow subscriber must
    // not hold up the next mutation. Hub deliveries never reject.
    this.#board = createWhiteboard(new DoStorageRepository(ctx.storage), {
      onEvent: (event) => { this.#hub.broadcast(event); },
    });
  }

  // --- Reads ---------------------------------------------------------------------------------

  getBoard() {
    return this.#board.getBoard();
  }

  /** @param {number} [limit] */
  getHistory(limit = 50) {
    return this.#board.getHistory(limit);
  }

  /** @param {any} [filter] {type?, text?, frame?, within?} */
  findObjects(filter) {
    return this.#board.findObjects(filter);
  }

  /** @param {string} frame id or name */
  getFrame(frame) {
    return this.#board.getFrame(frame);
  }

  /** @param {any} [args] {query?, packId?, category?, limit?} or a query string */
  findIcons(args) {
    return this.#board.findIcons(args);
  }

  /** @param {any} [args] {frame?} */
  exportSvg(args) {
    return this.#board.exportSvg(args);
  }

  // --- Core writes ---------------------------------------------------------------------------

  /** @param {any} request OperationRequest */
  async applyOperation(request) {
    return (await this.#board.applyOperation(request)).result;
  }

  /** @param {any} args {senderId?, by?, historyId?, requestId?} */
  async undo(args) {
    return (await this.#board.undo(args)).result;
  }

  // --- Convenience writes (for executeCode from chat) ----------------------------------------

  /** @param {any} args {objects, by?} */
  async addObjects(args) {
    const { created, errors } = await this.#board.addObjects(args);
    return { created, errors };
  }

  /** @param {any} args {stickies, frame?, at?, columns?, gap?, by?} */
  async addStickies(args) {
    const { created, errors } = await this.#board.addStickies(args);
    return { created, errors };
  }

  /** @param {any} args {updates: [{id, fields}], by?} */
  async updateObjects(args) {
    return (await this.#board.updateObjects(args)).result;
  }

  /** @param {any} args {ids, dx, dy, by?} */
  async moveObjects(args) {
    return (await this.#board.moveObjects(args)).result;
  }

  /** @param {any} args {ids, columns?, gap?, at?, by?} */
  async arrangeGrid(args) {
    return (await this.#board.arrangeGrid(args)).result;
  }

  /** @param {any} args {ids, by?} */
  async deleteObjects(args) {
    return (await this.#board.deleteObjects(args)).result;
  }

  /** @param {any} args {name, x?, y?, w?, h?, contains?, by?} */
  async addFrame(args) {
    const { frame, result } = await this.#board.addFrame(args);
    return { frame, result };
  }

  /**
   * Named connectObjects, not connect: a Durable Object stub (like any Fetcher) already has a
   * built-in connect() for TCP sockets, so a `connect` RPC method is unreachable through a stub.
   * @param {any} args {from, to, label?, routing?, arrow?, color?, by?}
   */
  async connectObjects(args) {
    const { connector, errors } = await this.#board.connect(args);
    return { connector, errors };
  }

  /** @param {any} args {icons, frame?, at?, columns?, gap?, by?} */
  async addIcons(args) {
    const { created, errors } = await this.#board.addIcons(args);
    return { created, errors };
  }

  // --- Live updates and presence -------------------------------------------------------------

  /**
   * Keeps `callback` (duplicated, so it outlives this call) and returns the current snapshot plus
   * the subscription's `session` token. The subscriber is registered before the snapshot is read,
   * so no event is missed; events at or below the snapshot's revision may also arrive and should
   * be ignored by the client. Throws "clientId in use" (live subscription, other session) or
   * "board is full" (LIMITS.subscribers); the duplicated stub is disposed in that case.
   * @param {any} callback RpcTarget with operation(event) and presence(events)
   * @param {any} client {clientId, name, color, session?}
   * @returns {Promise<import("../shared/protocol.js").SubscribeResult>}
   */
  async subscribe(callback, client) {
    const stub = typeof callback?.dup === "function" ? callback.dup() : callback;
    let session;
    try {
      ({ session } = this.#hub.add(stub, client));
    } catch (e) {
      if (stub !== callback) {
        try { stub?.[Symbol.dispose]?.(); } catch { /* ignore */ }
      }
      throw e;
    }
    return { ...(await this.#board.getBoard()), session };
  }

  /**
   * Presence update and heartbeat. `known: false` tells the client this instance has no
   * subscription for it (or the session does not match), so it re-subscribes.
   * @param {any} presence PresenceUpdate
   */
  async updatePresence(presence) {
    const { known } = this.#hub.updatePresence(presence);
    return { known, revision: this.#board.revisionNow() ?? await this.#board.getRevision() };
  }

  /** @param {string} clientId @param {string} session */
  leavePresence(clientId, session) {
    this.#hub.leave(clientId, session);
  }
}

// ---------------------------------------------------------------------------------------------
// Export formats: SVG from the server; HTML and PDF rendered by the client in export mode.
// ---------------------------------------------------------------------------------------------

export class ExportHandler extends WorkerEntrypoint {
  async getExportFormats(/** @type {any} */ _gadget) {
    return [
      { id: "svg", label: "SVG image", mode: "server", contentType: "image/svg+xml", fileExtension: ".svg" },
      { id: "html", label: "HTML", mode: "browser", contentType: "text/html", fileExtension: ".html" },
      { id: "pdf", label: "PDF", mode: "browser", contentType: "application/pdf", fileExtension: ".pdf" },
    ];
  }

  /** @param {any} gadget @param {string} id */
  async export(gadget, id) {
    if (id !== "svg") throw new Error(`Unknown server export format: ${id}`);
    /** @type {any} */
    let svg;
    try {
      svg = await gadget.exportSvg({});
      return new Response(String(svg)).body;
    } finally {
      try { svg?.[Symbol.dispose]?.(); } catch { /* ignore */ }
    }
  }
}
