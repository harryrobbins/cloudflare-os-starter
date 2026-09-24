// Response construction. One place, so no handler can forget `no-store` on a private payload or
// invent an error shape the SPA does not know how to read.

import type { ErrorCode, ErrorEnvelope } from "./shared/contract.js";

export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = {
  invalid_request: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  rate_limited: 429,
  internal: 500,
};

/**
 * API responses must never be cached by a shared or edge cache: a cached body would survive the
 * membership change that revoked access to it.
 */
export const PRIVATE_CACHE_HEADERS: Readonly<Record<string, string>> = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
};

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      ...PRIVATE_CACHE_HEADERS,
      "content-type": "application/json; charset=utf-8",
      ...init.headers,
    },
  });
}

export function errorResponse(code: ErrorCode, message: string, retryAfter?: number): Response {
  const envelope: ErrorEnvelope = { error: { code, message } };
  return json(envelope, {
    status: ERROR_STATUS[code],
    headers: retryAfter !== undefined ? { "retry-after": String(retryAfter) } : {},
  });
}

/** 401 for a browser: no `WWW-Authenticate`, because Access -- not this Worker -- owns the login. */
export function unauthenticated(message = "A verified Cloudflare Access assertion is required."): Response {
  return errorResponse("unauthenticated", message);
}

export function forbidden(message = "Not allowed."): Response {
  return errorResponse("forbidden", message);
}

export function invalidRequest(message: string): Response {
  return errorResponse("invalid_request", message);
}

export function notFound(message = "Not found."): Response {
  return errorResponse("not_found", message);
}
