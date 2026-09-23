// Seeds the workerd suite's world with plain SQL as the migration owner. It runs at vitest config
// time under Node's own loader, which cannot import the workspace's `.js`-suffixed TypeScript, so it
// uses only records-schema (which imports with `.ts`) and postgres.js.

import postgres from "postgres";

import { bootstrapOrganisation, WORKSHOP_ISSUER } from "../../records-schema/src/bootstrap.ts";
import { createTestDatabase, type TestDatabase } from "../../records-schema/src/testing.ts";

export type WorkerdSeed = {
  db: TestDatabase;
  orgA: string;
  orgB: string;
  ds1: string;
  ds2: string;
  eng: string;
  people: Record<string, { id: string; email: string }>;
};

const STATES = [["backlog", "Backlog", "todo"], ["todo", "To do", "todo"], ["in_progress", "In progress", "in_progress"], ["done", "Done", "done"]] as const;
const TRANSITIONS = [["backlog", "todo"], ["todo", "in_progress"], ["in_progress", "done"], ["done", "todo"]] as const;

export async function seedWorkerdWorld(superuserUrl: string): Promise<WorkerdSeed> {
  const db = await createTestDatabase(superuserUrl);
  const sql = postgres(db.ownerUrl, { max: 1, onnotice: () => {} });
  try {
    const a = await bootstrapOrganisation(sql, { orgName: "Org A", adminEmail: "ada@a.test", adminName: "Ada" });
    const b = await bootstrapOrganisation(sql, { orgName: "Org B", adminEmail: "bea@b.test", adminName: "Bea" });
    const people: WorkerdSeed["people"] = { ada: { id: a.principalId, email: "ada@a.test" }, bea: { id: b.principalId, email: "bea@b.test" } };
    for (const name of ["Olive", "Adam", "Ed", "Rae", "Nia"]) {
      const id = crypto.randomUUID();
      const email = `${name.toLowerCase()}@a.test`;
      await sql`INSERT INTO records.principals (org_id, id, kind, display_name, email) VALUES (${a.orgId}, ${id}, 'human', ${name}, ${email})`;
      await sql`INSERT INTO records.identity_mappings (issuer, subject, org_id, principal_id) VALUES (${WORKSHOP_ISSUER}, ${email}, ${a.orgId}, ${id})`;
      people[name.toLowerCase()] = { id, email };
    }
    const datastore = async (name: string, members: [string, string][]) => {
      const id = crypto.randomUUID();
      await sql`INSERT INTO records.datastores (org_id, id, name, module_id, api_major, owner_principal_id, retention_policy, created_by)
                VALUES (${a.orgId}, ${id}, ${name}, 'projects', 1, ${people.olive!.id}, 'retain-until-deleted', ${a.principalId})`;
      for (const [who, role] of members) {
        await sql`INSERT INTO records.memberships (org_id, datastore_id, principal_id, role, granted_by) VALUES (${a.orgId}, ${id}, ${people[who]!.id}, ${role}, ${a.principalId})`;
      }
      for (const [i, [key, label, category]] of STATES.entries()) {
        await sql`INSERT INTO projects.workflow_states (org_id, datastore_id, key, name, category, position) VALUES (${a.orgId}, ${id}, ${key}, ${label}, ${category}, ${i})`;
      }
      for (const [from, to] of TRANSITIONS) {
        await sql`INSERT INTO projects.workflow_transitions (org_id, datastore_id, from_state, to_state) VALUES (${a.orgId}, ${id}, ${from}, ${to})`;
      }
      return id;
    };
    const ds1 = await datastore("Engineering projects", [["olive", "owner"], ["adam", "admin"], ["ed", "editor"], ["rae", "reader"]]);
    const ds2 = await datastore("Operations", [["olive", "owner"]]);
    const eng = crypto.randomUUID();
    await sql`INSERT INTO projects.projects (org_id, datastore_id, id, key, name, created_by, updated_by)
              VALUES (${a.orgId}, ${ds1}, ${eng}, 'ENG', 'Engineering', ${people.olive!.id}, ${people.olive!.id})`;
    return { db, orgA: a.orgId, orgB: b.orgId, ds1, ds2, eng, people };
  } finally {
    await sql.end();
  }
}
