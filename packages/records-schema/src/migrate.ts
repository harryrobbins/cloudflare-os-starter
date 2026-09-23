// The single migration runner (Phase 0 decision: an in-repo runner rather than dbmate, because the
// plan requires a checksum ledger and dbmate records only versions).
//
// Guarantees:
// - One runner at a time per database: a session advisory lock is held for the whole run.
// - Every applied migration's checksum is re-verified; an edited, missing or out-of-order file
//   stops the run before anything is applied.
// - Each migration and its ledger row commit in one transaction.
// Runtime Worker credentials cannot run this: they hold no CREATE privilege on any schema.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Sql } from "postgres";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));
const LOCK_KEY = 7_302_914_118; // arbitrary, fixed: "records migrations"

export type Migration = { id: string; sql: string; checksum: string };
export type MigrationStatus = { id: string; checksum: string; state: "applied" | "pending" };

export function loadMigrations(dir = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .toSorted()
    .map((file) => {
      const sql = readFileSync(join(dir, file), "utf8");
      return { id: file.replace(/\.sql$/, ""), sql, checksum: createHash("sha256").update(sql).digest("hex") };
    });
}

async function ensureLedger(sql: Sql): Promise<void> {
  await sql.unsafe(`
    CREATE SCHEMA IF NOT EXISTS records_meta;
    REVOKE ALL ON SCHEMA records_meta FROM PUBLIC;
    CREATE TABLE IF NOT EXISTS records_meta.schema_migrations (
      id          text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      applied_by  text NOT NULL DEFAULT current_user
    );`);
}

/** Compare the ledger with the files. Throws on any drift; returns the pending tail. */
export function plan(files: Migration[], applied: { id: string; checksum: string }[]): Migration[] {
  const byId = new Map(files.map((m) => [m.id, m]));
  for (const [i, row] of applied.entries()) {
    const file = byId.get(row.id);
    if (!file) throw new Error(`Applied migration ${row.id} is missing from this build.`);
    if (file.checksum !== row.checksum) throw new Error(`Migration ${row.id} was edited after it was applied.`);
    if (files[i]?.id !== row.id) throw new Error(`Migration ${files[i]?.id} was added before ${row.id}, out of order.`);
  }
  return files.slice(applied.length);
}

export async function status(sql: Sql, files = loadMigrations()): Promise<MigrationStatus[]> {
  await ensureLedger(sql);
  const applied = await sql<{ id: string; checksum: string }[]>`
    SELECT id, checksum FROM records_meta.schema_migrations ORDER BY id`;
  const pending = new Set(plan(files, applied).map((m) => m.id));
  return files.map((m) => ({ id: m.id, checksum: m.checksum, state: pending.has(m.id) ? "pending" : "applied" }));
}

/** Apply pending migrations. Returns the IDs applied by this run. */
export async function migrate(sql: Sql, files = loadMigrations(), log: (line: string) => void = () => {}): Promise<string[]> {
  const conn = await sql.reserve();
  try {
    await conn`SELECT pg_advisory_lock(${LOCK_KEY})`;
    try {
      await ensureLedger(conn);
      const applied = await conn<{ id: string; checksum: string }[]>`
        SELECT id, checksum FROM records_meta.schema_migrations ORDER BY id`;
      const pending = plan(files, applied);
      for (const m of pending) {
        log(`applying ${m.id}`);
        await conn.unsafe("BEGIN");
        try {
          await conn.unsafe(m.sql);
          await conn`INSERT INTO records_meta.schema_migrations (id, checksum) VALUES (${m.id}, ${m.checksum})`;
          await conn.unsafe("COMMIT");
        } catch (err) {
          await conn.unsafe("ROLLBACK");
          throw new Error(`Migration ${m.id} failed and was rolled back: ${(err as Error).message}`, { cause: err });
        }
      }
      return pending.map((m) => m.id);
    } finally {
      await conn`SELECT pg_advisory_unlock(${LOCK_KEY})`;
    }
  } finally {
    conn.release();
  }
}
