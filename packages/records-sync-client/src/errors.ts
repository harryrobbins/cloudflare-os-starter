// Errors raised by mutators (local predictions) and by transports (push/pull calls).

export type MutationErrorCode =
  | "not_found"
  | "validation_failed"
  | "revision_conflict"
  | "workflow_conflict"
  | "duplicate";

/**
 * Thrown by a mutator when the local state says the command will fail. The client still pushes the
 * mutation, because the server decides; the error is shown as `likelyToFail` meanwhile.
 */
export class MutationError extends Error {
  override name = "MutationError";
  readonly code: MutationErrorCode;
  readonly currentRevision?: number;

  constructor(code: MutationErrorCode, message: string, currentRevision?: number) {
    super(message);
    this.code = code;
    if (currentRevision !== undefined) this.currentRevision = currentRevision;
  }
}

/**
 * A push or pull call that failed as a whole.
 * - `network`: no answer (offline, DNS, abort/timeout). Retried with backoff.
 * - `server`: 5xx, 408 or 429. Retried with backoff.
 * - `client`: any other 4xx (auth, validation, …). Not retried automatically.
 */
export class SyncTransportError extends Error {
  override name = "SyncTransportError";
  readonly kind: "network" | "server" | "client";
  readonly status: number | null;
  readonly code: string | null;

  constructor(kind: "network" | "server" | "client", message: string, status: number | null = null, code: string | null = null) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.code = code;
  }

  get retryable(): boolean {
    return this.kind !== "client";
  }
}

/** Anything thrown by a transport that is not a SyncTransportError counts as a network failure. */
export function asTransportError(err: unknown): SyncTransportError {
  if (err instanceof SyncTransportError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new SyncTransportError("network", message || "The request failed.");
}
