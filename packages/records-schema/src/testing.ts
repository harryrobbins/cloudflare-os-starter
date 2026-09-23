// Disposable real Postgres for tests: one embedded cluster per test run (vitest globalSetup), one
// fresh database per test file. Synthetic data only; never point this at a shared database.
//
// Login roles mirror production: `records_app_login` and `records_publisher_login` are members of
// the NOLOGIN group roles the migrations create, and neither owns anything.

import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import EmbeddedPostgres from "embedded-postgres";
import postgres from "postgres";

import { migrate } from "./migrate.ts";

export const TEST_PASSWORD = "records-test-only";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

export type TestCluster = { superuserUrl: string; port: number; stop(): Promise<void> };

export async function startTestCluster(): Promise<TestCluster> {
  const dir = mkdtempSync(join(tmpdir(), "records-pg-"));
  const port = await freePort();
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    user: "postgres",
    password: TEST_PASSWORD,
    port,
    persistent: false,
    onLog: () => {},
    onError: () => {},
    postgresFlags: ["-c", "max_connections=200", "-c", "fsync=off", "-c", "synchronous_commit=off", "-c", "full_page_writes=off"],
  });
  await pg.initialise();
  await pg.start();
  return {
    port,
    superuserUrl: `postgres://postgres:${TEST_PASSWORD}@127.0.0.1:${port}/postgres`,
    async stop() {
      await pg.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export type TestDatabase = {
  name: string;
  /** Migration owner (superuser in tests). */
  ownerUrl: string;
  /** Runtime application login: member of records_app only. */
  appUrl: string;
  /** Outbox publisher login: member of records_publisher only. */
  publisherUrl: string;
};

/** Create an empty database. `migrateIt` false leaves it unmigrated (migration-runner tests). */
export async function createTestDatabase(superuserUrl: string, migrateIt = true): Promise<TestDatabase> {
  const admin = postgres(superuserUrl, { max: 1, onnotice: () => {} });
  const name = `records_test_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const base = new URL(superuserUrl);
  const url = (user: string, password: string) => {
    const u = new URL(base);
    u.username = user;
    u.password = password;
    u.pathname = `/${name}`;
    return u.toString();
  };
  const db: TestDatabase = {
    name,
    ownerUrl: url("postgres", TEST_PASSWORD),
    appUrl: url("records_app_login", TEST_PASSWORD),
    publisherUrl: url("records_publisher_login", TEST_PASSWORD),
  };
  if (migrateIt) await migrateTestDatabase(db);
  return db;
}

export async function migrateTestDatabase(db: TestDatabase): Promise<void> {
  const owner = postgres(db.ownerUrl, { max: 1, onnotice: () => {} });
  try {
    await migrate(owner);
    // Cluster-wide login roles; creation races between parallel test files are tolerated.
    for (const [login, group] of [["records_app_login", "records_app"], ["records_publisher_login", "records_publisher"]]) {
      try {
        await owner.unsafe(`CREATE ROLE ${login} LOGIN PASSWORD '${TEST_PASSWORD}'`);
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code !== "42710" && code !== "23505") throw err;
      }
      await owner.unsafe(`GRANT ${group} TO ${login}`);
    }
    await owner.unsafe(`GRANT CONNECT ON DATABASE ${db.name} TO records_app_login, records_publisher_login`);
  } finally {
    await owner.end();
  }
}
