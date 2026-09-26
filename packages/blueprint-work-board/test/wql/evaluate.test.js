import { describe, expect, it } from "vitest";
import { check, compare, compile, evaluate, parse, resolveDay, run } from "../../src/shared/wql/index.js";
import { BOB, TODAY, context } from "./fixture.js";

const ctx = context();
const nums = (q, c = ctx) => run(q, c).map((i) => i.number).toSorted((a, b) => a - b);
const order = (q, c = ctx) => run(q, c).map((i) => i.number);
const ALL = [1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12];
const except = (...n) => ALL.filter((x) => !n.includes(x));

describe("evaluate: fields", () => {
  it.each([
    ["", ALL],
    ["status:open", [2, 4, 5, 10, 12]],
    ["status:active", [1, 3, 8, 11]],
    ["status:done", [6, 7]],
    ["category:DONE", [6, 7]],
    ["status:open,active", [1, 2, 3, 4, 5, 8, 10, 11, 12]],
    ["state:todo", [2, 10, 12]],
    ['state:"In Progress"', [1, 8, 11]],
    ["state:in_progress,in_review", [1, 3, 8, 11]],
    ["state:Canceled", [7]],
    ["state:<in_progress", [2, 4, 5, 10, 12]],
    ["state:>=done", [6, 7]],
    ["kind:started", [1, 3, 8, 11]],
    ["kind:canceled", [7]],
    ["kind:triage", [5]],
    ["kind:>=completed", [6, 7]],
    ["priority:urgent", [1, 8]],
    ["priority:1", [1, 8]],
    ["priority:none", [5, 12]],
    ["priority:0", [5, 12]],
    ["priority:<=high", [1, 2, 3, 8, 10]],
    ["priority:<=2", [1, 2, 3, 8, 10]],
    ["priority:<high", [1, 8]],
    ["priority:>=medium", [4, 5, 6, 7, 11, 12]],
    ["priority:>medium", [4, 5, 7, 12]],
    ["priority:high..medium", [2, 3, 6, 10, 11]],
    ["priority:urgent,low", [1, 4, 7, 8]],
    ["assignee:me", [1, 3, 11]],
    ["assignee:none", [4, 5, 7, 10, 12]],
    ["assignee:bob", [2, 6, 8]],
    ['assignee:"bob@example.com"', [2, 6, 8]],
    [`assignee:"${BOB}"`, [2, 6, 8]],
    ["assignee:me,bob", [1, 2, 3, 6, 8, 11]],
    ["-assignee:me", [2, 4, 5, 6, 7, 8, 10, 12]],
    ["created_by:bob", [5]],
    ["creator:me", except(5)],
    ["updated_by:ada", except(5)],
    ["label:bug", [1, 3, 10]],
    ["label:BUG", [1, 3, 10]],
    ['label:"User interface"', [1, 6]],
    ["label:bug,docs", [1, 3, 4, 10]],
    ["-label:bug", [2, 4, 5, 6, 7, 8, 11, 12]],
    ["label:none", [5, 8, 11, 12]],
    ["labels:ui", [1, 6]],
    ["estimate:3", [2]],
    ["estimate:>=5", [1, 6, 8]],
    ["estimate:<3", [3, 10]],
    ["estimate:2..5", [1, 2, 3]],
    ["estimate:5..2", [1, 2, 3]],
    ["estimate:none", [4, 5, 7, 11, 12]],
    ["due:<today", [1, 6]],
    ["due:today", [3]],
    ["due:<7d", [1, 2, 3, 6, 12]],
    ["due:<+7d", [1, 2, 3, 6, 12]],
    ["due:<1w", [1, 2, 3, 6, 12]],
    ["due:<=2026-09-30", [1, 3, 6, 12]],
    ["due:>tomorrow", [2, 8, 12]],
    ["due:yesterday", []],
    ["due:-2d", [1]],
    ["due:none", [4, 5, 7, 10, 11]],
    ["due_date:2026-09-24", [1]],
    ["due:2026-09-20..2026-09-26", [1, 3, 6]],
    ["due:2026-09-24,2026-09-26", [1, 3]],
    ["start:2026-09-20", [8]],
    ["start_date:none", except(8)],
    ["updated:>-14d", [1, 3, 5, 8, 10, 12]],
    ["updated:<-14d", [2, 4, 6, 7, 11]],
    ["updated:>-2w", [1, 3, 5, 8, 10, 12]],
    ["created:-1d", [5]],
    ["created:>=-5d", [5, 10, 12]],
    ["created:<-1m", [4, 6, 7, 1]],
    ["created:today", []],
    ["parent:WRK-1", [3, 10]],
    ["parent:1", [3, 10]],
    ["parent:none", except(3, 10)],
    ["parent:WRK-99", []],
    ['project:"Website relaunch"', [1, 3, 6]],
    ['project:"public api"', [2, 8, 12]],
    ["project:none", [4, 5, 7, 10, 11]],
    ["cycle:current", [1, 2, 3, 8]],
    ["cycle:next", [4]],
    ["cycle:previous", [6]],
    ['cycle:"Cycle 2"', [1, 2, 3, 8]],
    ["cycle:2", [1, 2, 3, 8]],
    ["cycle:none", [5, 7, 10, 11, 12]],
    ["cycle:current,next", [1, 2, 3, 4, 8]],
    ["key:WRK-3", [3]],
    ["key:3", [3]],
    ["key:WRK-4,WRK-5", [4, 5]],
    ["number:1..3", [1, 2, 3]],
    ["key:>10", [11, 12]],
    ["key:#aaaaaaaa", ALL],
    ["text:login", [1, 3]],
    ["login", [1, 3]],
    ["LOGIN", [1, 3]],
    ['"login timeout"', [3]],
    ["title:plan", [12]],
    ["description:minutes", [3]],
    ["archived:true", [9]],
    ["archived:false", ALL],
    ["ext.team:web", [1]],
    ["ext.points:>5", [8]],
    ["ext.points:3..8", [1, 8]],
    ["ext.tags:b", [10]],
    ["ext.team:none", except(1, 8)],
    ["has:ext.team", [1, 8]],
  ])("%s", (q, expected) => {
    expect(parse(q).errors).toEqual([]);
    expect(nums(q)).toEqual([...expected].toSorted((a, b) => a - b));
  });
});

