// @ts-check
// The gadget server's Records surface, kept free of `cloudflare:workers` so it runs under Node
// tests. `src/server/index.js` mixes it into the `Gadget` Durable Object.
//
// Sync pushes are passed through UNCHANGED: the Records Gatekeeper recomputes each mutation's
// intent digest over exactly the `args`, client id and mutation id the browser asserted, so this
// layer must not validate, normalise, copy or default anything in the request or its options.

import { BINDING_NAME, REQUIREMENT } from "../shared/records.js";

/** @typedef {import("../../../gatekeeper-records/src/vendor/types.d.ts").RecordsSession} RecordsSession */

/** Every server method that reaches a Records write. */
export const WRITE_METHODS = /** @type {const} */ (["syncPush"]);

/**
 * @param {() => any} getEnv returns the gadget's env
 * @param {import("./pokes.js").PokeLog} pokes
 * @param {() => Promise<unknown>} makeHookStub mints the persistent `ctx.restore` callback stub
 */
export function createRecordsProxy(getEnv, pokes, makeHookStub) {
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

    // Reads, for agents (executeCode) and the assignee picker. The board itself reads by sync pull.
    listProjects() { return records().listProjects(); },
    getWorkflow() { return records().getWorkflow(); },
    listAssignees() { return records().listAssignees(); },
    /** @param {any} input */
    listIssues(input) { return records().listIssues(input); },
    /** @param {string} issueId */
    getIssue(issueId) { return records().getIssue(issueId); },
    /** @param {any} input */
    listComments(input) { return records().listComments(input); },

    // Sync (records-sync-client protocol).
    /** @param {any} request @param {any} options one `{viewerAssertion}` per mutation */
    syncPush(request, options) { return records().syncPush(request, options); },
    /** @param {any} request */
    syncPull(request) { return records().syncPull(request); },
    /** @param {number[]} actionIds */
    syncApprovals(actionIds) { return records().syncApprovals(actionIds); },

    /**
     * Ask Records to poke this gadget after each commit. The Workshop owner approves the hook
     * once; until the first poke arrives, tabs keep pulling on a timer.
     */
    async requestLiveUpdates() {
      const session = records();
      await session.onChange(/** @type {any} */ (await makeHookStub()), { deliver: "pokes" });
      pokes.markRequested();
      return pokes.summary();
    },
    /** The latest poke this gadget received. Gadget-local; cheap to poll. */
    getPokes() { return pokes.summary(); },
  };
}
