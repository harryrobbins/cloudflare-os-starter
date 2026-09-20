// Structured counters, redacted by construction.
//
// One line of JSON per event so the Workers observability pipeline can aggregate it. What must never
// appear: message bodies, file bytes, Access assertions, cookies, or an email address. User and
// channel identifiers are hashed, which is enough to correlate two events in one incident without
// naming anybody.

/** FNV-1a, hex. Synchronous (WebCrypto digests are async) and not a secret -- only an identifier. */
function hash(value: string): string {
  let h = 0x81_1c_9d_c5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01_00_01_93) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** A stable, non-reversible handle for a user or channel id, safe to log. */
export function hashId(value: string | null | undefined): string {
  return value === null || value === undefined || value.length === 0 ? "-" : hash(value);
}

export type LogFields = Readonly<Record<string, string | number | boolean | undefined>>;

/**
 * Emits one counter. `evt` is the metric name; everything else is a dimension.
 *
 * Call it with ids already passed through {@link hashId}: this function does not know which of its
 * fields are sensitive.
 */
export function logEvent(evt: string, fields: LogFields = {}): void {
  const line: Record<string, string | number | boolean> = { evt };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) line[key] = value;
  }
  console.log(JSON.stringify(line));
}

/** An authorization refusal. The one counter that must never be silent. */
export function logDenial(reason: string, fields: LogFields = {}): void {
  logEvent("chat.deny", { reason, ...fields });
}
