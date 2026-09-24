import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { DATASTORE_ROLES, ModuleManifestSchema, ROLE_PERMISSIONS } from "@records/contracts";

import { projectsModuleManifest } from "../src/manifest.ts";
import { loadMigrations, migrate, plan, status } from "../src/migrate.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";

const quiet = { onnotice: () => {} } as const;

// Fixed synthetic identifiers.
const ORG_A = "00000000-0000-4000-8000-00000000000a";
const ORG_B = "00000000-0000-4000-8000-00000000000b";
const ALICE = "00000000-0000-4000-8000-0000000a11ce";
const BOB = "00000000-0000-4000-8000-0000000000b0";
const DS_A1 = "00000000-0000-4000-8000-0000000000a1";
const DS_A2 = "00000000-0000-4000-8000-0000000000a2";
const DS_B1 = "00000000-0000-4000-8000-0000000000b1";
const PROJ_A1 = "00000000-0000-4000-8000-000000000a01";
const PROJ_A2 = "00000000-0000-4000-8000-000000000a02";

let db: TestDatabase;
let owner: Sql;
let app: Sql;
let publisher: Sql;

async function seed(sql: Sql) {
  await sql.unsafe(`
    INSERT INTO records.organisations (id, name) VALUES ('${ORG_A}', 'Org A'), ('${ORG_B}', 'Org B');
    INSERT INTO records.principals (org_id, id, kind, display_name) VALUES
      ('${ORG_A}', '${ALICE}', 'human', 'Alice'), ('${ORG_B}', '${BOB}', 'human', 'Bob');
    INSERT INTO records.datastores (org_id, id, name, module_id, api_major, owner_principal_id, retention_policy, created_by) VALUES
      ('${ORG_A}', '${DS_A1}', 'A1', 'projects', 1, '${ALICE}', 'keep', '${ALICE}'),
      ('${ORG_A}', '${DS_A2}', 'A2', 'projects', 1, '${ALICE}', 'keep', '${ALICE}'),
      ('${ORG_B}', '${DS_B1}', 'B1', 'projects', 1, '${BOB}', 'keep', '${BOB}');
    INSERT INTO projects.workflow_states (org_id, datastore_id, key, name, category, position) VALUES
      ('${ORG_A}', '${DS_A1}', 'todo', 'To do', 'todo', 0),
      ('${ORG_A}', '${DS_A2}', 'todo', 'To do', 'todo', 0);
    INSERT INTO records.memberships (org_id, datastore_id, principal_id, role, granted_by) VALUES
      ('${ORG_A}', '${DS_A1}', '${ALICE}', 'editor', '${ALICE}'),
      ('${ORG_A}', '${DS_A2}', '${ALICE}', 'editor', '${ALICE}');
  `);
  // Journaled rows need their journal entry in the same transaction.
  for (const [ds, id, key] of [[DS_A1, PROJ_A1, "ENG"], [DS_A2, PROJ_A2, "OPS"]] as const) {
    await sql.begin(async (tx) => {
      const [{ seq }] = (await tx`UPDATE records.datastore_clock SET seq = seq + 1 WHERE datastore_id = ${ds} RETURNING seq`) as unknown as [{ seq: string }];
      await tx`INSERT INTO projects.projects (org_id, datastore_id, id, key, name, created_by, updated_by, last_seq)
               VALUES (${ORG_A}, ${ds}, ${id}, ${key}, ${key}, ${ALICE}, ${ALICE}, ${seq})`;
      await tx`INSERT INTO records.journal (org_id, datastore_id, seq, ordinal, change_id, command, command_id, entity_type, entity_id,
                                            entity_rev, op, after, actor_id, via)
               VALUES (${ORG_A}, ${ds}, ${seq}, 0, gen_random_uuid(), 'projects.createProject', gen_random_uuid(), 'project', ${id},
                       1, 'create', ${tx.json({ key, name: key, description: "" })}, ${ALICE}, 'system')`;
    });
  }
}

