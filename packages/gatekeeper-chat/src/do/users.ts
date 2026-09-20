// Identity and the directory.
//
// "Signing in through Access is membership. Nobody is invited, approved or asked for a name"
// (chat.md, "People and identity"): the upsert below is the whole account model. A person appears in
// the directory the first time they open chat, which is also why the directory never answers
// questions about addresses that have not appeared -- doing so would disclose who is allowed to sign
// in.

import { isAdminEmail } from "../env.js";
import {
  AGENT_USER_ID,
  MAX_PAGE_LIMIT,
  type ChatIdentity,
  type UpdateMeRequest,
  type User,
  type UserId,
} from "../shared/protocol.js";
import { placeholders, type Ctx } from "./context.js";
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
  const row = loadUserRow(ctx, identity.id);
  if (row === null) throw new Error("The user row vanished immediately after being written.");
  return row;
}

export function loadUserRow(ctx: Ctx, userId: UserId): UserRow | null {
  return ctx.sql.exec<UserRow>(`SELECT * FROM users WHERE id = ?`, userId).toArray()[0] ?? null;
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

/** The subset of `userIds` that name a real user. Used before a mention row is written. */
export function existingUserIds(ctx: Ctx, userIds: readonly UserId[]): Set<UserId> {
  if (userIds.length === 0) return new Set();
  const rows = ctx.sql
    .exec<{ id: string }>(
      `SELECT id FROM users WHERE id IN (${placeholders(userIds.length)})`,
      ...userIds,
    )
    .toArray();
  return new Set(rows.map((row) => row.id));
}

export function isAdmin(ctx: Ctx, user: UserRow): boolean {
  return isAdminEmail(ctx.env, user.email);
}

/** `PATCH /api/me`. A cleared `displayName` falls back to the identity-derived name. */
export function updatePrefs(ctx: Ctx, user: UserRow, patch: UpdateMeRequest): UserRow {
  const fallback = user.email?.split("@")[0] || user.id;
  if (patch.displayName !== undefined) {
    const override = patch.displayName === null || patch.displayName.length === 0 ? null : patch.displayName;
    ctx.sql.exec(
      `UPDATE users SET display_name = ?, name = COALESCE(?, ?) WHERE id = ?`,
      override,
      override,
      fallback,
      user.id,
    );
  }
  if (patch.tz !== undefined) {
    ctx.sql.exec(`UPDATE users SET tz = ? WHERE id = ?`, patch.tz, user.id);
  }
  if (patch.notify !== undefined) {
    ctx.sql.exec(`UPDATE users SET notify = ? WHERE id = ?`, patch.notify, user.id);
  }
  const row = loadUserRow(ctx, user.id);
  if (row === null) throw new Error("The user row vanished during a preferences update.");
  return row;
}

export interface UserPage {
  readonly users: readonly User[];
  readonly cursor: string | null;
}

/**
 * `GET /api/users`. Everyone who has appeared, newest first sight last, paged by id.
 *
 * The cursor is the last id of the previous page: ids are time-ordered, so `id > cursor` is a stable
 * keyset with no offset to drift.
 */
export function listUsers(ctx: Ctx, cursor: string | null, limit: number): UserPage {
  const size = Math.min(Math.max(limit, 1), MAX_PAGE_LIMIT);
  const rows =
    cursor === null
      ? ctx.sql.exec<UserRow>(`SELECT * FROM users ORDER BY id LIMIT ?`, size + 1).toArray()
      : ctx.sql
          .exec<UserRow>(`SELECT * FROM users WHERE id > ? ORDER BY id LIMIT ?`, cursor, size + 1)
          .toArray();
  const page = rows.slice(0, size);
  return {
    users: page.map((row) => toUser(row, ctx.bus.isOnline(row.id))),
    cursor: rows.length > size ? (page.at(-1)?.id ?? null) : null,
  };
}

/** Searches the directory by display name or email local part, for the search page's top section. */
export function matchUsers(ctx: Ctx, text: string, limit: number): readonly User[] {
  if (text.length === 0) return [];
  const like = `%${escapeLike(text.toLowerCase())}%`;
  const rows = ctx.sql
    .exec<UserRow>(
      `SELECT * FROM users
       WHERE lower(name) LIKE ? ESCAPE '\\' OR lower(email) LIKE ? ESCAPE '\\'
       ORDER BY name LIMIT ?`,
      like,
      like,
      limit,
    )
    .toArray();
  return rows.map((row) => toUser(row, ctx.bus.isOnline(row.id)));
}

/** Makes user text safe inside a `LIKE ... ESCAPE '\\'` pattern. */
export function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}
