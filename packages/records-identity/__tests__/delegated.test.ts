import { describe, expect, it } from "vitest";
import { decodeJwt, decodeProtectedHeader, SignJWT } from "jose";
import { DELEGATED_AUDIENCE, DELEGATED_TOKEN_TTL_SECONDS, DelegatedClaimsSchema } from "@records/contracts";
import {
  DELEGATED_TYP,
  generateSigningKey,
  IdentityError,
  importSigningKey,
  localKeySet,
  MemoryReplayGuard,
  mintDelegatedToken,
  publicJwks,
  verifyDelegatedToken,
  type SigningKey,
  type VerifyDelegatedTokenOptions,
} from "../src/index.js";
import { handToken, ids, ISSUER, T0 } from "./helpers.js";

async function setup() {
  const key = await importSigningKey(await generateSigningKey());
  const jwks = publicJwks([key]);
  const replay = new MemoryReplayGuard({ now: () => T0 });
  const opts: VerifyDelegatedTokenOptions = { issuer: ISSUER, keySet: localKeySet(jwks), replay, now: T0 };
  return { key, jwks, replay, opts };
}

const mint = (key: SigningKey, over: Partial<Parameters<typeof mintDelegatedToken>[1]> = {}) =>
  mintDelegatedToken(key, {
    issuer: ISSUER,
    principalId: ids.principal,
    orgId: ids.org,
    datastoreId: ids.datastore,
    bindingId: ids.binding,
    scopes: ["issues.read", "issues.write"],
    now: T0,
    ...over,
  });

async function refusal(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(IdentityError);
    return { reason: (err as IdentityError).reason, code: (err as IdentityError).code };
  }
  throw new Error("expected a refusal");
}

describe("signing keys", () => {
  it("generates a P-256 private JWK with a thumbprint kid and round-trips through JSON", async () => {
    const jwk = await generateSigningKey();
    expect(jwk).toMatchObject({ kty: "EC", crv: "P-256", alg: "ES256" });
    expect(jwk.kid).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const key = await importSigningKey(JSON.stringify(jwk));
    expect(key.kid).toBe(jwk.kid);
    expect(key.privateKey.extractable).toBe(false);
  });

  it("publishes only public material and refuses duplicate kids", async () => {
    const a = await generateSigningKey();
    const b = await importSigningKey(await generateSigningKey());
    const doc = publicJwks([a, b]);
    expect(doc.keys).toHaveLength(2);
    for (const k of doc.keys) {
      expect(k).not.toHaveProperty("d");
      expect(k).toMatchObject({ kty: "EC", crv: "P-256", alg: "ES256", use: "sig" });
    }
    expect(() => publicJwks([a, a])).toThrow(/Duplicate kid/);
  });

  it("rejects keys that are not EC P-256 private JWKs", async () => {
    await expect(importSigningKey("{not json")).rejects.toThrow();
    const jwk = await generateSigningKey();
    const { d: _d, ...pub } = jwk;
    await expect(importSigningKey(pub)).rejects.toThrow();
    const { kid: _kid, ...noKid } = jwk;
    await expect(importSigningKey(noKid)).rejects.toThrow();
  });
});

describe("mint", () => {
  it("produces the frozen claim set with a 60 s TTL and an explicit typ", async () => {
    const { key } = await setup();
    const token = await mint(key);
    const header = decodeProtectedHeader(token);
    expect(header).toEqual({ alg: "ES256", typ: DELEGATED_TYP, kid: key.kid });
    const claims = DelegatedClaimsSchema.parse(decodeJwt(token));
    expect(claims).toMatchObject({
      iss: ISSUER,
      sub: ids.principal,
      aud: DELEGATED_AUDIENCE,
      org: ids.org,
      ds: ids.datastore,
      scope: "issues.read issues.write",
      act: { sub: ids.binding, kind: "binding" },
      iat: Math.floor(T0 / 1000),
    });
    expect(claims.exp - claims.iat).toBe(DELEGATED_TOKEN_TTL_SECONDS);
    expect(Object.keys(decodeJwt(token)).sort()).toEqual(["act", "aud", "ds", "exp", "iat", "iss", "jti", "org", "scope", "sub"]);
  });

  it("uses a fresh jti each time", async () => {
    const { key } = await setup();
    const a = decodeJwt(await mint(key)).jti;
    const b = decodeJwt(await mint(key)).jti;
    expect(a).not.toBe(b);
  });

  it("refuses bad input", async () => {
    const { key } = await setup();
    await expect(mint(key, { principalId: "not-a-uuid" })).rejects.toThrow();
    await expect(mint(key, { scopes: ["has space"] })).rejects.toThrow();
  });
});

