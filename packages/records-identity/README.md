# @records/identity

> **Legacy implementation; not migrated.** This package still targets the earlier Projects runtime.
> The standards-based service is implemented separately in [records-service](../records-service/README.md)
> and is deployed at [records.surprisingly.ltd](https://records.surprisingly.ltd).
> See the [current direction](../../docs/plans/external_datastores/records-direction.md) and
> [homeserver deployment record](../records-service/deploy/homeserver.md).
> Routes, credentials, schemas, sync and operator steps below apply to this legacy implementation;
> they are not a deployment or migration runbook for the current service.

Credential verification for the portable Records datastore service (canonical Postgres plan §5). It
uses Web Crypto and `jose` only, so it runs on Workers and Node. It does not touch a database: the
principal lookup through `records.identity_mappings` belongs to the integrator.

## Delegated token format

The cloudflare-os Records gatekeeper mints one per gadget call, after it redeems a viewer assertion.

```text
header  { "alg": "ES256", "typ": "records-delegated+jwt", "kid": "<RFC 7638 thumbprint>" }
payload { "iss": "<gatekeeper issuer URL>", "sub": "<viewer principal uuid>",
          "aud": "records-datastore", "iat": 1790000000, "exp": 1790000060,
          "jti": "<22-char random base64url, single use>",
          "org": "<org uuid>", "ds": "<datastore uuid>", "scope": "issues.read issues.write",
          "act": { "sub": "<binding uuid>", "kind": "binding" } }
```

The claims are exactly `DelegatedClaimsSchema` from `@records/contracts`. Verification accepts only
ES256 with that `typ` and a `kid`. It checks `iss` and `aud`, and allows 5 s of clock skew by default
(capped at 30 s). It refuses a token whose `exp - iat` is longer than 60 s plus that skew, and claims
that do not parse. When `expectedDatastoreId` is set, a token for another datastore is refused as
`forbidden`. The `jti` is claimed in the replay guard last, so a token refused for another reason does
not use up its id.

## Precedence

`parseAuthorization` and `resolveCaller` read one credential per request:

1. `Authorization: Bearer <JWT>`: a delegated token or an Access for SaaS token.
2. `Authorization: Bearer rk1_…`, or `Basic base64(email:rk1_…)` for Jira clients. Basic with any
   other password is refused.
3. `Cf-Access-Jwt-Assertion`: an Access application, for a user or a service token.

If an `Authorization` header is present, the Access header is ignored, because an rk1 client may sit
behind an Access service token. If the `Authorization` header is invalid, the request is refused. It
never falls back to the Access header.

## Refusals

Each failure is an `IdentityError`, a subclass of `RecordsError`. Its `reason` is for logs only:

- `unauthenticated` (401): the credential is missing, malformed, expired, replayed, or from the wrong
  issuer or audience.
- `forbidden` (403): the delegated token is for another datastore.
- `unavailable` (503): the JWKS or the replay store cannot be reached. Both fail closed.

## Integrator responsibilities

- **Signing key.** Run `generateSigningKey()` once from an operator script and store the JSON as a
  Worker secret. The suggested name is `RECORDS_DELEGATION_SIGNING_KEY`. When rotating, keep the
  previous public key in the JWKS for at least 60 s plus the verifiers' JWKS cache lifetime.
  `RECORDS_DELEGATION_PREVIOUS_KEYS` could hold the old public JWKs.
- **JWKS route.** Serve `publicJwks([current, ...previous])` at
  `/gatekeeper/records/.well-known/jwks.json`, with a short `Cache-Control`, such as
  `max-age=300`.
- **Issuer table.** Load `records.trusted_issuers` rows (`TrustedIssuer`) and build one
  `IssuerRegistry` per isolate, so JWKS caching works. Create one row per exact `iss`:
  - The delegated row uses the gatekeeper issuer URL, audience `records-datastore` and the JWKS
    route above.
  - The Access row uses `https://<team>.cloudflareaccess.com`, the application AUD tag, and
    `…/cdn-cgi/access/certs`.
  - The Access for SaaS row uses the OIDC issuer from the SaaS application, which ends in
    `/cdn-cgi/access/sso/oidc/<client id>`, with the client ID as the audience.
- **Shared replay store.** `MemoryReplayGuard` works within one isolate only. Production needs a
  shared `ReplayGuard`, such as a Postgres table or a Durable Object. `src/replay.ts` gives the
  table, the single-statement claim and the cleanup query.
- **Principal lookup.** Map `delegated` identities by checking that the org, datastore, binding and
  membership are still active. Map `oidc` identities through `identity_mappings (issuer, subject)`.
  For an Access service token, `subject` is its `common_name` and `subjectType` is
  `"service_token"`. Pass `credential` identities to `authenticateCredential`. You can pass these
  lookups as `resolveCaller(..., { lookup })`.
