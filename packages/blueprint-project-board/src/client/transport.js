// @ts-check
// The SyncClient transport for a gadget: browser → gadget server → RECORDS session.
//
// Push: every mutation in a batch needs its own viewer assertion, minted by the host for the
// intent the Records Gatekeeper will recompute:
//
//   { operation: name without "projects.", input: args, idempotencyKey: "sync:<clientId>:<id>" }
//
// digested with records-contracts `intentDigest` (SHA-256 of canonical JSON). The request and the
// assertions then go to the gadget server, which passes them to `RECORDS.syncPush` unchanged. An
// assertion is valid once, for 60 seconds, so each push attempt (including a retry of the same
// mutations) mints fresh ones.
//
// Errors cross Workers RPC as "<code>: <detail>" and are mapped to SyncTransportError kinds, which
// decide what the SyncClient does: `network`/`server` retry with backoff; `client` 400/413 isolates
// the bad mutation; any other `client` error stops pushing until the next change or Retry.

import { intentDigest } from "../../../records-contracts/src/caller.ts";
import { SyncTransportError } from "../../../records-sync-client/src/index.ts";
import { BINDING_NAME, errorCode, errorDetail } from "../shared/records.js";

/** @typedef {import("../../../records-sync-client/src/index.ts").SyncTransport} SyncTransport */

/** HTTP-like status per Records error code (packages/records-contracts/src/errors.ts). */
const STATUS = /** @type {Record<string, number>} */ ({
  validation_failed: 400, revision_required: 400, idempotency_conflict: 409, duplicate: 409,
  unauthenticated: 401, forbidden: 403, not_connected: 403, datastore_archived: 403, not_found: 404,
  payload_too_large: 413, rate_limited: 429, unavailable: 503, internal: 500,
});

/**
 * Maps an error thrown by a gadget RPC call to a SyncTransportError. Unrecognised errors (a lost
 * connection, a broken stub) count as network failures and are retried.
 * @param {unknown} err
 */
export function toTransportError(err) {
  if (err instanceof SyncTransportError) return err;
  const code = errorCode(err);
  const message = errorDetail(err) || "The Records service did not answer.";
  if (!code) return new SyncTransportError("network", message);
  const status = STATUS[code] ?? 400;
  const kind = status >= 500 || status === 429 ? "server" : "client";
  return new SyncTransportError(kind, message, status, code);
}

/** @param {string} name e.g. "projects.createIssue" */
export function operationOf(name) {
  return name.startsWith("projects.") ? name.slice("projects.".length) : name;
}

/** @param {string} clientId @param {number} mutationId */
export function syncIdempotencyKey(clientId, mutationId) {
  return `sync:${clientId}:${mutationId}`;
}

/**
 * Mints one viewer assertion per mutation, in order.
 * @param {any} gadget
 * @param {{clientId: string, mutations: {id: number, name: string, args: unknown}[]}} request
 */
export async function assertPush(gadget, request) {
  const options = [];
  for (const m of request.mutations) {
    const digest = await intentDigest({
      operation: /** @type {any} */ (operationOf(m.name)), input: m.args, idempotencyKey: syncIdempotencyKey(request.clientId, m.id),
    });
    let viewerAssertion;
    try {
      viewerAssertion = await gadget.$createViewerAssertion(BINDING_NAME, digest);
    } catch (err) {
      throw new SyncTransportError("client",
        `The Workshop could not confirm these changes came from you (${errorDetail(err) || "no reason given"}). Nothing was sent.`,
        401, "assertion_failed");
    }
    if (typeof viewerAssertion !== "string" || !viewerAssertion) {
      throw new SyncTransportError("client",
        "The Workshop did not confirm these changes came from you, so they were not sent. Only signed-in viewers can change records.",
        401, "assertion_unavailable");
    }
    options.push({ viewerAssertion });
  }
  return options;
}

/**
 * @param {any} gadget the platform's RPC stub to the gadget server (plus `$createViewerAssertion`)
 * @returns {SyncTransport}
 */
export function gadgetTransport(gadget) {
  return {
    async push(request) {
      const options = await assertPush(gadget, request);
      let res;
      try {
        res = await gadget.syncPush(request, options);
      } catch (err) {
        throw toTransportError(err);
      }
      if (!res || !Array.isArray(res.outcomes)) throw new SyncTransportError("server", "Malformed push response.", 200, "malformed_response");
      return res;
    },
    async pull(request) {
      let res;
      try {
        res = await gadget.syncPull(request);
      } catch (err) {
        throw toTransportError(err);
      }
      if (!res || typeof res.cookie !== "number" || !Array.isArray(res.patch) || typeof res.lastMutationIdChanges !== "object") {
        throw new SyncTransportError("server", "Malformed pull response.", 200, "malformed_response");
      }
      return res;
    },
    async approvals(actionIds) {
      try {
        return await gadget.syncApprovals(actionIds);
      } catch (err) {
        throw toTransportError(err);
      }
    },
  };
}