describe("evaluate: predicates and combinations", () => {
  it.each([
    ["is:blocked", [2]],
    ["is:blocking", [8]],
    ["is:overdue", [1]],
    ["is:archived", [9]],
    ["is:parent", [1]],
    ["is:sub", [3, 10]],
    ["is:unassigned", [4, 5, 7, 10, 12]],
    ["is:unestimated", [4, 5, 7, 11, 12]],
    ["is:stale", [2, 4, 11]],
    ["is:open", [2, 4, 5, 10, 12]],
    ["is:active", [1, 3, 8, 11]],
    ["is:done", [6, 7]],
    ["-is:blocked status:open", [4, 5, 10, 12]],
    ["has:due", [1, 2, 3, 6, 8, 12]],
    ["has:label", [1, 2, 3, 4, 6, 7, 10]],
    ["has:priority", except(5, 12)],
    ["has:estimate", [1, 2, 3, 6, 8, 10]],
    ["has:assignee", [1, 2, 3, 6, 8, 11]],
    ["has:parent", [3, 10]],
    ["has:cycle", [1, 2, 3, 4, 6, 8]],
    ["has:project", [1, 2, 3, 6, 8, 12]],
    ["-has:assignee", [4, 5, 7, 10, 12]],
    ["has:status", ALL],
    ["status:active OR label:docs", [1, 3, 4, 8, 11]],
    ["(label:bug OR label:regression) assignee:none", [10]],
    ["label:bug -(assignee:me)", [10]],
    ["NOT label:bug", [2, 4, 5, 6, 7, 8, 11, 12]],
    ["is:blocked OR is:blocking", [2, 8]],
    ["is:blocked,blocking", [2, 8]],
    ["status:open AND priority:<=2", [2, 10]],
    ["-(status:open OR status:done)", [1, 3, 8, 11]],
    ["login OR migration", [1, 3, 8]],
    ["is:archived OR is:blocked", [2, 9]],
    ["-is:archived", ALL],
  ])("%s", (q, expected) => {
    expect(parse(q).errors).toEqual([]);
    expect(nums(q)).toEqual([...expected].toSorted((a, b) => a - b));
  });

  it("a blocker that is done no longer blocks", () => {
    expect(nums("is:blocking")).not.toContain(6);
    expect(nums("is:blocked")).not.toContain(12);
  });

  it("assignee:me with no viewer matches nothing", () => {
    expect(nums("assignee:me", context({ viewer: null }))).toEqual([]);
  });

  it("evaluate and compile agree", () => {
    const ast = parse("label:bug priority:<=2").ast;
    const pred = compile(ast, ctx);
    for (const item of ctx.index.itemList) expect(evaluate(ast, item, ctx)).toBe(pred(item));
  });

  it("run accepts text or an AST and an explicit item list", () => {
    const some = ctx.index.itemList.slice(0, 3);
    expect(run(parse("status:active").ast, ctx, some).map((i) => i.number)).toEqual(run("status:active", ctx, some).map((i) => i.number));
  });

  it("cycles follow today", () => {
    expect(nums("cycle:current", context({ today: "2026-09-05" }))).toEqual([6]);
    expect(nums("cycle:previous", context({ today: "2026-10-20" }))).toEqual([4]);
    expect(nums("cycle:next", context({ today: "2026-10-20" }))).toEqual([]);
  });
});

