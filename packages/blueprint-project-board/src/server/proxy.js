// @ts-check
// The gadget server's Records surface, kept free of `cloudflare:workers` so it runs under Node
// tests. `src/server/index.js` mixes it into the `Gadget` Durable Object.
//
// Writes are passed through UNCHANGED: the Records Gatekeeper recomputes the intent digest over
// exactly the `input` object and idempotency key the browser asserted, so this layer must not
// validate, normalise, copy or default anything in `input` or `options`.

import { BINDING_NAME, REQUIREMENT } from "../shared/records.js";

/** @typedef {import("../../../gatekeeper-records/src/vendor/types.d.ts").RecordsSession} RecordsSession */

export const WRITE_METHODS = /** @type {const} */ (["createIssue", "editIssue", "transitionIssue", "addComment"]);

/**
 * @param {() => any} getEnv returns the gadget's env
 * @param {import("./feed.js").ChangeFeed} feed
 * @param {() => Promise<unknown>} makeHookStub mints the persistent `ctx.restore` callback stub
 */
export function createRecordsProxy(getEnv, feed, makeHookStub) {
  /** @returns {RecordsSession} */
  function records() {
    const session = getEnv()?.[BINDING_NAME];
    if (!session) {
      throw new Error(`not_connected: Connect a Projects datastore as ${BINDING_NAME} in this gadget's Connections tab.`);
    }
    return session;
  }

  return {
    /** Setup summary for the UI. Never throws for an unconnected or forbidden datastore. */
    async getSetup() {
      const requirement = REQUIREMENT;
      if (!getEnv()?.[BINDING_NAME]) return { connected: false, requirement, binding: null, error: null };
      try {
        return { connected: true, requirement, binding: await records().describe(), error: null };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { connected: true, requirement, binding: null, error: message };
      }
    },
    listProjects() { return records().listProjects(); },
    getWorkflow() { return records().getWorkflow(); },
    listAssignees() { return records().listAssignees(); },
    /** @param {any} input */
    listIssues(input) { return records().listIssues(input); },
    /** @param {string} issueId */
    getIssue(issueId) { return records().getIssue(issueId); },
    /** @param {any} input */
    listComments(input) { return records().listComments(input); },

    /** @param {any} input @param {any} options */
    createIssue(input, options) { return records().createIssue(input, options); },
    /** @param {any} input @param {any} options */
    editIssue(input, options) { return records().editIssue(input, options); },
    /** @param {any} input @param {any} options */
    transitionIssue(input, options) { return records().transitionIssue(input, options); },
    /** @param {any} input @param {any} options */
    addComment(input, options) { return records().addComment(input, options); },
    /** @param {number} actionId */
    getWriteOutcome(actionId) { return records().getWriteOutcome(actionId); },

    /**
     * Ask Records to notify this gadget of changes. The Workshop owner approves the hook once;
     * until the first delivery the UI keeps polling.
     */
    async requestLiveUpdates() {
      const session = records();
      await session.onChange(/** @type {any} */ (await makeHookStub()));
      feed.markRequested();
      return feed.since();
    },
    /** @param {{epoch?: string, seq?: number}} [since] */
    getChanges(since) { return feed.since(since); },
  };
}
