// A transport-neutral issue query: a bounded boolean tree over a few issue fields, plus ordering.
//
// Adapters (the Jira JQL subset today; a native filter language later) parse their own syntax into
// this tree, resolving names to stored identifiers as they go: statuses become workflow state keys,
// projects become project IDs, users become principal IDs, and relative dates become ISO instants.
// The core compiles the tree to SQL. Nothing in the tree is a raw string that reaches SQL other than
// as a bound parameter.
//
// `evaluateIssueQuery` and `compareIssues` are the reference semantics, in memory. The SQL compiler
// must agree with them; tests and in-memory fakes use them directly.

import { z } from "zod";

import {
  LIMITS,
  PRIORITIES,
  UuidSchema,
  WORKFLOW_CATEGORIES,
  type Issue,
  type Priority,
  type WorkflowCategory,
} from "./dto.js";

// ---------------------------------------------------------------------------------------------
// Bounds

export const ISSUE_QUERY_LIMITS = {
  /** Deepest nesting of and/or/not nodes, counting the root. */
  maxDepth: 12,
  /** Total nodes (boolean nodes plus predicates) in one query. */
  maxNodes: 200,
  /** Values in one IN / NOT IN list. */
  maxValues: 100,
  /** Keys in one ORDER BY. */
  maxOrderKeys: 4,
} as const;

// ---------------------------------------------------------------------------------------------
// Predicates

/**
 * Operators. `in`/`not_in` take a list; `is_empty`/`is_not_empty` take none; `~`/`!~` are text
 * containment; comparisons apply to instants only.
 */
export const ISSUE_QUERY_OPS = ["=", "!=", "in", "not_in", "is_empty", "is_not_empty", "<", "<=", ">", ">=", "~", "!~"] as const;
export type IssueQueryOp = (typeof ISSUE_QUERY_OPS)[number];

const EqOps = z.enum(["=", "!=", "in", "not_in"]);
const EqOrEmptyOps = z.enum(["=", "!=", "in", "not_in", "is_empty", "is_not_empty"]);
const CompareOps = z.enum(["=", "!=", "<", "<=", ">", ">="]);

const Values = <T extends z.ZodType>(item: T) => z.array(item).max(ISSUE_QUERY_LIMITS.maxValues);

/** A project reference: its ID (what parsers emit) or its key (accepted for hand-written queries). */
export const ProjectRefSchema = z.union([UuidSchema, z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/)]);
const IssueKeySchema = z.string().regex(/^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,9}$/);
const StateKeySchema = z.string().min(1).max(40);
/** An ISO 8601 instant with an explicit offset, e.g. `2026-09-24T00:00:00.000Z`. */
const InstantSchema = z.iso.datetime({ offset: true });

/**
 * Leaf predicates. An empty `values` list is allowed: `in []` matches nothing and `not_in []`
 * matches everything, which is how parsers express constant clauses (e.g. JQL `issuetype = Task`,
 * or `assignee = currentUser()` for an anonymous caller). A SQL compiler must emit FALSE/TRUE for
 * these rather than an empty `IN ()`.
 */
export const IssuePredicateSchema = z.discriminatedUnion("field", [
  z.object({ type: z.literal("pred"), field: z.literal("project"), op: EqOps, values: Values(ProjectRefSchema) }).strict(),
  z.object({ type: z.literal("pred"), field: z.literal("key"), op: EqOps, values: Values(IssueKeySchema) }).strict(),
  z.object({ type: z.literal("pred"), field: z.literal("status"), op: EqOps, values: Values(StateKeySchema) }).strict(),
  z.object({ type: z.literal("pred"), field: z.literal("statusCategory"), op: EqOps, values: Values(z.enum(WORKFLOW_CATEGORIES)) }).strict(),
  /** Principal IDs. `is_empty` means unassigned. */
  z.object({ type: z.literal("pred"), field: z.literal("assignee"), op: EqOrEmptyOps, values: Values(UuidSchema) }).strict(),
  /** `none` is the empty priority: `is_empty` and `= none` mean the same thing. */
  z.object({ type: z.literal("pred"), field: z.literal("priority"), op: EqOrEmptyOps, values: Values(z.enum(PRIORITIES)) }).strict(),
  z.object({ type: z.literal("pred"), field: z.enum(["created", "updated"]), op: CompareOps, value: InstantSchema }).strict(),
  /**
   * Case-insensitive containment of every word of `value` (Jira `~` semantics, simplified: no
   * stemming, no wildcards). `in` chooses the searched fields.
   */
  z.object({
    type: z.literal("pred"),
    field: z.literal("text"),
    op: z.enum(["~", "!~"]),
    value: z.string().trim().min(1).max(LIMITS.searchQueryMax),
    in: z.enum(["all", "title", "description"]),
  }).strict(),
]);
export type IssuePredicate = z.infer<typeof IssuePredicateSchema>;
export type IssueQueryField = IssuePredicate["field"];

