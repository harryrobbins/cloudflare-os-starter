import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { datastoreUrl, parseDatastoreUrl } from "../src/vendor/resource.ts";
import TYPES_CODE from "../src/vendor/types-code.ts";

const ID = "00000000-0000-4000-8000-0000000000a1";

describe("resource URLs", () => {
  it("round-trips, sorting scopes and always including projects.read", () => {
    const url = datastoreUrl(ID, ["issues.create", "issues.read"]);
    expect(url).toBe(`records://datastore/${ID}/issues.create,issues.read`);
    expect(parseDatastoreUrl(url)).toEqual({ datastoreId: ID, scopes: ["issues.create", "issues.read", "projects.read"] });
  });

  it("defaults to read scopes and rejects unknown scopes or malformed IDs", () => {
    expect(parseDatastoreUrl(`records://datastore/${ID}`).scopes).toEqual(["issues.read", "projects.read"]);
    expect(() => parseDatastoreUrl(`records://datastore/${ID}/records.write`)).toThrow(/Unknown scopes/);
    expect(() => parseDatastoreUrl("records://datastore/not-a-uuid")).toThrow(/validation_failed/);
    expect(() => parseDatastoreUrl(`https://evil.test/${ID}`)).toThrow();
  });
});

describe("agent-facing types", () => {
  it("types-code.ts is generated from types.d.ts (run scripts/gen-types.mjs)", () => {
    expect(TYPES_CODE).toBe(readFileSync(new URL("../src/vendor/types.d.ts", import.meta.url), "utf8"));
  });
});
