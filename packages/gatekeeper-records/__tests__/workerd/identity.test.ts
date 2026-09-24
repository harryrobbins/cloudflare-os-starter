// Delegated tokens in workerd: the JWKS route, and the gadget session running entirely on tokens
// minted and verified in the facet (the session suite covers behaviour; this checks the wiring).

import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { RecordsGatekeeperProps } from "../../src/vendor/gatekeeper.js";

type Seed = { orgA: string; ds1: string; people: Record<string, { id: string; email: string }> };
const seed = JSON.parse((env as unknown as { TEST_SEED: string }).TEST_SEED) as Seed;
const hooks = (env as unknown as { TEST_HOOKS: DurableObjectNamespace }).TEST_HOOKS.getByName("hooks") as unknown as {
  session(name: string, props: RecordsGatekeeperProps, calls: { method: string; args: unknown[] }[]): Promise<{ results: ({ ok: unknown } | { error: string })[] }>;
};

describe("delegation keys", () => {
  it("serves the public JWKS at /gatekeeper/records/.well-known/jwks.json", async () => {
    const res = await SELF.fetch("https://records.example.test/gatekeeper/records/.well-known/jwks.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/jwk-set+json");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    const configured = JSON.parse((env as unknown as { RECORDS_DELEGATION_SIGNING_KEY: string }).RECORDS_DELEGATION_SIGNING_KEY) as { kid: string };
    const body = (await res.json()) as { keys: Record<string, unknown>[] };
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).toMatchObject({ kty: "EC", crv: "P-256", kid: configured.kid, alg: "ES256", use: "sig" });
    expect(body.keys[0]).not.toHaveProperty("d");
    expect((await SELF.fetch("https://records.example.test/gatekeeper/records/.well-known/jwks.json", { method: "POST" })).status).toBe(404);
  });

  it("a gadget session reads through delegated tokens, one per call", async () => {
    const props: RecordsGatekeeperProps = {
      accountId: "acct-ed-identity", orgId: seed.orgA, principalId: seed.people.ed!.id, datastoreId: seed.ds1, scopes: ["projects.read", "issues.read"],
    };
    const r = await hooks.session(`identity-${crypto.randomUUID()}`, props, [
      { method: "listProjects", args: [] },
      { method: "listProjects", args: [] },
    ]);
    expect(r.results.every((x) => "ok" in x)).toBe(true);
  });
});
