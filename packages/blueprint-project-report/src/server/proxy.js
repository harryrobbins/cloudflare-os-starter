// @ts-check
// The report's Records surface: reads only. There is deliberately no method here that reaches a
// Records write (createIssue, editIssue, transitionIssue, addComment); tests assert that.
// Kept free of `cloudflare:workers` so it runs under Node tests.

import { BINDING_NAME, REQUIREMENT } from "../shared/records.js";
import { loadIssues, toCsv } from "../client/report.js";

/**
 * @param {() => any} getEnv
 * @param {import("./feed.js").ChangeFeed} feed
 * @param {() => Promise<unknown>} makeHookStub
 */
export function createReadOnlyProxy(getEnv, feed, makeHookStub) {
  function records() {
    const session = getEnv()?.[BINDING_NAME];
    if (!session) throw new Error(`not_connected: Connect a Projects datastore as ${BINDING_NAME} in this gadget's Connections tab.`);
    return session;
  }
  return {
    async getSetup() {
      const requirement = REQUIREMENT;
      if (!getEnv()?.[BINDING_NAME]) return { connected: false, requirement, binding: null, error: null };
      try {
        return { connected: true, requirement, binding: await records().describe(), error: null };
      } catch (err) {
        return { connected: true, requirement, binding: null, error: err instanceof Error ? err.message : String(err) };
      }
    },
    listProjects() { return records().listProjects(); },
    getWorkflow() { return records().getWorkflow(); },
    /** @param {any} input */
    listIssues(input) { return records().listIssues(input); },
    async requestLiveUpdates() {
      await records().onChange(/** @type {any} */ (await makeHookStub()));
      feed.markRequested();
      return feed.since();
    },
    /** @param {any} since */
    getChanges(since) { return feed.since(since); },
    /** CSV of every issue in the datastore, for the Workshop's Export menu. */
    async exportCsv() {
      const session = records();
      const [projects, workflow] = await Promise.all([session.listProjects(), session.getWorkflow()]);
      const { items } = await loadIssues((input) => session.listIssues(input));
      return toCsv(items, projects, workflow);
    },
  };
}
