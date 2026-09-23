// Messages, threads and reactions.
//
// The invariants this file is responsible for:
//
//   * `seq` is per channel, gapless and monotonic. It is allocated by incrementing
//     `channels.last_seq` inside the same synchronous transaction that inserts the message, which is
//     what makes unread arithmetic and cursor paging agree with each other.
//   * A thread reply gets a channel `seq` as well as a `root_id`, so a permalink to a reply works and
//     a followed thread's unread count can use the same cursor type as everything else.
//   * `clientId` is unique per author, so a retried POST returns the message that was already
//     written instead of a second copy.
//   * A mention is a user id token, validated against a real user before a row is written. A display
//     name is never authoritative.

import {
  AGENT_USER_ID,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  type ChannelId,
  type DeleteMessageResponse,
  type EditMessageRequest,
  type ListMessagesQuery,
  type ListThreadsQuery,
  type Mention,
  type Message,
  type MessageId,
  type MessagePageResponse,
  type MessageResponse,
  type Reaction,
  type ReactionResponse,
  type SendMessageRequest,
  type SendMessageResponse,
  type ThreadListResponse,
  type ThreadResponse,
  type ThreadSummary,
  type UserId,
} from "../shared/protocol.js";
import { extractMentionIds } from "../shared/validate.js";
import { memberIdsOf, requireRead, requireWrite, visibleChannelIds } from "./access.js";
import { agentFieldsFor, forgetAgentRequest, recordAgentRequest } from "./agent.js";
import { allow, firstRow, placeholders, refuse, scalar, type Ctx, type Outcome } from "./context.js";
import {
  attachmentRowsForMessage,
  attachmentsFor,
  deleteObjects,
  discardPending,
  isVerifiedImage,
  preparePending,
  promotePending,
  rollbackPromoted,
} from "./files.js";
import { newMessageId } from "./ids.js";
import { consume } from "./limits.js";
import { hashId, logEvent } from "./logs.js";
import { asMessageKind, type MessageRow, type UserRow } from "./rows.js";
import { badgeSummary, otherReadCursors, unreadReplies } from "./unread.js";
import { existingUserIds, loadUsers } from "./users.js";

/** Avatar stacks do not need more than this, and the query is cheaper for the cap. */
const MAX_THREAD_PARTICIPANTS = 8;
const LINK_PATTERN = /\bhttps?:\/\/\S/iu;

// ---------------------------------------------------------------------------
// Hydration
// ---------------------------------------------------------------------------

export function loadMessage(ctx: Ctx, messageId: MessageId): MessageRow | null {
  return firstRow<MessageRow>(ctx, `SELECT * FROM messages WHERE id = ?`, messageId);
}

/**
 * Turns rows into wire messages, with reactions, attachments and mentions fetched in one query each.
 *
 * `clientId` is carried through whenever the row has one: the sender needs it to reconcile an
 * optimistic row against either the HTTP response or the `msg` event, whichever arrives first.
 */
export function hydrateMessages(ctx: Ctx, rows: readonly MessageRow[]): readonly Message[] {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const reactions = reactionsFor(ctx, ids);
  const attachments = attachmentsFor(ctx, ids);
  const mentions = mentionsFor(ctx, ids);
  const agent = agentFieldsFor(ctx, ids);
  return rows.map((row) => ({
    id: row.id,
    channelId: row.channel_id,
    seq: row.seq,
    rootId: row.root_id,
    authorId: row.author_id,
    body: row.body,
    kind: asMessageKind(row.kind),
    createdAt: row.created_at,
    editedAt: row.edited_at,
    deletedAt: row.deleted_at,
    replyCount: row.reply_count,
    lastReplyAt: row.last_reply_at,
    reactions: reactions.get(row.id) ?? [],
    attachments: attachments.get(row.id) ?? [],
    mentions: mentions.get(row.id) ?? [],
    ...(row.client_id === null ? {} : { clientId: row.client_id }),
    ...agent.get(row.id),
  }));
}

function hydrateMessage(ctx: Ctx, row: MessageRow): Message {
  return hydrateMessages(ctx, [row])[0]!;
}

