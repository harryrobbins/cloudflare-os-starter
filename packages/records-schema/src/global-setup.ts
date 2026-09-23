// vitest globalSetup: one embedded Postgres cluster for the run, shared through `inject`.
import type { TestProject } from "vitest/node";

import { startTestCluster, type TestCluster } from "./testing.ts";

let cluster: TestCluster | undefined;

export async function setup(project: TestProject): Promise<void> {
  cluster = await startTestCluster();
  project.provide("pgSuperuserUrl", cluster.superuserUrl);
}

export async function teardown(): Promise<void> {
  await cluster?.stop();
}

declare module "vitest" {
  export interface ProvidedContext {
    pgSuperuserUrl: string;
  }
}
