// Caller identity and write intents.
//
// Trusted identity never comes from a payload. Two sources exist in v1 (decisions record §4,
// frozen in Phase 0):
//
// - Gadget writes carry a *viewer assertion*: a one-use, 60-second token the Workshop mints for the
//   authenticated viewer's session, bound to one gadget, one binding target and the SHA-256 digest
//   of exactly one write intent. The gadget server forwards it; the Records Gatekeeper recomputes
//   the digest and redeems the token through its kernel-owned ApprovalQueue, which returns the
//   verified viewer. Gadget code can drop or delay a token, but cannot forge one, reuse it, or
//   attach it to a different write.
// - HTTP calls carry a Records service credential (and a verified Access service token), which
//   resolves to a delegated service principal.
//
// Reads through a gadget are authorised for the binding and for every verified observer of that
// gadget (one uniform read audience), so they need no per-call token.

import type { MutatingRecordOperation } from "./permissions.js";

/** How a request reached the domain layer. Recorded on every audit event. */
export type Via = "gadget" | "http" | "management" | "system";

/**
 * The server-derived authority for one domain call. Built only by transport adapters from
 * verified material; never deserialised from a request.
 */
export type CallerContext = {
  orgId: string;
  /** The principal whose rights apply (the verified viewer, service principal or UI user). */
  principalId: string;
  via: Via;
  /** The binding or credential narrowing the principal's rights, if any. */
  bindingId?: string;
  /** Scopes of that binding/credential. `undefined` = acting directly as the principal. */
  scopes?: readonly string[];
  /** A separately verified initiator (e.g. the human who approved an agent action). */
  initiatorPrincipalId?: string;
};

/** Stable JSON: object keys sorted, no whitespace, `undefined` members dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("non-finite number");
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v ?? null)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A write intent: what the viewer is asserting they asked for. */
export type WriteIntent = {
  operation: MutatingRecordOperation;
  input: unknown;
  idempotencyKey: string;
};

/**
 * Digest a viewer assertion is bound to. Computed identically by the gadget UI (to request the
 * assertion) and by the Gatekeeper (to redeem it), so both must pass the same raw input object.
 */
export function intentDigest(intent: WriteIntent): Promise<string> {
  return sha256Hex(
    canonicalJson({ v: 1, service: "records", operation: intent.operation, input: intent.input, key: intent.idempotencyKey }),
  );
}

/** Digest of a request body for idempotency comparison. */
export function requestDigest(operation: string, input: unknown): Promise<string> {
  return sha256Hex(canonicalJson({ operation, input }));
}

/** Options accompanying every mutating call on the gadget session. */
export type WriteOptions = {
  idempotencyKey: string;
  /** Viewer assertion from `$createViewerAssertion(bindingName, intentDigest(...))`. */
  viewerAssertion: string;
};
