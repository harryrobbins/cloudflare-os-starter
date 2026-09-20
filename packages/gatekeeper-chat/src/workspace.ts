// `ChatWorkspace`: the one SQLite-backed Durable Object, reached as `idFromName("main")`.
//
// Stream 0 scope: the migration runner plus `GET /api/me`, so the identity path is end-to-end
// testable. Every other route answers `not_implemented` by name rather than 404, so a client built
// against the contract can tell "not yet" from "wrong URL". Streams A and B fill it in.

import { DurableObject } from "cloudflare:workers";

import { adminEmails, maxUploadBytes, type ChatEnv } from "./env.js";
import { errorResponse, json, unauthenticated } from "./http.js";
import { runMigrations } from "./migrations.js";
import {
  IDENTITY_HEADER,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_BODY_BYTES,
  PROTOCOL_VERSION,
  type BadgeSummary,
  type ChatIdentity,
  type MeResponse,
  type NotifyLevel,
  type User,
  type UserPrefs,
} from "./shared/protocol.js";
import { API_ROUTES, matchApiRoute, WS_PATH } from "./shared/routes.js";
import { isRecord } from "./shared/validate.js";

// A type alias rather than an interface on purpose: `sql.exec<T>()` constrains T to
// `Record<string, SqlStorageValue>`, and only an alias gets the implicit index signature that
// satisfies it.
type UserRow = {
  id: string;
  name: string;
  display_name: string | null;
  email: string | null;
  avatar_key: string | null;
  first_seen_at: number;
  last_seen_at: number;
  tz: string | null;
  notify: string;
};

const EMPTY_BADGES: BadgeSummary = { unread: {}, mentions: {}, threads: 0 };

export class ChatWorkspace extends DurableObject<ChatEnv> {
  constructor(ctx: DurableObjectState, env: ChatEnv) {
    super(ctx, env);
    // Synchronous and inside the constructor: every later handler may assume the schema exists, and
    // SQLite access in a DO is synchronous, so no gate is needed to order it before the first fetch.
    runMigrations(ctx.storage);
  }

  override async fetch(request: Request): Promise<Response> {
    const identity = readIdentity(request);
    if (identity === null) {
      // Only this deployment's Worker can reach the object, and it always sets the header. Reaching
      // here means a wiring mistake, not a user error.
      return unauthenticated("The workspace was reached without a verified identity.");
    }

    const url = new URL(request.url);
    const user = this.touchUser(identity);

    if (url.pathname === WS_PATH) {
      return errorResponse("not_implemented", "The chat WebSocket is not implemented yet.");
    }

    const match = matchApiRoute(request.method, url.pathname);
    if (match === null) {
      return errorResponse("not_found", `No API route for ${request.method} ${url.pathname}.`);
    }
    if ("methodMismatch" in match) {
      return errorResponse("invalid_request", `Allowed methods: ${match.methodMismatch.join(", ")}`);
    }

    if (match.name === "me" satisfies keyof typeof API_ROUTES) {
      return json(this.me(user));
    }

    return errorResponse("not_implemented", `${match.name} is not implemented yet.`);
  }

  /** Test seam: the schema version actually recorded in this object's database. */
  schemaVersion(): number {
    return (
      this.ctx.storage.sql
        .exec<{ value: number }>(`SELECT value FROM schema_meta WHERE key = 'schema_version'`)
        .toArray()[0]?.value ?? 0
    );
  }

  private me(user: UserRow): MeResponse {
    const email = user.email ?? "";
    return {
      user: this.toUser(user),
      prefs: toPrefs(user),
      admin: email.length > 0 && adminEmails(this.env).includes(email),
      badges: EMPTY_BADGES,
      limits: {
        maxBodyBytes: MAX_BODY_BYTES,
        maxUploadBytes: maxUploadBytes(this.env),
        maxAttachmentsPerMessage: MAX_ATTACHMENTS_PER_MESSAGE,
      },
      protocolVersion: PROTOCOL_VERSION,
    };
  }

  /**
   * Records the caller in the directory on first sight and refreshes `last_seen_at`.
   *
   * "A person appears in the directory the first time they open chat" (chat.md): there is no invite
   * or approval step, so this upsert is the whole membership model for the deployment. The stored
   * name never overwrites a profile override, and it falls back to the email local part because
   * whether the Access identity endpoint yields a useful name is still an open question.
   */
  private touchUser(identity: ChatIdentity): UserRow {
    const now = Date.now();
    const fallbackName = identity.name?.trim() || identity.email.split("@")[0] || identity.id;
    this.ctx.storage.sql.exec(
      `INSERT INTO users (id, name, email, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         last_seen_at = excluded.last_seen_at,
         email        = excluded.email,
         name         = COALESCE(users.display_name, excluded.name)`,
      identity.id,
      fallbackName,
      identity.email,
      now,
      now,
    );
    const row = this.ctx.storage.sql
      .exec<UserRow>(`SELECT * FROM users WHERE id = ?`, identity.id)
      .toArray()[0];
    if (row === undefined) throw new Error("The user row vanished immediately after being written.");
    return row;
  }

  private toUser(row: UserRow): User {
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      avatarKey: row.avatar_key,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      tz: row.tz,
      // Presence is derived from live sockets, not stored: a close event alone is not enough to know
      // somebody left, so there is nothing durable worth writing.
      online: this.ctx.getWebSockets(row.id).length > 0,
    };
  }
}

function toPrefs(row: UserRow): UserPrefs {
  return {
    displayName: row.display_name,
    tz: row.tz,
    notify: isNotifyLevel(row.notify) ? row.notify : "all",
  };
}

function isNotifyLevel(value: string): value is NotifyLevel {
  return value === "all" || value === "mentions" || value === "none";
}

/** Reads and narrows the identity header the Worker set. */
export function readIdentity(request: Request): ChatIdentity | null {
  const raw = request.headers.get(IDENTITY_HEADER);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const { id, email, name } = parsed;
  if (typeof id !== "string" || id.length === 0) return null;
  if (typeof email !== "string" || email.length === 0) return null;
  return { id, email, ...(typeof name === "string" && name.length > 0 ? { name } : {}) };
}
