// Identity at the service boundary: delegated-token keys and minting (the gatekeeper side), the
// ServiceAuthenticator (the datastore side) and the in-process client between them.

export { ServiceAuthenticator, TrustedIssuerCache, TRUSTED_ISSUER_TTL_MS, type Authenticated, type AuthenticateOptions, type AuthRefusal, type ServiceAuthenticatorOptions } from "./authenticator.js";
export { DatastoreHandle, DelegatedDatastoreClient, type DatastoreWriteResult } from "./client.js";
export { delegationIssuer, delegationKeys, FALLBACK_ISSUER, JWKS_PATH, jwksResponse, type DelegationEnv, type DelegationKeys } from "./keys.js";
export { mintFor, type DelegatedGrantInput } from "./minter.js";
