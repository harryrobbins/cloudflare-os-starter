// @ts-check
// Work board gadget server. Business data lives in Records: every item read and write goes to the
// Records service through the RECORDS binding, and commands pass through unchanged. The server
// keeps only small documents (saved views, per-viewer preferences, board settings) and a
// short-lived read cache so the agent's `query()` sees what the board shows. See README.md.

import { DurableObject } from "cloudflare:workers";
import { createGadgetApi } from "./api.js";

export class Gadget extends DurableObject {
  /** @param {DurableObjectState} ctx @param {any} env */
  constructor(ctx, env) {
    super(ctx, env);
    this.api = createGadgetApi({ getEnv: () => this.env, storage: /** @type {any} */ (ctx.storage) });
  }

  // Records (pass-through)
  getSetup() { return this.api.getSetup(); }
  connection() { return this.api.connection(); }
  describe() { return this.api.describe(); }
  model() { return this.api.model(); }
  /** @param {number} [limit] */
  snapshot(limit) { return this.api.snapshot(limit); }
  /** @param {number} [after] @param {number} [epoch] */
  changes(after, epoch) { return this.api.changes(after, epoch); }
  /** @param {any} [query] */
  records(query) { return this.api.records(query); }
  /** @param {string} command @param {any} input @param {any} options */
  command(command, input, options) { return this.api.command(command, input, options); }
  /** @param {number} actionId */
  getOutcome(actionId) { return this.api.getOutcome(actionId); }

  // Documents
  listViews() { return this.api.listViews(); }
  /** @param {any} view @param {any} [opts] */
  saveView(view, opts) { return this.api.saveView(view, opts); }
  /** @param {string} id */
  deleteView(id) { return this.api.deleteView(id); }
  /** @param {string} viewerId */
  getPrefs(viewerId) { return this.api.getPrefs(viewerId); }
  /** @param {string} viewerId @param {any} prefs */
  savePrefs(viewerId, prefs) { return this.api.savePrefs(viewerId, prefs); }
  getSettings() { return this.api.getSettings(); }
  /** @param {any} settings @param {any} [opts] */
  saveSettings(settings, opts) { return this.api.saveSettings(settings, opts); }

  // Agent reads
  /** @param {string} wql @param {any} [opts] */
  query(wql, opts) { return this.api.query(wql, opts); }
  /** @param {string} wql */
  describeQuery(wql) { return this.api.describeQuery(wql); }
  /** @param {string} key */
  item(key) { return this.api.item(key); }
  vocabulary() { return this.api.vocabulary(); }
}
