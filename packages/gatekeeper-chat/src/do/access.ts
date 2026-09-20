// Who may see and write what.
//
// Every read, write, search hit, file download and socket command goes through one of the functions
// here, so there is exactly one definition of "member" in the Worker (chat.md, "Security
// checklist"). The rules:
//
//   * public    -- anyone signed in may read and browse; writing joins you, because a read cursor
//                  needs a membership row to live in.
//   * private   -- members only, for reads and writes alike.
//   * dm, group -- members only. There is no "browse".
//   * archived  -- readable, never writable.
//
// The agent is not special-cased: `seedBuiltins` and `createChannel` give it a real membership row in
// every public channel, so these queries treat it like anybody else.

import { GENERAL_CHANNEL_ID, type ChannelId, type UserId } from "../shared/protocol.js";
import { allow, placeholders, refuse, type Ctx, type Outcome } from "./context.js";
import { hashId, logDenial } from "./logs.js";
import type { ChannelRow, CountRow, MembershipRow } from "./rows.js";

export interface ChannelAccess {
  readonly channel: ChannelRow;
  /** Null when the caller is browsing a public channel they have not joined. */
  readonly membership: MembershipRow | null;
}

export function loadChannel(ctx: Ctx, channelId: ChannelId): ChannelRow | null {
  return ctx.sql.exec<ChannelRow>(`SELECT * FROM channels WHERE id = ?`, channelId).toArray()[0] ?? null;
}

export function loadMembership(ctx: Ctx, channelId: ChannelId, userId: UserId): MembershipRow | null {
  return (
    ctx.sql
      .exec<MembershipRow>(
        `SELECT * FROM memberships WHERE channel_id = ? AND user_id = ?`,
        channelId,
        userId,
      )
      .toArray()[0] ?? null
  );
}

/** Reading a channel: public is open, everything else needs a membership row. */
export function requireRead(ctx: Ctx, channelId: ChannelId, userId: UserId): Outcome<ChannelAccess> {
  const channel = loadChannel(ctx, channelId);
  // "Not found" rather than "forbidden" for a private channel, so probing ids cannot enumerate them.
  if (channel === null) return refuse("not_found", "No such channel.");
  const membership = loadMembership(ctx, channelId, userId);
  if (channel.kind !== "public" && membership === null) {
    logDenial("channel_read", { channel: hashId(channelId), user: hashId(userId) });
    return refuse("not_found", "No such channel.");
  }
  return allow({ channel, membership });
}

/**
 * Writing to a channel.
 *
 * A public channel the caller has not joined joins them first: the alternative is a 403 on the
 * first message of a channel you are already reading, and the membership row is what holds the read
 * cursor the send is about to advance.
 */
export function requireWrite(ctx: Ctx, channelId: ChannelId, userId: UserId): Outcome<ChannelAccess> {
  const read = requireRead(ctx, channelId, userId);
  if (!read.ok) return read;
  const { channel } = read.value;
  if (channel.archived_at !== null) {
    logDenial("channel_archived", { channel: hashId(channelId), user: hashId(userId) });
    return refuse("forbidden", "This channel is archived.");
  }
  if (read.value.membership !== null) return read;
  if (channel.kind !== "public") {
    logDenial("channel_write", { channel: hashId(channelId), user: hashId(userId) });
    return refuse("forbidden", "You are not a member of this channel.");
  }
  joinChannelRow(ctx, channel, userId);
  return allow({ channel, membership: loadMembership(ctx, channelId, userId) });
}

/** Inserts a membership row at the channel's current high-water mark, so history is not "unread". */
export function joinChannelRow(ctx: Ctx, channel: ChannelRow, userId: UserId): void {
  ctx.sql.exec(
    `INSERT INTO memberships (channel_id, user_id, joined_at, last_read_seq)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (channel_id, user_id) DO NOTHING`,
    channel.id,
    userId,
    ctx.now(),
    channel.last_seq,
  );
}

/** Channel ids the caller may search and browse: every public channel plus their own memberships. */
export function visibleChannelIds(ctx: Ctx, userId: UserId): readonly ChannelId[] {
  return ctx.sql
    .exec<{ id: string }>(
      `SELECT c.id FROM channels c
       WHERE c.kind = 'public'
          OR EXISTS (SELECT 1 FROM memberships m WHERE m.channel_id = c.id AND m.user_id = ?)`,
      userId,
    )
    .toArray()
    .map((row) => row.id);
}

/** Member ids of one channel. */
export function memberIdsOf(ctx: Ctx, channelId: ChannelId): readonly UserId[] {
  return ctx.sql
    .exec<{ user_id: string }>(
      `SELECT user_id FROM memberships WHERE channel_id = ? ORDER BY joined_at`,
      channelId,
    )
    .toArray()
    .map((row) => row.user_id);
}

/** Member counts for several channels in one query. */
export function memberCounts(ctx: Ctx, channelIds: readonly ChannelId[]): Map<ChannelId, number> {
  const counts = new Map<ChannelId, number>();
  if (channelIds.length === 0) return counts;
  for (const row of ctx.sql
    .exec<CountRow>(
      `SELECT channel_id, COUNT(*) AS n FROM memberships
       WHERE channel_id IN (${placeholders(channelIds.length)}) GROUP BY channel_id`,
      ...channelIds,
    )
    .toArray()) {
    counts.set(row.channel_id, row.n);
  }
  return counts;
}

export interface Recipients {
  /**
   * True for a public channel: every connected user may see it, including somebody browsing without
   * having joined, so fan-out is not restricted to the membership list.
   */
  readonly everyone: boolean;
  readonly userIds: readonly UserId[];
}

/** Who a channel event may reach, derived from membership now rather than from a cached list. */
export function recipientsOf(ctx: Ctx, channelId: ChannelId): Recipients {
  const channel = loadChannel(ctx, channelId);
  const userIds = memberIdsOf(ctx, channelId);
  return { everyone: channel?.kind === "public", userIds };
}

/** `#general` cannot be left, and the agent's implicit memberships cannot be dropped. */
export function leavable(channel: ChannelRow): boolean {
  return channel.id !== GENERAL_CHANNEL_ID && channel.kind !== "dm";
}
