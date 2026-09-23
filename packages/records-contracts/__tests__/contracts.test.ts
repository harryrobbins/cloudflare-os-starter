import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  canAssignRole,
  canonicalJson,
  checkCompatibility,
  CreateIssueInputSchema,
  effectivePermissions,
  intentDigest,
  OPERATION_PERMISSION,
  parseInput,
  RecordsError,
  ROLE_PERMISSIONS,
} from "../src/index.js";

const vector = JSON.parse(readFileSync(new URL("../fixtures/intent-vector.json", import.meta.url), "utf8"));

describe("role matrix", () => {
  it("is strictly nested reader ⊂ editor ⊂ admin ⊂ owner", () => {
    const order = ["reader", "editor", "admin", "owner"] as const;
    for (let i = 1; i < order.length; i++) {
      for (const p of ROLE_PERMISSIONS[order[i - 1]!]) expect(ROLE_PERMISSIONS[order[i]!].has(p)).toBe(true);
      expect(ROLE_PERMISSIONS[order[i]!].size).toBeGreaterThan(ROLE_PERMISSIONS[order[i - 1]!].size);
    }
  });

  it("readers cannot write, editors cannot manage, only owners purge or transfer", () => {
    expect(ROLE_PERMISSIONS.reader.has("issues.create")).toBe(false);
    expect(ROLE_PERMISSIONS.editor.has("members.manage")).toBe(false);
    expect(ROLE_PERMISSIONS.admin.has("ownership.transfer")).toBe(false);
    expect(ROLE_PERMISSIONS.owner.has("datastore.purge")).toBe(true);
  });

  it("scopes only narrow a role", () => {
    expect([...effectivePermissions("reader", ["issues.read", "issues.create"])]).toEqual(["issues.read"]);
    expect(effectivePermissions(null, ["issues.read"]).size).toBe(0);
    expect(effectivePermissions("editor", []).size).toBe(0);
  });

  it("every operation maps to a permission some role holds", () => {
    for (const p of Object.values(OPERATION_PERMISSION)) expect(ROLE_PERMISSIONS.owner.has(p)).toBe(true);
  });

  it("nobody assigns owner; admins cannot create admins", () => {
    expect(canAssignRole("owner", "owner")).toBe(false);
    expect(canAssignRole("owner", "admin")).toBe(true);
    expect(canAssignRole("admin", "admin")).toBe(false);
    expect(canAssignRole("admin", "editor")).toBe(true);
    expect(canAssignRole("editor", "reader")).toBe(false);
  });
});

describe("intent digests", () => {
  it("canonical JSON sorts keys, drops undefined and keeps null", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: undefined, c: null }] })).toBe('{"a":[2,{"c":null}],"b":1}');
    expect(() => canonicalJson({ x: Number.NaN })).toThrow();
  });

  it("matches the checked-in vector, so every implementation agrees", async () => {
    const { intent, canonical } = vector;
    expect(canonicalJson({ v: 1, service: "records", operation: intent.operation, input: intent.input, key: intent.idempotencyKey })).toBe(canonical);
    expect(await intentDigest(intent)).toBe(createHash("sha256").update(canonical).digest("hex"));
  });

  it("differs for any change to operation, input or key", async () => {
    const base = await intentDigest(vector.intent);
    expect(await intentDigest({ ...vector.intent, idempotencyKey: "k-0002-abcdef" })).not.toBe(base);
    expect(await intentDigest({ ...vector.intent, operation: "editIssue" })).not.toBe(base);
    expect(await intentDigest({ ...vector.intent, input: { ...vector.intent.input, title: "Fix logout" } })).not.toBe(base);
  });
});

describe("validation", () => {
  it("reports paths without echoing values", () => {
    try {
      parseInput(CreateIssueInputSchema, { projectId: "nope", title: "x".repeat(500) + "SECRET" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(RecordsError);
      const problem = (err as RecordsError).toProblem();
      expect(problem.status).toBe(400);
      expect(JSON.stringify(problem)).not.toContain("SECRET");
      expect(problem.issues!.map((i) => i.path).toSorted()).toEqual(["projectId", "title"]);
    }
  });

  it("recovers codes from errors that crossed RPC", () => {
    expect(RecordsError.codeOf(new Error("revision_conflict: changed"))).toBe("revision_conflict");
    expect(RecordsError.codeOf(new Error("boom"))).toBeNull();
  });
});

describe("compatibility", () => {
  const offered = { moduleId: "projects", apiVersions: [1], features: ["issues", "comments"] };
  const req = { service: "records" as const, moduleId: "projects", apiMajor: 1, features: ["issues"], scopes: ["issues.read" as const] };
  it("accepts a compatible requirement and explains each refusal", () => {
    expect(checkCompatibility(req, offered, ["issues.read"])).toEqual({ compatible: true });
    expect(checkCompatibility({ ...req, apiMajor: 2 }, offered, ["issues.read"])).toMatchObject({ reason: "api_major" });
    expect(checkCompatibility({ ...req, features: ["attachments"] }, offered, ["issues.read"])).toMatchObject({ reason: "feature" });
    expect(checkCompatibility({ ...req, scopes: ["issues.create"] }, offered, ["issues.read"])).toMatchObject({ reason: "scope" });
    expect(checkCompatibility({ ...req, moduleId: "crm" }, offered, [])).toMatchObject({ reason: "module" });
  });
});
