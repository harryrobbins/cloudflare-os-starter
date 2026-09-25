// @ts-check
// Exact-intent digests for Records service commands. Must match the connector's
// `recordsOsIntentDigest` (packages/records-service/src/cloudflare-os.ts): lowercase hex SHA-256 of
// canonical JSON — object keys sorted recursively, no whitespace. Undefined values are refused, so
// callers omit absent fields rather than send them as undefined.

/** @param {unknown} value @returns {string} */
export function canonical(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const object = /** @type {Record<string, unknown>} */ (value);
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  throw new Error("Command intent must contain only JSON values");
}

/**
 * @typedef {{
 *   datastore: string, binding: string, moduleId: string, apiMajor: number, command: string,
 *   input: Record<string, unknown>, expectedRevision: number|null, idempotencyKey: string,
 * }} CommandIntent
 */

/** @param {CommandIntent} intent @returns {Promise<string>} */
export async function intentDigest(intent) {
  const bytes = new TextEncoder().encode(canonical(intent));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
