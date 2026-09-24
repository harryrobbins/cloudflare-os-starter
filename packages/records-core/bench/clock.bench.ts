// Phase 0 clock spike, local only (canonical plan §10, Phase 0 "Clock"): commands per second and
// commit latency on ONE datastore with the clock taken last, against an embedded Postgres 17 with
// durable settings (fsync and synchronous_commit on, unlike the test clusters). Hyperdrive and
// Neon are out of scope here: there, every statement also pays a network round trip, and the clock
// row is held for the final inserts plus the COMMIT round trip, so remote numbers will be lower.
//
//   pnpm -C packages/records-core run bench:clock
//
// Runs under vitest only because the workspace's `.js`-suffixed TypeScript needs its resolver.

import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import EmbeddedPostgres from "embedded-postgres";
import postgres from "postgres";
import { it } from "vitest";

import { bootstrapOrganisation } from "@records/schema/bootstrap";
import { migrateTestDatabase, TEST_PASSWORD, type TestDatabase } from "@records/schema/testing";

import { connect, RecordsService } from "../src/index.js";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

const pct = (xs: number[], p: number) => {
  const s = xs.toSorted((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};
const ms = (x: number) => `${x.toFixed(2)} ms`;

it("clock spike", { timeout: 600_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "records-bench-"));
  const port = await freePort();
  const pg = new EmbeddedPostgres({
    databaseDir: dir, user: "postgres", password: TEST_PASSWORD, port, persistent: false,
    onLog: () => {}, onError: () => {}, postgresFlags: ["-c", "max_connections=200"],
  });
  await pg.initialise();
  await pg.start();
  const base = `postgres://postgres:${TEST_PASSWORD}@127.0.0.1:${port}`;
  const admin = postgres(`${base}/postgres`, { max: 1, onnotice: () => {} });
  await admin`CREATE DATABASE records_bench`;
  const settings = await admin`SELECT name, setting FROM pg_settings WHERE name IN ('fsync', 'synchronous_commit', 'server_version')`;
  await admin.end();
  const db: TestDatabase = {
    name: "records_bench",
    ownerUrl: `${base}/records_bench`,
    appUrl: `postgres://records_app_login:${TEST_PASSWORD}@127.0.0.1:${port}/records_bench`,
    publisherUrl: `postgres://records_publisher_login:${TEST_PASSWORD}@127.0.0.1:${port}/records_bench`,
  };
  await migrateTestDatabase(db);

  const owner = postgres(db.ownerUrl, { max: 1, onnotice: () => {} });
  const holds: number[] = [];
  const clockAt = new Map<number, number>();
  const app = connect(db.appUrl, { max: 64 });
  const service = new RecordsService(app, { afterClock: async (_ds, seq) => void clockAt.set(seq, performance.now()) });
  const lines: string[] = [`postgres: ${settings.map((s) => `${s.name}=${s.setting}`).join(", ")}`];

  try {
    const org = await bootstrapOrganisation(owner, { orgName: "Bench", adminEmail: "admin@bench.test", adminName: "Admin" });
    const adminCaller = { orgId: org.orgId, principalId: org.principalId, via: "management" as const };
    const writer = (await service.registry.invitePrincipal(adminCaller, { email: "w@bench.test", displayName: "Writer" })).id;
    const caller = { orgId: org.orgId, principalId: writer, via: "http" as const };
    // One project per writer, so writers contend only on the datastore clock and not on a shared
    // project row (createIssue locks its project to allocate the issue number).
    const WRITERS = 48;
    type Target = { ds: string; projects: string[] };
    const mk = async (name: string, key: string): Promise<Target> => {
      const ds = (await service.registry.createDatastore(adminCaller, { name, moduleId: "projects", ownerPrincipalId: writer })).id;
      const projects: string[] = [];
      for (let i = 0; i < WRITERS; i++) projects.push((await service.projects.createProject(caller, ds, { key: `${key}${i}`, name: `${name} ${i}` })).id);
      return { ds, projects };
    };
    const one = await mk("One", "ONE");
    const two = await mk("Two", "TWO");

    let n = 0;
    let failures = 0;
    const command = async (target: Target, worker: number): Promise<number | null> => {
      const t0 = performance.now();
      try {
        const out = await service.commands.execute(caller, target.ds, {
          name: "projects.createIssue", input: { projectId: target.projects[worker % WRITERS]!, title: `Bench ${n++}` },
        }, { idempotencyKey: `bench-${crypto.randomUUID()}` });
        const t1 = performance.now();
        const at = clockAt.get(out.seq);
        if (at !== undefined && target === one) holds.push(t1 - at);
        clockAt.delete(out.seq);
        return t1 - t0;
      } catch {
        failures++;
        return null;
      }
    };

    // Warm up connections and plans.
    for (let i = 0; i < 50; i++) await command(one, i);

    // Baseline: the cost of one durable commit with no work in it (a one-row insert), serially.
    await owner`CREATE TABLE IF NOT EXISTS bench_commit (id bigint)`;
    const bare: number[] = [];
    for (let i = 0; i < 200; i++) {
      const t0 = performance.now();
      await owner.begin((tx) => tx`INSERT INTO bench_commit VALUES (${i})`);
      bare.push(performance.now() - t0);
    }
    lines.push(`${"bare one-row commit (baseline)".padEnd(42)} p50 ${ms(pct(bare, 50))}  p95 ${ms(pct(bare, 95))}`);

    const run = async (label: string, total: number, concurrency: number, targets: Target[], sameProject = false) => {
      holds.length = 0;
      failures = 0;
      const latencies: number[] = [];
      let next = 0;
      const t0 = performance.now();
      await Promise.all(Array.from({ length: concurrency }, async (_, worker) => {
        while (next < total) {
          next++;
          const latency = await command(targets[worker % targets.length]!, sameProject ? 0 : Math.floor(worker / targets.length));
          if (latency !== null) latencies.push(latency);
        }
      }));
      const seconds = (performance.now() - t0) / 1000;
      lines.push(
        `${label.padEnd(42)} ${String(total).padStart(5)} cmds  ${((total - failures) / seconds).toFixed(0).padStart(5)} cmd/s  ` +
        `p50 ${ms(pct(latencies, 50))}  p95 ${ms(pct(latencies, 95))}  p99 ${ms(pct(latencies, 99))}` +
        (holds.length ? `  clock held p50 ${ms(pct(holds, 50))} p95 ${ms(pct(holds, 95))}` : "") +
        (failures ? `  FAILED ${failures} (statement timeout)` : ""),
      );
    };

    await run("1 datastore, 1 writer (serial)", 500, 1, [one]);
    await run("1 datastore, 4 concurrent", 1000, 4, [one]);
    await run("1 datastore, 16 concurrent", 1000, 16, [one]);
    await run("1 datastore, 48 concurrent", 1000, 48, [one]);
    await run("2 datastores, 48 concurrent (split)", 1000, 48, [one, two]);
    // Every writer in ONE project: the project row lock (issue numbering) serialises them too.
    await run("1 datastore, 16 concurrent, one project", 1000, 16, [one], true);

    // The same with commit durability relaxed, isolating the fsync share of the clock hold.
    await owner`ALTER DATABASE records_bench SET synchronous_commit = off`;
    await app.end();
    const relaxed = connect(db.appUrl, { max: 64 });
    Object.assign(service, new RecordsService(relaxed, { afterClock: async (_ds, s) => void clockAt.set(s, performance.now()) }));
    await run("1 datastore, 16 concurrent, async commit", 1000, 16, [one]);
    await relaxed.end();

    const [{ seq }] = (await owner`SELECT seq FROM records.datastore_clock WHERE datastore_id = ${one.ds}`) as unknown as [{ seq: string }];
    const [{ n: entries, gaps }] = (await owner`
      SELECT count(*)::int AS n, (max(seq) - min(seq) + 1 - count(DISTINCT seq))::int AS gaps
        FROM records.journal WHERE datastore_id = ${one.ds}`) as unknown as [{ n: number; gaps: number }];
    lines.push(`datastore One: clock ${seq}, ${entries} journal entries, ${gaps} gaps`);
    process.stderr.write(`\nClock spike (local embedded Postgres, createIssue through the command bus)\n${lines.join("\n")}\n`);
  } finally {
    await Promise.allSettled([owner.end(), app.end()]);
    await pg.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
