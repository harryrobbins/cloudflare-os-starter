// A synthetic organisation on a fresh real Postgres database, built through the service itself.

import postgres, { type Sql } from "postgres";
import { inject } from "vitest";

import type { CallerContext } from "@records/contracts";
import { bootstrapOrganisation } from "@records/schema/bootstrap";
import { createTestDatabase, type TestDatabase } from "@records/schema/testing";

import { connect, RecordsService, type BusHooks, type Db } from "../src/index.js";

export type Person = { id: string; caller: CallerContext };

export type World = {
  db: TestDatabase;
  /** Migration owner: bypasses RLS, used only to inspect. */
  owner: Sql;
  app: Db;
  service: RecordsService;
  orgA: string;
  ada: Person; // data administrator, no membership
  olive: Person; // owner of ds1 and ds2
  ed: Person; // ds1 editor
  rae: Person; // ds1 reader
  nia: Person; // no membership
  ds1: string;
  ds2: string;
  eng: string; // project in ds1
  ops: string; // project in ds2
  close(): Promise<void>;
};

const human = (orgId: string, principalId: string): Person => ({ id: principalId, caller: { orgId, principalId, via: "management" } });

export async function createWorld(opts: { hooks?: BusHooks; max?: number } = {}): Promise<World> {
  const db = await createTestDatabase(inject("pgSuperuserUrl"));
  const owner = postgres(db.ownerUrl, { max: 2, onnotice: () => {} });
  const app = connect(db.appUrl, { max: opts.max ?? 10 });
  const service = new RecordsService(app, opts.hooks);

  const a = await bootstrapOrganisation(owner, { orgName: "Org A", adminEmail: "ada@a.test", adminName: "Ada" });
  const ada = human(a.orgId, a.principalId);
  const invite = async (name: string) =>
    human(a.orgId, (await service.registry.invitePrincipal(ada.caller, { email: `${name.toLowerCase()}@a.test`, displayName: name })).id);
  const [olive, ed, rae, nia] = [await invite("Olive"), await invite("Ed"), await invite("Rae"), await invite("Nia")];

  const ds1 = (await service.registry.createDatastore(ada.caller, {
    name: "Engineering", moduleId: "projects", ownerPrincipalId: olive.id, initialProject: { key: "ENG", name: "Engineering" },
  })).id;
  const ds2 = (await service.registry.createDatastore(ada.caller, {
    name: "Operations", moduleId: "projects", ownerPrincipalId: olive.id, initialProject: { key: "OPS", name: "Operations" },
  })).id;
  await service.registry.addMember(olive.caller, ds1, { principalId: ed.id, role: "editor" });
  await service.registry.addMember(olive.caller, ds1, { principalId: rae.id, role: "reader" });
  await service.registry.addMember(olive.caller, ds2, { principalId: ed.id, role: "editor" });
  const eng = (await service.projects.listProjects(olive.caller, ds1))[0]!.id;
  const ops = (await service.projects.listProjects(olive.caller, ds2))[0]!.id;

  return {
    db, owner, app, service, orgA: a.orgId, ada, olive, ed, rae, nia, ds1, ds2, eng, ops,
    async close() {
      await Promise.all([owner.end(), app.end()]);
    },
  };
}

let counter = 0;
export const key = (label = "k") => `${label}-${Date.now().toString(36)}-${(counter++).toString(36)}`;

export const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
  return "ok";
};

declare module "vitest" {
  export interface ProvidedContext {
    pgSuperuserUrl: string;
  }
}
