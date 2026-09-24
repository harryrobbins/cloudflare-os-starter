// The SDK tests' server: records-node's contract world (database, credentials, test Access issuer)
// and a Node server over it. Imported by relative path: the SDK has no runtime dependency on the
// service packages.

import { inject } from "vitest";

import { startContractStack, type ContractStack } from "../../records-node/__tests__/support/world.ts";

export type { ContractStack };

export function startServer(): Promise<ContractStack> {
  return startContractStack(inject("pgSuperuserUrl"));
}
