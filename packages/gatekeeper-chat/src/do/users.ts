// Identity and the directory.
//
// "Signing in through Access is membership. Nobody is invited, approved or asked for a name"
// (chat.md, "People and identity"): the upsert below is the whole account model. A person appears in
// the directory the first time any request of theirs reaches the object -- opening chat, or the
// platform shell's once-per-session `POST /api/me/seen` -- which is also why the directory never
// answers questions about addresses that have not appeared: doing so would disclose who is allowed to
// sign in.
//
// Who may *see* whom in the directory is decided in exactly one place, {@link directoryFilter}. Today
// every signed-in person is a trusted colleague and sees everybody; guests or people with more
// limited access are expected later, and hiding them (or hiding the directory from them) is a change
// to that one function rather than to each listing.

import { isAdminEmail } from "../env.js";
import {
  AGENT_USER_ID,
  DEFAULT_PAGE_LIMIT,
  GENERAL_CHANNEL_ID,
  MAX_PAGE_LIMIT,
  type ChatIdentity,
  type UpdateMeRequest,
  type User,
  type UserId,
} from "../shared/protocol.js";
import { joinChannelRow, loadChannel } from "./access.js";
import { firstRow, placeholders, updateRow, type Ctx } from "./context.js";
import { toUser, type UserRow } from "./rows.js";

/**
 * Records the caller on first sight and refreshes `last_seen_at`.
 *
 * The stored `name` never overwrites a profile override, and it falls back to the email local part
 * because whether the Access identity endpoint yields a useful name is still an open question
 * (chat.md phase 0, item 4). The reserved agent row is left alone: it has no email and its name is
 * fixed, so a caller presenting the agent identity only bumps the timestamp.
 */
export function touchUser(ctx: Ctx, identity: ChatIdentity): UserRow {
  const now = ctx.now();
  if (identity.id === AGENT_USER_ID) {
    // The seeded agent row has no address. The vendor presents a synthetic one, which is recorded
    // once so the directory entry is complete; its name and kind stay fixed.
    ctx.sql.exec(
      `UPDATE users SET last_seen_at = ?, email = COALESCE(email, ?) WHERE id = ?`,
      now,
      identity.email.toLowerCase(),
      AGENT_USER_ID,
    );
  } else {
    const fallbackName = identity.name?.trim() || identity.email.split("@")[0] || identity.id;
    ctx.sql.exec(
      `INSERT INTO users (id, name, email, first_seen_at, last_seen_at, kind)
       VALUES (?, ?, ?, ?, ?, 'person')
       ON CONFLICT (id) DO UPDATE SET
         last_seen_at = excluded.last_seen_at,
         email        = excluded.email,
         name         = COALESCE(users.display_name, excluded.name)`,
      identity.id,
      fallbackName,
      identity.email.toLowerCase(),
      now,
      now,
    );
  }
  joinGeneral(ctx, identity.id);
  const row = loadUserRow(ctx, identity.id);
  if (row === null) throw new Error("The user row vanished immediately after being written.");
  return row;
}

/**
 * Everybody is in `#general`.
 *
 * "`#general` exists on first boot and cannot be left" (chat.md, "Channels and conversations") only
 * makes sense if you are in it to begin with: the read cursor lives in the membership row, so without
 * one a brand-new person opens chat to an empty rail and a "You are not in #general / Join" card for
 * the channel they are not allowed to leave. The row is inserted at the channel's current high-water
 * mark, so history is not unread, and the insert is idempotent -- it cannot resurrect a membership
 * somebody dropped, because this is the one channel nobody can drop.
 */
function joinGeneral(ctx: Ctx, userId: UserId): void {
  const general = loadChannel(ctx, GENERAL_CHANNEL_ID);
  if (general === null) return;
  joinChannelRow(ctx, general, userId);
}

export function loadUserRow(ctx: Ctx, userId: UserId): UserRow | null {
  return firstRow<UserRow>(ctx, `SELECT * FROM users WHERE id = ?`, userId);
}

/** Hydrates a set of ids in one query, skipping ids that are not real users. */
export function loadUsers(ctx: Ctx, userIds: Iterable<UserId>): readonly User[] {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return [];
  return ctx.sql
    .exec<UserRow>(`SELECT * FROM users WHERE id IN (${placeholders(ids.length)})`, ...ids)
    .toArray()
    .map((row) => toUser(row, ctx.bus.isOnline(row.id)));
}

/**
 * The subset of `userIds` that name a real user.
 *
 * Every write that takes ids from a client goes through this: a mention token can name anybody, and
 * so can the member list of a new conversation.
 */
export function existingUserIds(ctx: Ctx, userIds: readonly UserId[]): Set<UserId> {
  if (userIds.length === 0) return new Set();
  return new Set(
    ctx.sql
      .exec<{ id: string }>(`SELECT id FROM users WHERE id IN (${placeholders(userIds.length)})`, ...userIds)
      .toArray()
      .map((row) => row.id),
  );
}

