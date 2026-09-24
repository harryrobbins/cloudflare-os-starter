// Numbered, append-only schema migrations for `SearchIndex`, in the style of
// packages/gatekeeper-chat/src/migrations.ts:
//   * Append only. A deployed object has recorded its version and will not re-run an entry.
//   * Idempotent statements (`IF NOT EXISTS`), so a migration interrupted mid-way re-runs cleanly.
//   * The applied version lives in `schema_meta`, not inferred from the tables present.

export interface Migration {
  readonly version: number;
  readonly description: string;
  readonly up: (sql: SqlStorage) => void;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: "documents, chunks with FTS5, principals, scopes, tombstones, rate limits",
    up(sql) {
      sql.exec(`
        CREATE TABLE IF NOT EXISTS documents (
          -- "<source>:<externalId>", the caller's business. Re-pushing the same id updates it.
          id          TEXT PRIMARY KEY,
          source      TEXT NOT NULL,
          kind        TEXT NOT NULL,
          title       TEXT NOT NULL,
          url         TEXT,
          scope       TEXT NOT NULL,
          vis         TEXT NOT NULL CHECK (vis IN ('all', 'scoped')),
          workspace   TEXT,
          channel     TEXT,
          author_id   TEXT,
          -- Display name, for from: and the author facet.
          author      TEXT,
          mime        TEXT,
          created_at  INTEGER NOT NULL,
          updated_at  INTEGER NOT NULL,
          -- Set by a delete. The row survives (for stats and a later resurrection); its chunks do not.
          deleted_at  INTEGER,
          -- Bumped by every change that is not a no-op. Chunks record the revision they were written at.
          revision    INTEGER NOT NULL DEFAULT 1,
          -- SHA-256 of the (possibly truncated) body: an unchanged push is a free no-op.
          body_hash   TEXT NOT NULL,
          -- The whole body, for open(). Chunks overlap, so they cannot reconstruct it. Blanked on delete.
          body        TEXT NOT NULL DEFAULT ''
        )
      `);
      sql.exec(`CREATE INDEX IF NOT EXISTS documents_scope ON documents (scope)`);
      sql.exec(`CREATE INDEX IF NOT EXISTS documents_source ON documents (source, updated_at)`);
      sql.exec(`CREATE INDEX IF NOT EXISTS documents_updated ON documents (updated_at)`);
      sql.exec(`CREATE INDEX IF NOT EXISTS documents_vis ON documents (vis)`);

      sql.exec(`
        CREATE TABLE IF NOT EXISTS chunks (
          -- 22-char base64url SHA-256 of "<documentId>#<ord>": also the Vectorize vector id.
          id             TEXT PRIMARY KEY,
          document_id    TEXT NOT NULL,
          ord            INTEGER NOT NULL,
          text           TEXT NOT NULL,
          -- Approximate tokens, chars / 4.
          tokens         INTEGER NOT NULL,
          -- The document revision this chunk's text or vector metadata last changed at. The queue
          -- consumer marks a chunk embedded only for the revision it actually embedded.
          revision       INTEGER NOT NULL,
          -- EMBED_REVISION of the vector in Vectorize; null until the current revision is embedded.
          embed_revision INTEGER,
          embedded_at    INTEGER,
          UNIQUE (document_id, ord)
        )
      `);
      sql.exec(`CREATE INDEX IF NOT EXISTS chunks_pending ON chunks (embedded_at) WHERE embedded_at IS NULL`);

      // External content on `text` alone: every indexed column must be a real column of the content
      // table, and document metadata is filtered by join (chat's spike, spikes/README.md).
      sql.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5 (
          text,
          content = 'chunks',
          content_rowid = 'rowid',
          tokenize = 'unicode61'
        )
      `);
      sql.exec(`
        CREATE TRIGGER IF NOT EXISTS chunks_fts_insert AFTER INSERT ON chunks BEGIN
          INSERT INTO chunks_fts (rowid, text) VALUES (new.rowid, new.text);
        END
      `);
      sql.exec(`
        CREATE TRIGGER IF NOT EXISTS chunks_fts_delete AFTER DELETE ON chunks BEGIN
          INSERT INTO chunks_fts (chunks_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
        END
      `);
      // The delete row first: an external-content index cannot be updated in place.
      sql.exec(`
        CREATE TRIGGER IF NOT EXISTS chunks_fts_update AFTER UPDATE OF text ON chunks BEGIN
          INSERT INTO chunks_fts (chunks_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
          INSERT INTO chunks_fts (rowid, text) VALUES (new.rowid, new.text);
        END
      `);

      sql.exec(`
        CREATE TABLE IF NOT EXISTS principals (
          scope     TEXT NOT NULL,
          principal TEXT NOT NULL,
          PRIMARY KEY (scope, principal)
        )
      `);
      sql.exec(`CREATE INDEX IF NOT EXISTS principals_principal ON principals (principal)`);

      sql.exec(`
        CREATE TABLE IF NOT EXISTS scopes (
          scope  TEXT PRIMARY KEY,
          source TEXT NOT NULL,
          label  TEXT NOT NULL,
          vis    TEXT NOT NULL CHECK (vis IN ('all', 'scoped'))
        )
      `);

      // A deleted chunk's vector id, until the alarm has asked Vectorize to delete it. The chunk row
      // itself is already gone (and so is its FTS entry), which is what makes a delete instant.
      sql.exec(`
        CREATE TABLE IF NOT EXISTS tombstones (
          chunk_id   TEXT PRIMARY KEY,
          deleted_at INTEGER NOT NULL,
          purged_at  INTEGER
        )
      `);
      sql.exec(`CREATE INDEX IF NOT EXISTS tombstones_pending ON tombstones (deleted_at) WHERE purged_at IS NULL`);

      // Persisted rather than in memory, so an eviction does not hand a caller a fresh quota.
      sql.exec(`
        CREATE TABLE IF NOT EXISTS rate_limits (
          principal    TEXT NOT NULL,
          bucket       TEXT NOT NULL,
          window_start INTEGER NOT NULL,
          count        INTEGER NOT NULL,
          PRIMARY KEY (principal, bucket)
        )
      `);
    },
  },
];

/** Highest version {@link MIGRATIONS} can reach. */
export const TARGET_SCHEMA_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);

/**
 * Applies every migration above the recorded version, each in its own synchronous transaction, and
 * returns the version now in force.
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