describe("verify", () => {
  it("accepts a fresh token once", async () => {
    const { key, opts } = await setup();
    const token = await mint(key);
    const identity = await verifyDelegatedToken(token, { ...opts, expectedDatastoreId: ids.datastore });
    expect(identity).toEqual({
      kind: "delegated",
      issuer: ISSUER,
      principalId: ids.principal,
      orgId: ids.org,
      datastoreId: ids.datastore,
      bindingId: ids.binding,
      scopes: ["issues.read", "issues.write"],
      tokenId: decodeJwt(token).jti,
    });
  });

  it("refuses a replayed token", async () => {
    const { key, opts } = await setup();
    const token = await mint(key);
    await verifyDelegatedToken(token, opts);
    expect(await refusal(verifyDelegatedToken(token, opts))).toEqual({ reason: "replayed", code: "unauthenticated" });
  });

  it("does not burn the jti on a token refused for another reason", async () => {
    const { key, opts } = await setup();
    const token = await mint(key);
    expect((await refusal(verifyDelegatedToken(token, { ...opts, expectedDatastoreId: ids.otherDatastore }))).reason).toBe("datastore_mismatch");
    await expect(verifyDelegatedToken(token, opts)).resolves.toMatchObject({ kind: "delegated" });
  });

  it("refuses an expired token, allowing only the small tolerance", async () => {
    const { key, opts } = await setup();
    const token = await mint(key);
    await expect(verifyDelegatedToken(token, { ...opts, now: T0 + 63_000 })).resolves.toBeTruthy();
    const token2 = await mint(key);
    expect((await refusal(verifyDelegatedToken(token2, { ...opts, now: T0 + 66_000 }))).reason).toBe("expired");
  });

  it("refuses a token issued in the future", async () => {
    const { key, opts } = await setup();
    const token = await mint(key, { now: T0 + 30_000 });
    expect((await refusal(verifyDelegatedToken(token, opts))).reason).toBe("not_yet_valid");
  });

  it("refuses a re-scoped (tampered) payload", async () => {
    const { key, opts } = await setup();
    const token = await mint(key);
    const [h, p, s] = token.split(".");
    const claims = decodeJwt(token);
    const forged = Buffer.from(JSON.stringify({ ...claims, scope: "issues.read issues.write audit.read" })).toString("base64url");
    expect((await refusal(verifyDelegatedToken(`${h}.${forged}.${s}`, opts))).reason).toBe("bad_signature");
    const reDs = Buffer.from(JSON.stringify({ ...claims, ds: ids.otherDatastore })).toString("base64url");
    expect((await refusal(verifyDelegatedToken(`${h}.${reDs}.${s}`, opts))).reason).toBe("bad_signature");
    expect(p).toBeTruthy();
  });

  it("refuses the wrong audience", async () => {
    const { key, opts } = await setup();
    const token = await mint(key);
    expect((await refusal(verifyDelegatedToken(token, { ...opts, audience: "some-other-service" }))).reason).toBe("wrong_audience");
  });

  it("refuses the wrong issuer", async () => {
    const { key, opts } = await setup();
    const token = await mint(key, { issuer: "https://evil.example.test/gatekeeper/records" });
    expect((await refusal(verifyDelegatedToken(token, opts))).reason).toBe("wrong_issuer");
  });

  it("refuses a token for another datastore as forbidden", async () => {
    const { key, opts } = await setup();
    const token = await mint(key, { datastoreId: ids.otherDatastore });
    expect(await refusal(verifyDelegatedToken(token, { ...opts, expectedDatastoreId: ids.datastore }))).toEqual({ reason: "datastore_mismatch", code: "forbidden" });
  });

  it("refuses a token signed by a key that is not in the JWKS", async () => {
    const { opts } = await setup();
    const stranger = await importSigningKey(await generateSigningKey());
    expect((await refusal(verifyDelegatedToken(await mint(stranger), opts))).reason).toBe("no_matching_key");
  });

  it("refuses a validly signed token whose TTL exceeds 60 s", async () => {
    const { key, opts } = await setup();
    const iat = Math.floor(T0 / 1000);
    const token = await new SignJWT({ org: ids.org, ds: ids.datastore, scope: "issues.read", act: { sub: ids.binding, kind: "binding" } })
      .setProtectedHeader({ alg: "ES256", typ: DELEGATED_TYP, kid: key.kid })
      .setIssuer(ISSUER).setSubject(ids.principal).setAudience(DELEGATED_AUDIENCE)
      .setIssuedAt(iat).setExpirationTime(iat + 3600).setJti("a".repeat(22))
      .sign(key.privateKey);
    expect((await refusal(verifyDelegatedToken(token, opts))).reason).toBe("ttl_too_long");
  });

  it("refuses the wrong typ and malformed claims even when correctly signed", async () => {
    const { key, opts } = await setup();
    const iat = Math.floor(T0 / 1000);
    const base = () => new SignJWT({ org: ids.org, ds: ids.datastore, scope: "issues.read", act: { sub: ids.binding, kind: "binding" } })
      .setIssuer(ISSUER).setSubject(ids.principal).setAudience(DELEGATED_AUDIENCE)
      .setIssuedAt(iat).setExpirationTime(iat + 60).setJti("b".repeat(22));
    const jwtTyp = await base().setProtectedHeader({ alg: "ES256", typ: "JWT", kid: key.kid }).sign(key.privateKey);
    expect((await refusal(verifyDelegatedToken(jwtTyp, opts))).reason).toBe("wrong_typ");
    const badClaims = await new SignJWT({ org: "nope", ds: ids.datastore, scope: "issues.read", act: { sub: ids.binding, kind: "binding" } })
      .setIssuer(ISSUER).setSubject(ids.principal).setAudience(DELEGATED_AUDIENCE)
      .setIssuedAt(iat).setExpirationTime(iat + 60).setJti("c".repeat(22))
      .setProtectedHeader({ alg: "ES256", typ: DELEGATED_TYP, kid: key.kid }).sign(key.privateKey);
    expect((await refusal(verifyDelegatedToken(badClaims, opts))).reason).toBe("invalid_claims");
  });

  it("refuses alg confusion: HS256 keyed with the public key, and alg none", async () => {
    const { key, jwks, opts } = await setup();
    const claims = decodeJwt(await mint(key));
    const hs = await handToken({ alg: "HS256", typ: DELEGATED_TYP, kid: key.kid }, claims, new TextEncoder().encode(JSON.stringify(jwks.keys[0])));
    expect((await refusal(verifyDelegatedToken(hs, opts))).reason).toBe("wrong_alg");
    const none = await handToken({ alg: "none", typ: DELEGATED_TYP, kid: key.kid }, claims);
    expect((await refusal(verifyDelegatedToken(none, opts))).reason).toBe("wrong_alg");
  });

  it("refuses garbage without throwing anything but a refusal", async () => {
    const { opts } = await setup();
    for (const junk of ["", "a.b", "a.b.c", "x".repeat(9000), "..."]) {
      expect((await refusal(verifyDelegatedToken(junk, opts))).reason).toBe("malformed");
    }
  });

  it("fails closed when the replay store is unreachable", async () => {
    const { key, opts } = await setup();
    const broken = { claim: async () => { throw new Error("db down"); } };
    expect(await refusal(verifyDelegatedToken(await mint(key), { ...opts, replay: broken }))).toEqual({ reason: "replay_unavailable", code: "unavailable" });
  });

  it("rotation: the old kid verifies while published, and fails once removed", async () => {
    const { replay } = await setup();
    const oldKey = await importSigningKey(await generateSigningKey());
    const newKey = await importSigningKey(await generateSigningKey());
    const both = localKeySet(publicJwks([newKey, oldKey]));
    const onlyNew = localKeySet(publicJwks([newKey]));
    const base = { issuer: ISSUER, replay, now: T0 };
    await expect(verifyDelegatedToken(await mint(oldKey), { ...base, keySet: both })).resolves.toBeTruthy();
    await expect(verifyDelegatedToken(await mint(newKey), { ...base, keySet: both })).resolves.toBeTruthy();
    expect((await refusal(verifyDelegatedToken(await mint(oldKey), { ...base, keySet: onlyNew }))).reason).toBe("no_matching_key");
    await expect(verifyDelegatedToken(await mint(newKey), { ...base, keySet: onlyNew })).resolves.toBeTruthy();
  });
});
