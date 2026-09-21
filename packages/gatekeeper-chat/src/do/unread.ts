// Unread and mention arithmetic.
//
// The whole badge summary is three queries, none of which touches a message twice: the plan's warning
// against a per-message walk is what forces the `GROUP BY channel_id` shape here.
//
// The effective read cursor is `min(last_read_seq, manual_unread_seq - 1)`. "Mark unread from here"
// stores the seq of the first message that should count as unread again; it never moves
// `last_read_seq` backwards, because that cursor is also what another tab's read acknowledgement
// writes and what decides whether an old mention notifies again.

import type { BadgeSummary, ChannelId, ReadCursor, UserId } from "../shared/protocol.js";
import { scalar, type Ctx } from "./context.js";
import type { CountRow } from "./rows.js";

/**
 * SQL for the effective cursor, given a `memberships` alias.
 *
 * `MIN(a, b)` here is SQLite's two-argument scalar minimum, not the aggregate.
 */
const EFFECTIVE_READ_SEQ = `MIN(mb.last_read_seq, COALESCE(mb.manual_unread_seq - 1, mb.last_read_seq))`;

/**
 * Everything the rail badges and the document title need.
 *
 * Muted conversations are excluded, per "muted conversations never badge". A message the caller wrote
 * is never unread to them, and a tombstone is not either.
 */
export function badgeSummary(ctx: Ctx, userId: UserId): BadgeSummary {
  const unread: Record<ChannelId, number> = {};
  for (const row of ctx.sql
    .exec<CountRow>(
      `SELECT m.channel_id AS channel_id, COUNT(*) AS n
         FROM memberships mb
         JOIN messages m ON m.channel_id = mb.channel_id
        WHERE mb.user_id = ?
          AND mb.muted = 0
          AND m.author_id <> ?
          AND m.deleted_at IS NULL
          AND m.seq > ${EFFECTIVE_READ_SEQ}
        GROUP BY m.channel_id`,
      userId,
      userId,
    )
    .toArray()) {
    unread[row.channel_id] = row.n;
  }

  const mentions: Record<ChannelId, number> = {};
  for (const row of ctx.sql
    .exec<CountRow>(
      // No filter on `mentions.kind`: a human's rows are all kind 'user', and the agent's own row is
      // kind 'agent', so matching on user_id alone counts each account's real mentions and keeps an
      // @agent mention out of every human's badge.
      `SELECT m.channel_id AS channel_id, COUNT(*) AS n
         FROM mentions x
         JOIN messages m ON m.id = x.message_id
         JOIN memberships mb ON mb.channel_id = m.channel_id AND mb.user_id = x.user_id
        WHERE x.user_id = ?
          AND mb.muted = 0
          AND m.author_id <> ?
          AND m.deleted_at IS NULL
          AND m.seq > ${EFFECTIVE_READ_SEQ}
        GROUP BY m.channel_id`,
      userId,
      userId,
    )
    .toArray()) {
    mentions[row.channel_id] = row.n;
  }

  // A followed thread only badges while its channel is still one the follower may see and has not
  // muted: the same two rules the per-channel counts above obey. Without them a thread in a channel
  // somebody was removed from badges forever -- `GET /api/threads` filters by visibility, so there
  // would be nothing in the view to clear it with.
  const threads = scalar(
    ctx,
    `SELECT COUNT(*) AS value
           FROM thread_follows f
           JOIN messages r ON r.id = f.root_id
           JOIN channels c ON c.id = r.channel_id
           LEFT JOIN memberships mb ON mb.channel_id = r.channel_id AND mb.user_id = f.user_id
          WHERE f.user_id = ?
            AND (c.kind = 'public' OR mb.user_id IS NOT NULL)
            AND COALESCE(mb.muted, 0) = 0
            AND EXISTS (
              SELECT 1 FROM messages rep
               WHERE rep.root_id = f.root_id
                 AND rep.seq > f.last_read_reply_seq
                 AND rep.author_id <> f.user_id
                 AND rep.deleted_at IS NULL
            )`,
    [userId],
  );

  return { unread, mentions, threads };
}

/** Unread replies for one thread, for a {@link import("../shared/protocol.js").ThreadSummary}. */
export function unreadReplies(ctx: Ctx, rootId: string, userId: UserId, lastReadReplySeq: number): number {
  return scalar(
    ctx,
    `SELECT COUNT(*) AS value FROM messages
      WHERE root_id = ? AND seq > ? AND author_id <> ? AND deleted_at IS NULL`,
    [rootId, lastReadReplySeq, userId],
  );
}

/**
 * The other members' read cursors, for the "seen by" line.
 *
 * Only ever called for a `dm` or a `group`, where the member list is small and the caller is already
 * known to be a member. `manual_unread_seq` is deliberately ignored: "I marked this unread again" is
 * a private note to yourself, not something to tell the room.
 */
export function otherReadCursors(ctx: Ctx, channelId: ChannelId, selfId: UserId): readonly ReadCursor[] {
  return ctx.sql
    .exec<{ user_id: string; last_read_seq: number }>(
      `SELECT user_id, last_read_seq FROM memberships
        WHERE channel_id = ? AND user_id <> ? ORDER BY user_id`,
      channelId,
      selfId,
    )
    .toArray()
    .map((row) => ({ userId: row.user_id, lastReadSeq: row.last_read_seq }));
}
