// Mention tokens.
//
// The token syntax is the *shared* one: `MENTION_TOKEN_SOURCE` in `src/shared/protocol.ts` and
// `mentionToken` / `extractMentionIds` in `src/shared/validate.ts` are the single definition, used by
// the Durable Object to write `mentions` rows and by this module to build and render them. There is
// no second regex for a person:
//
//   <@USER_ID>      a person; the composer inserts it, the renderer shows the display name
//   <#CHANNEL_ID>   a channel. Client-only sugar: the server stores no channel mention, so this one
//                   is defined here, over the same id charset, and only ever affects rendering.
//   @channel @here  bare, because they name no id
//   @agent          bare, the one reserved name (chat.md: ship `@user` and `@agent` first)
//
// The angle brackets are the important part: a token can never be produced by ordinary typing, so the
// composer can insert one without escaping, and the server -- not this file -- decides who actually
// gets notified.

import {
  extractMentionIds,
  MENTION_TOKEN_SOURCE,
  mentionToken,
  type Mention,
  type UserId,
} from "../contract.js";

/** The channel form of {@link MENTION_TOKEN_SOURCE}: the same id charset behind a `#`. */
const CHANNEL_TOKEN_SOURCE = MENTION_TOKEN_SOURCE.replace("<@", "<#");

/**
 * A fresh global regex per call.
 *
 * Never a shared `const`: a global `RegExp` carries `lastIndex`, which is exactly why the contract
 * publishes the source string rather than a compiled pattern.
 */
export function userTokenPattern(): RegExp {
  return new RegExp(MENTION_TOKEN_SOURCE, "gu");
}

export function channelTokenPattern(): RegExp {
  return new RegExp(CHANNEL_TOKEN_SOURCE, "gu");
}

/** `@channel`, `@here` and `@agent` at a word boundary. */
export function bareMentionPattern(): RegExp {
  return /(^|[^\w@])@(channel|here|agent)\b/g;
}

export function userToken(id: UserId): string {
  return mentionToken(id);
}

export function channelToken(id: string): string {
  return `<#${id}>`;
}

/**
 * Every mention in a body, deduplicated, in the order the server would see them.
 *
 * The user half is `extractMentionIds` from the contract, so the client and the Durable Object cannot
 * disagree about which tokens count. Client-side only: it drives the composer's preview and the "did
 * this mention me" check that decides whether to raise a notification before the server's own
 * `mentions` array arrives. The server's copy is authoritative for badges.
 */
export function parseMentions(body: string): Mention[] {
  const out: Mention[] = [];
  for (const userId of extractMentionIds(body)) out.push({ kind: "user", userId });
  const seenKinds = new Set<string>();
  for (const match of body.matchAll(bareMentionPattern())) {
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
  for (const match of body.matchAll(channelTokenPattern())) {
    if (!out.includes(match[1]!)) out.push(match[1]!);
  }
  return out;
}

/**
 * Whether a message should count as a mention of `userId`.
 *
 * **Only `<@id>` counts.** `@channel` and `@here` are parsed above so the composer can show them, but
 * the Durable Object never writes a `channel` or `here` row -- `extractMentionIds` in
 * `src/shared/validate.ts` sees the id token and nothing else -- so counting them here would badge a
 * mention the server does not have, and the badge would vanish on the next `badge` event or reload.
 * chat.md gates those two behind explicit limits and permissions, and until that lands the honest
 * client behaviour is to ignore them. `authorId` is supplied so a self-mention never badges.
 */
export function mentionsUser(
  mentions: readonly Mention[],
  userId: UserId,
  authorId?: UserId,
): boolean {
  if (authorId === userId) return false;
  return mentions.some((mention) => mention.kind === "user" && mention.userId === userId);
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
    .replace(userTokenPattern(), (_all, id: string) => `@${nameOf(id) ?? "unknown"}`)
    .replace(channelTokenPattern(), (_all, id: string) => `#${channelNameOf(id) ?? "unknown"}`);
}
