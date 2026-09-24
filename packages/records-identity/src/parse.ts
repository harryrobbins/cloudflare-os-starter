// Credential parsing. Bounded and total: never throws, never decodes more than MAX_HEADER_LENGTH.
//
// Precedence is decided here: when an `Authorization` header is present it is the credential, and
// `Cf-Access-Jwt-Assertion` is ignored (behind Access, the edge already enforced the assertion, and
// an rk1 credential may legitimately arrive with an Access service token in front). A present but
// unusable `Authorization` header is `invalid`; it never falls back to the Access assertion.

import { isCompactJwt } from "./jwt.js";

/** `rk1_<credential id, 32 hex>_<secret, 43 base64url>` (gatekeeper-records registry format). */
export const CREDENTIAL_TOKEN = /^rk1_[0-9a-f]{32}_[A-Za-z0-9_-]{43}$/;

/** Longest header value inspected. */
export const MAX_HEADER_LENGTH = 8192;
/** Longest Basic user name (an e-mail address). */
export const MAX_BASIC_USER_LENGTH = 320;

export type InvalidReason = "too_long" | "unknown_scheme" | "bad_bearer" | "bad_basic_encoding" | "bad_basic_user" | "basic_not_credential" | "bad_access_assertion";

export type ParsedAuthorization =
  | { type: "jwt"; token: string }
  | { type: "credential"; token: string }
  | { type: "basic"; email: string; token: string }
  | { type: "access"; token: string }
  | { type: "invalid"; reason: InvalidReason }
  | { type: "none" };

export type HeaderSource = { get(name: string): string | null };

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
// Visible ASCII and Unicode letters, no controls or separators that could smuggle a second field.
const BASIC_USER = /^[^\u0000-\u001f\u007f:\s]+$/u;

function decodeBase64Utf8(value: string): string | null {
  if (value.length % 4 !== 0 || !BASE64.test(value)) return null;
  try {
    const bin = atob(value);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

function parseAuthorizationValue(value: string): ParsedAuthorization {
  if (value.length > MAX_HEADER_LENGTH) return { type: "invalid", reason: "too_long" };
  const match = /^([A-Za-z]+) +([^ ]+)$/.exec(value.trim());
  if (!match) return { type: "invalid", reason: "unknown_scheme" };
  const scheme = match[1]!.toLowerCase();
  const credentials = match[2]!;

  if (scheme === "bearer") {
    if (CREDENTIAL_TOKEN.test(credentials)) return { type: "credential", token: credentials };
    if (isCompactJwt(credentials)) return { type: "jwt", token: credentials };
    return { type: "invalid", reason: "bad_bearer" };
  }

  if (scheme === "basic") {
    const decoded = decodeBase64Utf8(credentials);
    if (decoded === null) return { type: "invalid", reason: "bad_basic_encoding" };
    const colon = decoded.indexOf(":");
    if (colon <= 0) return { type: "invalid", reason: "bad_basic_user" };
    const email = decoded.slice(0, colon);
    const token = decoded.slice(colon + 1);
    if (email.length > MAX_BASIC_USER_LENGTH || !BASIC_USER.test(email)) return { type: "invalid", reason: "bad_basic_user" };
    if (!CREDENTIAL_TOKEN.test(token)) return { type: "invalid", reason: "basic_not_credential" };
    return { type: "basic", email, token };
  }

  return { type: "invalid", reason: "unknown_scheme" };
}

/** Classify the request's credential. See the module comment for precedence. */
export function parseAuthorization(headers: HeaderSource): ParsedAuthorization {
  let authorization: string | null;
  let access: string | null;
  try {
    authorization = headers.get("authorization");
    access = headers.get("cf-access-jwt-assertion");
  } catch {
    return { type: "invalid", reason: "unknown_scheme" };
  }

  if (authorization !== null && authorization.trim() !== "") return parseAuthorizationValue(authorization);

  if (access !== null && access.trim() !== "") {
    const token = access.trim();
    if (!isCompactJwt(token)) return { type: "invalid", reason: token.length > MAX_HEADER_LENGTH ? "too_long" : "bad_access_assertion" };
    return { type: "access", token };
  }
  return { type: "none" };
}
