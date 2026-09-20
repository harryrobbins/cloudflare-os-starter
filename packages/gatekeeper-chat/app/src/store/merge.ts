// Merging message lists.
//
// Three things write into a conversation and they can arrive in any order: an HTTP page (history
// scroll, a permalink's `around=`, the `since` catch-up after a reconnect), a socket `msg`, and the
// user's own optimistic send. Every one of them goes through `mergeMessages`, so "last writer wins per
// id, ordered by seq, pending rows pinned to the bottom" is a single rule rather than three.

import type { Message, MessageId, Reaction, UserId } from "../contract.js";

/**
 * A message that has not been committed yet. Its `seq` is this sentinel, which sorts it after every
 * real message without needing a separate list, and the reconciliation below replaces it wholesale once
 * the server answers.
 */
export const PENDING_SEQ = Number.MAX_SAFE_INTEGER;

export type SendState = "pending" | "failed";

export interface LocalMessage extends Message {
  /** Present only while a send is in flight or has failed. */
  readonly local?: { readonly state: SendState; readonly error?: string };
}

function isPending(message: LocalMessage): boolean {
  return message.local !== undefined;
}

/**
 * Orders a conversation.
 *
 * Committed messages by `seq`, which is monotonic per channel and is the same order the server pages
 * in. Uncommitted ones after them by creation time, so a burst of optimistic sends keeps its typing
 * order. `seq` is not unique across a pending/committed boundary (every pending row shares
 * `PENDING_SEQ`), which is why the tiebreak exists.
 */
