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
  /** Bounded, side-effect-free contract for describeBinding. */
  describeGadget() {
    return {
      "gadget": "board",
      "contract": 1,
      "summary": "Use the listed domain methods first. Connector calls require the named binding. Omitted author on supported writes is Assistant. Read README.md for the remaining low-level API.",
      "operations": [
        {
          "name": "getBoard",
          "description": "Read the current board and revisions.",
          "input": {},
          "example": "await env.Blueprint.getBoard();",
          "returns": "{title, revision, columns, columnOrder, cards, labels}"
        },
        {
          "name": "findCards",
          "description": "Find cards by title, label, or column.",
          "input": {
            "type": "object",
            "properties": {
              "text": {
                "type": "string"
              }
            },
            "required": []
          },
          "example": "await env.Blueprint.findCards({ text: \"review\" });",
          "returns": "Card[]"
        },
        {
          "name": "addCards",
          "description": "Add cards; reads current revisions, applies valid cards and reports errors for invalid items.",
          "input": {
            "type": "object",
            "properties": {
              "cards": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "title": {
                      "type": "string"
                    },
                    "column": {
                      "type": "string"
                    }
                  },
                  "required": [
                    "title", "column"
                  ]
                }
              }
            },
            "required": [
              "cards"
            ]
          },
          "example": "await env.Blueprint.addCards({ cards: [{ title: \"Review proposals\", column: \"Backlog\" }] });",
          "returns": "{created, errors}"
        },
        {
          "name": "addColumn",
          "description": "Add a column; reads current revisions and returns validation errors.",
          "input": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string"
              }
            },
            "required": [
              "name"
            ]
          },
          "example": "await env.Blueprint.addColumn({ name: \"Blocked\" });",
          "returns": "{column, errors}"
        }
      ],
      "adapt": {
        "client": "client.js: adapt block (title, actionLabel, styles, actions, onReady)",
        "server": "server.js: class Gadget",
        "readme": "README.md#adapting-this-gadget"
      }
    };
  }

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
    const { created, errors } = await this.#board.addCards({ ...args, by: args?.by ?? "Assistant" });
    return { created, errors };
  }

  /** @param {any} args {cardId, fields, by?} */
  async updateCard(args) {
    return (await this.#board.updateCard({ ...args, by: args?.by ?? "Assistant" })).result;
  }

  /** @param {any} args {cardId, toColumn, position?, by?} */
  async moveCard(args) {
    return (await this.#board.moveCard({ ...args, by: args?.by ?? "Assistant" })).result;
  }

  /** @param {any} args {cardId, by?} */
  async deleteCard(args) {
    return (await this.#board.deleteCard({ ...args, by: args?.by ?? "Assistant" })).result;
  }

  /** @param {any} args {name, index?, by?} */
  async addColumn(args) {
    const { column, errors } = await this.#board.addColumn({ ...args, by: args?.by ?? "Assistant" });
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
