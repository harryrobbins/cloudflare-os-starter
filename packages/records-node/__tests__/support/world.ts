// The contract suite's world and stack: one migrated database with an organisation, a Projects
// datastore (plus a second one the credentials cannot reach), write and read-only credentials, a
// test Access issuer, and a Node server over that database. Used by records-node's own tests, by
// the workerd run (which points Miniflare's Hyperdrive at the same database), and by the SDK tests.

import postgres from "postgres";

import { bootstrapOrganisation } from "@records/schema/bootstrap";
import { createTestDatabase, type TestDatabase } from "@records/schema/testing";
import { connect, RecordsService } from "@records/core";

import { createRecordsServer, type RecordsServer, type RecordsServerOptions } from "../../src/index.js";
import type { ContractTarget, ContractWorldInfo } from "../contract/target.js";
import { startTestAccess, type TestAccess } from "./access.js";

export type ContractWorld = ContractWorldInfo & { db: TestDatabase; close(): Promise<void> };

const WRITE_SCOPES = ["projects.read", "issues.read", "issues.create", "issues.edit", "issues.transition", "comments.create", "audit.read"] as const;

/** A fresh database with the contract world in it. */
export async function createContractWorld(superuserUrl: string): Promise<ContractWorld> {
  const db = await createTestDatabase(superuserUrl);
  const owner = postgres(db.ownerUrl, { max: 1, onnotice: () => {} });
  const app = connect(db.appUrl, { max: 2 });
  try {
    const service = new RecordsService(app);
    const org = await bootstrapOrganisation(owner, { orgName: "Contract org", adminEmail: "ada@contract.test", adminName: "Ada" });
    const admin = { orgId: org.orgId, principalId: org.principalId, via: "management" as const };
    const olive = await service.registry.invitePrincipal(admin, { email: "olive@contract.test", displayName: "Olive" });
    const oliveCaller = { orgId: org.orgId, principalId: olive.id, via: "management" as const };
    const ds = await service.registry.createDatastore(admin, {
      name: "Contract projects", moduleId: "projects", ownerPrincipalId: olive.id, initialProject: { key: "CON", name: "Contract" },
    });
    const other = await service.registry.createDatastore(admin, { name: "Elsewhere", moduleId: "projects", ownerPrincipalId: olive.id });
    const project = (await service.projects.listProjects(oliveCaller, ds.id))[0]!;
    const write = await service.registry.createCredential(oliveCaller, ds.id, { label: "Contract suite", scopes: [...WRITE_SCOPES], expiresInDays: 7 });
    const readOnly = await service.registry.createCredential(oliveCaller, ds.id, { label: "Contract read-only", scopes: ["projects.read", "issues.read"], expiresInDays: 7 });
    return {
      db,
      datastoreId: ds.id,
      otherDatastoreId: other.id,
      projectId: project.id,
      projectKey: project.key,
      ownerEmail: "olive@contract.test",
      credential: write.secret,
      readOnlyCredential: readOnly.secret,
      async close() {},
    };
  } finally {
    await Promise.all([owner.end(), app.end()]);
  }
}

export type ContractStack = {
  world: ContractWorld;
  access: TestAccess;
  node: RecordsServer;
  /** The Node server's base URL. */
  baseUrl: string;
  /** A contract target over real HTTP to the Node server. */
  target(name?: string): Promise<ContractTarget>;
  close(): Promise<void>;
};

/** World + test Access issuer + a listening Node server over the world's database. */
export async function startContractStack(superuserUrl: string, opts: Partial<RecordsServerOptions> = {}): Promise<ContractStack> {
  const world = await createContractWorld(superuserUrl);
  const access = await startTestAccess();
  const node = await createRecordsServer({
    databaseUrl: world.db.appUrl,
    access: { issuer: access.issuer, audience: access.audience },
    rateLimit: false,
    ...opts,
  });
  const baseUrl = await node.listen(0, "127.0.0.1");
  return {
    world,
    access,
    node,
    baseUrl,
    async target(name = "node") {
      return { ...worldInfo(world), name, baseUrl, fetch: (request) => fetch(request), accessAssertion: await access.sign() };
    },
    async close() {
      await node.close();
      await access.close();
      await world.close();
    },
  };
}

export function worldInfo(world: ContractWorld): ContractWorldInfo {
  const { db: _db, close: _close, ...info } = world;
  return info;
}

declare module "vitest" {
  export interface ProvidedContext {
    pgSuperuserUrl: string;
  }
}