/**
 * THE directory rule, as a SQL predicate over a `users` row aliased `u`, for one viewer.
 *
 * Every listing, lookup and "may I start a conversation with them" check goes through it, so the
 * directory can be narrowed later -- guests seeing only the people they share a channel with, or
 * being hidden from everyone else -- by changing this function alone. Today it admits every row:
 * everyone who can sign in is one of the deployment owner's colleagues, and the built-in Agent is
 * listed so it can be messaged.
 */
export function directoryFilter(viewer: Pick<UserRow, "id" | "kind">): {
  readonly sql: string;
  readonly params: readonly unknown[];
} {
  void viewer;
  return { sql: "u.kind IN ('person', 'agent')", params: [] };
}

/** {@link directoryFilter} for one row: may `viewer` see `userId` in the directory? */
export function visibleInDirectory(ctx: Ctx, viewer: UserRow, userId: UserId): boolean {
  return visibleUserIds(ctx, viewer, [userId]).has(userId);
}

/** The subset of `userIds` that `viewer` may see in the directory. */
export function visibleUserIds(ctx: Ctx, viewer: UserRow, userIds: readonly UserId[]): Set<UserId> {
  if (userIds.length === 0) return new Set();
  const filter = directoryFilter(viewer);
  return new Set(
    ctx.sql
      .exec<{ id: string }>(
        `SELECT u.id AS id FROM users u WHERE u.id IN (${placeholders(userIds.length)}) AND ${filter.sql}`,
        ...userIds,
        ...filter.params,
      )
      .toArray()
      .map((row) => row.id),
  );
}

export function isAdmin(ctx: Ctx, user: UserRow): boolean {
  return isAdminEmail(ctx.env, user.email);
}

/** `PATCH /api/me`. A cleared `displayName` falls back to the identity-derived name. */
export function updatePrefs(ctx: Ctx, user: UserRow, patch: UpdateMeRequest): UserRow {
  const override =
    patch.displayName === undefined || patch.displayName === null || patch.displayName.length === 0
      ? null
      : patch.displayName;
  updateRow(ctx, "users", "id = ?", [user.id], {
    // The resolved `name` follows the override, falling back to the identity-derived local part.
    ...(patch.displayName === undefined
      ? {}
      : { display_name: override, name: override ?? user.email?.split("@")[0] ?? user.id }),
    tz: patch.tz,
    notify: patch.notify,
  });
  const row = loadUserRow(ctx, user.id);
  if (row === null) throw new Error("The user row vanished during a preferences update.");
  return row;
}

export interface UserPage {
  readonly users: readonly User[];
  readonly cursor: string | null;
}

/**
 * `GET /api/users`. Everyone who has appeared and {@link directoryFilter} lets the viewer see,
 * ordered by id.
 *
 * The cursor is the last id of the previous page, which makes it a keyset with no offset to drift as
 * people appear. A user id is an Access subject, so the order is lexicographic rather than temporal;
 * what matters is only that it is total and stable. An empty cursor sorts before every id, so the
 * first page needs no second query.
 */
export function listUsers(
  ctx: Ctx,
  viewer: UserRow,
  cursor: string | null,
  limit: number = DEFAULT_PAGE_LIMIT,
): UserPage {
  const size = Math.min(Math.max(limit, 1), MAX_PAGE_LIMIT);
  const filter = directoryFilter(viewer);
  const rows = ctx.sql
    .exec<UserRow>(
      `SELECT u.* FROM users u WHERE u.id > ? AND ${filter.sql} ORDER BY u.id LIMIT ?`,
      cursor ?? "",
      ...filter.params,
      size + 1,
    )
    .toArray();
  const page = rows.slice(0, size);
  return {
    users: page.map((row) => toUser(row, ctx.bus.isOnline(row.id))),
    cursor: rows.length > size ? (page.at(-1)?.id ?? null) : null,
  };
}

/** Searches the directory by display name or email local part, for the search page's top section. */
export function matchUsers(ctx: Ctx, viewer: UserRow, text: string, limit: number): readonly User[] {
  if (text.length === 0) return [];
  const like = `%${escapeLike(text.toLowerCase())}%`;
  const filter = directoryFilter(viewer);
  const rows = ctx.sql
    .exec<UserRow>(
      `SELECT u.* FROM users u
       WHERE (lower(u.name) LIKE ? ESCAPE '\\' OR lower(u.email) LIKE ? ESCAPE '\\') AND ${filter.sql}
       ORDER BY u.name LIMIT ?`,
      like,
      like,
      ...filter.params,
      limit,
    )
    .toArray();
  return rows.map((row) => toUser(row, ctx.bus.isOnline(row.id)));
}

/** Makes user text safe inside a `LIKE ... ESCAPE '\\'` pattern. */
export function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}