function reactionsFor(ctx: Ctx, messageIds: readonly MessageId[]): Map<MessageId, Reaction[]> {
  const byMessage = new Map<MessageId, Map<string, UserId[]>>();
  for (const row of ctx.sql
    .exec<{ message_id: string; emoji: string; user_id: string }>(
      `SELECT message_id, emoji, user_id FROM reactions
        WHERE message_id IN (${placeholders(messageIds.length)})
        ORDER BY created_at, user_id`,
      ...messageIds,
    )
    .toArray()) {
    const emojis = byMessage.get(row.message_id) ?? new Map<string, UserId[]>();
    const users = emojis.get(row.emoji) ?? [];
    users.push(row.user_id);
    emojis.set(row.emoji, users);
    byMessage.set(row.message_id, emojis);
  }
  const out = new Map<MessageId, Reaction[]>();
  for (const [messageId, emojis] of byMessage) {
    out.set(
      messageId,
      [...emojis].map(([emoji, userIds]) => ({ emoji, userIds })),
    );
  }
  return out;
}

function mentionsFor(ctx: Ctx, messageIds: readonly MessageId[]): Map<MessageId, Mention[]> {
  const out = new Map<MessageId, Mention[]>();
  for (const row of ctx.sql
    .exec<{ message_id: string; user_id: string; kind: string }>(
      `SELECT message_id, user_id, kind FROM mentions
        WHERE message_id IN (${placeholders(messageIds.length)})`,
      ...messageIds,
    )
    .toArray()) {
    const list = out.get(row.message_id) ?? [];
    list.push(
      row.kind === "channel" || row.kind === "here"
        ? { kind: row.kind }
        : { kind: row.kind === "agent" ? "agent" : "user", userId: row.user_id },
    );
    out.set(row.message_id, list);
  }
  return out;
}

/** Reactions for one message, in the shape {@link ReactionResponse} wants. */
function reactionsOf(ctx: Ctx, messageId: MessageId): readonly Reaction[] {
  return reactionsFor(ctx, [messageId]).get(messageId) ?? [];
}

// ---------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------

export function listMessages(
  ctx: Ctx,
  userId: UserId,
  channelId: ChannelId,
  query: ListMessagesQuery,
): Outcome<MessagePageResponse> {
  const access = requireRead(ctx, channelId, userId);
  if (!access.ok) return access;
  const { channel } = access.value;
  const limit = Math.min(query.limit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);

  // A thread page is the root plus its replies; a channel page is everything, threads included, which
  // is why the filter is opt-in rather than "root_id IS NULL".
  const threadFilter = query.rootId === undefined ? "" : ` AND (root_id = ? OR id = ?)`;
  const threadParams: readonly string[] = query.rootId === undefined ? [] : [query.rootId, query.rootId];

  let rows: MessageRow[];
  if (query.around !== undefined) {
    const target = loadMessage(ctx, query.around);
    if (target === null || target.channel_id !== channelId) {
      return refuse("not_found", "No such message in this channel.");
    }
    const half = Math.max(1, Math.floor(limit / 2));
    const before = ctx.sql
      .exec<MessageRow>(
        `SELECT * FROM messages WHERE channel_id = ? AND seq <= ?${threadFilter}
          ORDER BY seq DESC LIMIT ?`,
        channelId,
        target.seq,
        ...threadParams,
        half + 1,
      )
      .toArray()
      .toReversed();
    const after = ctx.sql
      .exec<MessageRow>(
        `SELECT * FROM messages WHERE channel_id = ? AND seq > ?${threadFilter}
          ORDER BY seq ASC LIMIT ?`,
        channelId,
        target.seq,
        ...threadParams,
        Math.max(0, limit - before.length),
      )
      .toArray();
    rows = [...before, ...after];
  } else if (query.after !== undefined) {
    rows = ctx.sql
      .exec<MessageRow>(
        `SELECT * FROM messages WHERE channel_id = ? AND seq > ?${threadFilter} ORDER BY seq ASC LIMIT ?`,
        channelId,
        query.after,
        ...threadParams,
        limit,
      )
      .toArray();
  } else {
    // `before` and "no cursor" are the same query: the latest page is everything below infinity.
    const before = query.before ?? Number.MAX_SAFE_INTEGER;
    rows = ctx.sql
      .exec<MessageRow>(
        `SELECT * FROM messages WHERE channel_id = ? AND seq < ?${threadFilter} ORDER BY seq DESC LIMIT ?`,
        channelId,
        before,
        ...threadParams,
        limit,
      )
      .toArray()
      .toReversed();
  }

  const first = rows[0];
  const last = rows.at(-1);
  // "Seen by" is a small-conversation feature, so the cursors ride along only where the member list
  // is bounded and the product wants them.
  const seenBy =
    channel.kind === "dm" || channel.kind === "group"
      ? otherReadCursors(ctx, channelId, userId)
      : undefined;
  return allow({
    messages: hydrateMessages(ctx, rows),
    hasMoreBefore:
      first !== undefined &&
      existsAround(ctx, channelId, threadFilter, threadParams, "<", first.seq),
    hasMoreAfter:
      last !== undefined && existsAround(ctx, channelId, threadFilter, threadParams, ">", last.seq),
    users: loadUsers(ctx, rows.map((row) => row.author_id)),
    channelLastSeq: channel.last_seq,
    ...(seenBy === undefined ? {} : { readCursors: seenBy }),
  });
}

