// @ts-check
// Whiteboard gadget server: the `Gadget` Durable Object and the `ExportHandler`. Its RPC surface
// is described for agents by describeGadget() (DESCRIPTION at the end of this file) and in
// README.md. Whiteboard rules live in src/core/whiteboard.js, subscriber fan-out and presence in
// src/core/hub.js and storage in src/server/do-repository.js; this file only wires them to the
// platform. To add a server feature, add a method to class Gadget and list it in DESCRIPTION.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { createWhiteboard } from "../core/whiteboard.js";
import { Hub } from "../core/hub.js";
import { DoStorageRepository } from "./do-repository.js";
import { exportData, importData } from "../core/backup.js";

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

  /**
   * What this gadget holds and the operations to call from executeCode, for agents
   * (describeBinding shows it). Synchronous and side-effect free.
   */
  describeGadget() {
    return DESCRIPTION;
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

  // --- Portable data (backup format, src/shared/backup.js) ---------------------------------

  /** The board as a data-only backup document: title, background and objects. */
  exportData() {
    return exportData(this.#board);
  }

  /** @param {any} args {data, at?, structure?, by?} */
  importData(args) {
    return importData(this.#board, args);
  }

  /** @param {any} args {icons, frame?, at?, columns?, gap?, by?} */
  async addIcons(args) {
    const { created, errors } = await this.#board.addIcons(args);
    return { created, errors };
  }

  /** @param {any} args {code, language?, at?, frame?, title?, filename?, theme?, lineNumbers?, wrap?, fontSize?, w?, by?} */
  async addCode(args) {
    const { block, errors } = await this.#board.addCode(args);
    return { block, errors };
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
   * @returns {Promise<any>} SubscribeResult (src/shared/protocol.js)
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
      { id: "backup", label: "Whiteboard backup (JSON)", mode: "server", contentType: "application/json", fileExtension: ".json" },
    ];
  }

  /** @param {any} gadget @param {string} id */
  async export(gadget, id) {
    if (id === "backup") {
      /** @type {any} */
      let data;
      try {
        data = await gadget.exportData();
        return new Response(JSON.stringify(data, null, 2)).body;
      } finally {
        try { data?.[Symbol.dispose]?.(); } catch { /* ignore */ }
      }
    }
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

// ---------------------------------------------------------------------------------------------
// describeGadget(): the operations an agent should call from executeCode, convenience first.
// Keep every example runnable: test/core/describe-gadget.test.js runs each one against the real
// Gadget and checks its argument against `input`. Add an entry when you add a method above.
// ---------------------------------------------------------------------------------------------

// Shared schema pieces; the summary explains colours, `at`, frames and `by` once.
const COLOR = { type: "string" };
const AT = { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] };
const FRAME = { type: "string" };
const BY = { type: "string" };
const IDS = { type: "array", items: { type: "string" } };
const OBJECT_TYPES = ["sticky", "rect", "ellipse", "text", "frame", "pen", "connector", "icon", "code"];

const DESCRIPTION = Object.freeze({
  gadget: "whiteboard",
  contract: 1,
  summary: "A live, shared whiteboard of sticky notes, shapes, text, frames, connectors, icons, code blocks and pen strokes, " +
    "kept in this gadget's storage. Read and change it by calling these methods on its binding from executeCode " +
    "(env.Whiteboard below; use your binding's name). Coordinates are world units, x right and y down; a sticky note is 200 by 200. " +
    "Writes read current versions themselves, so they never conflict; each applies the valid items and reports the rest " +
    "in `errors` ({index, code, message}), so check `errors` after a write. Every write takes an optional `by`, the name shown in Activity " +
    "(e.g. \"Assistant\"). A `color` is yellow, orange, red, pink, purple, blue, teal, green, gray, white, black or \"#rrggbb\"; " +
    "a `frame` is a frame's id or name; `at` is a top-left {x, y}. Also available, see README.md: getHistory(limit), " +
    "exportSvg({frame?}), exportData() and importData({data, at?}) for backups.",
  operations: [
    {
      name: "getBoard",
      description: "The whole board: title, background and every object keyed by id. Read it to find where content is before placing more.",
      input: { type: "null", description: "no argument" },
      example: "await env.Whiteboard.getBoard()",
      returns: "{schemaVersion, revision, title, background, objects: {[id]: WhiteboardObject}, lastModified}; " +
        "WhiteboardObject is {id, type, x, y, w, h, rot, z, frameId, text, style: {fill, stroke, strokeWidth, textColor, fontSize, align, arrowStart, arrowEnd}, version, …}",
    },
    {
      name: "findObjects",
      description: "Objects matching every filter given, bottom to top. `text` is a case-insensitive substring; `type` is a type or a list of types; `within` {x, y, w, h} keeps objects whose bounds intersect it.",
      input: {
        type: "object", properties: {
          type: { type: ["string", "array"] }, text: { type: "string" }, frame: FRAME, within: { type: "object" },
        },
      },
      example: "await env.Whiteboard.findObjects({ type: \"sticky\", text: \"launch\", frame: \"Planning\" })",
      returns: "WhiteboardObject[]",
    },
    {
      name: "getFrame",
      description: "A frame (by id or name) and the objects that belong to it.",
      input: FRAME,
      example: "await env.Whiteboard.getFrame(\"Planning\")",
      returns: "{frame: WhiteboardObject, objects: WhiteboardObject[]} or null when there is no such frame",
    },
    {
      name: "addStickies",
      description: "Adds sticky notes laid out in a grid, in list order row by row: at `at`, else inside `frame`, else right of existing content. " +
        "`columns` defaults to ceil(sqrt(n)): pass columns: n for one row, 1 for one column. Each note is a string or {text, color?, w?, h?}.",
      input: {
        type: "object", required: ["stickies"], properties: {
          stickies: {
            type: "array", maxItems: 1000, items: {
              anyOf: [{ type: "string" }, {
                type: "object", required: ["text"],
                properties: { text: { type: "string" }, color: COLOR },
              }],
            },
          },
          frame: FRAME, at: AT, columns: { type: "integer", minimum: 1 }, gap: { type: "number", minimum: 0, description: "default 40" }, by: BY,
        },
      },
      example: "await env.Whiteboard.addStickies({ stickies: [\"Hire two engineers\", { text: \"Ship the app\", color: \"green\" }], frame: \"Planning\", columns: 2, by: \"Assistant\" })",
      returns: "{created: WhiteboardObject[], errors}",
    },
    {
      name: "addObjects",
      description: "Creates objects of any type (" + OBJECT_TYPES.join(", ") + ") with their fields: x, y, w, h, rot, text, style, frameId; " +
        "pen needs points, connector from and to (and routing), icon packId and iconId. Omitted fields take defaults; `color` sets the fill (the line for pen, connector and glyph icons); `frame` puts it in an existing frame. Give your own ids (\"o_\" + 12 hex) to connect them, or put them in a frame (frameId), in the same call.",
      input: {
        type: "object", required: ["objects"], properties: {
          objects: {
            type: "array", maxItems: 1000, items: {
              type: "object", required: ["type"], properties: {
                type: { enum: OBJECT_TYPES }, id: { type: "string", pattern: "^o_[0-9a-f]{12}$" }, color: COLOR, frame: FRAME,
              },
            },
          },
          by: BY,
        },
      },
      example: "await env.Whiteboard.addObjects({ objects: [{ type: \"rect\", x: 0, y: 400, w: 300, h: 120, text: \"Decision\", color: \"blue\" }, { type: \"text\", x: 0, y: 320, text: \"Q4 priorities\", style: { fontSize: 48 } }], by: \"Assistant\" })",
      returns: "{created: WhiteboardObject[], errors}",
    },
    {
      name: "connectObjects",
      description: "Draws a connector (arrow) from one object to another; it follows them when they move. Not named connect: a stub's connect() is reserved.",
      input: {
        type: "object", required: ["from", "to"], properties: {
          from: { type: "string" }, to: { type: "string" }, label: { type: "string" },
          routing: { enum: ["straight", "elbow", "curved"] }, arrow: { enum: ["end", "both", "none"] },
          fromSide: { enum: ["auto", "top", "right", "bottom", "left"] }, toSide: { enum: ["auto", "top", "right", "bottom", "left"] },
          color: COLOR, by: BY,
        },
      },
      example: "await env.Whiteboard.connectObjects({ from: \"o_1a2b3c4d5e6f\", to: \"o_6f5e4d3c2b1a\", label: \"then\", routing: \"elbow\", by: \"Assistant\" })",
      returns: "{connector: WhiteboardObject|null, errors}",
    },
    {
      name: "addFrame",
      description: "Adds a named frame. With `contains` and no geometry it is sized around those objects and they become its members; otherwise at x, y (default right of content), 800 by 600 unless w, h are given.",
      input: {
        type: "object", required: ["name"], properties: {
          name: { type: "string" }, contains: IDS, x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" }, by: BY,
        },
      },
      example: "await env.Whiteboard.addFrame({ name: \"Themes\", contains: [\"o_1a2b3c4d5e6f\", \"o_6f5e4d3c2b1a\"], by: \"Assistant\" })",
      returns: "{frame: WhiteboardObject|null, result: OperationResult}",
    },
    {
      name: "updateObjects",
      description: "Changes fields of existing objects: text, x, y, w, h, rot, style (merged key by key), color, frame (null leaves the frame), and type-specific fields such as routing.",
      input: {
        type: "object", required: ["updates"], properties: {
          updates: {
            type: "array", maxItems: 1000, items: {
              type: "object", required: ["id", "fields"], properties: { id: { type: "string" }, fields: { type: "object" } },
            },
          },
          by: BY,
        },
      },
      example: "await env.Whiteboard.updateObjects({ updates: [{ id: \"o_1a2b3c4d5e6f\", fields: { text: \"Renamed\", color: \"pink\" } }], by: \"Assistant\" })",
      returns: "OperationResult {status, revision, upserts, deletes, errors, conflicts}",
    },
    {
      name: "moveObjects",
      description: "Moves objects by dx, dy (connectors follow their ends). A frame's members do not move with it: list them too.",
      input: { type: "object", required: ["ids"], properties: { ids: IDS, dx: { type: "number" }, dy: { type: "number" }, by: BY } },
      example: "await env.Whiteboard.moveObjects({ ids: [\"o_1a2b3c4d5e6f\"], dx: 300, dy: 0, by: \"Assistant\" })",
      returns: "OperationResult",
    },
    {
      name: "arrangeGrid",
      description: "Lays existing objects out in a grid in the order given, row by row, from `at` or their current top-left. columns: ids.length gives one row.",
      input: {
        type: "object", required: ["ids"], properties: {
          ids: IDS, columns: { type: "integer", minimum: 1 }, gap: { type: "number", minimum: 0 }, at: AT, by: BY,
        },
      },
      example: "await env.Whiteboard.arrangeGrid({ ids: [\"o_1a2b3c4d5e6f\", \"o_6f5e4d3c2b1a\"], columns: 2, gap: 40, by: \"Assistant\" })",
      returns: "OperationResult",
    },
    {
      name: "deleteObjects",
      description: "Deletes objects; connectors attached to them go too. Deleting a frame keeps its members.",
      input: { type: "object", required: ["ids"], properties: { ids: IDS, by: BY } },
      example: "await env.Whiteboard.deleteObjects({ ids: [\"o_1a2b3c4d5e6f\"], by: \"Assistant\" })",
      returns: "OperationResult",
    },
    {
      name: "findIcons",
      description: "Searches the icon packs (diagram shapes core.1: decision, database, cloud…; icons tabler.1). Use before addIcons.",
      input: {
        anyOf: [{ type: "string" }, {
          type: "object", properties: { query: { type: "string" }, packId: { enum: ["core.1", "tabler.1"] }, limit: { type: "integer", minimum: 1, maximum: 100 } },
        }],
      },
      example: "await env.Whiteboard.findIcons({ query: \"database\", limit: 5 })",
      returns: "[{packId, iconId, label, category, categoryLabel, tags, kind, aspect, text}], best first",
    },
    {
      name: "addIcons",
      description: "Adds icons or diagram shapes by id: \"packId/iconId\", a bare iconId, or {icon, size?, color?, text?, x?, y?}. Items without x and y go in a grid like addStickies.",
      input: {
        type: "object", required: ["icons"], properties: {
          icons: {
            type: "array", items: {
              anyOf: [{ type: "string" }, { type: "object", properties: { icon: { type: "string" }, size: { type: "number" }, color: COLOR } }],
            },
          },
          frame: FRAME, at: AT, columns: { type: "integer", minimum: 1 }, gap: { type: "number", minimum: 0 }, by: BY,
        },
      },
      example: "await env.Whiteboard.addIcons({ icons: [\"core.1/database\", { icon: \"tabler.1/server\", size: 64, color: \"blue\" }], at: { x: 0, y: 800 }, by: \"Assistant\" })",
      returns: "{created: WhiteboardObject[], errors}",
    },
    {
      name: "addCode",
      description: "Adds one syntax-highlighted code block, its height fitted to the code; language (python, js, sql…) is guessed when omitted. Also lineNumbers, wrap, fontSize, w.",
      input: {
        type: "object", required: ["code"], properties: {
          code: { type: "string" }, language: { type: "string" }, title: { type: "string" }, at: AT, frame: FRAME, theme: { enum: ["light", "dark"] }, by: BY,
        },
      },
      example: "await env.Whiteboard.addCode({ code: \"def main():\\n    print('hi')\\n\", language: \"python\", title: \"main.py\", by: \"Assistant\" })",
      returns: "{block: WhiteboardObject|null, errors}",
    },
    {
      name: "undo",
      description: "Undoes the latest change still in effect made under `by` (call again to go further back), or the history entry `historyId`.",
      input: { type: "object", properties: { by: BY, historyId: { type: "string" } } },
      example: "await env.Whiteboard.undo({ by: \"Assistant\" })",
      returns: "OperationResult",
    },
    {
      name: "applyOperation",
      description: "Low-level: raw ops [{op: \"create\", object} | {op: \"update\", id, baseVersion, patch} | {op: \"delete\", id, baseVersion}] and/or structure {title?, background?: \"dots\"|\"grid\"|\"plain\"}. " +
        "Use it to rename the board or change its background; prefer the methods above for objects (they need no baseVersion).",
      input: {
        type: "object", properties: {
          objectOps: { type: "array" },
          structure: { type: "object", properties: { title: { type: "string" }, background: { enum: ["dots", "grid", "plain"] } } },
          by: BY,
        },
      },
      example: "await env.Whiteboard.applyOperation({ structure: { title: \"Q4 planning\", background: \"grid\" }, by: \"Assistant\" })",
      returns: "OperationResult {status, revision, upserts, deletes, structure, errors, conflicts}",
    },
  ],
  adapt: {
    client: "client.js: the `adapt` block at its top (newObjectColors, minimap, styles, actions shown in the board menu, onReady) and the `app` handle",
    server: "server.js: add methods to class Gadget (and an entry to DESCRIPTION)",
    readme: "README.md#adapting-this-gadget",
  },
});
