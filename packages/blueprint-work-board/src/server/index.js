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
  /** @param {string} key @param {any} [opts] */
  history(key, opts) { return this.api.history(key, opts); }
  /** @param {any} [opts] */
  summary(opts) { return this.api.summary(opts); }

  // Insights (datasets and reports)
  datasets() { return this.api.datasets(); }
  /** @param {string} name @param {any} [opts] */
  dataset(name, opts) { return this.api.dataset(name, opts); }
  /** @param {any} [opts] */
  insights(opts) { return this.api.insights(opts); }
  listReports() { return this.api.listReports(); }
  /** @param {any} doc @param {any} [opts] */
  saveReport(doc, opts) { return this.api.saveReport(doc, opts); }
  /** @param {string} id @param {any} [opts] */
  deleteReport(id, opts) { return this.api.deleteReport(id, opts); }
  /** @param {string} id */
  restoreReport(id) { return this.api.restoreReport(id); }
  /** @param {any} doc */
  validateReport(doc) { return this.api.validateReport(doc); }

  // Proposals (agents propose; people apply)
  /** @param {any[]} changes @param {any} [opts] */
  propose(changes, opts) { return this.api.propose(changes, opts); }
  /** @param {any} [opts] */
  listProposals(opts) { return this.api.listProposals(opts); }
  /** @param {string} id */
  getProposal(id) { return this.api.getProposal(id); }
  /** @param {string} id @param {any} [opts] */
  withdrawProposal(id, opts) { return this.api.withdrawProposal(id, opts); }
  /** @param {string} id */
  refreshProposal(id) { return this.api.refreshProposal(id); }
  /** @param {string} id @param {any[]} outcomes @param {any} [opts] */
  recordProposalOutcome(id, outcomes, opts) { return this.api.recordProposalOutcome(id, outcomes, opts); }

  // Jev triage (optional JEV binding)
  /** @param {string|string[]} keys */
  triage(keys) { return this.api.triage(keys); }

  // People (display names for Records actors)
  people() { return this.api.people(); }
  /** @param {any} viewer */
  rememberViewer(viewer) { return this.api.rememberViewer(viewer); }
  /** @param {string} actor @param {string|null} alias */
  setPersonAlias(actor, alias) { return this.api.setPersonAlias(actor, alias); }
}
