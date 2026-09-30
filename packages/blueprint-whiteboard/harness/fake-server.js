// @ts-check
// The Gadget RPC surface over the REAL whiteboard rules (src/core/whiteboard.js) and subscriber
// hub (src/core/hub.js), running in the browser. Mirrors src/server/index.js method for method,
// minus the Durable Object and platform bindings.

import { createWhiteboard } from "../src/core/whiteboard.js";
import { Hub } from "../src/core/hub.js";

/**
 * A stand-in for the MermaiD2 connector: an SVG listing the source's lines in boxes, after a short
 * delay. Source containing "!error" fails, like invalid syntax would.
 * @param {{source: string, language: string}} request
 */
export async function fakeRender(request) {
  await new Promise((r) => setTimeout(r, 150));
  if (request.source.includes("!error")) throw new Error(`invalid_request: ${request.language} syntax error on line 1`);
  const lines = request.source.split("\n").filter((l) => l.trim()).slice(0, 12);
  const esc = (/** @type {string} */ s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const rows = lines.map((l, i) => `<rect x="10" y="${10 + i * 34}" width="300" height="26" rx="4" fill="#dbeafe" stroke="#1d4ed8"/><text x="20" y="${28 + i * 34}" font-family="sans-serif" font-size="13">${esc(l.slice(0, 40))}</text>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="${20 + lines.length * 34}" viewBox="0 0 320 ${20 + lines.length * 34}">${rows}</svg>`;
  return { data: new TextEncoder().encode(svg), contentType: "image/svg+xml" };
}

export class FakeGadget {
  /**
   * @param {import("../src/core/repository.js").Repository} repo
   * @param {{hub?: ConstructorParameters<typeof Hub>[0], renderDiagram?: ((request: any) => Promise<{data: unknown}>)|null}} [options]
   */
  constructor(repo, { hub, renderDiagram = fakeRender } = {}) {
    this.hub = new Hub(hub);
    this.board = createWhiteboard(repo, { onEvent: (event) => { this.hub.broadcast(event); }, renderDiagram });
  }

  getBoard() { return this.board.getBoard(); }
  getHistory(limit = 50) { return this.board.getHistory(limit); }
  /** @param {any} filter */
  findObjects(filter) { return this.board.findObjects(filter); }
  /** @param {any} frame */
  getFrame(frame) { return this.board.getFrame(frame); }
  /** @param {any} args */
  exportSvg(args) { return this.board.exportSvg(args); }
  /** @param {string} id */
  getDiagramRender(id) { return this.board.diagramRender(id); }

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
  "addFrame", "connectObjects", "addCode", "subscribe", "updatePresence", "leavePresence", "getDiagramRender",
]);
