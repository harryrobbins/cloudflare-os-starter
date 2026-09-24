// The contract suite against the Node server, over real HTTP.

import { afterAll, beforeAll, inject } from "vitest";

import { defineContractSuite } from "./contract/suite.js";
import { startContractStack, type ContractStack } from "./support/world.js";

let stack: ContractStack;

beforeAll(async () => {
  stack = await startContractStack(inject("pgSuperuserUrl"));
});
afterAll(async () => stack?.close());

defineContractSuite(() => stack.target("node"));
