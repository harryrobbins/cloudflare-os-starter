import { describe, expect, it } from "vitest";
import { describe as describeQuery, format, parse } from "../../src/shared/wql/index.js";
import { context, strip } from "./fixture.js";

const canon = (q) => format(parse(q).ast);

describe("format: canonical text", () => {
  it.each([
    ["", ""],
    ["status:active  assignee:me", "status:active assignee:me"],
    ["category:done", "status:done"],
    ["labels:bug", "label:bug"],
    ["due_date:<7d", "due:<7d"],
    ["creator:me", "created_by:me"],
    ["number:1..5", "key:1..5"],
    ["Priority:=High", "priority:High"],
    ["a and b", "a b"],
    ["a or b", "a OR b"],
    ["(a OR b) c", "(a OR b) c"],
    ["a OR (b c)", "a OR b c"],
    ["((a))", "a"],
    ["(a b) c", "a b c"],
    ["(a OR b) OR c", "a OR b OR c"],
    ["a AND (b OR c) AND d", "a (b OR c) d"],
    ["(a OR b) (c OR d)", "(a OR b) (c OR d)"],
    ["NOT label:bug", "-label:bug"],
    ["NOT (a OR b)", "-(a OR b)"],
    ["-(a b)", "-(a b)"],
    ["-(-a)", "a"],
    ["--a", "a"],
    ['project:"Website relaunch"', 'project:"Website relaunch"'],
    ['text:"login"', "text:login"],
    ['"login"', "login"],
    ['"login page"', '"login page"'],
    ['"or"', '"or"'],
    ['"-x"', '"-x"'],
    ['"a:b"', '"a:b"'],
    ['label:"a,b"', 'label:"a,b"'],
    ["label:a,b", "label:a,b"],
    ['label:"quote\\"d"', 'label:"quote\\"d"'],
    ['label:"back\\\\slash"', 'label:"back\\\\slash"'],
    ['estimate:"1..2"', 'estimate:"1..2"'],
    ['text:"<5"', 'text:"<5"'],
    ['due:"2026-01-01"', "due:2026-01-01"],
    ["sort:priority sort:-updated", "sort:priority,-updated"],
    ["sort:-updated status:open", "status:open sort:-updated"],
    ["IS:Blocked", "is:blocked"],
    ["has:due_date", "has:due"],
    ["is:blocked,overdue", "is:blocked OR is:overdue"],
    ["ext.Team:web", "ext.Team:web"],
    ["x:y status:open", "status:open"],
    ["estimate:>=3", "estimate:>=3"],
    ["due:2026-09-01..2026-09-30", "due:2026-09-01..2026-09-30"],
    ["a OR b c OR d", "a OR b c OR d"],
    ["-is:blocked -has:estimate", "-is:blocked -has:estimate"],
  ])("%s → %s", (q, expected) => {
    expect(canon(q)).toBe(expected);
    expect(canon(expected)).toBe(expected);
  });
});

// A tiny deterministic PRNG (mulberry32) and a random query generator.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIELDS = ["status", "state", "kind", "priority", "assignee", "created_by", "label", "estimate", "due", "created", "updated", "parent", "project", "cycle", "key", "text", "title", "archived", "ext.team", "labels", "due_date", "category"];
const COMPARABLE = new Set(["status", "state", "kind", "priority", "estimate", "due", "created", "updated", "key", "ext.team", "due_date", "category"]);
const VALUES = ["bug", "In Progress", "a,b", 'say "hi"', "x\\y", "-7d", "2026-09-30", "3", "me", "none", "<5", "a..b", "Done", "WRK-4", "current", "é", "x:y", "(p)"];
const WORDS = ["login", "or", "Fix bug", "-dash", "WRK-7", "a:b", "(x)", "and", "plain"];

const quoteWord = (v) => (/^[A-Za-z0-9_-]+$/.test(v) && !v.startsWith('-') ? v : `"${v.replace(/[\\"]/g, (c) => `\\${c}`)}"`);

