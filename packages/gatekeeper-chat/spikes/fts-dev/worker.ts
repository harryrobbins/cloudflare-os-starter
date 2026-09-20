// Spike 1, `wrangler dev` half: the same FTS5 shape as __tests__/spikes/fts-do.ts, exercised by a
// real workerd process against a real on-disk SQLite database rather than the vitest pool.
//
// GET /fts runs the whole sequence and returns what it observed, so one curl is the entire check.
import { DurableObject } from "cloudflare:workers";

// A type alias, not an interface: `sql.exec<T>()` needs the implicit index signature only aliases get.
type Hit = {
  id: string;
  snippet: string;
  score: number;
};

export class SpikeFtsDo extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    const sql = ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, body TEXT NOT NULL)`);
    sql.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      body, content='messages', content_rowid='rowid', tokenize='unicode61')`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts (rowid, body) VALUES (new.rowid, new.body); END`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts (messages_fts, rowid, body) VALUES ('delete', old.rowid, old.body); END`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts (messages_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
      INSERT INTO messages_fts (rowid, body) VALUES (new.rowid, new.body); END`);
  }

  run(): Record<string, unknown> {
    const sql = this.ctx.storage.sql;
    sql.exec(`DELETE FROM messages`);
    const rows: readonly [string, string, string][] = [
      ["m1", "general", "Can we ship the deployment today?"],
      ["m2", "general", "The build is green, deploying now"],
      ["m3", "design", "deployment deployment deployment"],
    ];
    for (const [id, channel, body] of rows) {
      sql.exec(`INSERT INTO messages (id, channel_id, body) VALUES (?, ?, ?)`, id, channel, body);
    }

    const search = (match: string): Hit[] =>
      sql
        .exec<Hit>(
          `SELECT m.id,
                  snippet(messages_fts, 0, '<mark>', '</mark>', '…', 8) AS snippet,
                  bm25(messages_fts) AS score
             FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid
            WHERE messages_fts MATCH ? ORDER BY score`,
          match,
        )
        .toArray();

    const term = search("deployment");
    const prefix = search("deploy*");
    sql.exec(`UPDATE messages SET body = '' WHERE id = 'm3'`);
    const afterBlank = search("deployment");
    sql.exec(`DELETE FROM messages WHERE id = 'm1'`);
    const afterDelete = search("deployment");
    let integrity = "ok";
    try {
      sql.exec(`INSERT INTO messages_fts (messages_fts, rank) VALUES ('integrity-check', 1)`);
    } catch (error) {
      integrity = String(error);
    }

    return {
      // Note: `SELECT sqlite_version()` is rejected by the Durable Object SQL gateway
      // ("not authorized to use function: sqlite_version"), so the version is not reportable here.
      term,
      prefixIds: prefix.map((hit) => hit.id),
      afterBlankIds: afterBlank.map((hit) => hit.id),
      afterDeleteIds: afterDelete.map((hit) => hit.id),
      rowsRemaining: sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM messages`).toArray()[0]?.n,
      integrity,
    };
  }
}

interface Env {
  SPIKE_FTS: DurableObjectNamespace<SpikeFtsDo>;
}

export default {
  async fetch(request, env): Promise<Response> {
    if (new URL(request.url).pathname !== "/fts") return new Response("try GET /fts", { status: 404 });
    const stub = env.SPIKE_FTS.get(env.SPIKE_FTS.idFromName("spike"));
    return Response.json(await stub.run());
  },
} satisfies ExportedHandler<Env>;