describe("dates", () => {
  it.each([
    ["today", TODAY], ["TODAY", TODAY], ["yesterday", "2026-09-25"], ["tomorrow", "2026-09-27"],
    ["-7d", "2026-09-19"], ["7d", "2026-10-03"], ["+7d", "2026-10-03"], ["-1w", "2026-09-19"], ["2w", "2026-10-10"],
    ["1m", "2026-10-26"], ["-1y", "2025-09-26"], ["0d", TODAY], ["2026-02-28", "2026-02-28"], ["-30d", "2026-08-27"],
  ])("%s → %s", (value, day) => expect(resolveDay(value, TODAY)).toBe(day));

  it.each(["2026-13-01", "soon", "7", "d7", "-7x", "2026-9-1", ""])("rejects %s", (value) => expect(resolveDay(value, TODAY)).toBeNull());

  it("crosses month and year boundaries", () => {
    expect(resolveDay("1d", "2026-12-31")).toBe("2027-01-01");
    expect(resolveDay("-1d", "2024-03-01")).toBe("2024-02-29");
  });
});

describe("sort", () => {
  it.each([
    ["sort:estimate", [10, 3, 2, 1, 6, 8, 12, 11, 7, 5, 4]],
    ["sort:-estimate", [8, 6, 1, 2, 3, 10, 12, 11, 7, 5, 4]],
    ["sort:due", [6, 1, 3, 12, 2, 8, 11, 10, 7, 5, 4]],
    ["sort:-due", [8, 2, 12, 3, 1, 6, 11, 10, 7, 5, 4]],
    ["sort:key", [1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12]],
    ["sort:-key", [12, 11, 10, 8, 7, 6, 5, 4, 3, 2, 1]],
    ["", [1, 8, 3, 10, 2, 6, 11, 7, 4, 5, 12]],
    ["sort:priority,-updated", [1, 8, 3, 10, 2, 6, 11, 7, 4, 5, 12]],
    ["sort:title", [2, 8, 7, 3, 11, 1, 12, 10, 6, 5, 4]],
    ["sort:state", [5, 4, 12, 10, 2, 11, 8, 1, 3, 6, 7]],
    ["sort:assignee", [11, 3, 1, 8, 6, 2, 12, 10, 7, 5, 4]],
    ["sort:project,-key", [12, 8, 2, 6, 3, 1, 11, 10, 7, 5, 4]],
    ["sort:rank", [1, 2, 12, 11, 10, 8, 7, 6, 5, 4, 3]],
    ["sort:cycle", [6, 8, 3, 2, 1, 4, 12, 11, 10, 7, 5]],
    ["sort:created", [7, 4, 6, 1, 2, 11, 8, 3, 10, 12, 5]],
    ["sort:-updated", [5, 1, 12, 3, 8, 10, 6, 11, 2, 7, 4]],
    ["sort:ext.points", [1, 8, 12, 11, 10, 7, 6, 5, 4, 3, 2]],
  ])("%s", (q, expected) => expect(order(q)).toEqual(expected));

  it("compare falls back to the default sort", () => {
    const items = [...ctx.index.itemList].filter((i) => !i.archived);
    expect(items.toSorted(compare([], ctx)).map((i) => i.number)).toEqual(order(""));
  });
});

