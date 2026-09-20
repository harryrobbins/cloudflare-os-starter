// Message bodies are Markdown, rendered client-side with a sanitising renderer and no raw HTML
// (chat.md, "Security checklist"). Two layers, because one is not enough:
//
//   marked      turns the body into HTML. GFM on, so tables, strikethrough and bare-URL autolinks
//               work; `breaks` on, because a chat line break is a line break.
//   DOMPurify   allow-lists the result. A body that contains `<img onerror=...>` reaches this
//               function as literal text (marked escapes it), but the sanitiser is what makes that a
//               guarantee rather than an observation about marked's current behaviour.
//
// Mention tokens are swapped for a private-use sentinel *before* marked sees them -- `<@id>` would
// otherwise be escaped to `&lt;@id&gt;` and be unrecoverable -- and for their chip *after* the
// sanitiser has run, with the display name escaped here. Nothing user-supplied is interpolated as
// markup at any point.

import DOMPurify from "dompurify";
import { Marked } from "marked";

import { channelTokenPattern, userTokenPattern } from "./mentions.js";

const marked = new Marked({ gfm: true, breaks: true, async: false });

/** Inline formatting plus the block elements a chat message legitimately needs. No media, no forms. */
const ALLOWED_TAGS = [
  "p", "br", "hr", "strong", "b", "em", "i", "del", "s", "code", "pre", "blockquote",
  "ul", "ol", "li", "a", "h1", "h2", "h3", "h4", "h5", "h6",
  "table", "thead", "tbody", "tr", "th", "td", "span",
];

const ALLOWED_ATTR = ["href", "title", "class", "align", "data-mention", "data-mention-id"];

let hooked = false;

/**
 * Anchor hardening, installed once.
 *
 * `rel="noopener noreferrer"` per the security checklist, `target="_blank"` because a chat message is
 * not a navigation, and any href whose protocol is not http(s) or mailto is dropped -- `javascript:`
 * is the obvious one, but `data:` on an anchor is just as good a payload delivery vehicle.
 */
function installHooks(): void {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (!(node instanceof Element) || node.tagName !== "A") return;
    const href = node.getAttribute("href");
    if (href === null || !/^(https?:|mailto:)/i.test(href.trim())) {
      node.removeAttribute("href");
      return;
    }
    node.setAttribute("rel", "noopener noreferrer");
    node.setAttribute("target", "_blank");
  });
}

const SENTINEL_OPEN = "";
const SENTINEL_CLOSE = "";

export interface MentionNames {
  /** Display name for a user id, or undefined when the directory has not seen them. */
  readonly nameOf: (id: string) => string | undefined;
  /** Channel name for a channel id. */
  readonly channelNameOf: (id: string) => string | undefined;
  /** The signed-in user, so their own mention can be highlighted harder. */
  readonly meId?: string;
}

/** Renders a message body to sanitised HTML with mention chips resolved. */
export function renderMarkdown(body: string, names: MentionNames): string {
  installHooks();
  const chips: string[] = [];
  const withSentinels = body
    .replace(userTokenPattern(), (_all, id: string) => {
      const name = names.nameOf(id);
      const classes = `mention${names.meId === id ? " mention-me" : ""}`;
      chips.push(
        `<span class="${classes}" data-mention="user" data-mention-id="${escapeHtml(id)}">@${escapeHtml(name ?? "unknown")}</span>`,
      );
      return `${SENTINEL_OPEN}${chips.length - 1}${SENTINEL_CLOSE}`;
    })
    .replace(channelTokenPattern(), (_all, id: string) => {
      chips.push(
        `<span class="mention" data-mention="channel" data-mention-id="${escapeHtml(id)}">#${escapeHtml(names.channelNameOf(id) ?? "unknown")}</span>`,
      );
      return `${SENTINEL_OPEN}${chips.length - 1}${SENTINEL_CLOSE}`;
    });

  const html = marked.parse(withSentinels) as string;
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    // No `<template>`/`<svg>` smuggling, and no leftover comments to hide markup in.
    FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "form", "input", "img", "svg"],
    ALLOW_DATA_ATTR: false,
  });

  return clean.replace(
    new RegExp(`${SENTINEL_OPEN}(\\d+)${SENTINEL_CLOSE}`, "g"),
    (_all, index: string) => chips[Number(index)] ?? "",
  );
}

/**
 * An FTS5 `snippet()` result.
 *
 * The server emits exactly one form: SQLite's `snippet(messages_fts, 0, '<mark>', '</mark>', '…', n)`
 * (`src/do/search.ts`). So the body is escaped, `&lt;mark&gt;` is turned back into a tag, and the
 * result is allow-listed down to `<mark>` -- the escape-then-reinstate order is what makes a body that
 * itself contains `<mark>` render as text.
 */
export function renderSnippet(snippet: string): string {
  installHooks();
  const marked_ = escapeHtml(snippet).replace(/&lt;(\/?)mark&gt;/g, "<$1mark>");
  return DOMPurify.sanitize(marked_, { ALLOWED_TAGS: ["mark"], ALLOWED_ATTR: [] });
}

/** Strips Markdown to a single line, for the rail preview and notification bodies. */
export function toPlainText(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, " code ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " image ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
