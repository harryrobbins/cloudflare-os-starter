// @ts-check
// The gadget server's Records surface, kept free of `cloudflare:workers` so it runs under Node
// tests. `src/server/index.js` mixes it into the `Gadget` Durable Object.
//
// Commands are passed through UNCHANGED: the connector recomputes the intent digest over exactly
// the command, input, idempotency key and revision the browser asserted, so this layer must not
// validate, copy, normalise or default anything in them.

import { BINDING_NAME, REQUIREMENT } from "../shared/records.js";

/** @typedef {import("../../../gatekeeper-records-service/src/types.d.ts").RecordsServiceSession} RecordsServiceSession */

/** @param {() => any} getEnv returns the gadget's env */
export function createRecordsProxy(getEnv) {
  /** @returns {RecordsServiceSession} */
  function records() {
    const session = getEnv()?.[BINDING_NAME];
    if (!session) throw new Error(`not_connected: Connect a Records work datastore as ${BINDING_NAME} in this gadget's Connections tab.`);
    return session;
  }

  return {
    /** Setup summary for the UI. Never throws for an unconnected or refused datastore. */
    async getSetup() {
      const requirement = REQUIREMENT;
      if (!getEnv()?.[BINDING_NAME]) return { connected: false, requirement, connection: null, description: null, error: null };
      try {
        const session = records();
        const [connection, description] = await Promise.all([session.connection(), session.describe()]);
        return { connected: true, requirement, connection, description, error: null };
      } catch (err) {
        return { connected: true, requirement, connection: null, description: null, error: err instanceof Error ? err.message : String(err) };
      }
    },
    connection() { return records().connection(); },
    describe() { return records().describe(); },
    model() { return records().model(); },
    /** @param {number} [limit] */
    snapshot(limit) { return records().snapshot(limit); },
    /** @param {number} [after] @param {number} [epoch] */
    changes(after, epoch) { return records().changes(after, epoch); },
    /** @param {any} [query] */
    records(query) { return records().records(query); },
    /** @param {string} command @param {any} input @param {any} options */
    command(command, input, options) { return records().command(command, input, options); },
    /** @param {number} actionId */
    getOutcome(actionId) { return records().getOutcome(actionId); },
  };
}