function compare(a: LocalMessage, b: LocalMessage): number {
  if (a.seq !== b.seq) return a.seq - b.seq;
  if (isPending(a) !== isPending(b)) return isPending(a) ? 1 : -1;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Folds `incoming` into `existing`.
 *
 * Server rows win over local ones with the same id, and a server row that echoes a `clientId` also
 * evicts the optimistic row that carried it -- that is the reconciliation the plan asks for, and it has
 * to happen here as well as in `reconcileSend` because a socket `msg` for your own send can beat the
 * HTTP response back.
 */
export function mergeMessages(
  existing: readonly LocalMessage[],
  incoming: readonly Message[],
): LocalMessage[] {
  if (incoming.length === 0) return existing as LocalMessage[];

  const byId = new Map<MessageId, LocalMessage>();
  for (const message of existing) byId.set(message.id, message);

  const committedClientIds = new Set<string>();
  for (const message of incoming) {
    byId.set(message.id, message);
    if (message.clientId !== undefined) committedClientIds.add(message.clientId);
  }

  const out: LocalMessage[] = [];
  for (const message of byId.values()) {
    // Drop the optimistic twin of a row the server has now confirmed under its own id.
    if (
      isPending(message) &&
      message.clientId !== undefined &&
      committedClientIds.has(message.clientId) &&
      !incoming.some((candidate) => candidate.id === message.id)
    ) {
      continue;
    }
    out.push(message);
  }
  return out.toSorted(compare);
}

/** The row shown the instant Enter is pressed. */
export function optimisticMessage(params: {
  readonly clientId: string;
  readonly channelId: string;
  readonly authorId: UserId;
  readonly body: string;
  readonly rootId: MessageId | null;
  readonly attachments: Message["attachments"];
  readonly mentions: Message["mentions"];
  readonly now?: number;
}): LocalMessage {
  return {
    id: `local:${params.clientId}`,
    channelId: params.channelId,
    seq: PENDING_SEQ,
    rootId: params.rootId,
    authorId: params.authorId,
    body: params.body,
    kind: "user",
    createdAt: params.now ?? Date.now(),
    editedAt: null,
    deletedAt: null,
    replyCount: 0,
    lastReplyAt: null,
    reactions: [],
    attachments: params.attachments,
    mentions: params.mentions,
    clientId: params.clientId,
    local: { state: "pending" },
  };
}

/**
 * Replaces the optimistic row for `clientId` with the committed message.
 *
 * A `deduped` response (the same `clientId` was already committed, because the first attempt actually
 * landed before the network error) reconciles identically: that is the point of the idempotency key.
 */
export function reconcileSend(
  existing: readonly LocalMessage[],
  clientId: string,
  committed: Message,
): LocalMessage[] {
  const withoutLocal = existing.filter(
    (message) => !(isPending(message) && message.clientId === clientId),
  );
  return mergeMessages(withoutLocal, [committed]);
}

/** Marks the optimistic row failed so the UI can offer Retry, keeping the body for a resend. */
export function markSendFailed(
  existing: readonly LocalMessage[],
  clientId: string,
  error: string,
): LocalMessage[] {
  return existing.map((message) =>
    isPending(message) && message.clientId === clientId
      ? { ...message, local: { state: "failed" as const, error } }
      : message,
  );
}

export function removeLocal(existing: readonly LocalMessage[], clientId: string): LocalMessage[] {
  return existing.filter((message) => !(isPending(message) && message.clientId === clientId));
}

/** A delete: the tombstone replaces the row when replies keep it visible, otherwise the row goes. */
export function applyDelete(
  existing: readonly LocalMessage[],
  id: MessageId,
  tombstone: Message | null,
): LocalMessage[] {
  if (tombstone !== null) return mergeMessages(existing, [tombstone]);
  return existing.filter((message) => message.id !== id);
}

export function applyReactions(
  existing: readonly LocalMessage[],
  id: MessageId,
  reactions: readonly Reaction[],
): LocalMessage[] {
  return existing.map((message) => (message.id === id ? { ...message, reactions } : message));
}

/** The optimistic half of a reaction toggle: add or remove the caller's id from one emoji's list. */
export function toggleReaction(
  reactions: readonly Reaction[],
  emoji: string,
  meId: UserId,
): readonly Reaction[] {
  const existing = reactions.find((reaction) => reaction.emoji === emoji);
  if (existing === undefined) return [...reactions, { emoji, userIds: [meId] }];
  if (existing.userIds.includes(meId)) {
    const userIds = existing.userIds.filter((id) => id !== meId);
    return userIds.length === 0
      ? reactions.filter((reaction) => reaction.emoji !== emoji)
      : reactions.map((reaction) =>
          reaction.emoji === emoji ? { emoji, userIds } : reaction,
        );
  }
  return reactions.map((reaction) =>
    reaction.emoji === emoji ? { emoji, userIds: [...reaction.userIds, meId] } : reaction,
  );
}

export interface CatchUpPlan {
  /** The `after=` cursor to ask for, or null when nothing was missed. */
  readonly after: number | null;
  /** How many messages the client is behind, for the "catching up" affordance. */
  readonly behind: number;
}

/**
 * What to fetch for one channel after `hello`.
 *
 * `hello` reports each channel's high-water mark at connect time. Anything above what the client
 * already holds was missed while the socket was down, and is fetched over HTTP with `after=` paging --
 * the socket replays nothing, by design. A channel the client has never opened needs no catch-up: its
 * history loads when it is opened.
 */
export function planCatchUp(params: {
  readonly serverLastSeq: number;
  readonly localLastSeq: number;
  readonly loaded: boolean;
}): CatchUpPlan {
  if (!params.loaded) return { after: null, behind: 0 };
  if (params.serverLastSeq <= params.localLastSeq) return { after: null, behind: 0 };
  return { after: params.localLastSeq, behind: params.serverLastSeq - params.localLastSeq };
}

/** The highest committed seq the client holds for a conversation. Pending rows do not count. */
export function localLastSeq(messages: readonly LocalMessage[]): number {
  let max = 0;
  for (const message of messages) {
    if (isPending(message)) continue;
    if (message.seq > max) max = message.seq;
  }
  return max;
}
