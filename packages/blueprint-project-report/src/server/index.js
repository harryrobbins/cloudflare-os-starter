// @ts-check
// Project report gadget server. Read-only: it holds no records and exposes no write path. The only
// local state is the change-notification log (identifiers and revisions) in src/server/feed.js.

import { DurableObject, RpcTarget, WorkerEntrypoint, restore } from "cloudflare:workers";
import { ChangeFeed } from "./feed.js";
import { createReadOnlyProxy } from "./proxy.js";

const HOOK_PARAMS = Object.freeze({ type: "records-change" });

class ChangeReceiver extends RpcTarget {
  /** @param {ChangeFeed} feed */
  constructor(feed) { super(); this.feed = feed; }
  /** @param {unknown} changes */
  changed(changes) { this.feed.record(changes); }
  resync() { this.feed.resync(); }
}

export class Gadget extends DurableObject {
  /** @param {DurableObjectState} ctx @param {any} env */
  constructor(ctx, env) {
    super(ctx, env);
    this.feed = new ChangeFeed(/** @type {any} */ (ctx.storage).kv);
    this.proxy = createReadOnlyProxy(() => this.env, this.feed, () => /** @type {any} */ (this.ctx).restore(HOOK_PARAMS));
  }

  // @ts-ignore restore is a runtime-provided symbol
  [restore](/** @type {any} */ params) {
    if (params?.type === HOOK_PARAMS.type) return new ChangeReceiver(this.feed);
    throw new Error("unknown restore params");
  }

  getSetup() { return this.proxy.getSetup(); }
  listProjects() { return this.proxy.listProjects(); }
  getWorkflow() { return this.proxy.getWorkflow(); }
  /** @param {any} input */
  listIssues(input) { return this.proxy.listIssues(input); }
  requestLiveUpdates() { return this.proxy.requestLiveUpdates(); }
  /** @param {any} since */
  getChanges(since) { return this.proxy.getChanges(since); }
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
