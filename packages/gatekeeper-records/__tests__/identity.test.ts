// The service boundary (src/identity): delegated tokens minted by the gatekeeper and verified by the
// ServiceAuthenticator, trusted issuers over HTTP (delegated and Access for SaaS), and the credential
// rules. Real Postgres (replay guard, bindings, identity mappings); keys generated per run.

import { base64url, exportJWK, generateKeyPair, importJWK, SignJWT, type JWK } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DELEGATED_AUDIENCE } from "@records/contracts";
import { generateSigningKey, mintDelegatedToken, type PrivateSigningJwk } from "@records/identity";

import { API_PREFIX, handleApi, type ApiDeps } from "../src/http/api.ts";
import { ServiceAuthenticator, TrustedIssuerCache } from "../src/identity/authenticator.ts";
import { DelegatedDatastoreClient } from "../src/identity/client.ts";
import { delegationIssuer, delegationKeys, jwksResponse, type DelegationEnv, type DelegationKeys } from "../src/identity/keys.ts";
import { mintFor } from "../src/identity/minter.ts";
import { createWorld, type World } from "./world.ts";

const BASE = "https://records.example.test";
const ISSUER = `${BASE}/gatekeeper/records`;
const SAAS_ISSUER = "https://team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/client123";
const SAAS_JWKS = "https://team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/client123/jwks";
const SCOPES = ["projects.read", "issues.read", "issues.create", "issues.edit", "issues.transition", "comments.create"] as const;

let w: World;
let jwk: PrivateSigningJwk;
let env: DelegationEnv;
let keys: DelegationKeys;
let bindingId: string;
let cache: TrustedIssuerCache;
let saas: { jwk: JWK; sign(payload: Record<string, unknown>): Promise<string> };
let credential: string;

const authenticator = () => new ServiceAuthenticator({ service: w.service, keys: () => delegationKeys(env), cache });
const grant = (over: Partial<{ principalId: string; datastoreId: string; bindingId: string; scopes: readonly string[] }> = {}) => ({
  principalId: w.ed.id, orgId: w.orgA, datastoreId: w.ds1, bindingId, scopes: SCOPES, ...over,
});

beforeAll(async () => {
  w = await createWorld();
  jwk = await generateSigningKey();
  env = { PUBLIC_BASE_URL: `${BASE}/some/path/`, RECORDS_DELEGATION_SIGNING_KEY: JSON.stringify(jwk) };
  keys = await delegationKeys(env);
  bindingId = (await w.service.registry.createGadgetBinding({ ...w.ed.caller, via: "gadget" }, w.ds1, { label: "Board", scopes: [...SCOPES] }, "acct-ed")).id;
  credential = (await w.service.registry.createCredential(w.olive.caller, w.ds1, { label: "CI", scopes: ["projects.read", "issues.read"], expiresInDays: 7 })).secret;

  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  saas = {
    jwk: { ...(await exportJWK(publicKey)), kid: "saas-1", alg: "RS256", use: "sig" },
    sign: (payload) => new SignJWT(payload).setProtectedHeader({ alg: "RS256", kid: "saas-1" }).setIssuedAt().setExpirationTime("5m").sign(privateKey),
  };
  cache = new TrustedIssuerCache(0, async (url: string) => {
    if (url === SAAS_JWKS) return new Response(JSON.stringify({ keys: [saas.jwk] }), { headers: { "content-type": "application/json" } });
    return new Response("not found", { status: 404 });
  });
});
afterAll(async () => w?.close());

