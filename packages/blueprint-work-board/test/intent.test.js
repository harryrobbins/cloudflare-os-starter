import { describe, expect, it } from "vitest";
import { recordsOsIntentDigest } from "../../records-service/src/cloudflare-os.ts";
import { canonical, intentDigest } from "../src/client/intent.js";

describe("intent digest", () => {
  it("matches the connector's recordsOsIntentDigest regardless of key order", async () => {
    const intent = {
      idempotencyKey: "k-1", command: "work.update", binding: "b", datastore: "d", moduleId: "work", apiMajor: 1, expectedRevision: 7,
      input: { status: "done", id: "r", extensions: { z: [1, { b: true, a: null }], a: "ü\"" } },
    };
    const reordered = { ...intent, input: { extensions: { a: "ü\"", z: [1, { a: null, b: true }] }, id: "r", status: "done" } };
    const ours = await intentDigest(intent);
    expect(ours).toMatch(/^[0-9a-f]{64}$/);
    expect(ours).toBe(await recordsOsIntentDigest(intent));
    expect(await intentDigest(reordered)).toBe(ours);
  });

  it("refuses undefined values rather than dropping them", () => {
    expect(() => canonical({ a: undefined })).toThrow();
    expect(canonical({ b: 1, a: [true, "x"] })).toBe('{"a":[true,"x"],"b":1}');
  });
});