/** Run `fn` as the app role inside a transaction with the given trusted context (Alice by default). */
async function asApp<T>(org: string | null, datastore: string | null, fn: (tx: Sql) => Promise<T>,
                        principal: string | null = ALICE, scopes = "*", binding: string | null = null): Promise<T> {
  return (await app.begin(async (tx) => {
    if (org) await tx`SELECT set_config('records.org_id', ${org}, true)`;
    if (datastore) await tx`SELECT set_config('records.datastore_id', ${datastore}, true)`;
    if (principal) await tx`SELECT set_config('records.principal_id', ${principal}, true), set_config('records.scopes', ${scopes}, true)`;
    if (binding) await tx`SELECT set_config('records.binding_id', ${binding}, true)`;
    return fn(tx as unknown as Sql);
  })) as T;
}

beforeAll(async () => {
  db = await createTestDatabase(inject("pgSuperuserUrl"));
  owner = postgres(db.ownerUrl, { max: 2, ...quiet });
  app = postgres(db.appUrl, { max: 4, ...quiet });
  publisher = postgres(db.publisherUrl, { max: 2, ...quiet });
  await seed(owner);
});

afterAll(async () => {
  await Promise.all([owner?.end(), app?.end(), publisher?.end()]);
});

describe("migration runner", () => {
  it("applies from empty and is then up to date", async () => {
    const fresh = await createTestDatabase(inject("pgSuperuserUrl"), false);
    const sql = postgres(fresh.ownerUrl, { max: 2, ...quiet });
    try {
      expect((await status(sql)).every((m) => m.state === "pending")).toBe(true);
      expect(await migrate(sql)).toEqual(loadMigrations().map((m) => m.id));
      expect(await migrate(sql)).toEqual([]);
    } finally {
      await sql.end();
    }
  });

  it("serialises concurrent runners with the lock", async () => {
    const fresh = await createTestDatabase(inject("pgSuperuserUrl"), false);
    const a = postgres(fresh.ownerUrl, { max: 1, ...quiet });
    const b = postgres(fresh.ownerUrl, { max: 1, ...quiet });
    try {
      const [ra, rb] = await Promise.all([migrate(a), migrate(b)]);
      expect([...ra, ...rb].toSorted()).toEqual(loadMigrations().map((m) => m.id));
    } finally {
      await Promise.all([a.end(), b.end()]);
    }
  });

  it("refuses edited, missing and out-of-order migrations", () => {
    const files = loadMigrations();
    const applied = files.map(({ id, checksum }) => ({ id, checksum }));
    expect(() => plan(files, [{ ...applied[0]!, checksum: "0".repeat(64) }])).toThrow(/edited/);
    expect(() => plan(files.slice(1), applied)).toThrow(/missing/);
    const inserted = [{ id: "0000_early", sql: "", checksum: "x" }, ...files];
    expect(() => plan(inserted, applied.slice(0, 1))).toThrow(/out of order/);
    expect(plan(files, applied.slice(0, 1)).map((m) => m.id)).toEqual(files.slice(1).map((m) => m.id));
  });

  it("rolls back a failing migration with its ledger row", async () => {
    const fresh = await createTestDatabase(inject("pgSuperuserUrl"), false);
    const sql = postgres(fresh.ownerUrl, { max: 1, ...quiet });
    try {
      const bad = [...loadMigrations(), { id: "9999_broken", sql: "CREATE TABLE records.x (a int); SELECT 1/0;", checksum: "f".repeat(64) }];
      await expect(migrate(sql, bad)).rejects.toThrow(/9999_broken failed/);
      const [row] = await sql`SELECT to_regclass('records.x') AS t, (SELECT count(*) FROM records_meta.schema_migrations WHERE id = '9999_broken') AS n`;
      expect(row).toEqual({ t: null, n: "0" });
    } finally {
      await sql.end();
    }
  });

  it("produces a manifest matching the contract", () => {
    expect(ModuleManifestSchema.parse(projectsModuleManifest()).migrations).toHaveLength(loadMigrations().length);
  });
});

