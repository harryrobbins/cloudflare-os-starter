// Stable error codes shared by both transports. HTTP maps them to status codes and RFC 9457
// problem documents; RPC throws a RecordsError whose message starts with the code, because
// Workers RPC carries only an error's name and message across the boundary.

import type { z } from "zod";

export const ERROR_STATUS = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 400,
  revision_conflict: 412,
  revision_required: 428,
  workflow_conflict: 409,
  idempotency_conflict: 409,
  datastore_archived: 409,
  duplicate: 409,
  payload_too_large: 413,
  rate_limited: 429,
  unavailable: 503,
  internal: 500,
} as const;
export type ErrorCode = keyof typeof ERROR_STATUS;

/** Problem document body for HTTP errors. `code` is the stable, machine-readable field. */
export type Problem = {
  type: string;
  title: string;
  status: number;
  code: ErrorCode;
  detail?: string;
  issues?: { path: string; message: string }[];
};

export class RecordsError extends Error {
  override name = "RecordsError";
  readonly code: ErrorCode;
  readonly issues?: { path: string; message: string }[];
  readonly currentRevision?: number;

  constructor(code: ErrorCode, detail: string, issues?: { path: string; message: string }[], currentRevision?: number) {
    super(`${code}: ${detail}`);
    this.code = code;
    if (issues) this.issues = issues;
    if (currentRevision !== undefined) this.currentRevision = currentRevision;
  }

  get detail(): string {
    return this.message.slice(this.code.length + 2);
  }

  get status(): number {
    return ERROR_STATUS[this.code];
  }

  toProblem(): Problem {
    return {
      type: `https://records.invalid/problems/${this.code}`,
      title: this.code.replaceAll("_", " "),
      status: this.status,
      code: this.code,
      detail: this.detail,
      ...(this.issues ? { issues: this.issues } : {}),
    };
  }

  /** Recover the code from an error that crossed an RPC boundary. */
  static codeOf(err: unknown): ErrorCode | null {
    const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
    const code = message.split(":", 1)[0] as ErrorCode;
    return code in ERROR_STATUS ? code : null;
  }
}

/**
 * Parse untrusted input. Failures become `validation_failed` with bounded issue paths; the input
 * values themselves are never echoed back.
 */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issues = result.error.issues.slice(0, 20).map((i) => ({
    path: i.path.map(String).join(".") || "(root)",
    message: i.message,
  }));
  // The issue list is also folded into the message: only the message survives an RPC boundary.
  // Paths and reasons never include the submitted values.
  const summary = issues.map((i) => `${i.path}: ${i.message}`).join("; ");
  throw new RecordsError("validation_failed", `The request did not match the contract (${summary}).`, issues);
}
