// Channels and memberships: the rail, creation, settings, join, leave, archive and read cursors.
//
// Direct messages are deduplicated by their member pair through `channels.dm_key`, a sorted join of
// the member ids with a unique index on it. Without that, "message Alice" from two different places
// would create two conversations with the same two people in them.

import {
  AGENT_USER_ID,
  GENERAL_CHANNEL_ID,
  type Channel,
  type ChannelId,
  type ChannelListResponse,
  type ChannelResponse,
  type CreateChannelRequest,
  type MarkReadRequest,
  type MarkReadResponse,
  type Membership,
  type MembershipResponse,
  type UpdateChannelRequest,
  type UpdateMembershipRequest,
  type UserId,
} from "../shared/protocol.js";
import {
  joinChannelRow,
  leavable,
  loadChannel,
  loadMembership,
  memberCounts,
  memberIdsOf,
  requireRead,
} from "./access.js";
import { allow, placeholders, refuse, type Ctx, type Outcome } from "./context.js";
import { newChannelId } from "./ids.js";
import { hashId, logEvent } from "./logs.js";
import { advanceThreadCursors, channelMemberIds, postSystemMessage } from "./messages.js";
import { toChannel, toMembership, type ChannelRow, type MembershipRow, type UserRow } from "./rows.js";
import { badgeSummary } from "./unread.js";
import { escapeLike, loadUsers } from "./users.js";

/** Public channels are browsable by everyone, so a rail request returns them all. */
export function listChannels(ctx: Ctx, user: UserRow): ChannelListResponse {
  const rows = ctx.sql
    .exec<ChannelRow>(
      `SELECT c.* FROM channels c
        WHERE c.kind = 'public'
           OR EXISTS (SELECT 1 FROM memberships m WHERE m.channel_id = c.id AND m.user_id = ?)
        ORDER BY c.kind, c.name, c.created_at`,
      user.id,
    )
    .toArray();
  const ids = rows.map((row) => row.id);
  const counts = memberCounts(ctx, ids);

  const mine = new Map<ChannelId, MembershipRow>();
  for (const row of ctx.sql
    .exec<MembershipRow>(`SELECT * FROM memberships WHERE user_id = ?`, user.id)
    .toArray()) {
    mine.set(row.channel_id, row);
  }

  // Member lists only for the conversations that are named by their members, and only for a member.
  const named = rows.filter((row) => (row.kind === "dm" || row.kind === "group") && mine.has(row.id));
  const membersByChannel = new Map<ChannelId, UserId[]>();
  if (named.length > 0) {
    for (const member of ctx.sql
      .exec<{ channel_id: string; user_id: string }>(
        `SELECT channel_id, user_id FROM memberships
          WHERE channel_id IN (${placeholders(named.length)}) ORDER BY joined_at`,
        ...named.map((row) => row.id),
      )
      .toArray()) {
      const list = membersByChannel.get(member.channel_id) ?? [];
      list.push(member.user_id);
      membersByChannel.set(member.channel_id, list);
    }
  }

  const channels: Channel[] = rows.map((row) =>
    toChannel(row, counts.get(row.id) ?? 0, membersByChannel.get(row.id)),
  );
  const memberships: Membership[] = rows
    .map((row) => mine.get(row.id))
    .filter((row): row is MembershipRow => row !== undefined)
    .map(toMembership);

  const referenced = new Set<UserId>([user.id]);
  for (const list of membersByChannel.values()) for (const id of list) referenced.add(id);

  return {
    channels,
    memberships,
    users: loadUsers(ctx, referenced),
    badges: badgeSummary(ctx, user.id),
  };
}

/** One channel plus the caller's membership row, the shape every mutating route answers with. */
export function channelResponse(
  ctx: Ctx,
  channelId: ChannelId,
  userId: UserId,
  systemMessage?: ChannelResponse["systemMessage"],
): Outcome<ChannelResponse> {
  const row = loadChannel(ctx, channelId);
  if (row === null) return refuse("not_found", "No such channel.");
  const membership = loadMembership(ctx, channelId, userId);
  const memberIds =
    (row.kind === "dm" || row.kind === "group") && membership !== null
      ? memberIdsOf(ctx, channelId)
      : undefined;
  return allow({
    channel: toChannel(row, memberCounts(ctx, [channelId]).get(channelId) ?? 0, memberIds),
    membership: membership === null ? null : toMembership(membership),
    ...(systemMessage === undefined ? {} : { systemMessage }),
  });
}

