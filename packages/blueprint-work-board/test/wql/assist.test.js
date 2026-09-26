import { describe, expect, it } from "vitest";
import { format, fromChips, hasTerm, parse, suggest, toChips, toggleTerm } from "../../src/shared/wql/index.js";
import { context } from "./fixture.js";

const ctx = context();
const labels = (text, cursor = text.length) => suggest(text, cursor, ctx).items.map((i) => i.label);

describe("suggest", () => {
  it("offers fields at the start, without keywords", () => {
    const s = suggest("", 0, ctx);
    expect(s).toMatchObject({ from: 0, to: 0 });
    expect(s.items.map((i) => i.label)).toEqual(expect.arrayContaining(["status:", "priority:", "is:", "has:", "sort:"]));
    expect(s.items.some((i) => i.kind === "keyword")).toBe(false);
  });

  it("completes a partial field name", () => {
    const s = suggest("prio", 4, ctx);
    expect(s).toMatchObject({ from: 0, to: 4 });
    expect(s.items[0]).toMatchObject({ label: "priority:", insert: "priority:", kind: "field" });
  });

  it("offers keywords after the first term", () => expect(labels("x ")).toEqual(expect.arrayContaining(["OR", "AND", "NOT"])));
  it("prefix matches come first, then substring matches", () => {
    const got = labels("st");
    expect(got.slice(0, 3)).toEqual(["status:", "state:", "start:"]);
    expect(got.slice(3)).toContain("estimate:");
  });

  it.each([
    ["status:a", 7, ["active"]],
    ["priority:", 9, ["urgent", "high", "medium", "low", "none"]],
    ["kind:st", 5, ["started"]],
    ["is:ov", 3, ["overdue"]],
    ["sort:-up", 5, ["-updated"]],
    ["due:<", 5, ["today", "-7d", "7d", "-14d", "-30d", "none"]],
    ["archived:", 9, ["true", "false"]],
    ["a -lab", 3, ["label:", "labels:"].slice(0, 1)],
  ])("%s → from %i", (text, from, expected) => {
    const s = suggest(text, text.length, ctx);
    expect(s.from).toBe(from);
    expect(s.items.map((i) => i.label).slice(0, expected.length)).toEqual(expected);
  });

  it("values after a comma", () => {
    const s = suggest("label:bug,u", 11, ctx);
    expect(s.from).toBe(10);
    expect(s.items.map((i) => i.label)).toContain("ui");
  });

  it("people, including me and none", () => {
    const s = suggest("assignee:", 9, ctx);
    expect(s.items.slice(0, 2).map((i) => i.label)).toEqual(["me", "none"]);
    expect(s.items.map((i) => i.detail)).toContain("cloudflare-os:bob@example.com");
  });

  it("quoted state names inside an open quote", () => {
    const s = suggest('state:"In P', 11, ctx);
    expect(s.from).toBe(6);
    expect(s.items[0]).toMatchObject({ label: "In Progress", insert: '"In Progress"' });
  });

  it("projects and cycles", () => {
    expect(suggest("project:web", 11, ctx).items[0]).toMatchObject({ label: "Website relaunch", insert: '"Website relaunch"' });
    expect(labels("cycle:").slice(0, 3)).toEqual(["current", "next", "previous"]);
    expect(labels("cycle:")).toContain("Cycle 2");
    expect(labels("parent:")).toEqual(expect.arrayContaining(["none", "WRK-1"]));
    expect(labels("has:")).toContain("due");
    expect(labels("state:")).toEqual(["Triage", "Backlog", "Todo", "In Progress", "In Review", "Done", "Canceled"]);
  });

  it("uses the cursor, not the end of the text", () => {
    const s = suggest("stat label:bug", 4, ctx);
    expect(s).toMatchObject({ from: 0, to: 4 });
    expect(s.items.slice(0, 2).map((i) => i.label)).toEqual(["status:", "state:"]);
  });

  it("unknown fields have no values; the list is capped at 50", () => {
    expect(labels("nope:")).toEqual([]);
    expect(suggest("", 0, ctx).items.length).toBeLessThanOrEqual(50);
  });
});

describe("chips", () => {
  it("splits top-level terms from the rest and round-trips", () => {
    const q = "status:active -label:bug is:blocked (a OR b) login priority:<=2 sort:key";
    const { ast } = parse(q);
    const { chips, rest } = toChips(ast);
    expect(chips).toEqual([
      { field: "status", op: "eq", values: ["active"], negated: false, text: "status:active" },
      { field: "label", op: "eq", values: ["bug"], negated: true, text: "-label:bug" },
      { field: "is", op: "eq", values: ["blocked"], negated: false, text: "is:blocked" },
      { field: "priority", op: "lte", values: ["2"], negated: false, text: "priority:<=2" },
    ]);
    expect(rest).toHaveLength(2);
    expect(format(fromChips(chips, rest, ast.sort))).toBe("status:active -label:bug is:blocked priority:<=2 (a OR b) login sort:key");
  });

  it("a single term or an empty query", () => {
    expect(toChips(parse("has:due").ast).chips).toEqual([{ field: "has", op: "eq", values: ["due"], negated: false, text: "has:due" }]);
    expect(toChips(parse("").ast)).toEqual({ chips: [], rest: [] });
    expect(toChips(parse("a OR b").ast).chips).toEqual([]);
    expect(fromChips([], [], []).where).toBeNull();
  });

  it("editing a chip changes the query", () => {
    const { chips, rest } = toChips(parse("status:open label:bug").ast);
    chips[1] = { ...chips[1], values: ["bug", "ui"], negated: true };
    expect(format(fromChips(chips, rest))).toBe("status:open -label:bug,ui");
  });
});

describe("toggleTerm / hasTerm", () => {
  it.each([
    ["", "assignee:me", "assignee:me"],
    ["assignee:me status:open", "assignee:me", "status:open"],
    ["status:open", "is:blocked", "status:open is:blocked"],
    ["a OR b", "is:blocked", "(a OR b) is:blocked"],
    ["Assignee:ME", "assignee:me", ""],
    ["sort:key", "is:blocked", "is:blocked sort:key"],
    ["is:blocked sort:key", "is:blocked", "sort:key"],
    ["cycle:current -is:blocked", "is:blocked", "cycle:current -is:blocked is:blocked"],
    ["status:open", "", "status:open"],
  ])("toggle(%s, %s) → %s", (text, term, expected) => expect(toggleTerm(text, term)).toBe(expected));

  it("hasTerm is structural", () => {
    expect(hasTerm("status:open  assignee:me", "assignee:me")).toBe(true);
    expect(hasTerm("labels:bug", "label:bug")).toBe(true);
    expect(hasTerm("-assignee:me", "assignee:me")).toBe(false);
    expect(hasTerm("assignee:me OR a", "assignee:me")).toBe(false);
    expect(hasTerm("", "is:overdue")).toBe(false);
  });
});
