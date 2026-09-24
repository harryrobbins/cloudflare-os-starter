// Issue search (projects/search.ts): the SQL compiler against the reference semantics
// (evaluateIssueQuery / compareIssues) on a random dataset, plus pagination, cursors, bounds,
// authorisation and literal matching.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  compareIssues,
  DEFAULT_WORKFLOW,
  evaluateIssueQuery,
  PRIORITIES,
  WORKFLOW_CATEGORIES,
  type Issue,
  type IssueOrder,
  type IssuePredicate,
  type IssueQuery,
  type IssueQueryNode,
  type Priority,
} from "@records/contracts";

import { searchIssues } from "../src/index.js";
import { code, createWorld, key, type World } from "./world.js";

let w: World;
let dataset: Issue[];
const projectKeys = new Map<string, string>();
let e2: string;

// Deterministic PRNG (mulberry32), so a failure names a reproducible seed.
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)]!;
  const some = <T>(xs: readonly T[], max = 3): T[] => Array.from({ length: int(max + 1) }, () => pick(xs));
  return { next, int, pick, some };
}

const WORDS = ["Alpha", "beta", "GAMMA", "delta", "under_score", "100%", "per-cent", "o'clock", "Build", "build", "x"];
// Instants with deliberate millisecond ties at different microseconds.
const INSTANTS = [
  "2026-01-01 00:00:00.123456+00",
  "2026-01-01 00:00:00.123999+00",
  "2026-01-01 00:00:00.124000+00",
  "2026-03-15 12:30:00+00",
  "2026-03-15 12:30:00.000001+00",
  "2026-06-30 23:59:59.999+00",
];

async function allIssues(ds: string): Promise<Issue[]> {
  const out: Issue[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await w.service.projects.listIssues(w.olive.caller, ds, { order: "number_asc", limit: 100, ...(cursor ? { cursor } : {}) });
    out.push(...page.items);
    if (!page.nextCursor) return out;
    cursor = page.nextCursor;
  }
}

beforeAll(async () => {
  w = await createWorld();
  e2 = (await w.service.projects.createProject(w.olive.caller, w.ds1, { key: "E2", name: "E two" })).id;
  const zed = (await w.service.projects.createProject(w.olive.caller, w.ds1, { key: "ZED", name: "Zed" })).id;
  projectKeys.set(w.eng, "ENG").set(e2, "E2").set(zed, "ZED");
  const r = rng(20260924);
  const assignees = [null, null, w.olive.id, w.ed.id, w.rae.id];
  const projects = [w.eng, e2, zed];
  for (let n = 0; n < 70; n++) {
    const title = Array.from({ length: 1 + r.int(3) }, () => r.pick(WORDS)).join(r.pick([" ", "-", ""]));
    const description = r.next() < 0.3 ? "" : Array.from({ length: 1 + r.int(4) }, () => r.pick(WORDS)).join(" ");
    await w.service.projects.createIssue(w.olive.caller, w.ds1, {
      projectId: r.pick(projects),
      title,
      description,
      state: r.pick(DEFAULT_WORKFLOW.states).key,
      priority: r.pick(PRIORITIES),
      assigneeId: r.pick(assignees),
    }, key("seed"));
  }
  // An issue in another datastore must never appear.
  await w.service.projects.createIssue(w.olive.caller, w.ds2, { projectId: w.ops, title: "Alpha elsewhere" }, key("ds2"));

  // Timestamps with ties (whole and sub-millisecond); the owner bypasses the journal triggers.
  const ids = (await w.owner`SELECT id FROM projects.issues WHERE datastore_id = ${w.ds1} ORDER BY id`).map((x) => x.id as string);
  await w.owner.begin(async (t) => {
    await t`SET LOCAL session_replication_role = replica`;
    for (const id of ids) {
      await t`UPDATE projects.issues SET created_at = ${r.pick(INSTANTS)}::timestamptz, updated_at = ${r.pick(INSTANTS)}::timestamptz WHERE id = ${id}`;
    }
  });
  dataset = await allIssues(w.ds1);
  expect(dataset).toHaveLength(70);
});
afterAll(async () => w?.close());

const ctx = {
  categoryOf: (s: string) => DEFAULT_WORKFLOW.states.find((x) => x.key === s)?.category ?? null,
  projectKeyOf: (id: string) => projectKeys.get(id) ?? null,
};

function reference(query: IssueQuery): string[] {
  return dataset.filter((i) => evaluateIssueQuery(query.where, i, ctx)).sort(compareIssues(query.orderBy)).map((i) => i.id);
}

