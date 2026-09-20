// Unread arithmetic, as pure functions over the contract's own shapes.
//
// The server is authoritative -- `BadgeSummary` arrives on `me`, on every write and on the socket's
// `badge` event -- but the client has to do the same sum locally, because a message that arrives while
// you are looking at another channel must bold the rail immediately rather than after a round trip.
// Keeping the rules here, with no React and no store, is what makes them testable.

import type {
  BadgeSummary,
  Channel,
  ChannelId,
  Membership,
  Message,
  UserId,
} from "../contract.js";
import { mentionsUser } from "../lib/mentions.js";

/**
 * The seq of the first message that should sit below the "New messages" line, or null when the
 * conversation is fully read.
 *
 * Two cursors feed this. `lastReadSeq` moves forward only, on the server's acknowledgement. A manual
 * "mark unread from here" sets `manualUnreadSeq` instead, precisely because moving `lastReadSeq`
 * backwards would re-notify old mentions and fight another tab's read (chat.md). When both are
 * present the earlier one wins: the user asked to see everything from their marker onwards.
 */
export function firstUnreadSeq(membership: Membership | undefined, channelLastSeq: number): number | null {
  if (membership === undefined) return null;
  const fromRead = membership.lastReadSeq < channelLastSeq ? membership.lastReadSeq + 1 : null;
  const fromManual = membership.manualUnreadSeq;
  if (fromManual === null) return fromRead;
  if (fromRead === null) return fromManual <= channelLastSeq ? fromManual : null;
  return Math.min(fromRead, fromManual);
}

/** How many messages sit at or above the first unread seq. */
export function unreadCount(membership: Membership | undefined, channelLastSeq: number): number {
  const first = firstUnreadSeq(membership, channelLastSeq);
  if (first === null) return 0;
  return Math.max(0, channelLastSeq - first + 1);
}

/** Bold-in-the-rail test. A muted conversation is still unread; it simply never badges. */
export function isUnread(membership: Membership | undefined, channelLastSeq: number): boolean {
  return unreadCount(membership, channelLastSeq) > 0;
}

/**
 * Advances the read cursor locally, the way the server will.
 *
 * `seq` never moves the cursor backwards. Reaching the end of the channel also clears a manual unread
 * marker: the user has now read past their own marker, so leaving it set would make the conversation
 * permanently unread.
 */
export function applyRead(
  membership: Membership,
  seq: number,
  channelLastSeq: number,
): Membership {
  const lastReadSeq = Math.max(membership.lastReadSeq, seq);
  const clearsMarker =
    membership.manualUnreadSeq !== null && lastReadSeq >= channelLastSeq;
  if (lastReadSeq === membership.lastReadSeq && !clearsMarker) return membership;
  return { ...membership, lastReadSeq, manualUnreadSeq: clearsMarker ? null : membership.manualUnreadSeq };
}

export interface BadgeTotals {
  readonly unread: number;
  readonly mentions: number;
  readonly threads: number;
  /** True when at least one unmuted conversation has unread messages. */
  readonly anyUnread: boolean;
}

/**
 * Collapses the per-channel summary into the numbers the rail's header, the document title and the
 * embed bridge send. Muted conversations contribute nothing at all -- not to the dot, not to the count
 * -- which is the whole point of muting.
 */
export function badgeTotals(
  badges: BadgeSummary,
  memberships: Readonly<Record<ChannelId, Membership>>,
): BadgeTotals {
  let unread = 0;
  let mentions = 0;
  for (const [channelId, count] of Object.entries(badges.unread)) {
    if (memberships[channelId]?.muted === true) continue;
    unread += count;
  }
  for (const [channelId, count] of Object.entries(badges.mentions)) {
    if (memberships[channelId]?.muted === true) continue;
    mentions += count;
  }
  return { unread, mentions, threads: badges.threads, anyUnread: unread > 0 };
}

/** `(2) Chat` when there are mentions, `• Chat` for unread without mentions, else `Chat`. */
export function documentTitle(totals: BadgeTotals, base = "Chat"): string {
  if (totals.mentions > 0) return `(${totals.mentions}) ${base}`;
  if (totals.anyUnread) return `• ${base}`;
  return base;
}

/**
 * The local badge update for one newly arrived message.
 *
 * Mirrors what the server will report, so the rail is right before the `badge` event lands. Returns the
 * summary unchanged when the message is the reader's own, or when the conversation's notify level means
 * it should not count towards a mention.
 */
export function applyIncoming(
  badges: BadgeSummary,
  message: Message,
  meId: UserId,
  membership: Membership | undefined,
): BadgeSummary {
  if (message.authorId === meId) return badges;
  if (membership === undefined) return badges;
  const channelId = message.channelId;
  const unread = { ...badges.unread, [channelId]: (badges.unread[channelId] ?? 0) + 1 };
  const mentioned =
    mentionsUser(message.mentions, meId, message.authorId) && membership.notify !== "none";
  const mentions = mentioned
    ? { ...badges.mentions, [channelId]: (badges.mentions[channelId] ?? 0) + 1 }
    : badges.mentions;
  return { unread, mentions, threads: badges.threads };
}

/** Clears one channel's counters, for the local half of "mark read". */
export function clearChannelBadges(badges: BadgeSummary, channelId: ChannelId): BadgeSummary {
  if (badges.unread[channelId] === undefined && badges.mentions[channelId] === undefined) {
    return badges;
  }
  const unread = { ...badges.unread };
  const mentions = { ...badges.mentions };
  delete unread[channelId];
  delete mentions[channelId];
  return { unread, mentions, threads: badges.threads };
}

/**
 * Whether a message in this conversation should raise a notification at all.
 *
 * The per-conversation `notify` preference, then muting, then the "not your own message" rule. The
 * caller adds the visibility test, which is state this module has no business knowing about.
 */
export function shouldNotify(
  message: Message,
  meId: UserId,
  membership: Membership | undefined,
): boolean {
  if (message.authorId === meId) return false;
  if (membership === undefined || membership.muted) return false;
  if (membership.notify === "none") return false;
  if (membership.notify === "mentions") return mentionsUser(message.mentions, meId, message.authorId);
  return true;
}

/** Rail ordering: unread first inside a section is *not* wanted (it makes rows jump), so this is
 *  alphabetical for named channels and by most recent activity for DMs, which is what Slack does. */
export function compareChannels(a: Channel, b: Channel): number {
  if (a.name !== null && b.name !== null) return a.name.localeCompare(b.name);
  return b.lastSeq - a.lastSeq;
}
