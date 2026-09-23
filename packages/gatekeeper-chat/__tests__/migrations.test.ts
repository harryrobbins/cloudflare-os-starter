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

  it("upgrades an object at version 2, the previous release, to the agent outbox without touching its data", async () => {
    // Stands in for the deployed object: everything version 2 wrote is there, version 3's table is
    // not, and the recorded version says 2.
    const stub = workspace(`upgrade-${crypto.randomUUID()}`);
    await stub.fetch(new Request("https://chat/gatekeeper/chat/api/me", { headers: IDENTITY }));
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO messages (id, channel_id, seq, author_id, body, kind, created_at)
         VALUES ('m_old', 'general', 1, 'alice', 'from before', 'user', 1)`,
      );
      state.storage.sql.exec(`DROP TABLE agent_requests`);
      state.storage.sql.exec(`UPDATE schema_meta SET value = 2 WHERE key = 'schema_version'`);

      expect(runMigrations(state.storage)).toBe(TARGET_SCHEMA_VERSION);
      const tables = state.storage.sql
        .exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_requests'`)
        .toArray();
      expect(tables).toHaveLength(1);
      const kept = state.storage.sql.exec<{ body: string }>(`SELECT body FROM messages WHERE id = 'm_old'`).toArray();
      expect(kept).toEqual([{ body: "from before" }]);
      const users = state.storage.sql.exec<{ id: string }>(`SELECT id FROM users ORDER BY id`).toArray();
      expect(users.map((row) => row.id)).toEqual(["agent", "alice"]);
    });
  });

  it("leaves versions 1 and 2 as they were released: version 3 only adds", () => {
    // An applied migration is never edited. Their descriptions are the cheapest fingerprint of that.
    expect(MIGRATIONS.slice(0, 2).map((migration) => migration.description)).toEqual([
      "users and the schema version record",
      "channels, memberships, messages with FTS, threads, reactions, attachments, limits",
    ]);
    expect(MIGRATIONS[2]?.description).toBe("the agent outbox: one row per question to the Agent");
  });

  it("rejects an invalid agent request state at the database level", async () => {
    const stub = workspace(`agent-check-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      expect(() =>
        state.storage.sql.exec(
          `INSERT INTO agent_requests (message_id, channel_id, requester_id, caller_account, chat_key,
                                       prompt, state, created_at, updated_at)
           VALUES ('m1', 'general', 'u1', 'u1@x', 'k', '', 'thinking', 0, 0)`,
        ),
      ).toThrow();
    });
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