async function searchAll(query: IssueQuery, limit: number): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let pages = 0; pages < 200; pages++) {
    const page = await searchIssues(w.app, w.olive.caller, w.ds1, query, { limit, cursor });
    expect(page.items.length).toBeLessThanOrEqual(limit);
    ids.push(...page.items.map((i) => i.id));
    if (!page.nextCursor) return ids;
    cursor = page.nextCursor;
  }
  throw new Error("pagination did not terminate");
}

function randomQuery(r: ReturnType<typeof rng>): IssueQuery {
  const iso = () => new Date(Date.parse(r.pick(INSTANTS).replace(" ", "T").replace("+00", "Z")) + r.pick([-1, 0, 0, 1])).toISOString();
  const pred = (): IssuePredicate => {
    const eqOp = () => r.pick(["=", "!=", "in", "not_in"] as const);
    const emptyOp = () => r.pick(["=", "!=", "in", "not_in", "is_empty", "is_not_empty"] as const);
    switch (r.int(8)) {
      case 0:
        return { type: "pred", field: "project", op: eqOp(), values: r.some([w.eng, e2, "ZED", "ENG", w.eng.toUpperCase(), crypto.randomUUID()]) };
      case 1:
        return { type: "pred", field: "key", op: eqOp(), values: r.some([...dataset.map((i) => i.key), "ENG-999"]) };
      case 2:
        return { type: "pred", field: "status", op: eqOp(), values: r.some([...DEFAULT_WORKFLOW.states.map((s) => s.key), "nowhere"]) };
      case 3:
        return { type: "pred", field: "statusCategory", op: eqOp(), values: r.some(WORKFLOW_CATEGORIES) };
      case 4: {
        const op = emptyOp();
        return { type: "pred", field: "assignee", op, values: op.startsWith("is_") ? [] : r.some([w.olive.id, w.ed.id, w.rae.id, w.nia.id]) };
      }
      case 5: {
        const op = emptyOp();
        return { type: "pred", field: "priority", op, values: op.startsWith("is_") ? [] : r.some<Priority>(PRIORITIES) };
      }
      case 6:
        return { type: "pred", field: r.pick(["created", "updated"] as const), op: r.pick(["=", "!=", "<", "<=", ">", ">="] as const), value: iso() };
      default: {
        const value = r.pick([...WORDS, "alpha beta", "BUILD x", "!!!", "gam", "ta", "%", "_"]);
        return { type: "pred", field: "text", op: r.pick(["~", "!~"] as const), value, in: r.pick(["all", "title", "description"] as const) };
      }
    }
  };
  const node = (depth: number): IssueQueryNode => {
    const roll = r.int(depth >= 3 ? 1 : 4);
    if (roll === 0) return pred();
    if (roll === 1) return { type: "not", clause: node(depth + 1) };
    const clauses = Array.from({ length: 1 + r.int(3) }, () => node(depth + 1));
    return { type: roll === 2 ? "and" : "or", clauses };
  };
  const orderBy: IssueOrder = Array.from({ length: r.int(4) }, () => ({
    field: r.pick(["created", "updated", "priority", "key"] as const),
    direction: r.pick(["asc", "desc"] as const),
  }));
  return { where: r.next() < 0.1 ? null : node(0), orderBy };
}

describe("searchIssues agrees with evaluateIssueQuery / compareIssues", () => {
  it("on random queries, in full and page by page", async () => {
    const seed = Number(process.env.SEARCH_SEED ?? 424242);
    const r = rng(seed);
    for (let n = 0; n < 250; n++) {
      const query = randomQuery(r);
      const expected = reference(query);
      const limit = 1 + r.int(12);
      const got = await searchAll(query, limit);
      expect(got, `seed ${seed}, query ${n}: ${JSON.stringify(query)} limit ${limit}`).toEqual(expected);
    }
  });

  it("orders by created desc (ID tiebreak) by default, with millisecond ties", async () => {
    const got = await searchAll({ where: null, orderBy: [] }, 100);
    expect(got).toEqual(reference({ where: null, orderBy: [] }));
    const ms = dataset.map((i) => i.createdAt);
    expect(new Set(ms).size).toBeLessThan(ms.length); // there really are ties
  });

  it("treats in [] as FALSE and not_in [] as TRUE", async () => {
    expect(await searchAll({ where: { type: "pred", field: "status", op: "in", values: [] }, orderBy: [] }, 100)).toEqual([]);
    expect(await searchAll({ where: { type: "pred", field: "status", op: "not_in", values: [] }, orderBy: [] }, 100)).toHaveLength(70);
    expect(await searchAll({ where: { type: "pred", field: "project", op: "in", values: [] }, orderBy: [] }, 100)).toEqual([]);
  });

  it("accepts project keys and IDs alike", async () => {
    const byKey = await searchAll({ where: { type: "pred", field: "project", op: "=", values: ["E2"] }, orderBy: [{ field: "key", direction: "asc" }] }, 100);
    const byId = await searchAll({ where: { type: "pred", field: "project", op: "=", values: [e2] }, orderBy: [{ field: "key", direction: "asc" }] }, 100);
    expect(byKey).toEqual(byId);
    expect(byKey.length).toBeGreaterThan(0);
  });
});

