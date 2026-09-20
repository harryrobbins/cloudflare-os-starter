// Spike: FTS5 in a SQLite-backed Durable Object.
//
// Answers phase 0 item 2 of chat.md with the exact shape the plan's schema block specifies: an
// external-content virtual table over `messages`, kept in sync by AFTER INSERT/UPDATE/DELETE
// triggers, queried with MATCH, `snippet()` and `bm25()`.
//
// Lives under `__tests__/` rather than `src/` so nothing spike-shaped can reach a production bundle.

import { DurableObject } from "cloudflare:workers";

export interface SpikeRow {
  readonly id: string;
  readonly channelId: string;
  readonly authorId: string;
  readonly body: string;
}

export interface SpikeHit {
  readonly id: string;
  readonly channelId: string;
  readonly authorId: string;
  readonly snippet: string;
  /** `bm25()`: negative, and lower is a better match. */
  readonly score: number;
}

export class SpikeFts extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.migrate();
  }

  private migrate(): void {
    const sql = this.ctx.storage.sql;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id         TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        author_id  TEXT NOT NULL,
        body       TEXT NOT NULL,
        deleted_at INTEGER
      )
    `);
    // External content: the index stores no copy of the text, only the terms, and reads values back
    // from `messages` by rowid. Every indexed column must therefore be a real column of `messages` --
    // which is why the plan indexes `body` alone and filters on immutable ids in SQL afterwards.
    sql.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        body,
        content='messages',
        content_rowid='rowid',
        tokenize='unicode61'
      )
    `);
    sql.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts (rowid, body) VALUES (new.rowid, new.body);
      END
    `);
    // An external-content index is not updated in place: the old terms are retracted with a
    // 'delete' command row carrying the *previous* values, then the new ones are inserted. Getting
    // this wrong leaves a deleted message findable, which is the case the test below pins down.
    sql.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts (messages_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
      END
    `);
    sql.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts (messages_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
        INSERT INTO messages_fts (rowid, body) VALUES (new.rowid, new.body);
      END
    `);
  }

  reset(): void {
    const sql = this.ctx.storage.sql;
    sql.exec(`DELETE FROM messages`);
  }

  seed(rows: readonly SpikeRow[]): void {
    for (const row of rows) {
      this.ctx.storage.sql.exec(
        `INSERT INTO messages (id, channel_id, author_id, body) VALUES (?, ?, ?, ?)`,
        row.id,
        row.channelId,
        row.authorId,
        row.body,
      );
    }
  }

  /**
   * Full-text search. `channelId` stands in for the membership filter: the plan's rule is to match on
   * text with FTS and then narrow on immutable ids in SQL, so the join is what production will do.
   */
  search(match: string, channelId?: string): SpikeHit[] {
    return this.ctx.storage.sql
      .exec<{ id: string; channel_id: string; author_id: string; snippet: string; score: number }>(
        `SELECT m.id,
                m.channel_id,
                m.author_id,
                snippet(messages_fts, 0, '<mark>', '</mark>', '…', 10) AS snippet,
                bm25(messages_fts)                                     AS score
           FROM messages_fts
           JOIN messages m ON m.rowid = messages_fts.rowid
          WHERE messages_fts MATCH ?
            AND (?2 IS NULL OR m.channel_id = ?2)
          ORDER BY score
          LIMIT 20`,
        match,
        channelId ?? null,
      )
      .toArray()
      .map((row) => ({
        id: row.id,
        channelId: row.channel_id,
        authorId: row.author_id,
        snippet: row.snippet,
        score: row.score,
      }));
  }

  /** The plan's delete rule: blank the body so the triggers drop it from the index. */
  softDelete(id: string): void {
    this.ctx.storage.sql.exec(
      `UPDATE messages SET body = '', deleted_at = ? WHERE id = ?`,
      Date.now(),
      id,
    );
  }

  hardDelete(id: string): void {
    this.ctx.storage.sql.exec(`DELETE FROM messages WHERE id = ?`, id);
  }

  /** `integrity-check` fails loudly when the triggers and the content table have drifted apart. */
  integrityOk(): boolean {
    try {
      this.ctx.storage.sql.exec(
        `INSERT INTO messages_fts (messages_fts, rank) VALUES ('integrity-check', 1)`,
      );
      return true;
    } catch {
      return false;
    }
  }

  rowCount(): number {
    return (
      this.ctx.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM messages`).toArray()[0]?.n ?? 0
    );
  }
}