describe("check", () => {
  const errs = (q) => check(parse(q).ast, ctx);
  it.each([
    ["state:Todoo", "Todo"],
    ['project:"Website relanch"', "Website relaunch"],
    ["cycle:currnt", "current"],
    ["priority:hgh", "high"],
    ["status:actve", "active"],
    ["kind:strted", "started"],
    ["archived:maybe", null],
  ])("%s suggests %s", (q, suggestion) => {
    const [error] = errs(q);
    expect(error).toBeDefined();
    expect(error.start).toBe(0);
    if (suggestion) expect(error.suggestions).toContain(suggestion);
  });

  it.each([
    ["due:tomorow", /not a date/],
    ["updated:>soon", /not a date/],
    ["estimate:abc", /not a number/],
    ["key:foo", /not an item key like WRK-12/],
    ["parent:WRK-99", /No item/],
  ])("%s", (q, message) => expect(errs(q)[0].message).toMatch(message));

  it.each(["label:anything", "assignee:zed", "state:todo priority:urgent project:none cycle:current due:<7d estimate:1..3 key:WRK-1 parent:WRK-1 archived:true", "-state:Done"])("%s has no errors", (q) => {
    expect(errs(q)).toEqual([]);
  });

  it("points at the offending term", () => {
    const [error] = errs("label:bug state:Nope");
    expect([error.start, error.end]).toEqual([10, 20]);
  });
});

describe("performance", () => {
  it("compiles and runs a complex query over 2,000 items quickly", async () => {
    const { buildIndex } = await import("../../src/shared/model/index.js");
    const { records } = await import("./fixture.js");
    const base = records().filter((r) => r.entity !== "work_item");
    const items = Array.from({ length: 2000 }, (_, n) => ({
      id: `aaaaaaaa-0000-4000-8000-${String(n + 1).padStart(12, "0")}`, entity: "work_item", revision: n + 1000,
      created_by: n % 3 ? "cloudflare-os:ada@example.com" : "cloudflare-os:bob@example.com", updated_at: new Date(Date.UTC(2026, 8, 26) - (n % 60) * 86_400_000).toISOString(),
      data: { title: `Item ${n} ${n % 7 ? "login" : "search"}`, description: "Some description text", status: "open", state: ["todo", "in_progress", "done", "backlog"][n % 4], number: n + 1,
        priority: n % 5, labels: n % 2 ? ["bug"] : ["ui", "docs"], estimate: n % 8, due_date: `2026-${String(9 + (n % 3)).padStart(2, "0")}-${String(1 + (n % 28)).padStart(2, "0")}`,
        assignee: n % 4 ? "cloudflare-os:ada@example.com" : undefined },
    }));
    const c = { index: buildIndex([...base, ...items], { keyPrefix: "WRK" }), viewer: "cloudflare-os:ada@example.com", now: Date.UTC(2026, 8, 26, 12), today: "2026-09-26" };
    const q = "(label:bug OR label:regression) -label:wontfix assignee:me priority:<=3 due:<30d updated:>-40d state:todo,in_progress text:login sort:priority,-updated";
    const t0 = performance.now();
    const out = run(parse(q).ast, c);
    const ms = performance.now() - t0;
    console.log(`WQL: ${out.length} of 2000 items in ${ms.toFixed(1)} ms`);
    expect(out.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(150);
  });
});