function existsAround(
  ctx: Ctx,
  channelId: ChannelId,
  threadFilter: string,
  threadParams: readonly string[],
  comparison: "<" | ">",
  seq: number,
): boolean {
  // `comparison` is one of two literals from this module, never request data.
  return (
    ctx.sql
      .exec<{ n: number }>(
        `SELECT 1 AS n FROM messages WHERE channel_id = ? AND seq ${comparison} ?${threadFilter} LIMIT 1`,
        channelId,
        seq,
        ...threadParams,
      )
      .toArray().length > 0
  );
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

export interface SendOptions {
  /**
   * The sender's Workshop account (`ChatIdentity.workshopAccount`), which a question to the Agent is
   * asked as. Only the HTTP route sets it, from the verified identity.
   */
  readonly workshopAccount?: string | null;
  /**
   * The Agent posting an answer (src/do/agent.ts). Exempt from the message budget, which exists to
   * stop a runaway client: an answer is one per question, and the question already paid for it.
   */
  readonly agentReply?: boolean;
}

export async function sendMessage(
  ctx: Ctx,
  author: UserRow,
  channelId: ChannelId,
  request: SendMessageRequest,
  options: SendOptions = {},
): Promise<Outcome<SendMessageResponse>> {
  // The replay check comes before the rate limit and before authorization: a retry must return the
  // original message even if the client has since been throttled or has left the channel.
  const replay = firstRow<MessageRow>(
    ctx,
    `SELECT * FROM messages WHERE author_id = ? AND client_id = ?`,
    author.id,
    request.clientId,
  );
  if (replay !== null) {
    return allow({
      message: hydrateMessage(ctx, replay),
      deduped: true,
      badges: badgeSummary(ctx, author.id),
    });
  }

  if (options.agentReply !== true) {
    const limited = consume(ctx, author.id, "messages");
    if (!limited.ok) return limited;
  }

  const access = requireWrite(ctx, channelId, author.id);
  if (!access.ok) return access;

  let rootRow: MessageRow | null = null;
  if (request.rootId !== undefined) {
    rootRow = loadMessage(ctx, request.rootId);
    if (rootRow === null || rootRow.channel_id !== channelId) {
      return refuse("not_found", "No such thread in this channel.");
    }
    if (rootRow.root_id !== null) {
      return refuse("invalid_request", "Reply to the thread's root, not to a reply.");
    }
  }

  const pending = preparePending(ctx, author.id, channelId, request.attachmentIds ?? []);
  if (!pending.ok) return pending;
  const promoted = await promotePending(ctx, pending.value);
  if (!promoted.ok) return promoted;

  const mentionIds = resolveMentions(ctx, request.body);
  const now = ctx.now();
  const id = newMessageId(now);
  const hasImage = pending.value.some((row) => isVerifiedImage(row.mime));
  const hasFile = pending.value.some((row) => !isVerifiedImage(row.mime));

  let inserted: MessageRow;
  try {
    ctx.storage.transactionSync(() => {
      const seq = nextSeq(ctx, channelId);
      ctx.sql.exec(
        `INSERT INTO messages (id, channel_id, seq, root_id, author_id, body, kind, client_id,
                               created_at, has_image, has_file, has_link)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        channelId,
        seq,
        request.rootId ?? null,
        author.id,
        request.body,
        // Everything a person sends is `user`; the reserved agent account's posts are `agent`, so a
        // client can render them as the assistant rather than as another colleague.
        author.kind === "agent" ? "agent" : "user",
        request.clientId,
        now,
        hasImage ? 1 : 0,
        hasFile ? 1 : 0,
        LINK_PATTERN.test(request.body) ? 1 : 0,
      );
      for (const entry of promoted.value) {
        ctx.sql.exec(
          `UPDATE attachments SET message_id = ?, r2_key = ? WHERE id = ?`,
          id,
          entry.key,
          entry.row.id,
        );
      }
      writeMentions(ctx, id, mentionIds);
      if (rootRow !== null) {
        ctx.sql.exec(
          `UPDATE messages SET reply_count = reply_count + 1, last_reply_at = ? WHERE id = ?`,
          now,
          rootRow.id,
        );
        // You follow a thread when you start it, reply to it, or are mentioned in it.
        followThreadRow(ctx, rootRow.id, rootRow.author_id, 0, now);
        for (const mentioned of mentionIds) followThreadRow(ctx, rootRow.id, mentioned, 0, now);
        followThreadRow(ctx, rootRow.id, author.id, seq, now);
      }
      // Your own message is never unread to you, in the channel or in the thread.
      ctx.sql.exec(
        `UPDATE memberships SET last_read_seq = MAX(last_read_seq, ?) WHERE channel_id = ? AND user_id = ?`,
        seq,
        channelId,
        author.id,
      );
      inserted = loadMessage(ctx, id)!;
    });
  } catch {
    await rollbackPromoted(ctx, promoted.value);
    return refuse("internal", "The message could not be committed.");
  }
  await discardPending(ctx, promoted.value);

  // Before hydrating, so the sender's response and everyone's `msg` event already carry the
  // question's state (src/do/agent.ts). Only SQLite is written here; the Workshop is called from the
  // alarm this wakes.
  const asked =
    options.agentReply !== true &&
    recordAgentRequest(ctx, author, access.value.channel, inserted!, options.workshopAccount ?? null);

  const message = hydrateMessage(ctx, inserted!);
  ctx.bus.toChannel(channelId, { t: "msg", message });
  if (rootRow !== null) {
    const root = loadMessage(ctx, rootRow.id);
    if (root !== null) ctx.bus.toChannel(channelId, { t: "edit", message: hydrateMessage(ctx, root) });
  }
  ctx.bus.badges(memberIdsOf(ctx, channelId));

  logEvent("chat.send", {
    channel: hashId(channelId),
    user: hashId(author.id),
    bytes: request.body.length,
    thread: rootRow !== null,
    attachments: promoted.value.length,
    mentions: mentionIds.length,
  });
  if (asked) await ctx.wakeAt(now);
  return allow({ message, deduped: false, badges: badgeSummary(ctx, author.id) });
}

/** A system message ("Harry archived #old"). Same seq machinery, no client id, no rate limit. */
export function postSystemMessage(ctx: Ctx, channelId: ChannelId, body: string): Message {
  const now = ctx.now();
  const id = newMessageId(now);
  ctx.storage.transactionSync(() => {
    const seq = nextSeq(ctx, channelId);
    ctx.sql.exec(
      `INSERT INTO messages (id, channel_id, seq, author_id, body, kind, created_at)
       VALUES (?, ?, ?, ?, ?, 'system', ?)`,
      id,
      channelId,
      seq,
      AGENT_USER_ID,
      body,
      now,
    );
  });
  const message = hydrateMessage(ctx, loadMessage(ctx, id)!);
  ctx.bus.toChannel(channelId, { t: "msg", message });
  return message;
}

/**
 * Allocates the next per-channel seq.
 *
 * Must be called inside {@link Ctx.storage}'s `transactionSync`: the read and the write are two
 * statements, and only the transaction makes them one step.
 */
function nextSeq(ctx: Ctx, channelId: ChannelId): number {
  ctx.sql.exec(`UPDATE channels SET last_seq = last_seq + 1 WHERE id = ?`, channelId);
  const seq = scalar(ctx, `SELECT last_seq AS value FROM channels WHERE id = ?`, [channelId], 0);
  if (seq === 0) throw new Error(`Channel ${channelId} vanished while allocating a seq.`);
  return seq;
}

/** Mentioned ids that name a real user. A token naming nobody is left as text and stored nowhere. */
function resolveMentions(ctx: Ctx, body: string): readonly UserId[] {
  const ids = extractMentionIds(body);
  const real = existingUserIds(ctx, ids);
  return ids.filter((id) => real.has(id));
}

function writeMentions(ctx: Ctx, messageId: MessageId, userIds: readonly UserId[]): void {
  for (const userId of userIds) {
    ctx.sql.exec(
      `INSERT INTO mentions (message_id, user_id, kind) VALUES (?, ?, ?)
       ON CONFLICT (message_id, user_id, kind) DO NOTHING`,
      messageId,
      userId,
      userId === AGENT_USER_ID ? "agent" : "user",
    );
  }
}

function followThreadRow(
  ctx: Ctx,
  rootId: MessageId,
  userId: UserId,
  lastReadReplySeq: number,
  now: number,
): void {
  ctx.sql.exec(
    `INSERT INTO thread_follows (root_id, user_id, last_read_reply_seq, followed_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (root_id, user_id) DO UPDATE SET
       last_read_reply_seq = MAX(thread_follows.last_read_reply_seq, excluded.last_read_reply_seq)`,
    rootId,
    userId,
    lastReadReplySeq,
    now,
  );
}

// ---------------------------------------------------------------------------
// Edit and delete
// ---------------------------------------------------------------------------

export function editMessage(
  ctx: Ctx,
  user: UserRow,
  messageId: MessageId,
  request: EditMessageRequest,
): Outcome<MessageResponse> {
  const row = loadMessage(ctx, messageId);
  if (row === null) return refuse("not_found", "No such message.");
  const access = requireRead(ctx, row.channel_id, user.id);
  if (!access.ok) return access;
  if (access.value.channel.archived_at !== null) return refuse("forbidden", "This channel is archived.");
  // Editing is the author's alone: an admin may remove a message but not put words in somebody's
  // mouth.
  if (row.author_id !== user.id) return refuse("forbidden", "Only the author can edit a message.");
  if (row.deleted_at !== null) return refuse("conflict", "This message was deleted.");

  const mentionIds = resolveMentions(ctx, request.body);
  const now = ctx.now();
  ctx.storage.transactionSync(() => {
    // The FTS triggers pick this up: the AFTER UPDATE trigger deletes the old indexed row before
    // inserting the new one, so the message stops matching its previous text.
    ctx.sql.exec(
      `UPDATE messages SET body = ?, edited_at = ?, has_link = ? WHERE id = ?`,
      request.body,
      now,
      LINK_PATTERN.test(request.body) ? 1 : 0,
      messageId,
    );
    ctx.sql.exec(`DELETE FROM mentions WHERE message_id = ?`, messageId);
    writeMentions(ctx, messageId, mentionIds);
  });

  const message = hydrateMessage(ctx, loadMessage(ctx, messageId)!);
  ctx.bus.toChannel(row.channel_id, { t: "edit", message });
  ctx.bus.badges(memberIdsOf(ctx, row.channel_id));
  return allow({ message });
}

/**
 * Deletes a message.
 *
 * A thread root with replies becomes a tombstone -- blank body, `deletedAt` set -- because the replies
 * would otherwise lose their context. Everything else is removed outright. Either way the body leaves
 * the search index (blanking it is enough: an empty body matches nothing) and the attachments and
 * their R2 objects go.
 */
export async function deleteMessage(
  ctx: Ctx,
  user: UserRow,
  admin: boolean,
  messageId: MessageId,
): Promise<Outcome<DeleteMessageResponse>> {
  const row = loadMessage(ctx, messageId);
  if (row === null) return refuse("not_found", "No such message.");
  const access = requireRead(ctx, row.channel_id, user.id);
  if (!access.ok) return access;
  if (access.value.channel.archived_at !== null) return refuse("forbidden", "This channel is archived.");
  if (row.author_id !== user.id && !admin) {
    return refuse("forbidden", "Only the author or an admin can delete a message.");
  }

  const objects = attachmentRowsForMessage(ctx, messageId);
  const keepTombstone = row.root_id === null && row.reply_count > 0;
  const now = ctx.now();

  ctx.storage.transactionSync(() => {
    ctx.sql.exec(`DELETE FROM attachments WHERE message_id = ?`, messageId);
    ctx.sql.exec(`DELETE FROM mentions WHERE message_id = ?`, messageId);
    // A withdrawn question is not answered: an answer arriving later finds no row and is dropped.
    forgetAgentRequest(ctx, messageId);
    ctx.sql.exec(`DELETE FROM reactions WHERE message_id = ?`, messageId);
    if (keepTombstone) {
      ctx.sql.exec(
        `UPDATE messages SET body = '', deleted_at = ?, has_image = 0, has_file = 0, has_link = 0
          WHERE id = ?`,
        now,
        messageId,
      );
      return;
    }
    if (row.root_id !== null) {
      ctx.sql.exec(
        `UPDATE messages
            SET reply_count = MAX(0, reply_count - 1),
                last_reply_at = (SELECT MAX(created_at) FROM messages
                                  WHERE root_id = ? AND id <> ? AND deleted_at IS NULL)
          WHERE id = ?`,
        row.root_id,
        messageId,
        row.root_id,
      );
    }
    ctx.sql.exec(`DELETE FROM thread_follows WHERE root_id = ?`, messageId);
    ctx.sql.exec(`DELETE FROM messages WHERE id = ?`, messageId);
  });
  await deleteObjects(ctx, objects);

  const tombstoneRow = keepTombstone ? loadMessage(ctx, messageId) : null;
  const tombstone = tombstoneRow === null ? null : hydrateMessage(ctx, tombstoneRow);
  ctx.bus.toChannel(row.channel_id, {
    t: "del",
    channel: row.channel_id,
    id: messageId,
    tombstone,
  });
  if (row.root_id !== null) {
    const root = loadMessage(ctx, row.root_id);
    if (root !== null) {
      ctx.bus.toChannel(row.channel_id, { t: "edit", message: hydrateMessage(ctx, root) });
    }
  }
  ctx.bus.badges(memberIdsOf(ctx, row.channel_id));
  logEvent("chat.delete", {
    channel: hashId(row.channel_id),
    user: hashId(user.id),
    admin,
    tombstone: keepTombstone,
  });
  return allow({ id: messageId, channelId: row.channel_id, tombstone });
}

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

export function setReaction(
  ctx: Ctx,
  user: UserRow,
  messageId: MessageId,
  emoji: string,
  add: boolean,
): Outcome<ReactionResponse> {
  const row = loadMessage(ctx, messageId);
  if (row === null) return refuse("not_found", "No such message.");
  // A reaction is a write, so it needs write access -- which in a public channel joins you, the same
  // way a message does.
  const access = requireWrite(ctx, row.channel_id, user.id);
  if (!access.ok) return access;

  if (add) {
    ctx.sql.exec(
      `INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (message_id, user_id, emoji) DO NOTHING`,
      messageId,
      user.id,
      emoji,
      ctx.now(),
    );
  } else {
    ctx.sql.exec(
      `DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?`,
      messageId,
      user.id,
      emoji,
    );
  }

  const reactions = reactionsOf(ctx, messageId);
  ctx.bus.toChannel(row.channel_id, {
    t: "react",
    channel: row.channel_id,
    id: messageId,
    reactions,
  });
  return allow({ messageId, channelId: row.channel_id, reactions });
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

type FollowRow = MessageRow & { last_read_reply_seq: number };

/**
 * `GET /api/threads`.
 *
 * The cursor is an offset rendered as a decimal string. Threads are ordered by their last reply, which
 * moves as people reply, so a keyset cursor over that column would skip or repeat rows anyway; an
 * offset is honest about being a snapshot and is bounded to a few pages.
 */
export function listThreads(ctx: Ctx, user: UserRow, query: ListThreadsQuery): Outcome<ThreadListResponse> {
  const limit = Math.min(query.limit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);
  const offset = parseOffset(query.cursor);
  if (offset === null) return refuse("invalid_request", "cursor is not a valid page marker.");

  const visible = visibleChannelIds(ctx, user.id);
  if (visible.length === 0) return allow({ threads: [], users: [], cursor: null });

  const unreadOnly = query.unread === true;
  const rows = ctx.sql
    .exec<FollowRow>(
      `SELECT r.*, f.last_read_reply_seq AS last_read_reply_seq
         FROM thread_follows f
         JOIN messages r ON r.id = f.root_id
        WHERE f.user_id = ?
          AND r.channel_id IN (${placeholders(visible.length)})
          ${
            unreadOnly
              ? `AND EXISTS (SELECT 1 FROM messages rep
                              WHERE rep.root_id = f.root_id
                                AND rep.seq > f.last_read_reply_seq
                                AND rep.author_id <> f.user_id
                                AND rep.deleted_at IS NULL)`
              : ""
          }
        ORDER BY COALESCE(r.last_reply_at, r.created_at) DESC, r.id
        LIMIT ? OFFSET ?`,
      user.id,
      ...visible,
      limit + 1,
      offset,
    )
    .toArray();

  const page = rows.slice(0, limit);
  const roots = hydrateMessages(ctx, page);
  const participants = participantsFor(ctx, page.map((row) => row.id));
  const threads: ThreadSummary[] = page.map((row, index) => ({
    rootId: row.id,
    channelId: row.channel_id,
    root: roots[index]!,
    replyCount: row.reply_count,
    lastReplyAt: row.last_reply_at,
    lastReadReplySeq: row.last_read_reply_seq,
    unreadReplies: unreadReplies(ctx, row.id, user.id, row.last_read_reply_seq),
    following: true,
    participantIds: participants.get(row.id) ?? [],
  }));

  const userIds = new Set<UserId>();
  for (const thread of threads) {
    userIds.add(thread.root.authorId);
    for (const id of thread.participantIds) userIds.add(id);
  }
  return allow({
    threads,
    users: loadUsers(ctx, userIds),
    cursor: rows.length > limit ? String(offset + limit) : null,
  });
}

/** Most recent repliers first, capped. One query for the whole page. */
function participantsFor(ctx: Ctx, rootIds: readonly MessageId[]): Map<MessageId, UserId[]> {
  const out = new Map<MessageId, UserId[]>();
  if (rootIds.length === 0) return out;
  for (const row of ctx.sql
    .exec<{ root_id: string; author_id: string; s: number }>(
      `SELECT root_id, author_id, MAX(seq) AS s FROM messages
        WHERE root_id IN (${placeholders(rootIds.length)}) AND deleted_at IS NULL
        GROUP BY root_id, author_id
        ORDER BY s DESC`,
      ...rootIds,
    )
    .toArray()) {
    const list = out.get(row.root_id) ?? [];
    if (list.length < MAX_THREAD_PARTICIPANTS) list.push(row.author_id);
    out.set(row.root_id, list);
  }
  return out;
}

export function setThreadFollow(
  ctx: Ctx,
  user: UserRow,
  rootId: MessageId,
  follow: boolean,
): Outcome<ThreadResponse> {
  const root = loadMessage(ctx, rootId);
  if (root === null || root.root_id !== null) return refuse("not_found", "No such thread.");
  const access = requireRead(ctx, root.channel_id, user.id);
  if (!access.ok) return access;

  if (follow) {
    // A new follow starts from the latest reply: following a thread is not a request to be told about
    // everything already said in it.
    const latest = scalar(ctx, `SELECT MAX(seq) AS value FROM messages WHERE root_id = ?`, [rootId]);
    followThreadRow(ctx, rootId, user.id, latest, ctx.now());
  } else {
    ctx.sql.exec(`DELETE FROM thread_follows WHERE root_id = ? AND user_id = ?`, rootId, user.id);
  }

  const lastReadReplySeq = scalar(
    ctx,
    `SELECT last_read_reply_seq AS value FROM thread_follows WHERE root_id = ? AND user_id = ?`,
    [rootId, user.id],
  );

  ctx.bus.badges([user.id]);
  return allow({
    thread: {
      rootId,
      channelId: root.channel_id,
      root: hydrateMessage(ctx, root),
      replyCount: root.reply_count,
      lastReplyAt: root.last_reply_at,
      lastReadReplySeq,
      unreadReplies: follow ? unreadReplies(ctx, rootId, user.id, lastReadReplySeq) : 0,
      following: follow,
      participantIds: participantsFor(ctx, [rootId]).get(rootId) ?? [],
    },
  });
}

/** Advances a followed thread's reply cursor when the channel's read cursor moves past its replies. */
export function advanceThreadCursors(ctx: Ctx, userId: UserId, channelId: ChannelId, seq: number): void {
  ctx.sql.exec(
    `UPDATE thread_follows
        SET last_read_reply_seq = ?
      WHERE user_id = ?
        AND last_read_reply_seq < ?
        AND root_id IN (SELECT id FROM messages WHERE channel_id = ?)`,
    seq,
    userId,
    seq,
    channelId,
  );
}

/** A decimal offset cursor, or null when the client sent something that is not one. */
export function parseOffset(cursor: string | undefined): number | null {
  if (cursor === undefined || cursor.length === 0) return 0;
  const parsed = Number(cursor);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 10_000) return null;
  return parsed;
}
