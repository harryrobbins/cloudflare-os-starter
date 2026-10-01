// @ts-check
// Work board gadget server. Business data lives in Records: every item read and write goes to the
// Records service through the RECORDS binding, and commands pass through unchanged. The server
// keeps only small documents (saved views, per-viewer preferences, board settings) and a
// short-lived read cache so the agent's `query()` sees what the board shows. See README.md.

import { DurableObject } from "cloudflare:workers";
import { createGadgetApi } from "./api.js";

export class Gadget extends DurableObject {
  /** Bounded, side-effect-free contract for describeBinding. */
  describeGadget() {
    return {
      "gadget": "work-board",
      "contract": 1,
      "summary": "A Records work board with WQL, local saved views, reports and proposals. Commands retain the Records approval flow; a proposal is not approval. Read SKILL.md for the full reporting API.",
      "operations": [
        {
          "name": "getSetup",
          "description": "Describe the Records work binding and optional Jev connection.",
          "input": {},
          "example": "await env.Blueprint.getSetup();",
          "returns": "Setup"
        },
        {
          "name": "query",
          "description": "Read items with WQL, using the same read cache as the board. Positional string argument; see SKILL.md for vocabulary.",
          "input": {
            "type": "string"
          },
          "example": "await env.Blueprint.query(\"\");",
          "returns": "Query result"
        },
        {
          "name": "vocabulary",
          "description": "Read WQL fields, statuses and labels.",
          "input": {},
          "example": "await env.Blueprint.vocabulary();",
          "returns": "Vocabulary"
        },
        {
          "name": "listViews",
          "description": "Read shared saved views.",
          "input": {},
          "example": "await env.Blueprint.listViews();",
          "returns": "View[]"
        },
        {
          "name": "saveView",
          "description": "Save a validated gadget-local view. Reads current document version; use opts.expectedVersion for conflict checks. Omitted actor uses Assistant.",
          "input": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string"
              },
              "name": {
                "type": "string"
              },
              "query": {
                "type": "string"
              },
              "layout": {
                "enum": [
                  "board",
                  "list",
                  "insights"
                ]
              }
            },
            "required": [
              "id",
              "name"
            ]
          },
          "example": "await env.Blueprint.saveView({ id: \"focus\", name: \"Focus\", query: \"\", layout: \"list\" });",
          "returns": "Saved view"
        },
        {
          "name": "datasets",
          "description": "List available report datasets.",
          "input": {},
          "example": "await env.Blueprint.datasets();",
          "returns": "Dataset[]"
        },
        {
          "name": "listProposals",
          "description": "Read saved proposals. This does not approve or apply them.",
          "input": {},
          "example": "await env.Blueprint.listProposals();",
          "returns": "Proposal[]"
        }
      ],
      "adapt": {
        "client": "client.js: adapt block (title, actionLabel, styles, actions, onReady)",
        "server": "server.js: class Gadget",
        "readme": "README.md#adapting-this-gadget"
      }
    };
  }

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
  saveView(view, opts) { return this.api.saveView(view, { ...opts, actor: opts?.actor ?? "Assistant" }); }
  /** @param {string} id */
  deleteView(id) { return this.api.deleteView(id); }
  /** @param {string} viewerId */
  getPrefs(viewerId) { return this.api.getPrefs(viewerId); }
  /** @param {string} viewerId @param {any} prefs */
  savePrefs(viewerId, prefs) { return this.api.savePrefs(viewerId, prefs); }
  getSettings() { return this.api.getSettings(); }
  /** @param {any} settings @param {any} [opts] */
  saveSettings(settings, opts) { return this.api.saveSettings(settings, { ...opts, actor: opts?.actor ?? "Assistant" }); }

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
  saveReport(doc, opts) { return this.api.saveReport(doc, { ...opts, actor: opts?.actor ?? "Assistant" }); }
  /** @param {string} id @param {any} [opts] */
  deleteReport(id, opts) { return this.api.deleteReport(id, opts); }
  /** @param {string} id */
  restoreReport(id) { return this.api.restoreReport(id); }
  /** @param {any} doc */
  validateReport(doc) { return this.api.validateReport(doc); }

  // Proposals (agents propose; people apply)
  /** @param {any[]} changes @param {any} [opts] */
  propose(changes, opts) { return this.api.propose(changes, { ...opts, ...(!opts?.by && !opts?.viewer?.id ? { by: { kind: "agent", name: "Assistant" } } : {}) }); }
  /** @param {any} [opts] */
  listProposals(opts) { return this.api.listProposals(opts); }
  /** @param {string} id */
  getProposal(id) { return this.api.getProposal(id); }
  /** @param {string} id @param {any} [opts] */
  withdrawProposal(id, opts) { return this.api.withdrawProposal(id, { ...opts, actor: opts?.actor ?? "Assistant" }); }
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
