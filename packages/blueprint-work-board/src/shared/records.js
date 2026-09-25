// @ts-check
// Facts shared by the gadget server, the client and the packing script: the binding this blueprint
// needs, the service requirement it declares, and how Records service errors are recognised after
// they cross an RPC boundary (`Error("<code>: <detail>")`, see
// packages/gatekeeper-records-service/src/types.d.ts).

import REQUIREMENT from "../service-requirement.json" with { type: "json" };

export { REQUIREMENT };

/** The env binding name the gadget reads; also what `$createViewerAssertion` is given. */
export const BINDING_NAME = "RECORDS";

/**
 * The archive's `bindings` entry. `gatekeeperName` is the Workshop vendor id of
 * packages/gatekeeper-records-service (binding GATEKEEPER_RECORDSERVICE); `typeUrlPattern` equals
 * its SupportedResource.urlPattern.
 */
export const BLUEPRINT_BINDINGS = Object.freeze({
  [BINDING_NAME]: {
    title: "Work datastore",
    description:
      "A Records datastore with the work module (API v1). Connect it with \"Read and request changes\" to " +
      "create and edit items; read-only connections show the board without editing. Items stay in the " +
      "datastore if this board is deleted, and other boards connected to it show the same items.",
    type: "gatekeeper",
    gatekeeperName: "recordservice",
    typeUrlPattern: "records-service://datastore/*",
  },
});

const CODES = new Set([
  "forbidden", "not_found", "invalid_request", "conflict", "reset_required", "stale_revision",
  "revision_required", "too_large", "read_only", "unavailable", "not_connected",
]);

/** @param {unknown} err @returns {string|null} */
export function errorCode(err) {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const match = /^([a-z_]+):/.exec(message.trim());
  return match && CODES.has(match[1]) ? match[1] : null;
}

/** @param {unknown} err */
export function errorDetail(err) {
  const message = err instanceof Error ? err.message : String(err ?? "");
  return errorCode(err) ? message.slice(message.indexOf(":") + 1).trim() : message;
}
