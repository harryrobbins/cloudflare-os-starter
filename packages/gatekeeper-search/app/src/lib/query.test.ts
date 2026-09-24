import { describe, expect, it } from "vitest";

import type { OmniQuery } from "../contract.js";
import {
  addQualifier,
  chipsFromQuery,
  facetActive,
  facetTokens,
  monthBounds,
  qualifierToken,
  removeChip,
  toggleFacet,
  tokenize,
} from "./query.js";

const DAY = 86_400_000;
const day = (iso: string): number => Date.parse(`${iso}T00:00:00Z`);

describe("tokenize", () => {
  it("splits on whitespace and keeps quoted phrases and quoted qualifier values whole", () => {
    expect(tokenize(`  atlas "data model"  from:"Jane Okafor" in:#design `)).toEqual([
      "atlas",
      `"data model"`,
      `from:"Jane Okafor"`,
      "in:#design",
    ]);
  });
});

describe("chipsFromQuery", () => {
  it("makes one chip per qualifier value, labelling scopes", () => {
    const query: OmniQuery = {
      text: "atlas",
      in: ["chat:C1"],
      from: ["Jane"],
      source: ["chat", "context"],
      kind: ["doc"],
      workspace: ["ws-1"],
    };
    const chips = chipsFromQuery(query, new Map([["chat:C1", "#general"]]));
    expect(chips.map((chip) => `${chip.key}:${chip.label}`)).toEqual([
      "in:#general",
      "from:Jane",
      "source:chat",
      "source:context",
      "kind:doc",
      "workspace:ws-1",
    ]);
  });

  it("shows before:/after: as the typed day, following the grammar's exclusive bounds", () => {
    const chips = chipsFromQuery({ text: "", after: day("2026-09-01") + DAY, before: day("2026-10-01") - 1 });
    expect(chips.map((chip) => `${chip.key}:${chip.label}`)).toEqual(["after:2026-09-01", "before:2026-10-01"]);
  });

  it("collapses an on: day into one chip", () => {
    const chips = chipsFromQuery({ text: "", after: day("2026-09-03"), before: day("2026-09-03") + DAY - 1 });
    expect(chips.map((chip) => `${chip.key}:${chip.label}`)).toEqual(["on:2026-09-03"]);
  });

  it("is empty for plain text", () => {
    expect(chipsFromQuery({ text: "hello" })).toEqual([]);
  });
});

describe("removeChip", () => {
  it("removes the matching token and keeps the rest in order", () => {
    const [chip] = chipsFromQuery({ text: "atlas", kind: ["doc"] });
    expect(removeChip("atlas kind:doc launch", chip!)).toBe("atlas launch");
  });

  it("matches a scope chip by the label the user typed", () => {
    const [chip] = chipsFromQuery({ text: "", in: ["chat:C1"] }, new Map([["chat:C1", "#General"]]));
    expect(removeChip("in:#general budget", chip!)).toBe("budget");
    expect(removeChip("in:general budget", chip!)).toBe("budget");
    expect(removeChip("in:chat:C1 budget", chip!)).toBe("budget");
  });

  it("matches quoted values case-insensitively", () => {
    const [chip] = chipsFromQuery({ text: "", from: ["jane okafor"] });
    expect(removeChip(`from:"Jane Okafor" notes`, chip!)).toBe("notes");
  });

  it("falls back to every token with the key when the server resolved the value", () => {
    const [chip] = chipsFromQuery({ text: "", from: ["user-123"] });
    expect(removeChip("from:me notes", chip!)).toBe("notes");
  });

  it("removes an on: token for either date chip, and before: for the before chip only", () => {
    const [onChip] = chipsFromQuery({ text: "", after: day("2026-09-03"), before: day("2026-09-03") + DAY - 1 });
    expect(removeChip("x on:2026-09-03", onChip!)).toBe("x");
    const chips = chipsFromQuery({ text: "", after: day("2026-09-01") + DAY, before: day("2026-10-01") - 1 });
    const before = chips.find((chip) => chip.key === "before")!;
    expect(removeChip("x after:2026-09-01 before:2026-10-01", before)).toBe("x after:2026-09-01");
  });
});

describe("adding qualifiers", () => {
  it("quotes values with spaces and skips duplicates", () => {
    expect(qualifierToken("from", "Jane Okafor")).toBe(`from:"Jane Okafor"`);
    expect(addQualifier("atlas", "kind", "doc")).toBe("atlas kind:doc");
    expect(addQualifier("atlas kind:DOC", "kind", "doc")).toBe("atlas kind:DOC");
    expect(addQualifier("", "source", "chat")).toBe("source:chat");
  });

  it("maps facet fields to qualifiers", () => {
    expect(facetTokens("scope", "chat:C1")).toEqual([{ key: "in", value: "chat:C1" }]);
    expect(facetTokens("author", "Sam")).toEqual([{ key: "from", value: "Sam" }]);
    expect(facetTokens("month", "2026-09")).toEqual([
      { key: "after", value: "2026-08-31" },
      { key: "before", value: "2026-10-01" },
    ]);
    expect(monthBounds("2026-12")).toEqual({ after: "2026-11-30", before: "2027-01-01" });
    expect(monthBounds("nope")).toBeNull();
  });

  it("toggles a facet on and off", () => {
    const on = toggleFacet("atlas", "source", "chat", { text: "atlas" });
    expect(on).toBe("atlas source:chat");
    expect(facetActive("source", "chat", { text: "atlas", source: ["chat"] })).toBe(true);
    expect(toggleFacet(on, "source", "chat", { text: "atlas", source: ["chat"] })).toBe("atlas");
  });

  it("replaces existing date bounds when a month is chosen, and recognises it as active", () => {
    const q = toggleFacet("atlas on:2026-01-02", "month", "2026-09", { text: "atlas" });
    expect(q).toBe("atlas after:2026-08-31 before:2026-10-01");
    const query: OmniQuery = { text: "atlas", after: day("2026-08-31") + DAY, before: day("2026-10-01") - 1 };
    expect(facetActive("month", "2026-09", query)).toBe(true);
    expect(toggleFacet(q, "month", "2026-09", query)).toBe("atlas");
  });

  it("removes a resolved scope facet even when the typed token was a label", () => {
    const query: OmniQuery = { text: "", in: ["chat:C1"] };
    expect(toggleFacet("in:#general budget", "scope", "chat:C1", query)).toBe("budget");
  });
});