export type IssueQueryNode =
  | IssuePredicate
  | { type: "and"; clauses: IssueQueryNode[] }
  | { type: "or"; clauses: IssueQueryNode[] }
  | { type: "not"; clause: IssueQueryNode };

export const IssueQueryNodeSchema: z.ZodType<IssueQueryNode> = z.lazy(() =>
  z.union([
    IssuePredicateSchema,
    z.object({ type: z.literal("and"), clauses: z.array(IssueQueryNodeSchema).min(1).max(ISSUE_QUERY_LIMITS.maxNodes) }).strict(),
    z.object({ type: z.literal("or"), clauses: z.array(IssueQueryNodeSchema).min(1).max(ISSUE_QUERY_LIMITS.maxNodes) }).strict(),
    z.object({ type: z.literal("not"), clause: IssueQueryNodeSchema }).strict(),
  ]),
);

// ---------------------------------------------------------------------------------------------
// Ordering

export const ISSUE_ORDER_FIELDS = ["created", "updated", "priority", "key"] as const;
export type IssueOrderField = (typeof ISSUE_ORDER_FIELDS)[number];

/**
 * `priority desc` puts the most urgent first (Jira's convention). `key` orders by project key, then
 * issue number. An empty order means the core's default, `created desc`; the core always adds the
 * issue ID as a final tiebreaker so pages are stable.
 */
export const IssueOrderSchema = z
  .array(z.object({ field: z.enum(ISSUE_ORDER_FIELDS), direction: z.enum(["asc", "desc"]) }).strict())
  .max(ISSUE_QUERY_LIMITS.maxOrderKeys);
export type IssueOrder = z.infer<typeof IssueOrderSchema>;

// ---------------------------------------------------------------------------------------------
// The query

export type IssueQuery = {
  /** Null matches every issue the caller may read. */
  where: IssueQueryNode | null;
  orderBy: IssueOrder;
};

/** Depth and size of a tree, for the bounds check. */
export function measureIssueQuery(node: IssueQueryNode | null): { depth: number; nodes: number } {
  if (!node) return { depth: 0, nodes: 0 };
  if (node.type === "pred") return { depth: 1, nodes: 1 };
  const children = node.type === "not" ? [node.clause] : node.clauses;
  let depth = 0;
  let nodes = 1;
  for (const child of children) {
    const m = measureIssueQuery(child);
    depth = Math.max(depth, m.depth);
    nodes += m.nodes;
  }
  return { depth: depth + 1, nodes };
}

export const IssueQuerySchema = z
  .object({ where: IssueQueryNodeSchema.nullable(), orderBy: IssueOrderSchema })
  .strict()
  .superRefine((q, ctx) => {
    const { depth, nodes } = measureIssueQuery(q.where);
    if (depth > ISSUE_QUERY_LIMITS.maxDepth) ctx.addIssue({ code: "custom", message: `the query nests deeper than ${ISSUE_QUERY_LIMITS.maxDepth}` });
    if (nodes > ISSUE_QUERY_LIMITS.maxNodes) ctx.addIssue({ code: "custom", message: `the query has more than ${ISSUE_QUERY_LIMITS.maxNodes} clauses` });
  });

// ---------------------------------------------------------------------------------------------
// Reference semantics

export type IssueQueryContext = {
  /** Category of a workflow state; unknown states match no category. */
  categoryOf(stateKey: string): WorkflowCategory | null;
  /** Key of a project, so project predicates can use keys. Optional when parsers emit IDs only. */
  projectKeyOf?(projectId: string): string | null;
};

