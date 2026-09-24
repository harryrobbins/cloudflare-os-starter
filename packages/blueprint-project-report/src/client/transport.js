// @ts-check
// A read-only SyncClient transport for the report: browser → gadget server → RECORDS.syncPull.
// There is no push: the report never mutates, and its gadget server has no write path.
//
// Errors cross Workers RPC as "<code>: <detail>" and are mapped to SyncTransportError kinds:
// `network`/`server` are retried with backoff by the SyncClient; `client` errors are not.

import { SyncTransportError } from "../../../records-sync-client/src/index.ts";
import { errorCode, errorDetail } from "../shared/records.js";

/** @typedef {import("../../../records-sync-client/src/index.ts").SyncTransport} SyncTransport */

const STATUS = /** @type {Record<string, number>} */ ({
  validation_failed: 400, unauthenticated: 401, forbidden: 403, not_connected: 403, not_found: 404,
  payload_too_large: 413, rate_limited: 429, unavailable: 503, internal: 500,
});

/** @param {unknown} err */
export function toTransportError(err) {
  if (err instanceof SyncTransportError) return err;
  const code = errorCode(err);
  const message = errorDetail(err) || "The Records service did not answer.";
  if (!code) return new SyncTransportError("network", message);
  const status = STATUS[code] ?? 400;
  return new SyncTransportError(status >= 500 || status === 429 ? "server" : "client", message, status, code);
}

/** @param {any} gadget @returns {SyncTransport} */
export function readOnlyTransport(gadget) {
  return {
    async push() {
      throw new SyncTransportError("client", "This report is read-only.", 405, "read_only");
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
  };
}
