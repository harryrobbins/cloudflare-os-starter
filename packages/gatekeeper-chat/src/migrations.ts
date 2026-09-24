// Numbered, append-only schema migrations for `ChatWorkspace`.
//
// Rules the operational section of chat.md fixes, and the reason each one matters:
//   * Append only. An existing entry is never edited, because a deployed DO has already recorded its
//     version and will not re-run it.
//   * Idempotent statements (`IF NOT EXISTS`), so a migration interrupted between two statements
//     re-runs cleanly.
//   * The applied version is recorded in `schema_meta`, not inferred from the tables present.
//
// Version 1 is what `/api/me` needs; version 2 is the rest of the plan's schema block; version 3 is
// the agent outbox; version 4 is the omni-search outbox.
//
// `ALTER TABLE ... ADD COLUMN` has no `IF NOT EXISTS`, so {@link addColumn} checks
// `pragma_table_info` first -- otherwise a migration that is re-run after a partial failure throws
// "duplicate column name" and can never complete.

export interface Migration {
  readonly version: number;
  readonly description: string;
  readonly up: (sql: SqlStorage) => void;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: "users and the schema version record",
    up(sql) {
      sql.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id            TEXT PRIMARY KEY,
          -- Resolved display name: the profile override if set, else the Access identity's name,
          -- else the email local part.
          name          TEXT NOT NULL,
          -- Profile override, null when the resolved name comes from the identity.
          display_name  TEXT,
          -- Mutable contact field. Normalized to lowercase. Never an identity key: the id column
          -- holds the Access subject.
          email         TEXT,
          avatar_key    TEXT,
          first_seen_at INTEGER NOT NULL,
          last_seen_at  INTEGER NOT NULL,
          tz            TEXT,
          -- Default notify level for conversations with no explicit setting.
          notify        TEXT NOT NULL DEFAULT 'all'
                        CHECK (notify IN ('all', 'mentions', 'none'))
        )
      `);
      sql.exec(`CREATE INDEX IF NOT EXISTS users_email ON users (email)`);
    },
  },
  {
    version: 2,
    description: "channels, memberships, messages with FTS, threads, reactions, attachments, limits",
    up(sql) {
      // `person` or `agent`. The agent row below is the only non-person, and it is seeded rather
      // than created on demand so a membership row can reference it from the start.
      addColumn(sql, "users", "kind", `TEXT NOT NULL DEFAULT 'person'`);

      sql.exec(`
        CREATE TABLE IF NOT EXISTS channels (
          id          TEXT PRIMARY KEY,
          kind        TEXT NOT NULL CHECK (kind IN ('public', 'private', 'dm', 'group')),
          -- Null for dm and group, which the client names from their members.
          name        TEXT,
          topic       TEXT,
          purpose     TEXT,
          created_by  TEXT NOT NULL,
          created_at  INTEGER NOT NULL,
          archived_at INTEGER,
          -- Highest seq committed. Allocating the next seq is an update of this column inside the
          -- send transaction, which is what makes (channel_id, seq) gapless and monotonic.
          last_seq    INTEGER NOT NULL DEFAULT 0,
          -- Sorted member ids joined with ':' for a dm, null otherwise. The unique index on it is
          -- the whole dm deduplication rule: a second "dm with Alice" finds the first one.
          dm_key      TEXT
        )
      `);
      // Partial unique indexes: a dm has no name and a named channel has no dm_key, so neither
      // constraint may treat the nulls as equal.
      sql.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS channels_name ON channels (name) WHERE name IS NOT NULL`,
      );
      sql.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS channels_dm_key ON channels (dm_key) WHERE dm_key IS NOT NULL`,
      );
      sql.exec(`CREATE INDEX IF NOT EXISTS channels_kind ON channels (kind)`);

      sql.exec(`
        CREATE TABLE IF NOT EXISTS memberships (
          channel_id        TEXT NOT NULL,
          user_id           TEXT NOT NULL,
          joined_at         INTEGER NOT NULL,
          last_read_seq     INTEGER NOT NULL DEFAULT 0,
          -- "Mark unread from here": the seq of the first message to count as unread again. Kept
          -- apart from last_read_seq so it cannot fight another tab's read acknowledgement.
          manual_unread_seq INTEGER,
          notify            TEXT NOT NULL DEFAULT 'all'
                            CHECK (notify IN ('all', 'mentions', 'none')),
          muted             INTEGER NOT NULL DEFAULT 0,
          starred           INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (channel_id, user_id)
        )
      `);
      sql.exec(`CREATE INDEX IF NOT EXISTS memberships_user ON memberships (user_id)`);

      sql.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id            TEXT PRIMARY KEY,
          channel_id    TEXT NOT NULL,
          -- Per channel and monotonic. A thread reply gets one too, so a reply permalink works.
          seq           INTEGER NOT NULL,
          root_id       TEXT,
          author_id     TEXT NOT NULL,
          body          TEXT NOT NULL,
          kind          TEXT NOT NULL CHECK (kind IN ('user', 'system', 'agent')),
          -- The sender's idempotency key. Unique per author, so a retried POST returns the first
          -- message instead of writing a second one.
          client_id     TEXT,
          created_at    INTEGER NOT NULL,
          edited_at     INTEGER,
          deleted_at    INTEGER,
          reply_count   INTEGER NOT NULL DEFAULT 0,
          last_reply_at INTEGER,
          -- Denormalised for the has: search qualifiers. Derived from the attachments committed with
          -- the message and from a scan of the body for a URL; recomputed on edit.
          has_image     INTEGER NOT NULL DEFAULT 0,
          has_file      INTEGER NOT NULL DEFAULT 0,
          has_link      INTEGER NOT NULL DEFAULT 0,
          UNIQUE (channel_id, seq)
        )
      `);
      sql.exec(`CREATE INDEX IF NOT EXISTS messages_channel_seq ON messages (channel_id, seq)`);
      sql.exec(`CREATE INDEX IF NOT EXISTS messages_root_seq ON messages (root_id, seq)`);
      sql.exec(`CREATE INDEX IF NOT EXISTS messages_author ON messages (author_id, created_at)`);
      sql.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS messages_client_id
           ON messages (author_id, client_id) WHERE client_id IS NOT NULL`,
      );

      // External content on `body` alone. Every indexed column has to be a real column of the
      // content table (spikes/README.md), and author and channel names are mutable, so they are
      // filtered as immutable ids in SQL after the text match instead of being indexed here.
      sql.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5 (
          body,
          content = 'messages',
          content_rowid = 'rowid',
          tokenize = 'unicode61'
        )
      `);
      sql.exec(`
        CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
          INSERT INTO messages_fts (rowid, body) VALUES (new.rowid, new.body);
        END
      `);
      sql.exec(`
        CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
          INSERT INTO messages_fts (messages_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
        END
      `);
      // The delete row first: an external-content index cannot be updated in place, and without it
      // an edited or blanked message stays findable under its old text.
      sql.exec(`
        CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE ON messages BEGIN
          INSERT INTO messages_fts (messages_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
          INSERT INTO messages_fts (rowid, body) VALUES (new.rowid, new.body);
        END
      `);

      sql.exec(`
        CREATE TABLE IF NOT EXISTS thread_follows (
          root_id             TEXT NOT NULL,
          user_id             TEXT NOT NULL,
          -- A channel seq, like every other cursor: replies carry one.
          last_read_reply_seq INTEGER NOT NULL DEFAULT 0,
          followed_at         INTEGER NOT NULL,
          PRIMARY KEY (root_id, user_id)
        )
      `);
      sql.exec(`CREATE INDEX IF NOT EXISTS thread_follows_user ON thread_follows (user_id)`);

      sql.exec(`
        CREATE TABLE IF NOT EXISTS mentions (
          message_id TEXT NOT NULL,
          -- The mentioned user. 'agent' for an @agent mention, which is a real reserved user.
          user_id    TEXT NOT NULL,
          kind       TEXT NOT NULL CHECK (kind IN ('user', 'channel', 'here', 'agent')),
          PRIMARY KEY (message_id, user_id, kind)
        )
      `);
      sql.exec(`CREATE INDEX IF NOT EXISTS mentions_user ON mentions (user_id)`);

      sql.exec(`
        CREATE TABLE IF NOT EXISTS reactions (
          message_id TEXT NOT NULL,
          user_id    TEXT NOT NULL,
          emoji      TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (message_id, user_id, emoji)
        )
      `);
      sql.exec(`CREATE INDEX IF NOT EXISTS reactions_message ON reactions (message_id)`);

      sql.exec(`
        CREATE TABLE IF NOT EXISTS attachments (
          id          TEXT PRIMARY KEY,
          -- Null while the upload is pending. The sweep alarm deletes pending rows, and their R2
          -- objects, an hour after they were written.
          message_id  TEXT,
          channel_id  TEXT NOT NULL,
          uploader_id TEXT NOT NULL,
          r2_key      TEXT NOT NULL,
          name        TEXT NOT NULL,
          -- Sniffed from the leading bytes for images, application/octet-stream otherwise. Never
          -- the client's claim, because an image mime is what makes a file renderable inline.
          mime        TEXT NOT NULL,
          bytes       INTEGER NOT NULL,
          width       INTEGER,
          height      INTEGER,
          thumb_key   TEXT,
          created_at  INTEGER NOT NULL
        )
      `);
      sql.exec(`CREATE INDEX IF NOT EXISTS attachments_message ON attachments (message_id)`);
      sql.exec(
        `CREATE INDEX IF NOT EXISTS attachments_pending
           ON attachments (created_at) WHERE message_id IS NULL`,
      );

      // One row per user and budget. Persisted rather than held in memory only, so an eviction
      // between two requests does not hand a caller a fresh quota.
      sql.exec(`
        CREATE TABLE IF NOT EXISTS rate_limits (
          user_id      TEXT NOT NULL,
          bucket       TEXT NOT NULL,
          window_start INTEGER NOT NULL,
          count        INTEGER NOT NULL,
          PRIMARY KEY (user_id, bucket)
        )
      `);

      // Phase 3's @agent routing writes these; nothing reads them yet. The table exists now so the
      // schema version that ships with phase 1 already has it.
      sql.exec(`
        CREATE TABLE IF NOT EXISTS agent_links (
          channel_id TEXT NOT NULL,
          root_id    TEXT NOT NULL,
          gadget_key TEXT NOT NULL,
          chat_key   TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (channel_id, root_id)
        )
      `);

      seedBuiltins(sql);
    },
  },
  {
    version: 3,
    description: "the agent outbox: one row per question to the Agent",
    up(sql) {
      // Written *before* the Workshop is called, so a question survives an eviction, a failed call
      // and a deploy between asking and answering (src/do/agent.ts). `agent_links` from version 2
      // stays unused: the gateway keys the workspace chat by `chat_key` itself, so there is no link
      // to keep here.
      sql.exec(`
        CREATE TABLE IF NOT EXISTS agent_requests (
          -- The asking message. One question per message, so this is also the idempotency key.
          message_id      TEXT PRIMARY KEY,
          channel_id      TEXT NOT NULL,
          -- Where the reply goes: the thread root for a channel question, the DM's own thread or
          -- NULL (inline) for a direct message.
          reply_root_id   TEXT,
          requester_id    TEXT NOT NULL,
          -- ChatIdentity.workshopAccount at asking time: the gateway's callerEmail. Never logged.
          caller_account  TEXT NOT NULL,
          -- The gateway's chatKey: one workspace chat per conversation (a thread, or a DM).
          chat_key        TEXT NOT NULL,
          -- Frozen at asking time, so an automatic retry sends exactly what was first sent.
          prompt          TEXT NOT NULL,
          state           TEXT NOT NULL
                          CHECK (state IN ('pending', 'accepted', 'replied', 'failed')),
          retryable       INTEGER NOT NULL DEFAULT 1,
          -- Bumped by a manual retry. The gateway's messageKey is derived from it, so a retry after
          -- the Workshop accepted a question is a new question rather than a deduplicated replay.
          generation      INTEGER NOT NULL DEFAULT 0,
          attempts        INTEGER NOT NULL DEFAULT 0,
          next_attempt_at INTEGER,
          chat_path       TEXT,
          reply_id        TEXT,
          error           TEXT,
          created_at      INTEGER NOT NULL,
          updated_at      INTEGER NOT NULL,
          accepted_at     INTEGER
        )
      `);
      sql.exec(`CREATE INDEX IF NOT EXISTS agent_requests_state ON agent_requests (state, next_attempt_at)`);
      sql.exec(
        `CREATE INDEX IF NOT EXISTS agent_requests_chat ON agent_requests (requester_id, chat_key, created_at)`,
      );
      sql.exec(
        `CREATE INDEX IF NOT EXISTS agent_requests_reply ON agent_requests (reply_id) WHERE reply_id IS NOT NULL`,
      );
    },
  },
  {
    version: 4,
    description: "the omni-search outbox and its sync state",
    up(sql) {
      // One row per thing search has not been told about yet: a *reference* (a message or channel
      // id), never a snapshot. The flush reads the current row when it builds the batch, so a message
      // edited three times before the flush is pushed once, a message deleted before the flush becomes
      // a delete, and a channel that no longer exists becomes a dropped scope (src/do/search-sync.ts).
      // Written in the same code path as the chat write, only when the SEARCH binding exists.
      sql.exec(`
        CREATE TABLE IF NOT EXISTS search_outbox (
          kind       TEXT NOT NULL CHECK (kind IN ('message', 'channel')),
          ref        TEXT NOT NULL,
          -- Bumped when the same reference is queued again while a flush is in flight, so the flush
          -- only clears the rows it actually pushed and a newer change is never lost.
          generation INTEGER NOT NULL DEFAULT 0,
          queued_at  INTEGER NOT NULL,
          PRIMARY KEY (kind, ref)
        )
      `);
      sql.exec(`CREATE INDEX IF NOT EXISTS search_outbox_queued ON search_outbox (queued_at)`);

      // Exactly one row: the flush's retry state and the backfill's resumable cursor.
      sql.exec(`
        CREATE TABLE IF NOT EXISTS search_sync (
          id                   INTEGER PRIMARY KEY CHECK (id = 1),
          -- NULL until SEARCH is first seen bound; then 'channels' -> 'messages' -> 'done'.
          backfill_phase       TEXT CHECK (backfill_phase IN ('channels', 'messages', 'done')),
          -- channels: the last channel id queued. messages: the last messages.rowid queued.
          backfill_cursor      TEXT NOT NULL DEFAULT '',
          backfill_queued      INTEGER NOT NULL DEFAULT 0,
          backfill_started_at  INTEGER,
          backfill_finished_at INTEGER,
          -- Consecutive failed ingest calls, and when the next attempt may run.
          attempts             INTEGER NOT NULL DEFAULT 0,
          next_attempt_at      INTEGER,
          last_error           TEXT,
          last_error_at        INTEGER,
          last_success_at      INTEGER,
          pushed_documents     INTEGER NOT NULL DEFAULT 0,
          -- Outbox rows discarded because search refused their batch as invalid input.
          dropped              INTEGER NOT NULL DEFAULT 0
        )
      `);
      sql.exec(`INSERT INTO search_sync (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
    },
  },
];

/**
 * The agent account and `#general`, both idempotent.
 *
 * `#general` is created by the agent because a seeded channel has no human creator and
 * `created_by` must name a real row. The agent is given a membership rather than being special-cased
 * in every query: "implicit member of every public channel" then costs nothing at read time, and
 * `createChannel` adds the same row for each new public channel.
 */
function seedBuiltins(sql: SqlStorage): void {
  const now = Date.now();
  sql.exec(
    `INSERT INTO users (id, name, email, first_seen_at, last_seen_at, kind)
     VALUES ('agent', 'Agent', NULL, ?, ?, 'agent')
     ON CONFLICT (id) DO NOTHING`,
    now,
    now,
  );
  sql.exec(
    `INSERT INTO channels (id, kind, name, topic, purpose, created_by, created_at)
     VALUES ('general', 'public', 'general', NULL, 'Everyone in this deployment.', 'agent', ?)
     ON CONFLICT (id) DO NOTHING`,
    now,
  );
  sql.exec(
    `INSERT INTO memberships (channel_id, user_id, joined_at) VALUES ('general', 'agent', ?)
     ON CONFLICT (channel_id, user_id) DO NOTHING`,
    now,
  );
}

/** `ALTER TABLE ... ADD COLUMN` made re-runnable: SQLite has no `IF NOT EXISTS` for it. */
function addColumn(sql: SqlStorage, table: string, column: string, definition: string): void {
  const present = sql
    .exec<{ name: string }>(`SELECT name FROM pragma_table_info(?)`, table)
    .toArray()
    .some((row) => row.name === column);
  if (present) return;
  // The table and column names are literals from the migration above, never request data; SQLite
  // cannot bind an identifier.
  sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/** Highest version {@link MIGRATIONS} can reach. */
export const TARGET_SCHEMA_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);

/**
 * Applies every migration above the recorded version and returns the version now in force.
 *
 * Each migration runs in its own synchronous transaction: a failure leaves the database at the last
 * version that completed, so the next call resumes rather than replaying what already succeeded.
 */
export function runMigrations(storage: DurableObjectStorage): number {
  const sql = storage.sql;
  sql.exec(`CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)`);

  let current = readSchemaVersion(sql);
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    storage.transactionSync(() => {
      migration.up(sql);
      sql.exec(
        `INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        migration.version,
      );
    });
    current = migration.version;
  }
  return current;
}

export function readSchemaVersion(sql: SqlStorage): number {
  const row = sql
    .exec<{ value: number }>(`SELECT value FROM schema_meta WHERE key = 'schema_version'`)
    .toArray()[0];
  return row?.value ?? 0;
}
