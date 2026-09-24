// @ts-check
// Network Map gadget server: the `Gadget` Durable Object (RPC surface in README.md) and the
// `ExportHandler`. Map rules live in src/core/network-map.js, imports in src/core/changesets.js,
// subscriber fan-out and presence in src/core/hub.js and storage in src/server/do-repository.js;
// this file only wires them to the platform.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { createNetworkMap } from "../core/network-map.js";
import { createChangesets } from "../core/changesets.js";
import { Hub } from "../core/hub.js";
import { DoStorageRepository } from "./do-repository.js";
import { buildBackup, toConnectionsCsv, toElementsCsv, toGexf, toGraphml, toKumuJson } from "../shared/exports.js";

export class Gadget extends DurableObject {
  #hub = new Hub();
  /** @type {ReturnType<typeof createNetworkMap>} */
  #map;
  /** @type {ReturnType<typeof createChangesets>} */
  #changesets;

  /** @param {DurableObjectState} ctx @param {unknown} env */
  constructor(ctx, env) {
    super(ctx, /** @type {any} */ (env));
    // Events go to the hub inside the map's queue, right after each commit, so deliveries start in
    // revision order. Delivery is not awaited: a slow subscriber must not hold up the next write.
    this.#map = createNetworkMap(new DoStorageRepository(ctx.storage), {
      onEvent: (event) => { this.#hub.broadcast(event); },
    });
    this.#changesets = createChangesets(this.#map);
  }

  // --- Reads ---------------------------------------------------------------------------------

  /** Counts, types, fields, views and limits: start here. */
  describeMap() { return this.#map.describeMap(); }

  /** @param {any} [filter] {text?, type?, tag?, limit?} */
  findElements(filter) { return this.#map.findElements(filter); }

  /** @param {any} args {id? | label?, depth?, limit?} */
  getNeighbourhood(args) { return this.#map.getNeighbourhood(args); }

  /** @param {any} [args] {limit?} */
  getMapMarkdown(args) { return this.#map.getMapMarkdown(args); }

  /** @param {number} [limit] */
  getHistory(limit) { return this.#map.getHistory(limit); }

  /** A revision-consistent snapshot: meta, counts and the first page; then snapshotPage. */
  openSnapshot() { return this.#map.openSnapshot(); }

  /** @param {string} token @param {number} cursor */
  snapshotPage(token, cursor) { return this.#map.snapshotPage(token, cursor); }

  // --- Writes --------------------------------------------------------------------------------

  /** @param {any} request {senderId, by, requestId, ops, structure} */
  async applyOperation(request) {
    return (await this.#map.applyOperation(request)).result;
  }

  /** @param {any} args {senderId, by, requestId?, historyId?} */
  async undo(args) {
    return (await this.#map.undo(args)).result;
  }

  /** @param {any} args {groupId, senderId, by} */
  undoGroup(args) { return this.#changesets.undoGroup(args); }

  // --- Imports (changesets) ------------------------------------------------------------------

  /** @param {any} args {name, source?, format?, by} */
  createChangeset(args) { return this.#changesets.createChangeset(args); }
  /** @param {any} args {changesetId, items} */
  addChangesetItems(args) { return this.#changesets.addChangesetItems(args); }
  /** @param {any} args {changesetId} */
  finalizeChangeset(args) { return this.#changesets.finalizeChangeset(args); }
  /** @param {any} args {changesetId, cursor?, limit?, filter?} */
  getChangeset(args) { return this.#changesets.getChangeset(args); }
  /** @param {any} args {changesetId, decisions} */
  setDecisions(args) { return this.#changesets.setDecisions(args); }
  /** @param {any} args {changesetId, digest, by, senderId} */
  acceptChangeset(args) { return this.#changesets.acceptChangeset(args); }
  /** @param {any} args {changesetId, by, senderId} */
  resumeChangeset(args) { return this.#changesets.resumeChangeset(args); }
  /** @param {any} args {changesetId} */
  rejectChangeset(args) { return this.#changesets.rejectChangeset(args); }
  listChangesets() { return this.#changesets.listChangesets(); }

  // --- Live updates and presence -------------------------------------------------------------

  /**
   * Keeps `callback` (duplicated, so it outlives this call) and opens a snapshot. The subscriber
   * is registered before the snapshot is taken, so no event is missed; events at or below the
   * snapshot's revision may also arrive and must be ignored. Throws "clientId in use" or
   * "map is full"; the duplicated stub is disposed in that case.
   * @param {any} callback RpcTarget with operation(event) and presence(events)
   * @param {any} client {clientId, name, color, session?}
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
    return { ...(await this.#map.openSnapshot()), session };
  }

  /** @param {any} presence */
  async updatePresence(presence) {
    const { known } = this.#hub.updatePresence(presence);
    return { known, revision: this.#map.revisionNow() ?? await this.#map.getRevision() };
  }

  /** @param {string} clientId @param {string} session */
  leavePresence(clientId, session) {
    this.#hub.leave(clientId, session);
  }
}

/**
 * Reads the whole map through snapshot pages (a single message could exceed the transport's
 * limit on a large map).
 * @param {any} gadget
 */
async function readMap(gadget) {
  /** @type {any[]} */
  const disposables = [];
  try {
    const first = await gadget.openSnapshot();
    disposables.push(first);
    const objects = [...first.objects];
    const positions = [...first.positions];
    let next = first.next;
    while (next !== null && next !== undefined) {
      const page = await gadget.snapshotPage(first.token, next);
      disposables.push(page);
      if (page.expired) throw new Error("The map changed too often to export; try again");
      objects.push(...page.objects);
      positions.push(...page.positions);
      next = page.next;
    }
    return { meta: first.meta, objects, positions };
  } finally {
    for (const d of disposables) {
      try { d?.[Symbol.dispose]?.(); } catch { /* ignore */ }
    }
  }
}

export class ExportHandler extends WorkerEntrypoint {
  async getExportFormats(/** @type {any} */ _gadget) {
    return [
      { id: "backup", label: "Network map backup (JSON)", mode: "server", contentType: "application/json", fileExtension: ".json" },
      { id: "kumu", label: "Kumu JSON", mode: "server", contentType: "application/json", fileExtension: ".kumu.json" },
      { id: "elements-csv", label: "Elements (CSV)", mode: "server", contentType: "text/csv", fileExtension: ".csv" },
      { id: "connections-csv", label: "Connections (CSV)", mode: "server", contentType: "text/csv", fileExtension: ".csv" },
      { id: "graphml", label: "GraphML", mode: "server", contentType: "application/xml", fileExtension: ".graphml" },
      { id: "gexf", label: "GEXF", mode: "server", contentType: "application/xml", fileExtension: ".gexf" },
    ];
  }

  /** @param {any} gadget @param {string} id */
  async export(gadget, id) {
    const map = await readMap(gadget);
    /** @type {string} */
    let text;
    switch (id) {
      case "backup": text = JSON.stringify(buildBackup(map), null, 2); break;
      case "kumu": text = JSON.stringify(toKumuJson(map), null, 2); break;
      case "elements-csv": text = toElementsCsv(map); break;
      case "connections-csv": text = toConnectionsCsv(map); break;
      case "graphml": text = toGraphml(map); break;
      case "gexf": text = toGexf(map); break;
      default: throw new Error(`Unknown export format: ${id}`);
    }
    return new Response(text).body;
  }
}
