// A synthetic two-organisation world on a fresh real Postgres database.

import postgres, { type Sql } from "postgres";
import { inject } from "vitest";


import type { CallerContext } from "@records/contracts";
import { bootstrapOrganisation } from "@records/schema/bootstrap";
import { createTestDatabase, type TestDatabase } from "@records/schema/testing";

import type { Db } from "../src/db/context.ts";
import { connect, RecordsService } from "../src/domain/service.ts";

export type Person = { id: string; caller: CallerContext; email: string };

export type World = {
  db: TestDatabase;
  owner: Sql;
  app: Db;
  service: RecordsService;
  orgA: string;
  orgB: string;
  /** Org A data administrator (not a member of any datastore). */
  ada: Person;
  olive: Person; // DS1 owner
  adam: Person; // DS1 admin
  ed: Person; // DS1 editor
  rae: Person; // DS1 reader
  nia: Person; // org A, no membership
  bea: Person; // org B data administrator
  ds1: string;
  ds2: string; // org A, owned by olive, discovery = organisation
  dsB: string; // org B
  eng: string; // project in DS1
  close(): Promise<void>;
};

const human = (orgId: string, principalId: string, email: string): Person => ({
  id: principalId,
  email,
  caller: { orgId, principalId, via: "management" },
});

export function createWorld(): Promise<World> {
  return createWorldAt(inject("pgSuperuserUrl"));
}

export async function createWorldAt(superuserUrl: string): Promise<World> {
  const db = await createTestDatabase(superuserUrl);
  const owner = postgres(db.ownerUrl, { max: 2, onnotice: () => {} });
  const app = connect(db.appUrl, { max: 10 });
  const service = new RecordsService(app);

  const a = await bootstrapOrganisation(owner, { orgName: "Org A", adminEmail: "ada@a.test", adminName: "Ada" });
  const b = await bootstrapOrganisation(owner, { orgName: "Org B", adminEmail: "bea@b.test", adminName: "Bea" });
  const ada = human(a.orgId, a.principalId, "ada@a.test");
  const bea = human(b.orgId, b.principalId, "bea@b.test");

  const invite = async (name: string) => {
    const email = `${name.toLowerCase()}@a.test`;
    const p = await service.registry.invitePrincipal(ada.caller, { email, displayName: name });
    return human(a.orgId, p.id, email);
  };
  const [olive, adam, ed, rae, nia] = [await invite("Olive"), await invite("Adam"), await invite("Ed"), await invite("Rae"), await invite("Nia")];

  const ds1 = (await service.registry.createDatastore(ada.caller, {
    name: "Engineering projects", moduleId: "projects", ownerPrincipalId: olive.id, initialProject: { key: "ENG", name: "Engineering" },
  })).id;
  const ds2 = (await service.registry.createDatastore(ada.caller, {
    name: "Operations", description: "secret ops description", moduleId: "projects", ownerPrincipalId: olive.id, discovery: "organisation",
  })).id;
  const dsB = (await service.registry.createDatastore(bea.caller, { name: "B data", moduleId: "projects", ownerPrincipalId: bea.id })).id;

  await service.registry.addMember(olive.caller, ds1, { principalId: adam.id, role: "admin" });
  await service.registry.addMember(olive.caller, ds1, { principalId: ed.id, role: "editor" });
  await service.registry.addMember(olive.caller, ds1, { principalId: rae.id, role: "reader" });
  const eng = (await service.projects.listProjects(olive.caller, ds1))[0]!.id;

  return {
    db, owner, app, service, orgA: a.orgId, orgB: b.orgId, ada, olive, adam, ed, rae, nia, bea, ds1, ds2, dsB, eng,
    async close() {
      await Promise.all([owner.end(), app.end()]);
    },
  };
}

declare module "vitest" {
  export interface ProvidedContext {
    pgSuperuserUrl: string;
  }
}

let counter = 0;
export const key = (label = "k") => `${label}-${Date.now().toString(36)}-${(counter++).toString(36)}`;
