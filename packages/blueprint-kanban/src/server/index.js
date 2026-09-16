// @ts-check
// Kanban board gadget server: the `Gadget` Durable Object (RPC surface in README.md) and the
// `ExportHandler`. Board rules live in src/core/board.js, subscriber fan-out in src/core/hub.js
// and storage in src/server/do-repository.js; this file only wires them to the platform.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { createBoard } from "../core/board.js";
import { Hub } from "../core/hub.js";
import { DoStorageRepository } from "./do-repository.js";
import { boardToCsv } from "../shared/protocol.js";

// ---------------------------------------------------------------------------------------------
// Gadget: the board's authoritative coordinator
// ---------------------------------------------------------------------------------------------

export class Gadget extends DurableObject {
  #hub = new Hub();
  /** @type {ReturnType<typeof createBoard>} */
  #board;

  /** @param {DurableObjectState} ctx @param {unknown} env */
  constructor(ctx, env) {
    super(ctx, /** @type {any} */ (env));
    // Events are handed to the hub inside the board's mutation queue, right after each commit, so
    // deliveries start in revision order. Delivery itself is not awaited: a slow subscriber must
    // not hold up the next mutation. Hub deliveries never reject.
    this.#board = createBoard(new DoStorageRepository(ctx.storage), {
      onEvent: (event) => { this.#hub.broadcast(event); },
    });
  }

  // --- Reads ---------------------------------------------------------------------------------

  getBoard() {
    return this.#board.getBoard();
  }

  /** @param {string} cardId */
  getComments(cardId) {
    return this.#board.getComments(cardId);
  }

  /** @param {number} [limit] */
  getHistory(limit = 50) {
    return this.#board.getHistory(limit);
  }

  /** @param {any} [filter] {column?, label?, assignee?, text?} */
  findCards(filter) {
    return this.#board.findCards(filter);
  }

  // --- Core writes ---------------------------------------------------------------------------

  /** @param {any} request OperationRequest */
  async applyOperation(request) {
    return (await this.#board.applyOperation(request)).result;
  }

  /** @param {any} args {senderId?, by?, historyId, requestId?} */
  async undo(args) {
    return (await this.#board.undo(args)).result;
  }

  /** @param {any} args {senderId?, cardId, author, text} */
  async addComment(args) {
    return (await this.#board.addComment(args)).comment;
  }

  // --- Convenience writes (for executeCode from chat) ----------------------------------------

  /** @param {any} args {cards, by?} */
  async addCards(args) {
    const { created, errors } = await this.#board.addCards(args);
    return { created, errors };
  }

  /** @param {any} args {cardId, fields, by?} */
  async updateCard(args) {
    return (await this.#board.updateCard(args)).result;
  }

  /** @param {any} args {cardId, toColumn, position?, by?} */
  async moveCard(args) {
    return (await this.#board.moveCard(args)).result;
  }

  /** @param {any} args {cardId, by?} */
  async deleteCard(args) {
    return (await this.#board.deleteCard(args)).result;
  }

  /** @param {any} args {name, index?, by?} */
  async addColumn(args) {
    const { column, errors } = await this.#board.addColumn(args);
    return { column, errors };
  }

  // --- Live updates and presence -------------------------------------------------------------

  /**
   * Keeps `callback` (duplicated, so it outlives this call) and returns the current snapshot plus
   * the subscription's `session` token. The subscriber is registered before the snapshot is read,
   * so no event is missed; events at or below the snapshot's revision may also arrive and should
   * be ignored by the client. Throws "clientId in use" (live subscription, other session) or
   * "board is full" (LIMITS.subscribers).
   * @param {any} callback RpcTarget with operation(event) and presence(event)
   * @param {any} client {clientId, name, color, session?}
   * @returns {Promise<import("../shared/protocol.js").SubscribeResult>}
   */
  async subscribe(callback, client) {
    const stub = typeof callback?.dup === "function" ? callback.dup() : callback;
    let session;
    try {
      ({ session } = this.#hub.add(stub, client));
    } catch (e) {
      if (stub !== callback) stub?.[Symbol.dispose]?.();
      throw e;
    }
    return { ...(await this.#board.getBoard()), session };
  }

  /**
   * Heartbeat. `known: false` tells the client this instance has no subscription for it (or the
   * session does not match), so it re-subscribes.
   * @param {any} presence {clientId, session, name, color, openCardId, dragCardId, hoverColumnId}
   */
  async updatePresence(presence) {
    const { known } = this.#hub.updatePresence(presence);
    return { known, revision: await this.#board.getRevision() };
  }

  /** @param {string} clientId @param {string} session */
  leavePresence(clientId, session) {
    this.#hub.leave(clientId, session);
  }
}

// ---------------------------------------------------------------------------------------------
// Export formats: CSV from the server; HTML and PDF rendered by the client in export mode.
// ---------------------------------------------------------------------------------------------

export class ExportHandler extends WorkerEntrypoint {
  async getExportFormats(/** @type {any} */ _gadget) {
    return [
      { id: "csv", label: "CSV (all cards)", mode: "server", contentType: "text/csv", fileExtension: ".csv" },
      { id: "html", label: "HTML", mode: "browser", contentType: "text/html", fileExtension: ".html" },
      { id: "pdf", label: "PDF", mode: "browser", contentType: "application/pdf", fileExtension: ".pdf" },
    ];
  }

  /** @param {any} gadget @param {string} id */
  async export(gadget, id) {
    if (id !== "csv") throw new Error(`Unknown server export format: ${id}`);
    const board = await gadget.getBoard();
    return new Response(boardToCsv(board)).body;
  }
}