describe("privileges", () => {
  it("runtime roles own nothing and cannot bypass RLS", async () => {
    const rows = await owner`
      SELECT r.rolname, r.rolbypassrls, r.rolsuper, r.rolcreaterole,
             (SELECT count(*) FROM pg_class c WHERE c.relowner = r.oid) AS owned
        FROM pg_roles r WHERE r.rolname IN ('records_app', 'records_publisher', 'records_app_login', 'records_publisher_login')`;
    expect(rows).toHaveLength(4);
    for (const r of rows) expect(r).toMatchObject({ rolbypassrls: false, rolsuper: false, rolcreaterole: false, owned: "0" });
  });

  it("the app role cannot run DDL", async () => {
    await expect(app`CREATE TABLE records.evil (a int)`).rejects.toThrow(/permission denied/);
    await expect(app`CREATE TABLE public.evil (a int)`).rejects.toThrow(/permission denied/);
    await expect(app`ALTER TABLE projects.issues DISABLE ROW LEVEL SECURITY`).rejects.toThrow(/must be owner/);
  });

  it("audit is append-only for the app role", async () => {
    await asApp(ORG_A, null, (tx) => tx`
      INSERT INTO records.audit_events (org_id, id, operation, actor_principal_id, via, summary)
      VALUES (${ORG_A}, gen_random_uuid(), 'test', ${ALICE}, 'system', 'x')`);
    await expect(asApp(ORG_A, null, (tx) => tx`UPDATE records.audit_events SET summary = 'y'`)).rejects.toThrow(/permission denied/);
    await expect(asApp(ORG_A, null, (tx) => tx`DELETE FROM records.audit_events`)).rejects.toThrow(/permission denied/);
  });

  it("the app role cannot read or settle the outbox", async () => {
    await expect(asApp(ORG_A, DS_A1, (tx) => tx`SELECT * FROM records.outbox`)).rejects.toThrow(/permission denied/);
    await expect(asApp(ORG_A, DS_A1, (tx) => tx`UPDATE records.outbox SET state = 'published'`)).rejects.toThrow(/permission denied/);
  });

  it("the publisher cannot touch business records", async () => {
    await expect(publisher`SELECT * FROM projects.issues`).rejects.toThrow(/permission denied/);
    await expect(publisher`SELECT * FROM records.memberships`).rejects.toThrow(/permission denied/);
  });

  it("every tenant table has RLS and every exemption is declared", async () => {
    const rows = await owner`
      SELECT n.nspname || '.' || c.relname AS name, c.relrowsecurity AS rls,
             obj_description(c.oid, 'pg_class') AS note
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind = 'r' AND n.nspname IN ('records', 'projects')`;
    const unprotected = rows.filter((r) => !r.rls && r.note !== "records:module-global");
    expect(unprotected.map((r) => r.name)).toEqual([]);
  });

  it("security definer functions pin search_path and are not public", async () => {
    const rows = await owner`
      SELECT p.proname, p.proconfig, has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'records' AND p.prosecdef`;
    expect(rows.map((r) => r.proname).toSorted()).toEqual([
      "can_any", "claim_delegated_token", "create_datastore_clock", "ensure_journal_partitions", "prune_delegated_token_uses", "require_journal_entry",
      "resolve_credential", "resolve_identity",
    ]);
    for (const r of rows) {
      expect(r.public_exec).toBe(false);
      expect(r.proconfig).toContain("search_path=pg_catalog, records");
    }
  });
});

