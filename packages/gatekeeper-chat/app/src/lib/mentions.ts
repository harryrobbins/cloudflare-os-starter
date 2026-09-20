// Mention tokens.
//
// CONTRACT GAP: `protocol.ts` fixes the *parsed* shape (`Mention`) and the plan fixes the rule --
// "mentions use immutable user IDs from autocomplete tokens, resolved and checked server-side at post
// time; display names are neither unique nor stable" -- but it never writes down the token syntax
// that carries the id through the message body. This module defines it for the client and is the only
// place that knows it, so replacing it with a shared helper later is a one-file change:
//
//   <@USER_ID>      a person; the composer inserts it, the renderer shows the display name
//   <#CHANNEL_ID>   a channel
//   @channel @here  bare, because they name no id
//   @agent          bare, the one reserved name (chat.md: ship `@user` and `@agent` first)
//
// The angle brackets are the important part: an id may contain characters a bare `@name` form would
// swallow, and a token can never be produced by ordinary typing, so a body that quotes `<@x>` in
// backticks is still parsed as a mention only if the server agrees -- which is why the server, not
// this file, decides who actually gets notified.

import type { Mention, UserId } from "../contract.js";

export const USER_TOKEN_PATTERN = /<@([^<>\s|]+)>/g;
export const CHANNEL_TOKEN_PATTERN = /<#([^<>\s|]+)>/g;
/** `@channel`, `@here` and `@agent` at a word boundary. */
export const BARE_MENTION_PATTERN = /(^|[^\w@])@(channel|here|agent)\b/g;

export function userToken(id: UserId): string {
  return `<@${id}>`;
}

export function channelToken(id: string): string {
  return `<#${id}>`;
}

/**
 * Every mention in a body, deduplicated, in the order the server would see them.
 *
 * Client-side only: it drives the composer's preview and the "did this mention me" check that decides
 * whether to raise a notification before the server's own `mentions` array arrives. The server's copy
 * is authoritative for badges.
 */
export function parseMentions(body: string): Mention[] {
  const out: Mention[] = [];
  const seenUsers = new Set<string>();
  const seenKinds = new Set<string>();
  for (const match of body.matchAll(USER_TOKEN_PATTERN)) {
    const id = match[1]!;
    if (seenUsers.has(id)) continue;
    seenUsers.add(id);
    out.push({ kind: "user", userId: id });
  }
  for (const match of body.matchAll(BARE_MENTION_PATTERN)) {
    const kind = match[2] as "channel" | "here" | "agent";
    if (seenKinds.has(kind)) continue;
    seenKinds.add(kind);
    out.push({ kind });
  }
  return out;
}

/** Channel ids referenced by `<#id>` tokens, for the "also mentioned in" affordances. */
export function parseChannelMentions(body: string): string[] {
  const out: string[] = [];
  for (const match of body.matchAll(CHANNEL_TOKEN_PATTERN)) {
    if (!out.includes(match[1]!)) out.push(match[1]!);
  }
  return out;
}

/**
 * Whether a message should count as a mention of `userId`.
 *
 * `@channel` and `@here` count for everyone but the author, matching the plan's badge model; the
 * caller supplies `authorId` so a self-mention never badges.
 */
export function mentionsUser(
  mentions: readonly Mention[],
  userId: UserId,
  authorId?: UserId,
): boolean {
  if (authorId === userId) return false;
  return mentions.some(
    (mention) =>
      (mention.kind === "user" && mention.userId === userId) ||
      mention.kind === "channel" ||
      mention.kind === "here",
  );
}

/**
 * Turns the display text a person typed back into id tokens, ready to post.
 *
 * The composer shows `@Alice Chen`, not `<@u-alice>`: a `<textarea>` cannot render a chip, and showing
 * the raw token is the difference between a product and a demo. The ids still have to reach the
 * server, so the conversion happens once, here, on the way out -- and `mentionsToText` is its exact
 * inverse, which is what lets an edit round-trip.
 *
 * Only an *exact* display name resolves, and an ambiguous one (two people, one name) resolves to
 * nobody rather than to a guess -- display names "are neither unique nor stable", so a guess would
 * notify the wrong person. Longest names first, so `@Alice Chen` is never eaten by an `@Alice`.
 */
export function resolveMentions(
  body: string,
  users: readonly { readonly id: UserId; readonly name: string }[],
  channels: readonly { readonly id: string; readonly name: string | null }[],
): string {
  const entries: Array<{ needle: string; replacement: string }> = [];

  const byName = new Map<string, string | null>();
  for (const user of users) {
    const name = user.name.trim();
    if (name.length === 0) continue;
    // A second user with the same name poisons the entry: neither resolves.
    byName.set(name, byName.has(name) ? null : user.id);
  }
  for (const [name, id] of byName) {
    if (id === null) continue;
    entries.push({ needle: `@${name}`, replacement: userToken(id) });
  }
  for (const channel of channels) {
    if (channel.name === null || channel.name.length === 0) continue;
    entries.push({ needle: `#${channel.name}`, replacement: channelToken(channel.id) });
  }

  entries.sort((a, b) => b.needle.length - a.needle.length);

  let out = body;
  for (const entry of entries) {
    // The token must start at a word boundary and must not be the tail of an existing `<@id>`, which
    // the leading `[^\w<]` rules out.
    const pattern = new RegExp(`(^|[^\\w<])${escapeRegExp(entry.needle)}(?![\\w])`, "g");
    out = out.replace(pattern, (_all, prefix: string) => `${prefix}${entry.replacement}`);
  }
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replaces tokens with display names for a plain-text context: notification bodies, the rail's
 * last-message preview, the document title. The Markdown renderer has its own, richer path.
 */
export function mentionsToText(
  body: string,
  nameOf: (id: string) => string | undefined,
  channelNameOf: (id: string) => string | undefined,
): string {
  return body
    .replace(USER_TOKEN_PATTERN, (_all, id: string) => `@${nameOf(id) ?? "unknown"}`)
    .replace(CHANNEL_TOKEN_PATTERN, (_all, id: string) => `#${channelNameOf(id) ?? "unknown"}`);
}
