import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { Sql } from 'postgres';

/** Dedicated new-service database only. Historical Records migrations are never changed. */
export async function migrate(sql: Sql): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS public.records_service_migrations (
    id text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`;
  const dir = new URL('../sql/', import.meta.url);
  const files = (await readdir(dir)).filter(file => /^\d{3}[-_].*\.sql$/.test(file)).sort();
  await sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(717823019)`;
    for (const file of files) {
      const source = await readFile(new URL(file, dir), 'utf8');
      const checksum = createHash('sha256').update(source).digest('hex');
      const [existing] = await tx`SELECT checksum FROM public.records_service_migrations WHERE id=${file}`;
      if (existing) {
        if (existing.checksum !== checksum) throw new Error(`Applied migration changed: ${file}`);
        continue;
      }
      // Fixture SQL is also usable with psql. The runner owns the atomic transaction and ledger.
      const statements = source.replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, '');
      await tx.unsafe(statements);
      await tx`INSERT INTO public.records_service_migrations(id,checksum) VALUES(${file},${checksum})`;
    }
  });
}