describe("row-level security", () => {
  it("denies everything when no context is set", async () => {
    expect(await asApp(null, null, (tx) => tx`SELECT id FROM records.datastores`)).toHaveLength(0);
    expect(await asApp(null, null, (tx) => tx`SELECT id FROM projects.projects`)).toHaveLength(0);
  });

  it("scopes registry rows to the organisation", async () => {
    const a = await asApp(ORG_A, null, (tx) => tx`SELECT id FROM records.datastores ORDER BY id`);
    expect(a.map((r) => r.id)).toEqual([DS_A1, DS_A2]);
    const b = await asApp(ORG_B, null, (tx) => tx`SELECT id FROM records.datastores`);
    expect(b.map((r) => r.id)).toEqual([DS_B1]);
  });

  it("scopes module rows to the datastore, even with a missing predicate", async () => {
    const rows = await asApp(ORG_A, DS_A1, (tx) => tx`SELECT id FROM projects.projects`);
    expect(rows.map((r) => r.id)).toEqual([PROJ_A1]);
    // Right org, wrong datastore context: the other dataset's rows are invisible.
    const other = await asApp(ORG_A, DS_A2, (tx) => tx`SELECT id FROM projects.projects WHERE id = ${PROJ_A1}`);
    expect(other).toHaveLength(0);
    // Mismatched org/datastore pair sees nothing.
    expect(await asApp(ORG_B, DS_A1, (tx) => tx`SELECT id FROM projects.projects`)).toHaveLength(0);
  });

  it("rejects writes outside the context", async () => {
    await expect(asApp(ORG_A, DS_A1, (tx) => tx`
      INSERT INTO projects.projects (org_id, datastore_id, id, key, name, created_by, updated_by)
      VALUES (${ORG_A}, ${DS_A2}, gen_random_uuid(), 'XX', 'x', ${ALICE}, ${ALICE})`)).rejects.toThrow(/row-level security/);
    await expect(asApp(ORG_A, null, (tx) => tx`
      INSERT INTO records.principals (org_id, id, kind, display_name) VALUES (${ORG_B}, gen_random_uuid(), 'human', 'Mallory')`))
      .rejects.toThrow(/row-level security/);
  });

  it("an UPDATE cannot touch another datastore's rows", async () => {
    const res = await asApp(ORG_A, DS_A1, (tx) => tx`UPDATE projects.projects SET name = 'pwned' WHERE id = ${PROJ_A2}`);
    expect(res.count).toBe(0);
  });

  it("context is transaction-local and cleared after commit or rollback", async () => {
    const conn = await app.reserve();
    try {
      await conn.unsafe("BEGIN");
      await conn`SELECT set_config('records.org_id', ${ORG_A}, true)`;
      expect(await conn`SELECT id FROM records.datastores`).toHaveLength(2);
      await conn.unsafe("COMMIT");
      expect((await conn`SELECT records.current_org() AS o`)[0]!.o).toBeNull();
      await conn.unsafe("BEGIN");
      await conn`SELECT set_config('records.org_id', ${ORG_A}, true)`;
      await conn.unsafe("ROLLBACK");
      expect((await conn`SELECT records.current_org() AS o`)[0]!.o).toBeNull();
      expect(await conn`SELECT id FROM records.datastores`).toHaveLength(0);
    } finally {
      conn.release();
    }
  });
});

describe("integrity", () => {
  it("rejects a cross-datastore reference even for the owner role", async () => {
    await expect(owner`
      INSERT INTO projects.issues (org_id, datastore_id, id, project_id, number, title, state, created_by, updated_by, last_seq)
      VALUES (${ORG_A}, ${DS_A2}, gen_random_uuid(), ${PROJ_A1}, 1, 't', 'todo', ${ALICE}, ${ALICE}, 1)`).rejects.toThrow(/foreign key/);
  });

  it("rejects a cross-organisation principal reference", async () => {
    await expect(owner`
      INSERT INTO records.memberships (org_id, datastore_id, principal_id, role, granted_by)
      VALUES (${ORG_A}, ${DS_A1}, ${BOB}, 'reader', ${ALICE})`).rejects.toThrow(/foreign key/);
  });

  it("tenant keys are immutable", async () => {
    await expect(owner`UPDATE records.datastores SET org_id = ${ORG_B} WHERE id = ${DS_A1}`).rejects.toThrow(/immutable/);
    await expect(owner`UPDATE projects.projects SET datastore_id = ${DS_A2} WHERE id = ${PROJ_A1}`).rejects.toThrow(/immutable|foreign key/);
  });

  it("allows one owner membership per datastore", async () => {
    const dan = crypto.randomUUID();
    await owner`INSERT INTO records.principals (org_id, id, kind, display_name) VALUES (${ORG_A}, ${dan}, 'human', 'Dan')`;
    await owner`INSERT INTO records.memberships (org_id, datastore_id, principal_id, role, granted_by) VALUES (${ORG_A}, ${DS_A1}, ${dan}, 'owner', ${ALICE})`;
    const carol = crypto.randomUUID();
    await owner`INSERT INTO records.principals (org_id, id, kind, display_name) VALUES (${ORG_A}, ${carol}, 'human', 'Carol')`;
    await expect(owner`INSERT INTO records.memberships (org_id, datastore_id, principal_id, role, granted_by) VALUES (${ORG_A}, ${DS_A1}, ${carol}, 'owner', ${ALICE})`)
      .rejects.toThrow(/memberships_one_owner/);
  });
});

