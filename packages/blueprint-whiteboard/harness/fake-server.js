// @ts-check
// The Gadget RPC surface over the REAL whiteboard rules (src/core/whiteboard.js) and subscriber
// hub (src/core/hub.js), running in the browser. Mirrors src/server/index.js method for method,
// minus the Durable Object and platform bindings.

import { createWhiteboard } from "../src/core/whiteboard.js";
import { Hub } from "../src/core/hub.js";

export class FakeGadget {
  /**
   * @param {import("../src/core/repository.js").Repository} repo
   * @param {{hub?: ConstructorParameters<typeof Hub>[0]}} [options]
   */
  constructor(repo, { hub } = {}) {
    this.hub = new Hub(hub);
    this.board = createWhiteboard(repo, { onEvent: (event) => { this.hub.broadcast(event); } });
  }

  getBoard() { return this.board.getBoard(); }
  getHistory(limit = 50) { return this.board.getHistory(limit); }
  /** @param {any} filter */
  findObjects(filter) { return this.board.findObjects(filter); }
  /** @param {any} frame */
  getFrame(frame) { return this.board.getFrame(frame); }
  /** @param {any} args */
  exportSvg(args) { return this.board.exportSvg(args); }

  /** @param {any} request */
  async applyOperation(request) { return (await this.board.applyOperation(request)).result; }
  /** @param {any} args */
  async undo(args) { return (await this.board.undo(args)).result; }

  /** @param {any} args */
  async addObjects(args) { const { created, errors } = await this.board.addObjects(args); return { created, errors }; }
  /** @param {any} args */
  async addStickies(args) { const { created, errors } = await this.board.addStickies(args); return { created, errors }; }
  /** @param {any} args */
  async updateObjects(args) { return (await this.board.updateObjects(args)).result; }
  /** @param {any} args */
  async moveObjects(args) { return (await this.board.moveObjects(args)).result; }
  /** @param {any} args */
  async arrangeGrid(args) { return (await this.board.arrangeGrid(args)).result; }
  /** @param {any} args */
  async deleteObjects(args) { return (await this.board.deleteObjects(args)).result; }
  /** @param {any} args */
  async addFrame(args) { const { frame, result } = await this.board.addFrame(args); return { frame, result }; }
  /** @param {any} args */
  async connectObjects(args) { const { connector, errors } = await this.board.connect(args); return { connector, errors }; }
  /** @param {any} args */
  async addCode(args) { const { block, errors } = await this.board.addCode(args); return { block, errors }; }

  /** @param {any} callback @param {any} client */
  async subscribe(callback, client) {
    const stub = typeof callback?.dup === "function" ? callback.dup() : callback;
    let session;
    try {
      ({ session } = this.hub.add(stub, client));
    } catch (e) {
      if (stub !== callback) {
        try { stub?.[Symbol.dispose]?.(); } catch { /* ignore */ }
      }
      throw e;
    }
    return { ...(await this.board.getBoard()), session };
  }

  /** @param {any} presence */
  async updatePresence(presence) {
    const { known } = this.hub.updatePresence(presence);
    return { known, revision: this.board.revisionNow() ?? await this.board.getRevision() };
  }

  /** @param {string} clientId @param {string} session */
  leavePresence(clientId, session) { this.hub.leave(clientId, session); }
}

/** Method names a pane's `gadget` proxy may call. */
export const RPC_METHODS = new Set([
  "getBoard", "getHistory", "findObjects", "getFrame", "exportSvg", "applyOperation", "undo",
  "addObjects", "addStickies", "updateObjects", "moveObjects", "arrangeGrid", "deleteObjects",
  "addFrame", "connectObjects", "addCode", "subscribe", "updatePresence", "leavePresence",
]);
