// What the landing page says.
//
// "Here is what happened while you were away" is arithmetic over state the client already holds -- the
// badge summary, the membership rows and the thread list -- so it is a pure function with tests rather
// than a pile of `useMemo`s in a view. It is also the one place that decides what *counts* as
// something to come back to, which is a product decision worth being able to read in one place.

import type {
  BadgeSummary,
  Channel,
  ChannelId,
  ChannelKind,
  Membership,
  MessageId,
  ThreadSummary,
  User,
  UserId,
} from "../contract.js";
import { channelLabel } from "./labels.js";
import { toPlainText } from "./markdown.js";
import { mentionsToText } from "./mentions.js";

export interface DigestConversation {
  readonly channelId: ChannelId;
  readonly label: string;
  readonly kind: ChannelKind;
  readonly unread: number;
  readonly mentions: number;
}

export interface DigestThread {
  readonly rootId: MessageId;
  readonly channelId: ChannelId;
  readonly channelLabel: string;
  readonly preview: string;
  readonly unreadReplies: number;
}

export interface Digest {
  /** Conversations where somebody used your name. Always first: they are the ones that are owed. */
  readonly mentions: readonly DigestConversation[];
  /** Unread without a mention. */
  readonly unread: readonly DigestConversation[];
  readonly threads: readonly DigestThread[];
  /** Where you have been lately, for when there is nothing new. */
  readonly recent: readonly DigestConversation[];
  readonly totalUnread: number;
  readonly totalMentions: number;
  /** Nothing is waiting. Worth saying out loud rather than showing three empty headings. */
  readonly quiet: boolean;
}

export interface DigestInput {
  readonly channels: Readonly<Record<ChannelId, Channel>>;
  readonly memberships: Readonly<Record<ChannelId, Membership>>;
  readonly badges: BadgeSummary;
  readonly users: Readonly<Record<UserId, User>>;
  readonly threads: readonly ThreadSummary[];
  readonly meId: UserId | undefined;
  /** Most recently opened first; see `store/recents.ts`. */
  readonly recents: readonly ChannelId[];
  readonly recentLimit?: number;
}

export function computeDigest(input: DigestInput): Digest {
  const conversations: DigestConversation[] = [];
  for (const channel of Object.values(input.channels)) {
    const membership = input.memberships[channel.id];
    // Muted is muted: a conversation that never badges must never appear in a digest either, or the
    // mute has simply moved the interruption to a different screen.
    if (membership === undefined || membership.muted || channel.archived) continue;
    const unread = input.badges.unread[channel.id] ?? 0;
    const mentions = input.badges.mentions[channel.id] ?? 0;
    if (unread === 0 && mentions === 0) continue;
    conversations.push({
      channelId: channel.id,
      label: channelLabel(channel, input.users, input.meId),
      kind: channel.kind,
      unread,
      mentions,
    });
  }

  const mentioned = conversations
    .filter((entry) => entry.mentions > 0)
    .toSorted((a, b) => b.mentions - a.mentions || a.label.localeCompare(b.label));
  const unread = conversations
    .filter((entry) => entry.mentions === 0)
    // A direct message is a person waiting for you; a channel is not. That ordering is the whole
    // difference between a useful digest and a list.
    .toSorted(
      (a, b) => directFirst(a.kind) - directFirst(b.kind) || a.label.localeCompare(b.label),
    );

  const threads = input.threads
    .filter((thread) => thread.following && thread.unreadReplies > 0)
    .toSorted((a, b) => (b.lastReplyAt ?? 0) - (a.lastReplyAt ?? 0))
    .map((thread) => ({
      rootId: thread.rootId,
      channelId: thread.channelId,
      channelLabel:
        input.channels[thread.channelId] === undefined
          ? "a conversation"
          : channelLabel(input.channels[thread.channelId]!, input.users, input.meId),
      preview: previewOf(thread, input),
      unreadReplies: thread.unreadReplies,
    }));

  const busy = new Set(conversations.map((entry) => entry.channelId));
  const recent: DigestConversation[] = [];
  for (const channelId of input.recents) {
    if (recent.length >= (input.recentLimit ?? 5)) break;
    if (busy.has(channelId)) continue;
    const channel = input.channels[channelId];
    if (channel === undefined || channel.archived) continue;
    if (input.memberships[channelId] === undefined) continue;
    recent.push({
      channelId,
      label: channelLabel(channel, input.users, input.meId),
      kind: channel.kind,
      unread: 0,
      mentions: 0,
    });
  }

  const totalUnread = conversations.reduce((sum, entry) => sum + entry.unread, 0);
  const totalMentions = conversations.reduce((sum, entry) => sum + entry.mentions, 0);

  return {
    mentions: mentioned,
    unread,
    threads,
    recent,
    totalUnread,
    totalMentions,
    quiet: mentioned.length === 0 && unread.length === 0 && threads.length === 0,
  };
}

function directFirst(kind: ChannelKind): number {
  return kind === "dm" ? 0 : kind === "group" ? 1 : 2;
}

function previewOf(thread: ThreadSummary, input: DigestInput): string {
  const text = toPlainText(
    mentionsToText(
      thread.root.body,
      (id) => input.users[id]?.name,
      (id) => input.channels[id]?.name ?? undefined,
    ),
  );
  return text.length > 90 ? `${text.slice(0, 89).trimEnd()}…` : text;
}

/** The first word of a display name; the whole thing when there is only one. */
export function firstName(name: string | null | undefined): string | null {
  const trimmed = (name ?? "").trim();
  if (trimmed.length === 0) return null;
  return trimmed.split(/\s+/)[0] ?? null;
}

/**
 * `Good morning, Harry`.
 *
 * Local hours, deliberately: a greeting is about where the reader is, and the server's idea of the
 * time is not that. The name is dropped rather than guessed at when there is not one.
 */
export function greeting(at: number | Date, name: string | null | undefined): string {
  const hour = (at instanceof Date ? at : new Date(at)).getHours();
  const part = hour < 5 ? "evening" : hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  const who = firstName(name);
  return who === null ? `Good ${part}` : `Good ${part}, ${who}`;
}

/** `3 unread in 2 conversations, 1 of them a mention` -- the one-line version of the whole digest. */
export function summarise(digest: Digest): string {
  if (digest.quiet) return "Nothing new";
  const parts: string[] = [];
  const conversations = digest.mentions.length + digest.unread.length;
  if (conversations > 0) {
    parts.push(
      `${digest.totalUnread} unread in ${conversations} ${conversations === 1 ? "conversation" : "conversations"}`,
    );
  }
  if (digest.totalMentions > 0) {
    parts.push(`${digest.totalMentions} ${digest.totalMentions === 1 ? "mention" : "mentions"}`);
  }
  if (digest.threads.length > 0) {
    parts.push(`${digest.threads.length} ${digest.threads.length === 1 ? "thread" : "threads"}`);
  }
  return parts.join(" · ");
}
