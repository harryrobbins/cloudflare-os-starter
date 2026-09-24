// Shared, pre-verification checks on a compact JWS. Nothing here trusts the token; it only bounds
// the work done before signature verification.

import { decodeJwt, decodeProtectedHeader, type JWTPayload, type ProtectedHeaderParameters } from "jose";
import { refuse } from "./errors.js";

/** Longest compact JWT accepted anywhere. Access assertions are ~1 KiB; delegated tokens ~600 B. */
export const MAX_JWT_LENGTH = 8192;

export const COMPACT_JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

export function isCompactJwt(token: string): boolean {
  return token.length <= MAX_JWT_LENGTH && COMPACT_JWT.test(token);
}

/** Decode header and payload without verifying. Throws a `malformed` refusal. */
export function peek(token: string): { header: ProtectedHeaderParameters; payload: JWTPayload } {
  if (typeof token !== "string" || !isCompactJwt(token)) throw refuse("malformed");
  try {
    return { header: decodeProtectedHeader(token), payload: decodeJwt(token) };
  } catch {
    throw refuse("malformed");
  }
}

/** Default and ceiling for clock skew, in seconds. */
export const DEFAULT_CLOCK_TOLERANCE_SEC = 5;
export const MAX_CLOCK_TOLERANCE_SEC = 30;

export function tolerance(sec: number | undefined): number {
  const value = sec ?? DEFAULT_CLOCK_TOLERANCE_SEC;
  if (!Number.isFinite(value) || value < 0) return DEFAULT_CLOCK_TOLERANCE_SEC;
  return Math.min(value, MAX_CLOCK_TOLERANCE_SEC);
}

export const toDate = (now: Date | number | undefined): Date =>
  now === undefined ? new Date() : now instanceof Date ? now : new Date(now);
