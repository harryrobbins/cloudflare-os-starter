import { describe, expect, it } from "vitest";

import { KNOWN_SOURCES } from "../contract.js";
import { createMockApi, mockOptionsFromLocation, parseMockQuery } from "./api.js";

describe("mock api", () => {
  it("covers every known source", async () => {
    const sources = await createMockApi().sources();
    for (const source of KNOWN_SOURCES) expect(sources.map((row) => row.source)).toContain(source);
  });

  it("returns escaped snippets with marks, facets and a cursor", async () => {
    const api = createMockApi();
    const first = await api.search({ q: "atlas" });
    expect(first.hits.length).toBe(20);
    expect(first.cursor).not.toBeNull();
    expect(first.facets.map((facet) => facet.field)).toContain("source");
    expect(first.hits.some((hit) => hit.snippet.includes("<mark>"))).toBe(true);
    const second = await api.search({ q: "atlas", cursor: first.cursor! });
    expect(second.hits[0]!.documentId).not.toBe(first.hits[0]!.documentId);

    const script = await api.search({ q: "script" });
    expect(script.hits[0]!.snippet).toContain("&lt;");
    expect(script.hits[0]!.snippet).not.toContain("<script");
  });

  it("finds dense-only hits by meaning, and none when dense is off", async () => {
    const on = await createMockApi().search({ q: "vacation" });
    expect(on.hits.some((hit) => hit.lexicalRank === null && hit.denseRank !== null)).toBe(true);
    const off = await createMockApi({ dense: "off" }).search({ q: "vacation" });
    expect(off.dense).toBe("off");
    expect(off.hits.every((hit) => hit.denseRank === null)).toBe(true);
  });

  it("parses qualifiers like the server grammar", () => {
    expect(parseMockQuery("atlas in:#design from:@Jane kind:DOC on:2026-09-03")).toMatchObject({
      text: "atlas",
      in: ["chat:C-design"],
      from: ["Jane"],
      kind: ["doc"],
      after: Date.UTC(2026, 8, 3),
    });
  });

  it("reads states from ?mock=", () => {
    expect(mockOptionsFromLocation("?mock=unavailable,member,401")).toMatchObject({
      dense: "unavailable",
      admin: false,
      failStatus: 401,
    });
  });
});
