// Response construction. One place, so no handler can forget `no-store` on a private payload or
// invent an error shape the client does not know how to read.

import { ERROR_STATUS, type ErrorCode, type ErrorEnvelope } from "./shared/protocol.js";

/**
 * API and private-file responses must never be cached by a shared or edge cache: a cached body would
 * survive the membership change that revoked access to it (chat.md, "Security checklist").
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
  const envelope: ErrorEnvelope = {
    error: { code, message, ...(retryAfter !== undefined ? { retryAfter } : {}) },
  };
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
