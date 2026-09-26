// @ts-check
// The gadget server's whole RPC surface, free of `cloudflare:workers` so it runs under Node tests
// and in the harness page. `src/server/index.js` exposes each method on the Durable Object.
//
//   Records pass-through (unchanged): getSetup, connection, describe, model, snapshot, changes,
//     records, command, getOutcome
//   Documents: listViews, saveView, deleteView, getPrefs, savePrefs, getSettings, saveSettings
//   Agent reads: query, describeQuery, item, history, summary, vocabulary
//   Insights: datasets, dataset, insights, listReports, saveReport, deleteReport, restoreReport, validateReport
//   Proposals: propose, listProposals, getProposal, withdrawProposal, refreshProposal, recordProposalOutcome
//   Jev (optional JEV binding): triage

import { createRecordsProxy } from "./proxy.js";
import { createDocuments, createPeople, registerLayout } from "./documents.js";
import { createQueryCache } from "./query.js";
import { createInsights } from "./insights.js";
import { createProposals } from "./proposals.js";
import { createTriage } from "./triage.js";

registerLayout("insights");

/** Every method the client or the agent may call. */
export const RPC_METHODS = Object.freeze([
  "getSetup", "connection", "describe", "model", "snapshot", "changes", "records", "command", "getOutcome",
  "listViews", "saveView", "deleteView", "getPrefs", "savePrefs", "getSettings", "saveSettings",
  "query", "describeQuery", "item", "history", "summary", "vocabulary", "people", "rememberViewer", "setPersonAlias",
  "datasets", "dataset", "insights", "listReports", "saveReport", "deleteReport", "restoreReport", "validateReport",
  "propose", "listProposals", "getProposal", "withdrawProposal", "refreshProposal", "recordProposalOutcome",
  "triage",
]);

/**
 * @param {{ getEnv: () => any, storage: Parameters<typeof createDocuments>[0], now?: () => number, ttlMs?: number, random?: () => number }} options
 */
export function createGadgetApi({ getEnv, storage, now, ttlMs, random }) {
  const proxy = createRecordsProxy(getEnv);
  const docs = createDocuments(storage, { now });
  const people = createPeople(storage, { now });
  /** @type {string|null} */
  let label = null;
  const queries = createQueryCache(() => /** @type {any} */ ({ snapshot: proxy.snapshot, changes: proxy.changes }), {
    now, ttlMs,
    settings: () => docs.getSettings(),
    names: async () => new Map((await people.people()).filter((p) => p.displayName).map((p) => [p.actor, /** @type {string} */ (p.displayName)])),
    label: async () => {
      if (label === null) { try { label = (await proxy.connection())?.label ?? ""; } catch { label = ""; } }
      return label;
    },
  });
  const insights = createInsights({ queries, storage, now });
  const proposals = createProposals({ queries, storage, now, random });
  const triage = createTriage({ getEnv, queries, now });

  return {
    ...proxy,
    /** Setup summary for the UI, plus whether the optional Jev binding is connected. */
    getSetup: async () => ({ ...(await proxy.getSetup()), jev: triage.available() }),
    listViews: () => docs.listViews(),
    /** @param {any} view @param {{ actor?: string|null, expectedVersion?: number }} [opts] */
    saveView: (view, opts) => docs.saveView(view, opts),
    /** @param {unknown} id */
    deleteView: (id) => docs.deleteView(id),
    /** @param {unknown} viewerId */
    getPrefs: (viewerId) => docs.getPrefs(viewerId),
    /** @param {unknown} viewerId @param {any} prefs */
    savePrefs: (viewerId, prefs) => docs.savePrefs(viewerId, prefs),
    getSettings: () => docs.getSettings(),
    /** @param {any} settings @param {{ actor?: string|null }} [opts] */
    saveSettings: (settings, opts) => docs.saveSettings(settings, opts),
    /** @param {unknown} wql @param {{ limit?: number, fields?: string[], viewer?: string|null }} [opts] */
    query: (wql, opts) => queries.query(wql, opts),
    /** @param {unknown} wql */
    describeQuery: (wql) => queries.describeQuery(wql),
    /** @param {unknown} key */
    item: (key) => queries.item(key),
    /** @param {unknown} key @param {{ limit?: number }} [opts] */
    history: (key, opts) => insights.history(key, opts),
    /** @param {{ query?: string, by?: string|string[], viewer?: string|null }} [opts] */
    summary: (opts) => insights.summary(opts),
    vocabulary: () => queries.vocabulary(),
    people: () => people.people(),
    /** @param {unknown} viewer */
    rememberViewer: (viewer) => people.rememberViewer(viewer),
    /** @param {unknown} actor @param {unknown} alias */
    setPersonAlias: (actor, alias) => people.setPersonAlias(actor, alias),
    datasets: () => insights.datasets(),
    /** @param {unknown} name @param {any} [opts] */
    dataset: (name, opts) => insights.dataset(name, opts),
    /** @param {any} [opts] */
    insights: (opts) => insights.insights(opts),
    listReports: () => insights.listReports(),
    /** @param {any} doc @param {{ actor?: string|null, expectedVersion?: number }} [opts] */
    saveReport: (doc, opts) => insights.saveReport(doc, opts),
    /** @param {unknown} id @param {{ actor?: string|null }} [opts] */
    deleteReport: (id, opts) => insights.deleteReport(id, opts),
    /** @param {unknown} id */
    restoreReport: (id) => insights.restoreReport(id),
    /** @param {unknown} doc */
    validateReport: (doc) => insights.validateReport(doc),
    /** @param {unknown} changes @param {any} [opts] */
    propose: (changes, opts) => proposals.propose(changes, opts),
    /** @param {{ status?: string }} [opts] */
    listProposals: (opts) => proposals.listProposals(opts),
    /** @param {unknown} id */
    getProposal: (id) => proposals.getProposal(id),
    /** @param {unknown} id @param {{ actor?: string|null }} [opts] */
    withdrawProposal: (id, opts) => proposals.withdrawProposal(id, opts),
    /** @param {unknown} id */
    refreshProposal: (id) => proposals.refreshProposal(id),
    /** @param {unknown} id @param {unknown} outcomes @param {any} [opts] */
    recordProposalOutcome: (id, outcomes, opts) => proposals.recordProposalOutcome(id, outcomes, opts),
    /** @param {unknown} keys */
    triage: (keys) => triage.triage(keys),
    /** @internal */
    queries,
  };
}