const PRIORITY_RANK: Record<Priority, number> = { none: 0, low: 1, medium: 2, high: 3, urgent: 4 };

function eq<T>(op: string, actual: T, values: readonly T[]): boolean {
  switch (op) {
    case "=":
    case "in":
      return values.includes(actual);
    case "!=":
    case "not_in":
      return !values.includes(actual);
    default:
      return false;
  }
}

function words(s: string): string[] {
  return s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function containsAll(haystack: string, needle: string): boolean {
  const hay = haystack.toLowerCase();
  const ws = words(needle);
  return ws.length > 0 && ws.every((w) => hay.includes(w));
}

function evaluatePredicate(p: IssuePredicate, issue: Issue, ctx: IssueQueryContext): boolean {
  switch (p.field) {
    case "project": {
      const key = ctx.projectKeyOf?.(issue.projectId) ?? null;
      const matches = p.values.some((v) => v === issue.projectId || (key !== null && v === key));
      return p.op === "=" || p.op === "in" ? matches : !matches;
    }
    case "key":
      return eq(p.op, issue.key, p.values);
    case "status":
      return eq(p.op, issue.state, p.values);
    case "statusCategory": {
      const category = ctx.categoryOf(issue.state);
      const matches = category !== null && p.values.includes(category);
      return p.op === "=" || p.op === "in" ? matches : !matches;
    }
    case "assignee": {
      const id = issue.assignee?.id ?? null;
      if (p.op === "is_empty") return id === null;
      if (p.op === "is_not_empty") return id !== null;
      // Jira semantics: `assignee != X` does not match unassigned issues.
      if (id === null) return false;
      return eq(p.op, id, p.values);
    }
    case "priority": {
      if (p.op === "is_empty") return issue.priority === "none";
      if (p.op === "is_not_empty") return issue.priority !== "none";
      if ((p.op === "!=" || p.op === "not_in") && issue.priority === "none" && !p.values.includes("none")) return false;
      return eq(p.op, issue.priority, p.values);
    }
    case "created":
    case "updated": {
      const actual = Date.parse(p.field === "created" ? issue.createdAt : issue.updatedAt);
      const value = Date.parse(p.value);
      switch (p.op) {
        case "=": return actual === value;
        case "!=": return actual !== value;
        case "<": return actual < value;
        case "<=": return actual <= value;
        case ">": return actual > value;
        case ">=": return actual >= value;
      }
      return false;
    }
    case "text": {
      const hay = p.in === "title" ? issue.title : p.in === "description" ? issue.description : `${issue.title}\n${issue.description}`;
      const found = containsAll(hay, p.value);
      return p.op === "~" ? found : !found;
    }
  }
}

/** Whether `issue` matches `node` (null matches everything). */
export function evaluateIssueQuery(node: IssueQueryNode | null, issue: Issue, ctx: IssueQueryContext): boolean {
  if (!node) return true;
  switch (node.type) {
    case "pred":
      return evaluatePredicate(node, issue, ctx);
    case "and":
      return node.clauses.every((c) => evaluateIssueQuery(c, issue, ctx));
    case "or":
      return node.clauses.some((c) => evaluateIssueQuery(c, issue, ctx));
    case "not":
      return !evaluateIssueQuery(node.clause, issue, ctx);
  }
}

/** Comparator for `orderBy`, with the default and the ID tiebreaker applied. */
export function compareIssues(orderBy: IssueOrder): (a: Issue, b: Issue) => number {
  const keys: IssueOrder = orderBy.length > 0 ? orderBy : [{ field: "created", direction: "desc" }];
  return (a, b) => {
    for (const { field, direction } of keys) {
      let c = 0;
      if (field === "created") c = Date.parse(a.createdAt) - Date.parse(b.createdAt);
      else if (field === "updated") c = Date.parse(a.updatedAt) - Date.parse(b.updatedAt);
      else if (field === "priority") c = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
      else {
        const [pa, na] = splitKey(a.key);
        const [pb, nb] = splitKey(b.key);
        c = pa < pb ? -1 : pa > pb ? 1 : na - nb;
      }
      if (c !== 0) return direction === "asc" ? c : -c;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
}

function splitKey(key: string): [string, number] {
  const i = key.lastIndexOf("-");
  return [key.slice(0, i), Number(key.slice(i + 1))];
}
