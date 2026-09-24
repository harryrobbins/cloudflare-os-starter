// @ts-check
// Project report gadget server. Read-only: it holds no records and exposes no write path. The only
// local state is the latest Records poke (a datastore clock value) in src/server/pokes.js.

import { DurableObject, RpcTarget, WorkerEntrypoint, restore } from "cloudflare:workers";
import { PokeLog } from "./pokes.js";
import { createReadOnlyProxy } from "./proxy.js";

const HOOK_PARAMS = Object.freeze({ type: "records-poke" });
/** Hooks registered by earlier revisions of this report (`deliver: "changes"`). */
const LEGACY_HOOK_TYPE = "records-change";

/** Receives Records pokes (`RecordsPokeHook`), and legacy change notifications as nudges. */
class PokeReceiver extends RpcTarget {
  /** @param {PokeLog} pokes */
  constructor(pokes) { super(); this.pokes = pokes; }
  /** @param {unknown} poke */
  poked(poke) { this.pokes.poked(poke); }
  changed() { this.pokes.nudge(); }
  resync() { this.pokes.nudge(); }
}

export class Gadget extends DurableObject {
  /** @param {DurableObjectState} ctx @param {any} env */
  constructor(ctx, env) {
    super(ctx, env);
    this.pokes = new PokeLog(/** @type {any} */ (ctx.storage).kv);
    this.proxy = createReadOnlyProxy(() => this.env, this.pokes, () => /** @type {any} */ (this.ctx).restore(HOOK_PARAMS));
  }

  // @ts-ignore restore is a runtime-provided symbol
  [restore](/** @type {any} */ params) {
    if (params?.type === HOOK_PARAMS.type || params?.type === LEGACY_HOOK_TYPE) return new PokeReceiver(this.pokes);
    throw new Error("unknown restore params");
  }

  getSetup() { return this.proxy.getSetup(); }
  listProjects() { return this.proxy.listProjects(); }
  getWorkflow() { return this.proxy.getWorkflow(); }
  /** @param {any} input */
  listIssues(input) { return this.proxy.listIssues(input); }
  /** @param {any} request */
  syncPull(request) { return this.proxy.syncPull(request); }
  requestLiveUpdates() { return this.proxy.requestLiveUpdates(); }
  getPokes() { return this.proxy.getPokes(); }
  exportCsv() { return this.proxy.exportCsv(); }
}

export class ExportHandler extends WorkerEntrypoint {
  async getExportFormats() {
    return [{ id: "csv", label: "CSV (all issues)", mode: "server", contentType: "text/csv", fileExtension: ".csv" }];
  }
  /** @param {any} gadget @param {string} id */
  async export(gadget, id) {
    if (id !== "csv") throw new Error(`Unknown export format: ${id}`);
    const csv = await gadget.exportCsv();
    return new Response(csv).body;
  }
}
