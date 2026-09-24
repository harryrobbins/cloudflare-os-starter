// Request checks and response headers for the connect page, kept free of Workers imports so they
// can be unit-tested.
//
// Referrer-Policy must be `same-origin`, NOT `no-referrer`: under `no-referrer` browsers send
// `Origin: null` on the page's own form POST, which fails the Origin check below and refuses every
// confirmation. `same-origin` still sends nothing to other sites, which matters because the page URL
// carries the flow nonce.

export const CONNECT_PAGE_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  "referrer-policy": "same-origin",
  "x-frame-options": "DENY",
};

export type GuardResult = { ok: true } | { ok: false; status: number; reason: "cross-site" | "origin" | "method" };

/**
 * GET (the confirmation page) and POST (the confirmation) must both come from this site. The
 * Workshop opens the tab itself, so the GET is `Sec-Fetch-Site: same-origin`; a link pasted from
 * e-mail or chat arrives as `cross-site` or `none`. The POST must additionally carry our Origin.
 */
export function checkConnectRequest(request: Request): GuardResult {
  if (request.method !== "GET" && request.method !== "POST") return { ok: false, status: 405, reason: "method" };
  if (request.headers.get("sec-fetch-site") !== "same-origin") return { ok: false, status: 403, reason: "cross-site" };
  if (request.method === "POST" && request.headers.get("origin") !== new URL(request.url).origin) {
    return { ok: false, status: 403, reason: "origin" };
  }
  return { ok: true };
}
