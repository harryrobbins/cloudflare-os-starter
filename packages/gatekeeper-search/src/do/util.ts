// Small shared helpers for the SearchIndex modules.

import { INPUT_ERROR_PREFIX } from "../shared/contract.js";

/** A caller mistake. RPC loses the class, so callers recognise it by the message prefix. */
export function inputError(message: string): Error {
  return new Error(`${INPUT_ERROR_PREFIX}${message}`);
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

export async function sha256Hex(value: string): Promise<string> {
  return [...(await sha256(value))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

/**
 * The vector id of one chunk: the first 22 base64url characters (132 bits) of
 * SHA-256(`<documentId>#<ord>`). Deterministic, so a re-push addresses the same vectors, and far
 * inside Vectorize's 64-byte id cap whatever the document id's length.
 */
export async function chunkId(documentId: string, ord: number): Promise<string> {
  return base64url(await sha256(`${documentId}#${ord}`)).slice(0, 22);
}

const encoder = new TextEncoder();

export function utf8Bytes(value: string): number {
  return encoder.encode(value).length;
}

/** Escapes text for inclusion in HTML, attribute-safe. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Sentinels FTS5's `snippet()` wraps matches in. Control characters that ingest strips from every
 * body, so the only occurrences in a snippet are the ones SQLite put there; they are turned into
 * `<mark>` *after* escaping, so a `<script>` in a body can never become markup.
 */
export const MARK_OPEN = "\u0001";
export const MARK_CLOSE = "\u0002";

/** Removes NUL and the snippet sentinels. */
export function stripControl(value: string): string {
  return value.replace(/[\u0000-\u0002]/gu, "");
}

/** An escaped FTS snippet with its sentinels turned into `<mark>`. */
export function markedSnippet(raw: string): string {
  return escapeHtml(raw).replaceAll(MARK_OPEN, "<mark>").replaceAll(MARK_CLOSE, "</mark>");
}

export const OPENING_CHARS = 200;

/** The escaped opening of a chunk, cut at a word boundary: a dense-only hit's snippet. */
export function openingSnippet(text: string): string {
  const clean = text.replaceAll(MARK_OPEN, "").replaceAll(MARK_CLOSE, "").replace(/\s+/gu, " ").trim();
  if (clean.length <= OPENING_CHARS) return escapeHtml(clean);
  const cut = clean.slice(0, OPENING_CHARS);
  const space = cut.lastIndexOf(" ");
  return `${escapeHtml(space > OPENING_CHARS / 2 ? cut.slice(0, space) : cut)}…`;
}

/** A JSON array parameter for `IN (SELECT value FROM json_each(?))`: one bound parameter, any length. */
export function jsonList(values: readonly (string | number)[]): string {
  return JSON.stringify(values);
}

export const IN_LIST = "(SELECT value FROM json_each(?))";