export function createChannel(
  ctx: Ctx,
  user: UserRow,
  request: CreateChannelRequest,
): Outcome<ChannelResponse> {
  const now = ctx.now();
  const others = [...new Set(request.memberIds ?? [])].filter((id) => id !== user.id);

  if (others.length > 0) {
    const known = ctx.sql
      .exec<{ id: string }>(`SELECT id FROM users WHERE id IN (${placeholders(others.length)})`, ...others)
      .toArray();
    if (known.length !== others.length) {
      // Never "that address is not allowed to sign in": the directory only knows people who have
      // opened chat, and saying more would disclose Access eligibility.
      return refuse("not_found", "One of those people is not in the directory.");
    }
  }

  if (request.kind === "dm") {
    const key = dmKey([user.id, ...others]);
    const existing = ctx.sql
      .exec<ChannelRow>(`SELECT * FROM channels WHERE dm_key = ?`, key)
      .toArray()[0];
    if (existing !== undefined) {
      // Deduplicated, not an error: the caller asked for "the conversation with this person".
      joinChannelRow(ctx, existing, user.id);
      return channelResponse(ctx, existing.id, user.id);
    }
  }

  if (request.name !== undefined) {
    const clash = ctx.sql
      .exec<{ id: string }>(`SELECT id FROM channels WHERE name = ?`, request.name)
      .toArray()[0];
    if (clash !== undefined) return refuse("conflict", `#${request.name} already exists.`);
  }

  const id = newChannelId(now);
  const members = [user.id, ...others, ...(request.kind === "public" ? [AGENT_USER_ID] : [])];
  try {
    ctx.storage.transactionSync(() => {
      ctx.sql.exec(
        `INSERT INTO channels (id, kind, name, topic, purpose, created_by, created_at, dm_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        request.kind,
        request.name ?? null,
        request.topic ?? null,
        request.purpose ?? null,
        user.id,
        now,
        request.kind === "dm" ? dmKey([user.id, ...others]) : null,
      );
      for (const memberId of new Set(members)) {
        ctx.sql.exec(
          `INSERT INTO memberships (channel_id, user_id, joined_at) VALUES (?, ?, ?)
           ON CONFLICT (channel_id, user_id) DO NOTHING`,
          id,
          memberId,
          now,
        );
      }
    });
  } catch {
    // The only constraint that can fire here is one of the unique indexes, which means somebody won
    // the race for the name or the member pair.
    return refuse("conflict", "That channel already exists.");
  }

  logEvent("chat.channel.create", { kind: request.kind, user: hashId(user.id), channel: hashId(id) });
  ctx.bus.badges(members);
  return channelResponse(ctx, id, user.id);
}

/** Sorted so "me and Alice" and "Alice and me" are the same conversation. */
function dmKey(memberIds: readonly UserId[]): string {
  return [...new Set(memberIds)].toSorted().join(":");
}

export function updateChannel(
  ctx: Ctx,
  user: UserRow,
  admin: boolean,
  channelId: ChannelId,
  request: UpdateChannelRequest,
): Outcome<ChannelResponse> {
  const access = requireRead(ctx, channelId, user.id);
  if (!access.ok) return access;
  const { channel } = access.value;
  if (channel.kind === "dm" || channel.kind === "group") {
    return refuse("invalid_request", "A direct or group conversation has no name, topic or purpose.");
  }
  if (!admin && channel.created_by !== user.id) {
    return refuse("forbidden", "Only an admin or the channel's creator can change its settings.");
  }
  if (channel.archived_at !== null) return refuse("forbidden", "This channel is archived.");

  if (request.name !== undefined && request.name !== channel.name) {
    const clash = ctx.sql
      .exec<{ id: string }>(
        `SELECT id FROM channels WHERE name = ? AND id <> ?`,
        request.name,
        channelId,
      )
      .toArray()[0];
    if (clash !== undefined) return refuse("conflict", `#${request.name} already exists.`);
  }

  ctx.storage.transactionSync(() => {
    if (request.name !== undefined) ctx.sql.exec(`UPDATE channels SET name = ? WHERE id = ?`, request.name, channelId);
    if (request.topic !== undefined) ctx.sql.exec(`UPDATE channels SET topic = ? WHERE id = ?`, request.topic, channelId);
    if (request.purpose !== undefined) {
      ctx.sql.exec(`UPDATE channels SET purpose = ? WHERE id = ?`, request.purpose, channelId);
    }
  });

  // Renames go into the message stream, because a channel that changed name under you is otherwise
  // indistinguishable from a channel you have never seen (chat.md: admin actions are system messages).
  const renamed =
    request.name !== undefined && request.name !== channel.name
      ? postSystemMessage(ctx, channelId, `${user.name} renamed #${channel.name} to #${request.name}`)
      : undefined;
  return channelResponse(ctx, channelId, user.id, renamed);
}

export function joinChannel(ctx: Ctx, user: UserRow, channelId: ChannelId): Outcome<ChannelResponse> {
  // `requireRead` first, so a private channel the caller cannot see answers "no such channel"
  // instead of "you may not join that", which would confirm it exists.
  const access = requireRead(ctx, channelId, user.id);
  if (!access.ok) return access;
  const { channel } = access.value;
  if (channel.kind !== "public") {
    // A private conversation is joined by being added to it, never by asking.
    return refuse("forbidden", "Only public channels can be joined.");
  }
  if (channel.archived_at !== null) return refuse("forbidden", "This channel is archived.");
  joinChannelRow(ctx, channel, user.id);
  ctx.bus.badges([user.id]);
  return channelResponse(ctx, channelId, user.id);
}

export function leaveChannel(ctx: Ctx, user: UserRow, channelId: ChannelId): Outcome<ChannelResponse> {
  const access = requireRead(ctx, channelId, user.id);
  if (!access.ok) return access;
  const { channel } = access.value;
  if (channel.id === GENERAL_CHANNEL_ID) return refuse("forbidden", "#general cannot be left.");
  if (!leavable(channel)) return refuse("forbidden", "This conversation cannot be left.");
  if (user.id === AGENT_USER_ID) return refuse("forbidden", "The agent's memberships are implicit.");

  ctx.sql.exec(`DELETE FROM memberships WHERE channel_id = ? AND user_id = ?`, channelId, user.id);
  logEvent("chat.channel.leave", { channel: hashId(channelId), user: hashId(user.id) });
  ctx.bus.badges([user.id]);
  const response = channelResponse(ctx, channelId, user.id);
  if (!response.ok) return response;
  return allow({ ...response.value, membership: null });
}

export function archiveChannel(
  ctx: Ctx,
  user: UserRow,
  admin: boolean,
  channelId: ChannelId,
): Outcome<ChannelResponse> {
  const access = requireRead(ctx, channelId, user.id);
  if (!access.ok) return access;
  const { channel } = access.value;
  if (channel.kind === "dm" || channel.kind === "group") {
    return refuse("invalid_request", "A direct or group conversation cannot be archived.");
  }
  if (channel.id === GENERAL_CHANNEL_ID) return refuse("forbidden", "#general cannot be archived.");
  if (!admin && channel.created_by !== user.id) {
    return refuse("forbidden", "Only an admin or the channel's creator can archive it.");
  }
  if (channel.archived_at !== null) return channelResponse(ctx, channelId, user.id);

  const notice = postSystemMessage(ctx, channelId, `${user.name} archived #${channel.name}`);
  ctx.sql.exec(`UPDATE channels SET archived_at = ? WHERE id = ?`, ctx.now(), channelId);
  logEvent("chat.channel.archive", { channel: hashId(channelId), user: hashId(user.id), admin });
  ctx.bus.badges(channelMemberIds(ctx, channelId));
  return channelResponse(ctx, channelId, user.id, notice);
}

/**
 * `POST /api/channels/:id/read`: either advance the read cursor or set the manual unread marker.
 *
 * `lastReadSeq` only ever moves forward. Moving it backwards would re-notify old mentions and fight
 * another tab's acknowledgement, which is exactly why `manualUnreadSeq` exists as a separate column.
 */
export function markRead(
  ctx: Ctx,
  user: UserRow,
  channelId: ChannelId,
  request: MarkReadRequest,
): Outcome<MarkReadResponse> {
  const access = requireRead(ctx, channelId, user.id);
  if (!access.ok) return access;
  if (access.value.membership === null) {
    return refuse("forbidden", "Join the channel before marking it read.");
  }

  if (request.seq !== undefined) {
    const seq = Math.min(request.seq, access.value.channel.last_seq);
    ctx.storage.transactionSync(() => {
      ctx.sql.exec(
        `UPDATE memberships
            SET last_read_seq = MAX(last_read_seq, ?),
                manual_unread_seq = CASE WHEN manual_unread_seq IS NOT NULL AND manual_unread_seq <= ?
                                         THEN NULL ELSE manual_unread_seq END
          WHERE channel_id = ? AND user_id = ?`,
        seq,
        seq,
        channelId,
        user.id,
      );
      advanceThreadCursors(ctx, user.id, channelId, seq);
    });
    // Other tabs of the same person need to move their "New messages" line too.
    ctx.bus.toUsers([user.id], { t: "read", channel: channelId, seq });
  } else {
    ctx.sql.exec(
      `UPDATE memberships SET manual_unread_seq = ? WHERE channel_id = ? AND user_id = ?`,
      request.manualUnreadSeq ?? null,
      channelId,
      user.id,
    );
  }

  const membership = loadMembership(ctx, channelId, user.id);
  if (membership === null) return refuse("not_found", "No such channel.");
  const badges = badgeSummary(ctx, user.id);
  ctx.bus.toUsers([user.id], { t: "badge", ...badges });
  return allow({ membership: toMembership(membership), badges });
}

/**
 * `PATCH /api/channels/:channelId/membership`: mute, notify level and star.
 *
 * These live on the caller's own `memberships` row, so they need membership -- browsing a public
 * channel you have not joined gives you nothing to set them on. A channel the caller cannot see
 * answers "no such channel", the same rule as everywhere else.
 */
export function updateMembership(
  ctx: Ctx,
  user: UserRow,
  channelId: ChannelId,
  patch: UpdateMembershipRequest,
): Outcome<MembershipResponse> {
  const access = requireRead(ctx, channelId, user.id);
  if (!access.ok) return access;
  if (access.value.membership === null) {
    return refuse("forbidden", "Join the channel before setting its preferences.");
  }

  ctx.storage.transactionSync(() => {
    if (patch.notify !== undefined) {
      ctx.sql.exec(
        `UPDATE memberships SET notify = ? WHERE channel_id = ? AND user_id = ?`,
        patch.notify,
        channelId,
        user.id,
      );
    }
    if (patch.muted !== undefined) {
      ctx.sql.exec(
        `UPDATE memberships SET muted = ? WHERE channel_id = ? AND user_id = ?`,
        patch.muted ? 1 : 0,
        channelId,
        user.id,
      );
    }
    if (patch.starred !== undefined) {
      ctx.sql.exec(
        `UPDATE memberships SET starred = ? WHERE channel_id = ? AND user_id = ?`,
        patch.starred ? 1 : 0,
        channelId,
        user.id,
      );
    }
  });

  const membership = loadMembership(ctx, channelId, user.id);
  if (membership === null) return refuse("not_found", "No such channel.");
  // Muting changes what the rail shows, so every tab of this person needs the new counts.
  const badges = badgeSummary(ctx, user.id);
  ctx.bus.toUsers([user.id], { t: "badge", ...badges });
  return allow({ membership: toMembership(membership), badges });
}

/** Channel-name matches for the search page's top section, restricted to what the caller may see. */
export function matchChannels(ctx: Ctx, userId: UserId, text: string, limit: number): readonly Channel[] {
  if (text.length === 0) return [];
  const like = `%${escapeLike(text.toLowerCase())}%`;
  const rows = ctx.sql
    .exec<ChannelRow>(
      `SELECT c.* FROM channels c
        WHERE lower(c.name) LIKE ? ESCAPE '\\'
          AND (c.kind = 'public'
               OR EXISTS (SELECT 1 FROM memberships m WHERE m.channel_id = c.id AND m.user_id = ?))
        ORDER BY c.name LIMIT ?`,
      like,
      userId,
      limit,
    )
    .toArray();
  const counts = memberCounts(ctx, rows.map((row) => row.id));
  return rows.map((row) => toChannel(row, counts.get(row.id) ?? 0));
}