function generate(rand, depth = 0) {
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const r = rand();
  if (depth < 3 && r < 0.2) {
    const n = 2 + Math.floor(rand() * 3);
    const parts = Array.from({ length: n }, () => generate(rand, depth + 1));
    const joiner = pick([" ", " AND ", " and ", " OR ", " or "]);
    return `(${parts.join(joiner)})`;
  }
  if (r < 0.3) return `${pick(["-", "NOT ", "not "])}${generate(rand, depth + 1)}`;
  if (r < 0.4) return quoteWord(pick(WORDS));
  if (r < 0.47) return `is:${pick(["blocked", "overdue", "stale", "sub", "open", "Parent"])}`;
  if (r < 0.52) return `has:${pick(["due", "label", "estimate", "ext.team", "assignee"])}`;
  if (r < 0.56) return `sort:${pick(["-", ""])}${pick(["priority", "updated", "due", "key"])}`;
  const field = pick(FIELDS);
  const kind = rand();
  if (COMPARABLE.has(field) && kind < 0.25) return `${field}:${pick(["<", "<=", ">", ">=", "="])}${quoteWord(pick(VALUES))}`;
  if (COMPARABLE.has(field) && kind < 0.4) return `${field}:${pick(["1", "2026-09-01", "high"])}..${pick(["5", "2026-10-01", "low"])}`;
  const n = 1 + Math.floor(rand() * 3);
  return `${field}:${Array.from({ length: n }, () => quoteWord(pick(VALUES))).join(",")}`;
}

describe("format: round-trip property", () => {
  it("parse(format(parse(x))) equals parse(x) and format is idempotent, for 600 generated queries", () => {
    const rand = prng(20260926);
    let clean = 0;
    for (let i = 0; i < 600; i++) {
      const n = 1 + Math.floor(rand() * 5);
      const text = Array.from({ length: n }, () => generate(rand)).join(rand() < 0.3 ? " AND " : rand() < 0.2 ? " OR " : " ");
      const first = parse(text);
      if (!first.errors.length) clean++;
      const once = format(first.ast);
      const again = parse(once);
      expect(again.errors, `${text} → ${once}`).toEqual([]);
      expect(strip(again.ast), `${text} → ${once}`).toEqual(strip(first.ast));
      expect(format(again.ast)).toBe(once);
    }
    expect(clean).toBeGreaterThan(300);
  });
});

describe("describe", () => {
  const ctx = context();
  it.each([
    ["", "All items"],
    ["sort:key", "All items, sorted by key."],
    ["status:active assignee:me priority:<=high label:bug -label:wontfix sort:priority,-updated",
      "Items with status Active, assigned to you, with priority High or higher, labelled bug, not labelled wontfix, sorted by priority, then most recently updated."],
    ["state:todo,in_progress", "Items in Todo or In Progress."],
    ["assignee:none", "Items that are unassigned."],
    ["assignee:bob", "Items assigned to bob@example.com."],
    ["is:blocked", "Items that are blocked."],
    ["-is:blocked", "Items that are not blocked."],
    ["-is:blocking", "Items that do not block other items."],
    ["-is:parent", "Items that do not have sub-issues."],
    ["has:due", "Items with a due date."],
    ["-has:due", "Items without a due date."],
    ["due:<7d", "Items due before in 7 days."],
    ["updated:>-14d", "Items updated after 14 days ago."],
    ["due:today", "Items due today."],
    ["due:none", "Items with no due date."],
    ["cycle:current", "Items in the current cycle (Cycle 2)."],
    ['project:"website relaunch"', "Items in project Website relaunch."],
    ["priority:urgent,high", "Items with priority Urgent or High."],
    ["priority:>=medium", "Items with priority Medium or lower."],
    ["estimate:2..5", "Items with estimate between 2 and 5."],
    ["estimate:>=3", "Items with estimate at least 3."],
    ["label:bug OR label:ui", "Items either labelled bug or labelled ui."],
    ["-(label:bug OR label:ui)", "Items not (either labelled bug or labelled ui)."],
    ['login "page"', "Items mentioning “login”, mentioning “page”."],
    ["parent:WRK-1", "Items sub-issues of WRK-1."],
    ["kind:started", "Items in a started state."],
    ["archived:true", "Items that are archived."],
    ["ext.team:web", "Items with ext.team equal to web."],
    ["sort:-created", "All items, sorted by newest first."],
  ])("%s", (q, expected) => expect(describeQuery(parse(q).ast, ctx)).toBe(expected));

  it("works without a context", () => {
    expect(describeQuery(parse("state:todo cycle:current assignee:me").ast)).toBe("Items in todo, in the current cycle, assigned to you.");
  });
});
