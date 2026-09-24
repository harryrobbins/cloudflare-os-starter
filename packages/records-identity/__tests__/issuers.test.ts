import { describe, expect, it } from "vitest";
import { DELEGATED_AUDIENCE, type TrustedIssuer } from "@records/contracts";
import {
  generateSigningKey,
  IdentityError,
  importSigningKey,
  IssuerRegistry,
  localKeySet,
  MemoryReplayGuard,
  mintDelegatedToken,
  publicJwks,
  verifyBearerJwt,
} from "../src/index.js";
import { ACCESS_AUD, ACCESS_ISSUER, accessKey, handToken, ids, ISSUER, memoryFetch, SAAS_AUD, SAAS_ISSUER, secs, T0 } from "./helpers.js";

const ACCESS_JWKS = `${ACCESS_ISSUER}/cdn-cgi/access/certs`;
const DELEGATED_JWKS = `${ISSUER}/.well-known/jwks.json`;

const issuers = (over: Partial<Record<"delegated" | "access" | "saas", Partial<TrustedIssuer>>> = {}): TrustedIssuer[] => [
  { issuer: ISSUER, kind: "delegated", audiences: [DELEGATED_AUDIENCE], jwksUrl: DELEGATED_JWKS, enabled: true, ...over.delegated },
  { issuer: ACCESS_ISSUER, kind: "access", audiences: [ACCESS_AUD], jwksUrl: ACCESS_JWKS, enabled: true, ...over.access },
  { issuer: SAAS_ISSUER, kind: "access_saas", audiences: [SAAS_AUD], jwksUrl: ACCESS_JWKS, enabled: true, ...over.saas },
];

async function refusal(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(IdentityError);
    return (err as IdentityError).reason;
  }
  throw new Error("expected a refusal");
}

async function world(over?: Parameters<typeof issuers>[0]) {
  const team = await accessKey("team-1");
  const signer = await importSigningKey(await generateSigningKey());
  const net = memoryFetch({ [ACCESS_JWKS]: { keys: [team.jwk] }, [DELEGATED_JWKS]: publicJwks([signer]) });
  const replay = new MemoryReplayGuard({ now: () => T0 });
  const registry = new IssuerRegistry(issuers(over), { replay, fetch: net.fetch, jwksCacheMaxAgeMs: 0, jwksCooldownMs: 0 });
  const iat = secs(T0);
  const accessUser = (over: Record<string, unknown> = {}) =>
    team.sign({ iss: ACCESS_ISSUER, aud: [ACCESS_AUD], sub: "7a1b0f7e-0000-4000-8000-000000000001", email: "ada@example.test", iat, nbf: iat, exp: iat + 300, type: "app", ...over });
  return { team, signer, net, replay, registry, accessUser, iat };
}

describe("IssuerRegistry", () => {
  it("rejects duplicate and invalid issuer rows", () => {
    const rows = issuers();
    expect(() => new IssuerRegistry([...rows, rows[0]!])).toThrow(/Duplicate/);
    expect(() => new IssuerRegistry([{ ...rows[0]!, audiences: [] }])).toThrow();
  });

  it("fetches each JWKS URL through the injected fetch, once per URL", async () => {
    const { net, registry, accessUser } = await world({ access: {}, saas: {} });
    await verifyBearerJwt(await accessUser(), registry, { now: T0 });
    expect(net.calls).toEqual([ACCESS_JWKS]);
  });
});

describe("Access", () => {
  it("verifies a user assertion to an oidc identity with email", async () => {
    const { registry, accessUser } = await world();
    await expect(verifyBearerJwt(await accessUser(), registry, { now: T0 })).resolves.toEqual({
      kind: "oidc",
      issuer: ACCESS_ISSUER,
      subject: "7a1b0f7e-0000-4000-8000-000000000001",
      email: "ada@example.test",
      subjectType: "user",
    });
  });

  it("surfaces a service token's common_name as the subject", async () => {
    const { registry, accessUser } = await world();
    const token = await accessUser({ sub: "", email: undefined, common_name: "abc123.access" });
    await expect(verifyBearerJwt(token, registry, { now: T0 })).resolves.toEqual({
      kind: "oidc",
      issuer: ACCESS_ISSUER,
      subject: "abc123.access",
      subjectType: "service_token",
    });
  });

  it("refuses an assertion with neither sub nor common_name", async () => {
    const { registry, accessUser } = await world();
    expect(await refusal(verifyBearerJwt(await accessUser({ sub: "", email: undefined }), registry, { now: T0 }))).toBe("invalid_claims");
  });

  it("refuses wrong audience, expiry, and a key outside the team JWKS", async () => {
    const { registry, accessUser, iat } = await world();
    expect(await refusal(verifyBearerJwt(await accessUser({ aud: ["other-app"] }), registry, { now: T0 }))).toBe("wrong_audience");
    expect(await refusal(verifyBearerJwt(await accessUser({ exp: iat - 60 }), registry, { now: T0 }))).toBe("expired");
    const rogue = await accessKey("team-1");
    const forged = await rogue.sign({ iss: ACCESS_ISSUER, aud: [ACCESS_AUD], sub: "x", iat, exp: iat + 300 });
    expect(await refusal(verifyBearerJwt(forged, registry, { now: T0 }))).toBe("bad_signature");
  });

  it("refuses HS256 keyed with the published key and alg none", async () => {
    const { registry, team, iat } = await world();
    const payload = { iss: ACCESS_ISSUER, aud: [ACCESS_AUD], sub: "x", email: "a@b.test", iat, exp: iat + 300 };
    const hs = await handToken({ alg: "HS256", kid: "team-1" }, payload, new TextEncoder().encode(JSON.stringify(team.jwk)));
    expect(await refusal(verifyBearerJwt(hs, registry, { now: T0 }))).toBe("wrong_alg");
    const none = await handToken({ alg: "none" }, payload);
    expect(await refusal(verifyBearerJwt(none, registry, { now: T0 }))).toBe("wrong_alg");
  });

  it("refuses unknown and disabled issuers", async () => {
    const { registry, accessUser } = await world({ access: { enabled: false } });
    expect(await refusal(verifyBearerJwt(await accessUser(), registry, { now: T0 }))).toBe("unknown_issuer");
    expect(await refusal(verifyBearerJwt(await accessUser({ iss: "https://evil.cloudflareaccess.com" }), registry, { now: T0 }))).toBe("unknown_issuer");
  });

  it("refuses an issuer kind not allowed at the entry point", async () => {
    const { registry, accessUser } = await world();
    expect(await refusal(verifyBearerJwt(await accessUser(), registry, { now: T0, kinds: ["delegated", "access_saas"] }))).toBe("kind_not_allowed");
  });

  it("maps an unreachable JWKS to unavailable", async () => {
    const team = await accessKey("team-1");
    const registry = new IssuerRegistry(issuers(), { fetch: async () => { throw new TypeError("network down"); } });
    const iat = secs(T0);
    const token = await team.sign({ iss: ACCESS_ISSUER, aud: [ACCESS_AUD], sub: "x", iat, exp: iat + 300 });
    try {
      await verifyBearerJwt(token, registry, { now: T0 });
      throw new Error("expected refusal");
    } catch (err) {
      expect((err as IdentityError).reason).toBe("jwks_unavailable");
      expect((err as IdentityError).code).toBe("unavailable");
    }
  });
});

