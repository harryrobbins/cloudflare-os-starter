import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { ModuleManifestSchema } from "@records/contracts";

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
    INSERT INTO projects.projects (org_id, datastore_id, id, key, name, created_by, updated_by) VALUES
      ('${ORG_A}', '${DS_A1}', '${PROJ_A1}', 'ENG', 'Engineering', '${ALICE}', '${ALICE}'),
      ('${ORG_A}', '${DS_A2}', '${PROJ_A2}', 'OPS', 'Ops', '${ALICE}', '${ALICE}');
  `);
}

/** Run `fn` as the app role inside a transaction with the given trusted context. */
async function asApp<T>(org: string | null, datastore: string | null, fn: (tx: Sql) => Promise<T>): Promise<T> {
  return (await app.begin(async (tx) => {
    if (org) await tx`SELECT set_config('records.org_id', ${org}, true)`;
    if (datastore) await tx`SELECT set_config('records.datastore_id', ${datastore}, true)`;
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
    expect(rows.map((r) => r.proname).toSorted()).toEqual(["resolve_credential", "resolve_identity"]);
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
      INSERT INTO projects.issues (org_id, datastore_id, id, project_id, number, title, state, created_by, updated_by)
      VALUES (${ORG_A}, ${DS_A2}, gen_random_uuid(), ${PROJ_A1}, 1, 't', 'todo', ${ALICE}, ${ALICE})`).rejects.toThrow(/foreign key/);
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
    await owner`INSERT INTO records.memberships (org_id, datastore_id, principal_id, role, granted_by) VALUES (${ORG_A}, ${DS_A1}, ${ALICE}, 'owner', ${ALICE})`;
    const carol = crypto.randomUUID();
    await owner`INSERT INTO records.principals (org_id, id, kind, display_name) VALUES (${ORG_A}, ${carol}, 'human', 'Carol')`;
    await expect(owner`INSERT INTO records.memberships (org_id, datastore_id, principal_id, role, granted_by) VALUES (${ORG_A}, ${DS_A1}, ${carol}, 'owner', ${ALICE})`)
      .rejects.toThrow(/memberships_one_owner/);
  });
});
