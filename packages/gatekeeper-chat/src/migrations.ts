// Numbered, append-only schema migrations for `ChatWorkspace`.
//
// Rules the operational section of chat.md fixes, and the reason each one matters:
//   * Append only. An existing entry is never edited, because a deployed DO has already recorded its
//     version and will not re-run it.
//   * Idempotent statements (`IF NOT EXISTS`), so a migration interrupted between two statements
//     re-runs cleanly.
//   * The applied version is recorded in `schema_meta`, not inferred from the tables present.
//
// Stream 0 ships only what `/api/me` needs. Stream A appends version 2 onwards with the channels,
// memberships, messages, FTS and attachment tables from the plan's schema block.

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
];

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
