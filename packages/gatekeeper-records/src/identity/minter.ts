// Minting delegated tokens for the gadget gatekeeper (canonical plan §5): one 60-second, single-use
// token per gadget call, `sub` = the principal the call acts for, `act` = the gadget's binding,
// `scope` = the binding's scopes, `ds` = its datastore.

import { mintDelegatedToken } from "@records/identity";

import type { DelegationKeys } from "./keys.js";

export type DelegatedGrantInput = { principalId: string; orgId: string; datastoreId: string; bindingId: string; scopes: readonly string[] };

export async function mintFor(keys: DelegationKeys, grant: DelegatedGrantInput, now?: number): Promise<string> {
  return mintDelegatedToken(keys.current, { issuer: keys.issuer, ...grant, ...(now !== undefined ? { now } : {}) });
}
