import { describe, expect, it } from "vitest";
import { fieldByName, FIELDS, highlight, parse } from "../../src/shared/wql/index.js";
import { strip } from "./fixture.js";

const where = (q) => strip(parse(q).ast.where);

describe("fields", () => {
  it.each([
    ["status", "status"], ["category", "status"], ["LABELS", "label"], ["due_date", "due"], ["start_date", "start"],
    ["creator", "created_by"], ["number", "key"], ["created_at", "created"], ["ext.team", "ext.team"], ["Priority", "priority"],
  ])("resolves %s → %s", (name, canonical) => expect(fieldByName(name)?.name).toBe(canonical));

  it("refuses unknown names and bad ext names", () => {
    expect(fieldByName("prority")).toBeNull();
    expect(fieldByName("ext.")).toBeNull();
    expect(fieldByName("ext.a b")).toBeNull();
    expect(fieldByName("ext.x").type).toBe("ext");
  });

  it("has unique names and aliases", () => {
    const all = FIELDS.flatMap((f) => [f.name, ...f.aliases]);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("parse: structure", () => {
  it.each([
    ["status:active", { type: "term", field: "status", op: "eq", values: ["active"] }],
    ["priority:<=2", { type: "term", field: "priority", op: "lte", values: ["2"] }],
    ["priority:>=high", { type: "term", field: "priority", op: "gte", values: ["high"] }],
    ["estimate:<3", { type: "term", field: "estimate", op: "lt", values: ["3"] }],
    ["estimate:>3", { type: "term", field: "estimate", op: "gt", values: ["3"] }],
    ["priority:=high", { type: "term", field: "priority", op: "eq", values: ["high"] }],
    ["label:a,b,c", { type: "term", field: "label", op: "eq", values: ["a", "b", "c"] }],
    ['state:"In Progress",Done', { type: "term", field: "state", op: "eq", values: ["In Progress", "Done"] }],
    ["estimate:1..5", { type: "term", field: "estimate", op: "range", values: ["1", "5"] }],
    ["due:2026-09-01..2026-09-30", { type: "term", field: "due", op: "range", values: ["2026-09-01", "2026-09-30"] }],
    ['label:"a..b"', { type: "term", field: "label", op: "eq", values: ["a..b"] }],
    ["login", { type: "text", value: "login" }],
    ['"login page"', { type: "text", value: "login page" }],
    ['"say \\"hi\\""', { type: "text", value: 'say "hi"' }],
    ["WRK-7", { type: "text", value: "WRK-7" }],
    ["is:blocked", { type: "is", value: "blocked" }],
    ["IS:Overdue", { type: "is", value: "overdue" }],
    ["has:due_date", { type: "has", value: "due" }],
    ["has:ext.team", { type: "has", value: "ext.team" }],
    ["-label:bug", { type: "not", child: { type: "term", field: "label", op: "eq", values: ["bug"] } }],
    ["NOT label:bug", { type: "not", child: { type: "term", field: "label", op: "eq", values: ["bug"] } }],
    ["not a", { type: "not", child: { type: "text", value: "a" } }],
    ["--a", { type: "text", value: "a" }],
    ["-(-a)", { type: "text", value: "a" }],
    ["(a)", { type: "text", value: "a" }],
    ["((a))", { type: "text", value: "a" }],
    ["ext.team:web", { type: "term", field: "ext.team", op: "eq", values: ["web"] }],
    ["label:a:b", { type: "term", field: "label", op: "eq", values: ["a:b"] }],
    ['text:"<5"', { type: "term", field: "text", op: "eq", values: ["<5"] }],
  ])("%s", (q, expected) => {
    const { errors } = parse(q);
    expect(errors).toEqual([]);
    expect(where(q)).toEqual(expected);
  });

  it("combines with implicit AND, explicit AND, OR and parentheses (AND binds tighter)", () => {
    expect(where("a b")).toEqual({ type: "and", children: [{ type: "text", value: "a" }, { type: "text", value: "b" }] });
    expect(where("a AND b")).toEqual(where("a b"));
    expect(where("a and b")).toEqual(where("a b"));
    expect(where("a OR b c")).toEqual({ type: "or", children: [{ type: "text", value: "a" }, { type: "and", children: [{ type: "text", value: "b" }, { type: "text", value: "c" }] }] });
    expect(where("(a OR b) c")).toEqual({ type: "and", children: [{ type: "or", children: [{ type: "text", value: "a" }, { type: "text", value: "b" }] }, { type: "text", value: "c" }] });
    expect(where("(a b) c")).toEqual({ type: "and", children: ["a", "b", "c"].map((value) => ({ type: "text", value })) });
    expect(where("a or b or c")).toEqual({ type: "or", children: ["a", "b", "c"].map((value) => ({ type: "text", value })) });
    expect(where("-(a OR b)")).toEqual({ type: "not", child: { type: "or", children: [{ type: "text", value: "a" }, { type: "text", value: "b" }] } });
  });

  it("collects sort clauses from anywhere, in order", () => {
    const { ast, errors } = parse("sort:priority status:open sort:-updated,key");
    expect(errors).toEqual([]);
    expect(ast.sort).toEqual([{ field: "priority", dir: "asc" }, { field: "updated", dir: "desc" }, { field: "key", dir: "asc" }]);
    expect(strip(ast.where)).toEqual({ type: "term", field: "status", op: "eq", values: ["open"] });
    expect(parse("sort:number,-due_date").ast.sort).toEqual([{ field: "key", dir: "asc" }, { field: "due", dir: "desc" }]);
  });

  it("an empty or whitespace query has no condition", () => {
    expect(parse("").ast).toEqual({ type: "query", where: null, sort: [] });
    expect(parse("   ").ast.where).toBeNull();
    expect(parse(null).errors).toEqual([]);
  });

  it("records source spans", () => {
    const { ast } = parse("  label:bug  is:blocked");
    expect(ast.where.children[0].span).toEqual([2, 11]);
    expect(ast.where.children[1].span).toEqual([13, 23]);
  });

  it("is:a,b becomes an OR of predicates", () => {
    expect(where("is:blocked,overdue")).toEqual({ type: "or", children: [{ type: "is", value: "blocked" }, { type: "is", value: "overdue" }] });
  });
});

describe("parse: errors with positions", () => {
  it.each([
    ["prority:1", 0, 7, /Unknown field “prority”. Did you mean “priority”/],
    ["foo:bar", 0, 3, /Unknown field “foo”/],
    ["ext.:x", 0, 4, /Unknown field/],
    ["label:", 0, 6, /Enter a value for “label”/],
    ["state:", 0, 6, /Enter a value/],
    ["a label:", 2, 8, /Enter a value/],
    ["label:a,", 7, 8, /after the comma/],
    ["assignee:me,,bob", 11, 12, /after the comma/],
    ['"abc', 0, 4, /Unterminated quote/],
    ['label:"abc', 6, 10, /Unterminated quote/],
    ["a )", 2, 3, /Unmatched “\)”/],
    ["(a b", 0, 1, /Missing “\)”/],
    ["a (b", 2, 3, /Missing “\)”/],
    ["a OR", 2, 4, /OR needs/],
    ["OR a", 0, 2, /OR needs/],
    ["a OR OR b", 2, 4, /OR needs/],
    ["(a OR)", 3, 5, /OR needs/],
    ["x OR )", 2, 4, /OR needs/],
    ["a AND", 2, 5, /AND needs/],
    ["AND a", 0, 3, /AND needs/],
    ["NOT", 0, 3, /Nothing to exclude after NOT/],
    ["a  NOT", 3, 6, /Nothing to exclude/],
    ["- a", 0, 1, /Nothing to exclude after “-”/],
    ["a -", 2, 3, /Nothing to exclude/],
    ["is:blockd", 3, 9, /Unknown predicate “is:blockd”. Did you mean “blocked”/],
    ["has:estimat", 4, 11, /Unknown field “estimat”. Did you mean “estimate”/],
    ["sort:priorty", 5, 12, /Cannot sort by “priorty”. Did you mean “priority”/],
    ["sort:description", 5, 16, /Cannot sort by/],
    ["-sort:priority", 0, 14, /sort cannot be excluded/],
    ["sort:<priority", 0, 14, /takes field names/],
    ["is:<open", 0, 8, /cannot be compared/],
    ["label:<bug", 6, 7, /“label” cannot be compared with </],
    ["assignee:>=me", 9, 11, /“assignee” cannot be compared/],
    ["priority:<1,2", 0, 13, /one value/],
    ["estimate:1..", 9, 12, /two values/],
    ["estimate:..5", 9, 12, /two values/],
    ["estimate:1..2..3", 9, 16, /two values/],
    ["label:a..b", 6, 10, /does not support ranges/],
    ["estimate:<1..5", 0, 14, /cannot be combined/],
    ["()", 0, 2, /Empty parentheses/],
  ])("%s → error at %i..%i", (q, start, end, message) => {
    const { errors } = parse(q);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatchObject({ start, end });
    expect(errors[0].message).toMatch(message);
  });

  it("offers suggestions and keeps the valid rest of the query", () => {
    const { ast, errors } = parse("status:open prority:1 label:bug");
    expect(errors[0].suggestions).toContain("priority");
    expect(strip(ast.where)).toEqual({ type: "and", children: [
      { type: "term", field: "status", op: "eq", values: ["open"] },
      { type: "term", field: "label", op: "eq", values: ["bug"] },
    ] });
  });

  it("never throws on hostile input", () => {
    for (const q of ['"', "(", ")", "-", ":", "::", '((("', "a:b:c:", "\\", "-(-(-(", "OR OR OR", "sort:", "is:", ",,,", "a..b", "\u0000"]) {
      expect(() => parse(q)).not.toThrow();
    }
  });
});

describe("highlight", () => {
  const kinds = (q) => highlight(q).map((t) => [q.slice(t.start, t.end), t.kind]);
  it.each([
    ["status:active", [["status:", "field"], ["active", "value"]]],
    ["priority:<=2", [["priority:", "field"], ["<=", "op"], ["2", "value"]]],
    ["-label:bug OR (a)", [["-", "neg"], ["label:", "field"], ["bug", "value"], ["OR", "keyword"], ["(", "paren"], ["a", "text"], [")", "paren"]]],
    ["foo:bar", [["foo:", "error"], ["bar", "error"]]],
    ["sort:-updated,key", [["sort:", "sort"], ["-updated", "sort"], ["key", "sort"]]],
    ['"x y"', [['"x y"', "text"]]],
    ["is:nope", [["is:", "field"], ["nope", "error"]]],
    ["NOT a AND b", [["NOT", "keyword"], ["a", "text"], ["AND", "keyword"], ["b", "text"]]],
    ["a )", [["a", "text"], [")", "error"]]],
  ])("%s", (q, expected) => expect(kinds(q)).toEqual(expected));

  it("omits whitespace and orders tokens", () => {
    const tokens = highlight("  a   b ");
    expect(tokens.map((t) => [t.start, t.end])).toEqual([[2, 3], [6, 7]]);
  });
});
