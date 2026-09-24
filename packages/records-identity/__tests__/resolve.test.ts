import { describe, expect, it } from "vitest";
import { DELEGATED_AUDIENCE, RecordsError, type TrustedIssuer } from "@records/contracts";
import { generateSigningKey, importSigningKey, IssuerRegistry, localKeySet, MemoryReplayGuard, mintDelegatedToken, publicJwks, resolveCaller } from "../src/index.js";
import { ACCESS_AUD, ACCESS_ISSUER, accessKey, ids, ISSUER, SAAS_AUD, SAAS_ISSUER, secs, T0 } from "./helpers.js";

const RK1 = `rk1_${"0123456789abcdef".repeat(2)}_${"A".repeat(43)}`;

async function world() {
  const team = await accessKey("team-1");
  const signer = await importSigningKey(await generateSigningKey());
  const rows: TrustedIssuer[] = [
    { issuer: ISSUER, kind: "delegated", audiences: [DELEGATED_AUDIENCE], jwksUrl: `${ISSUER}/.well-known/jwks.json`, enabled: true },
    { issuer: ACCESS_ISSUER, kind: "access", audiences: [ACCESS_AUD], jwksUrl: `${ACCESS_ISSUER}/cdn-cgi/access/certs`, enabled: true },
    { issuer: SAAS_ISSUER, kind: "access_saas", audiences: [SAAS_AUD], jwksUrl: `${ACCESS_ISSUER}/cdn-cgi/access/certs`, enabled: true },
  ];
  const teamSet = localKeySet({ keys: [team.jwk] });
  const registry = new IssuerRegistry(rows, {
    replay: new MemoryReplayGuard({ now: () => T0 }),
    keySets: { [ISSUER]: localKeySet(publicJwks([signer])), [ACCESS_ISSUER]: teamSet, [SAAS_ISSUER]: teamSet },
  });
  const iat = secs(T0);
  const access = () => team.sign({ iss: ACCESS_ISSUER, aud: [ACCESS_AUD], sub: "u1", email: "ada@example.test", iat, exp: iat + 300 });
  const delegated = (datastoreId = ids.datastore) =>
    mintDelegatedToken(signer, { issuer: ISSUER, principalId: ids.principal, orgId: ids.org, datastoreId, bindingId: ids.binding, scopes: ["issues.read"], now: T0 });
  return { registry, access, delegated };
}

describe("resolveCaller", () => {
  it("resolves a delegated bearer token", async () => {
    const { registry, delegated } = await world();
    const r = await resolveCaller(new Headers({ authorization: `Bearer ${await delegated()}` }), { registry, now: T0, expectedDatastoreId: ids.datastore });
    expect(r).toMatchObject({ ok: true, source: "bearer_jwt", identity: { kind: "delegated", principalId: ids.principal } });
  });

  it("resolves rk1 bearer and Basic credentials without a database", async () => {
    const { registry } = await world();
    expect(await resolveCaller(new Headers({ authorization: `Bearer ${RK1}` }), { registry })).toEqual({ ok: true, source: "bearer_credential", identity: { kind: "credential", credentialToken: RK1 } });
    const b = await resolveCaller(new Headers({ authorization: `Basic ${btoa(`ada@example.test:${RK1}`)}` }), { registry });
    expect(b).toEqual({ ok: true, source: "basic", identity: { kind: "credential", credentialToken: RK1 }, basicEmail: "ada@example.test" });
  });

  it("resolves the Access assertion when there is no Authorization header", async () => {
    const { registry, access } = await world();
    const r = await resolveCaller(new Headers({ "cf-access-jwt-assertion": await access() }), { registry, now: T0 });
    expect(r).toMatchObject({ ok: true, source: "access", identity: { kind: "oidc", subject: "u1", email: "ada@example.test" } });
  });

  it("does not accept an Access assertion as a bearer token, nor a delegated token in the Access header", async () => {
    const { registry, access, delegated } = await world();
    const a = await resolveCaller(new Headers({ authorization: `Bearer ${await access()}` }), { registry, now: T0 });
    expect(a).toMatchObject({ ok: false, reason: "kind_not_allowed" });
    const d = await resolveCaller(new Headers({ "cf-access-jwt-assertion": await delegated() }), { registry, now: T0 });
    expect(d).toMatchObject({ ok: false, reason: "kind_not_allowed" });
  });

  it("does not fall back to the Access header when Authorization is invalid", async () => {
    const { registry, access } = await world();
    const r = await resolveCaller(new Headers({ authorization: "Bearer junk", "cf-access-jwt-assertion": await access() }), { registry, now: T0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("unauthenticated");
  });

  it("maps refusals to unauthenticated vs forbidden", async () => {
    const { registry, delegated } = await world();
    const none = await resolveCaller(new Headers(), { registry });
    expect(none).toMatchObject({ ok: false, reason: "missing" });
    if (!none.ok) expect(none.error.status).toBe(401);
    const other = await resolveCaller(new Headers({ authorization: `Bearer ${await delegated(ids.otherDatastore)}` }), { registry, now: T0, expectedDatastoreId: ids.datastore });
    expect(other).toMatchObject({ ok: false, reason: "datastore_mismatch" });
    if (!other.ok) expect(other.error.status).toBe(403);
  });

  it("runs an injected lookup and honours its refusals", async () => {
    const { registry } = await world();
    const headers = new Headers({ authorization: `Bearer ${RK1}` });
    const found = await resolveCaller(headers, { registry, lookup: async () => ({ principalId: ids.principal }) });
    expect(found).toMatchObject({ ok: true, principal: { principalId: ids.principal } });
    const missing = await resolveCaller(headers, { registry, lookup: async () => null });
    expect(missing).toMatchObject({ ok: false, reason: "lookup_refused" });
    if (!missing.ok) expect(missing.error.code).toBe("unauthenticated");
    const forbidden = await resolveCaller(headers, { registry, lookup: async () => { throw new RecordsError("forbidden", "suspended"); } });
    if (!forbidden.ok) expect(forbidden.error.code).toBe("forbidden");
    else throw new Error("expected refusal");
  });
});