describe("Access for SaaS", () => {
  it("verifies an OIDC token for the configured client", async () => {
    const { registry, team, iat } = await world();
    const token = await team.sign({ iss: SAAS_ISSUER, aud: SAAS_AUD, sub: "user-1", email: "ada@example.test", iat, exp: iat + 300 });
    await expect(verifyBearerJwt(token, registry, { now: T0 })).resolves.toMatchObject({ kind: "oidc", issuer: SAAS_ISSUER, subject: "user-1", email: "ada@example.test" });
  });

  it("refuses a SaaS token whose iss is the Access issuer but aud is the SaaS client", async () => {
    const { registry, team, iat } = await world();
    const token = await team.sign({ iss: ACCESS_ISSUER, aud: SAAS_AUD, sub: "user-1", iat, exp: iat + 300 });
    expect(await refusal(verifyBearerJwt(token, registry, { now: T0 }))).toBe("wrong_audience");
  });
});

describe("delegated through the registry", () => {
  const mint = (signer: Awaited<ReturnType<typeof importSigningKey>>, datastoreId = ids.datastore) =>
    mintDelegatedToken(signer, { issuer: ISSUER, principalId: ids.principal, orgId: ids.org, datastoreId, bindingId: ids.binding, scopes: ["issues.read"], now: T0 });

  it("verifies via the remote JWKS and enforces replay and datastore", async () => {
    const { registry, signer } = await world();
    const token = await mint(signer);
    await expect(verifyBearerJwt(token, registry, { now: T0, expectedDatastoreId: ids.datastore })).resolves.toMatchObject({ kind: "delegated", datastoreId: ids.datastore });
    expect(await refusal(verifyBearerJwt(token, registry, { now: T0 }))).toBe("replayed");
    expect(await refusal(verifyBearerJwt(await mint(signer, ids.otherDatastore), registry, { now: T0, expectedDatastoreId: ids.datastore }))).toBe("datastore_mismatch");
  });

  it("key rotation through the published JWKS: old kid works while listed, fails once removed", async () => {
    const { registry, signer, net } = await world();
    const next = await importSigningKey(await generateSigningKey());
    net.docs[DELEGATED_JWKS] = publicJwks([next, signer]);
    await expect(verifyBearerJwt(await mint(signer), registry, { now: T0 })).resolves.toBeTruthy();
    await expect(verifyBearerJwt(await mint(next), registry, { now: T0 })).resolves.toBeTruthy();
    net.docs[DELEGATED_JWKS] = publicJwks([next]);
    expect(await refusal(verifyBearerJwt(await mint(signer), registry, { now: T0 }))).toBe("no_matching_key");
    await expect(verifyBearerJwt(await mint(next), registry, { now: T0 })).resolves.toBeTruthy();
  });

  it("refuses an Access-signed token claiming the delegated issuer", async () => {
    const { registry, team, iat } = await world();
    const token = await team.sign({ iss: ISSUER, aud: DELEGATED_AUDIENCE, sub: ids.principal, iat, exp: iat + 60 }, { typ: "records-delegated+jwt" });
    expect(await refusal(verifyBearerJwt(token, registry, { now: T0 }))).toBe("wrong_alg");
  });

  it("refuses delegated tokens when no replay guard is configured", async () => {
    const signer = await importSigningKey(await generateSigningKey());
    const registry = new IssuerRegistry(issuers(), { keySets: { [ISSUER]: localKeySet(publicJwks([signer])) } });
    expect(await refusal(verifyBearerJwt(await mint(signer), registry, { now: T0 }))).toBe("replay_unavailable");
  });
});