describe("journal and clock (0003)", () => {
  it("backfills a clock and a create entry for rows that predate the journal", async () => {
    const fresh = await createTestDatabase(inject("pgSuperuserUrl"), false);
    const sql = postgres(fresh.ownerUrl, { max: 1, ...quiet });
    try {
      const files = loadMigrations();
      await migrate(sql, files.slice(0, 2));
      const issue = crypto.randomUUID();
      const comment = crypto.randomUUID();
      await sql.unsafe(`
        INSERT INTO records.organisations (id, name) VALUES ('${ORG_A}', 'Org A');
        INSERT INTO records.principals (org_id, id, kind, display_name) VALUES ('${ORG_A}', '${ALICE}', 'human', 'Alice');
        INSERT INTO records.datastores (org_id, id, name, module_id, api_major, owner_principal_id, retention_policy, created_by)
          VALUES ('${ORG_A}', '${DS_A1}', 'A1', 'projects', 1, '${ALICE}', 'keep', '${ALICE}');
        INSERT INTO projects.workflow_states (org_id, datastore_id, key, name, category, position) VALUES ('${ORG_A}', '${DS_A1}', 'todo', 'To do', 'todo', 0);
        INSERT INTO projects.projects (org_id, datastore_id, id, key, name, created_by, updated_by) VALUES ('${ORG_A}', '${DS_A1}', '${PROJ_A1}', 'ENG', 'Eng', '${ALICE}', '${ALICE}');
        INSERT INTO projects.issues (org_id, datastore_id, id, project_id, number, title, state, created_by, updated_by, revision)
          VALUES ('${ORG_A}', '${DS_A1}', '${issue}', '${PROJ_A1}', 1, 'Old', 'todo', '${ALICE}', '${ALICE}', 3);
        INSERT INTO projects.comments (org_id, datastore_id, id, issue_id, body, author_id) VALUES ('${ORG_A}', '${DS_A1}', '${comment}', '${issue}', 'hi', '${ALICE}');
      `);
      await migrate(sql);
      const [clock] = await sql`SELECT seq FROM records.datastore_clock WHERE datastore_id = ${DS_A1}`;
      expect(clock!.seq).toBe("3");
      const entries = await sql`SELECT seq, entity_type, entity_id, entity_rev, op, after, via FROM records.journal ORDER BY seq`;
      expect(entries.map((e) => [e.seq, e.entity_type, e.entity_id, e.entity_rev, e.op, e.via])).toEqual([
        ["1", "project", PROJ_A1, 1, "create", "system"],
        ["2", "issue", issue, 3, "create", "system"],
        ["3", "comment", comment, 1, "create", "system"],
      ]);
      expect(entries[1]!.after).toMatchObject({ key: "ENG-1", title: "Old", state: "todo", assigneeId: null, customFields: {} });
      const seqs = await sql`
        SELECT (SELECT last_seq FROM projects.projects) AS p, (SELECT last_seq FROM projects.issues) AS i, (SELECT last_seq FROM projects.comments) AS c`;
      expect(seqs[0]).toEqual({ p: "1", i: "2", c: "3" });
    } finally {
      await sql.end();
    }
  });

  it("gives every new datastore a clock at zero", async () => {
    const ds = crypto.randomUUID();
    await owner`INSERT INTO records.datastores (org_id, id, name, module_id, api_major, owner_principal_id, retention_policy, created_by)
                VALUES (${ORG_A}, ${ds}, 'New', 'projects', 1, ${ALICE}, 'keep', ${ALICE})`;
    expect((await owner`SELECT seq FROM records.datastore_clock WHERE datastore_id = ${ds}`)[0]!.seq).toBe("0");
  });

  it("the journal is append-only: no UPDATE or DELETE privilege, and a trigger for any role granted one", async () => {
    await expect(asApp(ORG_A, DS_A1, (tx) => tx`UPDATE records.journal SET via = 'system'`)).rejects.toThrow(/permission denied/);
    await expect(asApp(ORG_A, DS_A1, (tx) => tx`DELETE FROM records.journal`)).rejects.toThrow(/permission denied/);
    const role = `journal_tamper_${crypto.randomUUID().slice(0, 8)}`;
    await owner.unsafe(`CREATE ROLE ${role} NOLOGIN`);
    await owner.unsafe(`GRANT USAGE ON SCHEMA records TO ${role}; GRANT SELECT, UPDATE, DELETE ON records.journal TO ${role}`);
    await owner.unsafe(`CREATE POLICY tamper ON records.journal TO ${role} USING (true) WITH CHECK (true)`);
    try {
      for (const stmt of ["UPDATE records.journal SET via = 'system'", "DELETE FROM records.journal"]) {
        await expect(owner.begin(async (tx) => {
          await tx.unsafe(`SET LOCAL ROLE ${role}`);
          await tx.unsafe(stmt);
        })).rejects.toThrow(/append-only/);
      }
    } finally {
      await owner.unsafe(`DROP POLICY tamper ON records.journal; REVOKE ALL ON records.journal FROM ${role}; REVOKE ALL ON SCHEMA records FROM ${role}; DROP ROLE ${role}`);
    }
  });

  it("refuses a content change that does not advance last_seq, even for the owner", async () => {
    await expect(owner`UPDATE projects.projects SET name = 'Silent' WHERE id = ${PROJ_A1}`).rejects.toThrow(/advance last_seq/);
    // The issue-number allocator is bookkeeping, not content.
    await owner`UPDATE projects.projects SET next_issue_number = next_issue_number WHERE id = ${PROJ_A1}`;
  });

  it("the publisher maintains partitions ahead and rescues rows that landed in the default partition", async () => {
    const created = await publisher`SELECT records.ensure_journal_partitions(3) AS n`;
    expect(created[0]!.n).toBe(0); // the migration already did it
    const far = new Date();
    far.setUTCMonth(far.getUTCMonth() + 6, 15);
    await owner.begin(async (tx) => {
      await tx`INSERT INTO records.journal (org_id, datastore_id, seq, ordinal, change_id, command, command_id, entity_type, entity_id,
                                            entity_rev, op, after, actor_id, via, occurred_at)
               VALUES (${ORG_A}, ${DS_A2}, 999, 0, gen_random_uuid(), 'system.test', gen_random_uuid(), 'project', gen_random_uuid(),
                       1, 'create', '{}', ${ALICE}, 'system', ${far})`;
    });
    const where = () => owner`SELECT tableoid::regclass::text AS part FROM records.journal WHERE seq = 999 AND datastore_id = ${DS_A2}`;
    expect((await where())[0]!.part).toBe("records.journal_default");
    expect((await publisher`SELECT records.ensure_journal_partitions(6) AS n`)[0]!.n).toBe(3);
    expect((await where())[0]!.part).toMatch(/^records\.journal_\d{4}m\d{2}$/);
    await expect(publisher`SELECT records.ensure_journal_partitions(99)`).rejects.toThrow(/between 0 and 24/);
    await expect(app`SELECT records.ensure_journal_partitions(1)`).rejects.toThrow(/permission denied/);
  });
});