describe("keys", () => {
  it("normalises the issuer to the base origin plus /gatekeeper/records", () => {
    expect(keys.issuer).toBe(ISSUER);
    expect(delegationIssuer("https://x.test")).toBe("https://x.test/gatekeeper/records");
    expect(delegationIssuer("")).toBe("http://localhost/gatekeeper/records");
    expect(delegationIssuer("javascript:alert(1)")).toBe("http://localhost/gatekeeper/records");
  });

  it("publishes public keys only, current first, with previous keys from the rotation secret", async () => {
    const previous = await generateSigningKey();
    const res = await jwksResponse({ ...env, RECORDS_DELEGATION_PREVIOUS_KEYS: JSON.stringify({ keys: [{ ...previous }] }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    const body = (await res.json()) as { keys: Record<string, unknown>[] };
    expect(body.keys.map((k) => k.kid)).toEqual([jwk.kid, previous.kid]);
    expect(body.keys.every((k) => !("d" in k))).toBe(true);
  });

  it("without a secret uses an ephemeral key that is never published; a broken secret is an error", async () => {
    const eph = await delegationKeys({ PUBLIC_BASE_URL: BASE });
    expect(eph.ephemeral).toBe(true);
    expect(eph.published).toEqual([]);
    expect(((await (await jwksResponse({ PUBLIC_BASE_URL: BASE })).json()) as { keys: unknown[] }).keys).toEqual([]);
    await expect(delegationKeys({ PUBLIC_BASE_URL: BASE, RECORDS_DELEGATION_SIGNING_KEY: "{\"kty\":\"EC\"}" })).rejects.toThrow(/unusable/);
    expect((await jwksResponse({ PUBLIC_BASE_URL: BASE, RECORDS_DELEGATION_SIGNING_KEY: "nope" })).status).toBe(503);
    // Restore the configured key for the rest of the file.
    keys = await delegationKeys(env);
  });
});

describe("in-process delegated tokens (gatekeeper → service)", () => {
  it("a fresh token opens the datastore as its principal, through its binding", async () => {
    const client = new DelegatedDatastoreClient(authenticator(), w.service);
    const handle = await client.open(await mintFor(keys, grant()), w.ds1);
    expect(handle.principalId).toBe(w.ed.id);
    expect((await handle.listProjects())[0]!.key).toBe("ENG");
    expect(await handle.bindingScopes()).toEqual(expect.arrayContaining([...SCOPES]));
  });

  it("refuses a replayed token", async () => {
    const token = await mintFor(keys, grant());
    await authenticator().verifyDelegated(token, w.ds1);
    await expect(authenticator().verifyDelegated(token, w.ds1)).rejects.toMatchObject({ code: "unauthenticated", reason: "replayed" });
  });

  it("refuses an expired token", async () => {
    const token = await mintFor(keys, grant(), Date.now() - 120_000);
    await expect(authenticator().verifyDelegated(token, w.ds1)).rejects.toMatchObject({ code: "unauthenticated", reason: "expired" });
  });

  it("refuses a re-scoped token: an edited claim breaks the signature", async () => {
    const token = await mintFor(keys, grant({ scopes: ["projects.read"] }));
    const [h, p, s] = token.split(".");
    const claims = JSON.parse(new TextDecoder().decode(base64url.decode(p!)));
    claims.scope = "projects.read issues.read issues.create audit.read";
    const forged = `${h}.${base64url.encode(JSON.stringify(claims))}.${s}`;
    await expect(authenticator().verifyDelegated(forged, w.ds1)).rejects.toMatchObject({ code: "unauthenticated", reason: "bad_signature" });
  });

  it("refuses a validly signed token claiming scopes beyond its binding", async () => {
    const token = await mintFor(keys, grant({ scopes: [...SCOPES, "audit.read"] }));
    await expect(authenticator().verifyDelegated(token, w.ds1)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("refuses a token for the wrong audience, issuer or key", async () => {
    const signer = (await importJWK({ ...jwk }, "ES256")) as CryptoKey;
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: ISSUER, sub: w.ed.id, aud: "someone-else", iat: now, exp: now + 60, jti: crypto.randomUUID().replaceAll("-", ""),
      org: w.orgA, ds: w.ds1, scope: SCOPES.join(" "), act: { sub: bindingId, kind: "binding" },
    };
    const sign = (c: object) => new SignJWT({ ...c }).setProtectedHeader({ alg: "ES256", typ: "records-delegated+jwt", kid: jwk.kid }).sign(signer);
    await expect(authenticator().verifyDelegated(await sign(claims), w.ds1)).rejects.toMatchObject({ reason: "wrong_audience" });
    await expect(authenticator().verifyDelegated(await sign({ ...claims, aud: DELEGATED_AUDIENCE, iss: "https://evil.test/gatekeeper/records" }), w.ds1))
      .rejects.toMatchObject({ reason: "unknown_issuer" });
    const stranger = await generateSigningKey();
    const { importSigningKey } = await import("@records/identity");
    const foreign = await mintDelegatedToken(await importSigningKey(stranger), { issuer: ISSUER, ...grant() });
    await expect(authenticator().verifyDelegated(foreign, w.ds1)).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("refuses a token for another datastore", async () => {
    const token = await mintFor(keys, grant());
    await expect(authenticator().verifyDelegated(token, w.ds2)).rejects.toMatchObject({ code: "forbidden", reason: "datastore_mismatch" });
  });

  it("refuses a still-valid token once its binding is revoked", async () => {
    const b = (await w.service.registry.createGadgetBinding({ ...w.ed.caller, via: "gadget" }, w.ds1, { label: "Soon revoked", scopes: ["projects.read"] }, "acct-revoke")).id;
    const token = await mintFor(keys, grant({ bindingId: b, scopes: ["projects.read"] }));
    await w.service.registry.revokeConnection(w.ed.caller, "acct-revoke");
    await expect(authenticator().verifyDelegated(token, w.ds1)).rejects.toThrow(/revoked/);
  });

  it("refuses a token for a service credential's binding (only gadget bindings delegate)", async () => {
    const [info] = await w.service.registry.listCredentials(w.olive.caller, w.ds1);
    const token = await mintFor(keys, grant({ bindingId: info!.bindingId, principalId: w.olive.id, scopes: ["projects.read"] }));
    await expect(authenticator().verifyDelegated(token, w.ds1)).rejects.toThrow(/revoked/);
  });

  it("the viewer's own rights still apply: a non-member's token reads nothing", async () => {
    const handle = await new DelegatedDatastoreClient(authenticator(), w.service).open(await mintFor(keys, grant({ principalId: w.nia.id })), w.ds1);
    await expect(handle.listProjects()).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("HTTP: trusted issuers", () => {
  let deps: ApiDeps;
  const accessOk = { value: true };
  const get = (path: string, headers: Record<string, string>) =>
    handleApi(new Request(`https://records.test${API_PREFIX}/datastores/${w.ds1}${path}`, { headers }), deps);

  beforeAll(() => {
    deps = { service: w.service, verifyAccess: async () => accessOk.value, authenticator: authenticator() };
  });

  it("with no trusted-issuer rows, every JWT is refused (production today)", async () => {
    await w.owner`DELETE FROM records.trusted_issuers`;
    const res = await get("/projects", { authorization: `Bearer ${await mintFor(keys, grant())}` });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="records"');
  });

  it("credential calls still need the path Access application", async () => {
    accessOk.value = false;
    expect((await get("/projects", { authorization: `Bearer ${credential}` })).status).toBe(401);
    accessOk.value = true;
    expect((await get("/projects", { authorization: `Bearer ${credential}` })).status).toBe(200);
    // Basic is a Jira-surface form only.
    const basic = `Basic ${Buffer.from(`olive@a.test:${credential}`).toString("base64")}`;
    expect((await get("/projects", { authorization: basic })).status).toBe(401);
  });

  it("accepts a delegated token from the trusted row without the Access application, once", async () => {
    await w.owner`INSERT INTO records.trusted_issuers (issuer, kind, audiences, jwks_url)
                  VALUES (${ISSUER}, 'delegated', ${[DELEGATED_AUDIENCE]}, ${`${BASE}/gatekeeper/records/.well-known/jwks.json`})`;
    accessOk.value = false;
    try {
      const token = await mintFor(keys, grant());
      const ok = await get("/projects", { authorization: `Bearer ${token}` });
      expect(ok.status).toBe(200);
      expect((await get("/projects", { authorization: `Bearer ${token}` })).status).toBe(401); // replayed
      const other = await handleApi(new Request(`https://records.test${API_PREFIX}/datastores/${w.ds2}/projects`, {
        headers: { authorization: `Bearer ${await mintFor(keys, grant())}` },
      }), deps);
      expect(other.status).toBe(403);
    } finally {
      accessOk.value = true;
    }
  });

  it("accepts Access for SaaS for a mapped subject only; never provisions", async () => {
    await w.owner`INSERT INTO records.trusted_issuers (issuer, kind, audiences, jwks_url) VALUES (${SAAS_ISSUER}, 'access_saas', ${["client123"]}, ${SAAS_JWKS})`;
    accessOk.value = false;
    try {
      const unknown = await saas.sign({ iss: SAAS_ISSUER, aud: "client123", sub: "user-unmapped", email: "rae@a.test" });
      expect((await get("/projects", { authorization: `Bearer ${unknown}` })).status).toBe(401);
      expect(await w.owner`SELECT 1 FROM records.identity_mappings WHERE issuer = ${SAAS_ISSUER}`).toHaveLength(0);

      await w.owner`INSERT INTO records.identity_mappings (issuer, subject, org_id, principal_id) VALUES (${SAAS_ISSUER}, 'user-rae', ${w.orgA}, ${w.rae.id})`;
      const rae = await saas.sign({ iss: SAAS_ISSUER, aud: "client123", sub: "user-rae", email: "rae@a.test" });
      const res = await get("/projects", { authorization: `Bearer ${rae}` });
      expect(res.status).toBe(200);
      // Rae's own rights apply: a reader cannot write.
      const write = await handleApi(new Request(`https://records.test${API_PREFIX}/datastores/${w.ds1}/issues`, {
        method: "POST",
        headers: { authorization: `Bearer ${rae}`, "content-type": "application/json", "idempotency-key": `k-${crypto.randomUUID()}` },
        body: JSON.stringify({ projectId: w.eng, title: "Reader" }),
      }), deps);
      expect(write.status).toBe(403);

      const wrongAud = await saas.sign({ iss: SAAS_ISSUER, aud: "other-client", sub: "user-rae" });
      expect((await get("/projects", { authorization: `Bearer ${wrongAud}` })).status).toBe(401);
    } finally {
      accessOk.value = true;
    }
  });

  it("a disabled issuer row is not trusted", async () => {
    await w.owner`UPDATE records.trusted_issuers SET enabled = false WHERE issuer = ${SAAS_ISSUER}`;
    const rae = await saas.sign({ iss: SAAS_ISSUER, aud: "client123", sub: "user-rae" });
    expect((await get("/projects", { authorization: `Bearer ${rae}` })).status).toBe(401);
  });
});

describe("credentials", () => {
  it("Basic needs the credential owner's e-mail", async () => {
    const auth = authenticator();
    const basic = (email: string) => new Headers({ authorization: `Basic ${Buffer.from(`${email}:${credential}`).toString("base64")}` });
    const opts = { datastoreId: w.ds1, verifyAccess: async () => true, allowBasic: true };
    expect(await auth.authenticate(basic("OLIVE@a.test"), opts)).toMatchObject({ ok: true, source: "credential" });
    expect(await auth.authenticate(basic("ed@a.test"), opts)).toMatchObject({ ok: false, stage: "credential", reason: "basic_user_mismatch" });
    expect(await auth.authenticate(basic("olive@a.test"), { ...opts, allowBasic: false })).toMatchObject({ ok: false, stage: "credential" });
    expect(await auth.authenticate(basic("olive@a.test"), { ...opts, datastoreId: w.ds2 })).toMatchObject({ ok: false, stage: "datastore" });
  });
});