describe("literal text and bound values", () => {
  it("matches LIKE metacharacters and quotes literally", async () => {
    const issue = (await w.service.projects.createIssue(w.olive.caller, w.ds1, {
      projectId: w.eng, title: "Literal 50%_off \\ o'clock", description: "'; DROP TABLE projects.issues; --",
    }, key("lit"))).record;
    const find = (value: string) =>
      searchAll({ where: { type: "pred", field: "text", op: "~", value, in: "all" }, orderBy: [] }, 100);
    expect(await find("50%_off")).toContain(issue.id); // words 50, off
    expect(await find("DROP TABLE")).toEqual([issue.id]);
    expect(await find("o'clock")).toContain(issue.id);
    const rows = await w.owner`SELECT count(*)::int AS n FROM projects.issues`;
    expect(rows[0]!.n).toBeGreaterThan(0);
  });
});

describe("pages, cursors and bounds", () => {
  const q: IssueQuery = { where: null, orderBy: [{ field: "priority", direction: "desc" }, { field: "key", direction: "asc" }] };

  it("refuses a cursor on another query, and a malformed cursor", async () => {
    const first = await searchIssues(w.app, w.olive.caller, w.ds1, q, { limit: 5 });
    expect(first.nextCursor).toBeTruthy();
    const other: IssueQuery = { where: null, orderBy: [{ field: "priority", direction: "asc" }] };
    expect(await code(searchIssues(w.app, w.olive.caller, w.ds1, other, { limit: 5, cursor: first.nextCursor }))).toBe("validation_failed");
    expect(await code(searchIssues(w.app, w.olive.caller, w.ds1, q, { limit: 5, cursor: "nonsense" }))).toBe("validation_failed");
    const forged = btoa(JSON.stringify({ v: 1, q: "x", k: ["'; --"] }));
    expect(await code(searchIssues(w.app, w.olive.caller, w.ds1, q, { limit: 5, cursor: forged }))).toBe("validation_failed");
  });

  it("bounds the page size and the query", async () => {
    expect(await code(searchIssues(w.app, w.olive.caller, w.ds1, q, { limit: 0 }))).toBe("validation_failed");
    expect(await code(searchIssues(w.app, w.olive.caller, w.ds1, q, { limit: 101 }))).toBe("validation_failed");
    let deep: IssueQueryNode = { type: "pred", field: "status", op: "=", values: ["todo"] };
    for (let i = 0; i < 13; i++) deep = { type: "not", clause: deep };
    expect(await code(searchIssues(w.app, w.olive.caller, w.ds1, { where: deep, orderBy: [] }))).toBe("validation_failed");
    expect(await code(searchIssues(w.app, w.olive.caller, w.ds1, { where: { type: "pred", field: "title", op: "=", values: [] }, orderBy: [] }))).toBe("validation_failed");
  });

  it("returns numeric Jira ids beside the DTOs", async () => {
    const page = await searchIssues(w.app, w.olive.caller, w.ds1, q, { limit: 3 });
    for (const i of page.items) expect(Number.isInteger(i.jiraId) && i.jiraId > 0).toBe(true);
  });
});

describe("authorisation", () => {
  it("needs listIssues on the datastore, and stays inside it", async () => {
    expect(await code(searchIssues(w.app, w.nia.caller, w.ds1, { where: null, orderBy: [] }))).toBe("not_found");
    const asReader = await searchIssues(w.app, w.rae.caller, w.ds1, { where: null, orderBy: [] }, { limit: 100 });
    expect(asReader.items.every((i) => projectKeys.has(i.projectId))).toBe(true);
    const ds2 = await searchIssues(w.app, w.ed.caller, w.ds2, { where: { type: "pred", field: "text", op: "~", value: "alpha", in: "all" }, orderBy: [] });
    expect(ds2.items.map((i) => i.title)).toEqual(["Alpha elsewhere"]);
  });
});
