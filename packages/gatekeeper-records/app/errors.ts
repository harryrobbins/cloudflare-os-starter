// Map errors that crossed the RPC boundary (message `"<code>: <detail>"`) to what the page shows.

import { RecordsError, type ErrorCode } from '@records/contracts'
import type { z } from 'zod'

export type Issue = { path: string; message: string }

export type DisplayError = {
  code: ErrorCode | null
  title: string
  detail: string
  issues: Issue[]
}

const TITLES: Partial<Record<ErrorCode, string>> = {
  forbidden: "You don't have permission to do that",
  not_found: 'Not found',
  validation_failed: 'Some details need correcting',
  datastore_archived: 'This datastore is archived and read-only',
  duplicate: 'That already exists',
  unavailable: 'The data service is unavailable. Try again shortly',
  unauthenticated: 'You are not signed in',
  rate_limited: 'Too many requests. Wait a moment and try again',
  payload_too_large: 'That is too large',
  revision_conflict: 'Someone else changed this first',
  workflow_conflict: 'That change is not allowed by the workflow',
}

export function describeError(err: unknown): DisplayError {
  const code = RecordsError.codeOf(err)
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  const detail = code ? message.slice(code.length + 1).trim() : message
  // Issues survive only in-process (tests) or when the transport carries them; see the report on
  // the RPC contract. Never echo input values: issues carry paths and messages only.
  const raw = (err as { issues?: unknown } | null)?.issues
  const issues = Array.isArray(raw)
    ? raw
        .filter((i): i is Issue => !!i && typeof i.path === 'string' && typeof i.message === 'string')
        .slice(0, 20)
    : []
  return {
    code,
    title: (code && TITLES[code]) || 'Something went wrong',
    detail: detail || (code ? '' : 'An unexpected error occurred.'),
    issues,
  }
}

/** Client-side pre-validation with the same contract schema the server uses. */
export function validate<S extends z.ZodType>(
  schema: S,
  input: unknown,
): { ok: true; value: z.output<S> } | { ok: false; error: DisplayError } {
  const result = schema.safeParse(input)
  if (result.success) return { ok: true, value: result.data }
  return {
    ok: false,
    error: {
      code: 'validation_failed',
      title: TITLES.validation_failed!,
      detail: '',
      issues: result.error.issues.slice(0, 20).map((i) => ({
        path: i.path.map(String).join('.') || '(root)',
        message: i.message,
      })),
    },
  }
}
