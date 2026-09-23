// @ts-check
// Facts shared by the gadget server, the client and the packing script: the binding this blueprint
// needs, the service requirement it declares, and how Records errors are recognised after they
// cross an RPC boundary.

import REQUIREMENT from "../service-requirement.json" with { type: "json" };

export { REQUIREMENT };

/** The env binding name the gadget reads; also what `$createViewerAssertion` is given. */
export const BINDING_NAME = "RECORDS";

/**
 * The archive's `bindings` entry. `typeUrlPattern` must equal the Records vendor's
 * `SupportedResource.urlPattern`; the coordinator aligns it with packages/gatekeeper-records.
 */
export const BLUEPRINT_BINDINGS = Object.freeze({
  [BINDING_NAME]: {
    title: "Projects datastore",
    description:
      "An organisation Projects datastore (Records service, API v1). Connect it with the issue " +
      "read, create, edit, transition and comment operations. Records stay with the organisation " +
      "if this board is deleted.",
    type: "gatekeeper",
    gatekeeperName: "records",
    typeUrlPattern: "records://datastore/*",
  },
});

/**
 * Stable Records error codes (packages/records-contracts/src/errors.ts). A RecordsError crosses
 * Workers RPC as `"<code>: <detail>"`; `not_connected` is this gadget's own code for a missing
 * binding.
 */
const CODES = new Set([
  "unauthenticated", "forbidden", "not_found", "validation_failed", "revision_conflict",
  "revision_required", "workflow_conflict", "idempotency_conflict", "datastore_archived",
  "duplicate", "payload_too_large", "rate_limited", "unavailable", "internal", "not_connected",
]);

/** @param {unknown} err @returns {string|null} */
export function errorCode(err) {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const code = message.split(":", 1)[0].trim();
  return CODES.has(code) ? code : null;
}

/** @param {unknown} err */
export function errorDetail(err) {
  const message = err instanceof Error ? err.message : String(err ?? "");
  const code = errorCode(err);
  return code ? message.slice(message.indexOf(":") + 1).trim() : message;
}

/** Errors that mean "the datastore can't be used right now", as opposed to one bad request. */
export const BLOCKING_CODES = new Set(["not_connected", "forbidden", "unauthenticated", "datastore_archived"]);

/** Errors worth retrying later without changing anything. */
export const TRANSIENT_CODES = new Set(["unavailable", "rate_limited", "internal"]);
