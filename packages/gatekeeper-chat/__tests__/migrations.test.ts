// The migration runner. Stream A appends versions; these tests are what stops an append from
// breaking an object that has already recorded a version.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { MIGRATIONS, readSchemaVersion, runMigrations, TARGET_SCHEMA_VERSION } from "../src/migrations.js";
import { IDENTITY_HEADER, type ErrorEnvelope } from "../src/shared/protocol.js";
import type { ChatWorkspace } from "../src/workspace.js";

const IDENTITY = { [IDENTITY_HEADER]: JSON.stringify({ id: "alice", email: "alice@example.test" }) };

function workspace(name: string) {
  return env.CHAT_WORKSPACE.get(env.CHAT_WORKSPACE.idFromName(name)) as DurableObjectStub<ChatWorkspace>;
}

describe("migrations", () => {
  it("numbers versions uniquely and in ascending order", () => {
    const versions = MIGRATIONS.map((migration) => migration.version);
    expect(versions).toEqual(versions.toSorted((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
    expect(TARGET_SCHEMA_VERSION).toBe(versions.at(-1));
  });

  it("records the version it reached", async () => {
    const stub = workspace(`migrate-${crypto.randomUUID()}`);
    await expect(stub.schemaVersion()).resolves.toBe(TARGET_SCHEMA_VERSION);
  });

  it("is idempotent: a second run changes nothing", async () => {
    const stub = workspace(`idempotent-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      const first = runMigrations(state.storage);
      const second = runMigrations(state.storage);
      expect(second).toBe(first);
      expect(readSchemaVersion(state.storage.sql)).toBe(TARGET_SCHEMA_VERSION);
    });
  });

  it("re-applies a migration when the recorded version is rolled back", async () => {
    // Stands in for a partially applied migration: the version says 0, so everything runs again over
    // tables that already exist. `IF NOT EXISTS` is what makes that safe.
    const stub = workspace(`resume-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(`UPDATE schema_meta SET value = 0 WHERE key = 'schema_version'`);
      expect(readSchemaVersion(state.storage.sql)).toBe(0);
      expect(runMigrations(state.storage)).toBe(TARGET_SCHEMA_VERSION);
    });
  });

  it("creates the users table version 1 describes, plus version 2's kind column", async () => {
    const stub = workspace(`schema-${crypto.randomUUID()}`);
    const columns = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ name: string }>(`SELECT name FROM pragma_table_info('users')`)
        .toArray()
        .map((row) => row.name)
        .toSorted(),
    );
    expect(columns).toEqual([
      "avatar_key",
      "display_name",
      "email",
      "first_seen_at",
      "id",
      "kind",
      "last_seen_at",
      "name",
      "notify",
      "tz",
    ]);
  });

  it("answers an error envelope when a query fails, not a bare 500", async () => {
    // A broken schema stands in for any bug inside the object: the client must still get the one
    // envelope the contract defines, with no stack trace in it.
    const stub = workspace(`internal-${crypto.randomUUID()}`);
    await stub.fetch(new Request("https://chat/gatekeeper/chat/api/me", { headers: IDENTITY }));
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(`DROP TABLE messages`);
    });
    const response = await stub.fetch(
      new Request("https://chat/gatekeeper/chat/api/channels/general/messages", { headers: IDENTITY }),
    );
    expect(response.status).toBe(500);
    const body = (await response.json()) as ErrorEnvelope;
    expect(body.error.code).toBe("internal");
    expect(body.error.message).not.toContain("messages");
  });

  it("rejects an invalid notify level at the database level", async () => {
    const stub = workspace(`check-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      expect(() =>
        state.storage.sql.exec(
          `INSERT INTO users (id, name, first_seen_at, last_seen_at, notify) VALUES ('u1', 'U', 0, 0, 'hourly')`,
        ),
      ).toThrow();
    });
  });
});