describe("principal row-level security (0004)", () => {
  it("records.role_permissions mirrors ROLE_PERMISSIONS in the contracts", async () => {
    const rows = await owner`SELECT role, permission FROM records.role_permissions ORDER BY role, permission`;
    const fromDb = Object.fromEntries(DATASTORE_ROLES.map((r) => [r, rows.filter((x) => x.role === r).map((x) => x.permission as string).toSorted()]));
    const fromContracts = Object.fromEntries(DATASTORE_ROLES.map((r) => [r, [...ROLE_PERMISSIONS[r]].toSorted()]));
    expect(fromDb).toEqual(fromContracts);
  });

  it("a principal with no membership sees no module rows and cannot write them", async () => {
    const mallory = crypto.randomUUID();
    await owner`INSERT INTO records.principals (org_id, id, kind, display_name) VALUES (${ORG_A}, ${mallory}, 'human', 'Mallory')`;
    expect(await asApp(ORG_A, DS_A1, (tx) => tx`SELECT id FROM projects.projects`, mallory)).toHaveLength(0);
    expect(await asApp(ORG_A, DS_A1, (tx) => tx`SELECT key FROM projects.workflow_states`, mallory)).toHaveLength(0);
    expect(await asApp(ORG_A, DS_A1, (tx) => tx`SELECT seq FROM records.journal`, mallory)).toHaveLength(0);
    await expect(asApp(ORG_A, DS_A1, (tx) => tx`
      INSERT INTO projects.workflow_states (org_id, datastore_id, key, name, category, position) VALUES (${ORG_A}, ${DS_A1}, 'x', 'X', 'todo', 9)`, mallory))
      .rejects.toThrow(/row-level security/);
    // No principal at all: nothing.
    expect(await asApp(ORG_A, DS_A1, (tx) => tx`SELECT id FROM projects.projects`, null)).toHaveLength(0);
  });

  it("scopes narrow the role: '*' is unnarrowed, a list narrows, empty means nothing", async () => {
    expect(await asApp(ORG_A, DS_A1, (tx) => tx`SELECT id FROM projects.projects`, ALICE, "*")).toHaveLength(1);
    expect(await asApp(ORG_A, DS_A1, (tx) => tx`SELECT id FROM projects.projects`, ALICE, "projects.read")).toHaveLength(1);
    expect(await asApp(ORG_A, DS_A1, (tx) => tx`SELECT seq FROM records.journal`, ALICE, "projects.read")).toHaveLength(0);
    expect(await asApp(ORG_A, DS_A1, (tx) => tx`SELECT seq FROM records.journal`, ALICE, "issues.read")).toHaveLength(1);
    expect(await asApp(ORG_A, DS_A1, (tx) => tx`SELECT id FROM projects.projects`, ALICE, "")).toHaveLength(0);
    // Scopes never widen: an editor claiming a management scope still cannot add workflow states.
    await expect(asApp(ORG_A, DS_A1, (tx) => tx`
      INSERT INTO projects.workflow_states (org_id, datastore_id, key, name, category, position) VALUES (${ORG_A}, ${DS_A1}, 'y', 'Y', 'todo', 9)`, ALICE, "projects.manage"))
      .rejects.toThrow(/row-level security/);
  });

  it("a binding narrows to its stored scopes and stops working when revoked", async () => {
    const binding = crypto.randomUUID();
    await owner`INSERT INTO records.bindings (org_id, datastore_id, id, kind, label, principal_id, scopes, created_by)
                VALUES (${ORG_A}, ${DS_A1}, ${binding}, 'gadget', 'Board', ${ALICE}, ${["projects.read"]}, ${ALICE})`;
    expect(await asApp(ORG_A, DS_A1, (tx) => tx`SELECT id FROM projects.projects`, ALICE, "*", binding)).toHaveLength(1);
    expect(await asApp(ORG_A, DS_A1, (tx) => tx`SELECT seq FROM records.journal`, ALICE, "*", binding)).toHaveLength(0);
    // Bound to another datastore: nothing there.
    expect(await asApp(ORG_A, DS_A2, (tx) => tx`SELECT id FROM projects.projects`, ALICE, "*", binding)).toHaveLength(0);
    await owner`UPDATE records.bindings SET status = 'revoked', revoked_at = now() WHERE id = ${binding}`;
    expect(await asApp(ORG_A, DS_A1, (tx) => tx`SELECT id FROM projects.projects`, ALICE, "*", binding)).toHaveLength(0);
  });

  it("trusted issuers are readable by the service and changed only by the owner", async () => {
    await owner`INSERT INTO records.trusted_issuers (issuer, kind, audiences, jwks_url)
                VALUES ('https://records.example/gatekeeper', 'delegated', ${["records-datastore"]}, 'https://records.example/.well-known/jwks.json')`;
    const rows = await app`SELECT issuer, kind, audiences, enabled FROM records.trusted_issuers`;
    expect(rows[0]).toEqual({ issuer: "https://records.example/gatekeeper", kind: "delegated", audiences: ["records-datastore"], enabled: true });
    await expect(app`UPDATE records.trusted_issuers SET enabled = false`).rejects.toThrow(/permission denied/);
    await expect(owner`INSERT INTO records.trusted_issuers (issuer, kind, audiences, jwks_url) VALUES ('https://x.example', 'delegated', '{}', 'https://x.example/j')`)
      .rejects.toThrow(/check constraint/);
  });
});
