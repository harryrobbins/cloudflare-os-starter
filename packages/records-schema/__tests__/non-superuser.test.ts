// Managed Postgres (Neon) gives the migration owner CREATEROLE and CREATEDB, never superuser. The
// shared test cluster migrates as `postgres`, a superuser, which let 0009 ship a function-level
// `SET records.<custom>` that Neon refuses ("permission denied to set parameter"). This applies
// every migration as a Neon-like owner in a cluster of its own, since roles are cluster-wide and
// the shared cluster's were created by a superuser.
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";

import { loadMigrations, migrate, status } from "../src/migrate.ts";
import { startTestCluster, type TestCluster } from "../src/testing.ts";

const quiet = { onnotice: () => {} } as const;
const OWNER_PASSWORD = "owner-test-password";

let cluster: TestCluster;

beforeAll(async () => {
  cluster = await startTestCluster();
  const admin = postgres(cluster.superuserUrl, { max: 1, ...quiet });
  try {
    await admin.unsafe(`CREATE ROLE records_owner LOGIN CREATEROLE CREATEDB NOSUPERUSER PASSWORD '${OWNER_PASSWORD}'`);
    await admin.unsafe(`CREATE DATABASE records_managed OWNER records_owner`);
  } finally {
    await admin.end();
  }
}, 120_000);

afterAll(async () => {
  await cluster?.stop();
});

it("applies every migration as a non-superuser owner", async () => {
  const url = new URL(cluster.superuserUrl);
  url.username = "records_owner";
  url.password = OWNER_PASSWORD;
  url.pathname = "/records_managed";
  const owner = postgres(url.toString(), { max: 1, ...quiet });
  try {
    const [{ rolsuper }] = await owner<{ rolsuper: boolean }[]>`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`;
    expect(rolsuper).toBe(false);
    await migrate(owner);
    const states = await status(owner);
    expect(states.map((m) => m.id)).toEqual(loadMigrations().map((m) => m.id));
    expect(states.every((m) => m.state === "applied")).toBe(true);
  } finally {
    await owner.end();
  }
}, 120_000);
