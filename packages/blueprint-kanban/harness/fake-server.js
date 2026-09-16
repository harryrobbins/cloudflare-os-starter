// @ts-check
// The Gadget RPC surface over the REAL board rules (src/core/board.js) and subscriber hub
// (src/core/hub.js), running in the browser. Mirrors src/server/index.js method for method,
// minus the Durable Object and platform bindings.

import { createBoard } from "../src/core/board.js";
import { Hub } from "../src/core/hub.js";

export class FakeGadget {
  /** @param {import("../src/core/repository.js").Repository} repo */
  constructor(repo) {
    this.hub = new Hub();
    this.board = createBoard(repo, { onEvent: (event) => { this.hub.broadcast(event); } });
  }

  getBoard() { return this.board.getBoard(); }
  /** @param {string} cardId */
  getComments(cardId) { return this.board.getComments(cardId); }
  getHistory(limit = 50) { return this.board.getHistory(limit); }
  /** @param {any} filter */
  findCards(filter) { return this.board.findCards(filter); }

  /** @param {any} request */
  async applyOperation(request) { return (await this.board.applyOperation(request)).result; }
  /** @param {any} args */
  async undo(args) { return (await this.board.undo(args)).result; }
  /** @param {any} args */
  async addComment(args) { return (await this.board.addComment(args)).comment; }

  /** @param {any} args */
  async addCards(args) { const { created, errors } = await this.board.addCards(args); return { created, errors }; }
  /** @param {any} args */
  async updateCard(args) { return (await this.board.updateCard(args)).result; }
  /** @param {any} args */
  async moveCard(args) { return (await this.board.moveCard(args)).result; }
  /** @param {any} args */
  async deleteCard(args) { return (await this.board.deleteCard(args)).result; }
  /** @param {any} args */
  async addColumn(args) { const { column, errors } = await this.board.addColumn(args); return { column, errors }; }

  /** @param {any} callback @param {any} client */
  async subscribe(callback, client) {
    const stub = typeof callback?.dup === "function" ? callback.dup() : callback;
    this.hub.add(stub, client);
    return this.board.getBoard();
  }

  /** @param {any} presence */
  async updatePresence(presence) {
    const { known } = this.hub.updatePresence(presence);
    return { known, revision: await this.board.getRevision() };
  }

  /** @param {string} clientId */
  leavePresence(clientId) { this.hub.leave(clientId); }
}

/** Method names a pane's `gadget` proxy may call. */
export const RPC_METHODS = new Set([
  "getBoard", "getComments", "getHistory", "findCards", "applyOperation", "undo", "addComment",
  "addCards", "updateCard", "moveCard", "deleteCard", "addColumn", "subscribe", "updatePresence",
  "leavePresence",
]);
