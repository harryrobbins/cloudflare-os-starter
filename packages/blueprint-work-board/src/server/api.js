// @ts-check
// The gadget server's whole RPC surface, free of `cloudflare:workers` so it runs under Node tests
// and in the harness page. `src/server/index.js` exposes each method on the Durable Object.
//
//   Records pass-through (unchanged): getSetup, connection, describe, model, snapshot, changes,
//     records, command, getOutcome
//   Documents: listViews, saveView, deleteView, getPrefs, savePrefs, getSettings, saveSettings
//   Agent reads: query, describeQuery, item, vocabulary

import { createRecordsProxy } from "./proxy.js";
import { createDocuments, createPeople } from "./documents.js";
import { createQueryCache } from "./query.js";

/** Every method the client or the agent may call. */
export const RPC_METHODS = Object.freeze([
  "getSetup", "connection", "describe", "model", "snapshot", "changes", "records", "command", "getOutcome",
  "listViews", "saveView", "deleteView", "getPrefs", "savePrefs", "getSettings", "saveSettings",
  "query", "describeQuery", "item", "vocabulary", "people", "rememberViewer", "setPersonAlias",
]);

/**
 * @param {{ getEnv: () => any, storage: Parameters<typeof createDocuments>[0], now?: () => number, ttlMs?: number }} options
 */
export function createGadgetApi({ getEnv, storage, now, ttlMs }) {
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

  return {
    ...proxy,
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
    vocabulary: () => queries.vocabulary(),
    people: () => people.people(),
    /** @param {unknown} viewer */
    rememberViewer: (viewer) => people.rememberViewer(viewer),
    /** @param {unknown} actor @param {unknown} alias */
    setPersonAlias: (actor, alias) => people.setPersonAlias(actor, alias),
    /** @internal */
    queries,
  };
}
