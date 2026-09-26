// @ts-check
// Named datasets for reports and the agent: plain rows computed from the normalised index (and,
// later, the journal). This is the boundary the Insights brief builds on: it registers
// `transitions`, `daily_state_counts`, `cycle_burndown`, … here, and both the Reports screen
// (client) and `dataset(name, params)` (gadget server) read through `runDataset`.
//
// Each dataset declares its columns (name, type, description) so the agent has a data dictionary.

import { compile, mentionsArchived, parse } from "../wql/index.js";
import { PRIORITIES } from "../model/work.js";
import { personName } from "../model/index.js";

/**
 * @typedef {import("../model/index.js").WorkIndex} WorkIndex
 * @typedef {import("../replica.js").HistoryEntry} HistoryEntry
 * @typedef {{ index: WorkIndex, viewer: string|null, now: number, today: string, history?: Map<string, HistoryEntry[]> }} DatasetContext
 * @typedef {{ name: string, type: "string"|"number"|"date"|"instant"|"boolean", description: string }} Column
 * @typedef {{ name: string, description: string, columns: Column[], params?: Record<string, string>,
 *   rows: (ctx: DatasetContext, items: import("../model/index.js").ItemView[], params: Record<string, unknown>) => Record<string, unknown>[] }} Dataset
 */

/** @type {Map<string, Dataset>} */
const DATASETS = new Map();

/** @param {Dataset} def */
export function registerDataset(def) { DATASETS.set(def.name, def); }
/** Names, descriptions and columns of every dataset (the data dictionary). */
export function listDatasets() {
  return [...DATASETS.values()].map(({ name, description, columns, params }) => ({ name, description, columns, params: params ?? {} }));
}

/**
 * Rows of a dataset for the items matching `query` (WQL; archived items only when asked for).
 * @param {string} name @param {DatasetContext} ctx @param {{ query?: string, params?: Record<string, unknown>, limit?: number }} [opts]
 */
export function runDataset(name, ctx, opts = {}) {
  const def = DATASETS.get(name);
  if (!def) throw new Error(`not_found: No dataset “${name}”. Available: ${[...DATASETS.keys()].join(", ")}.`);
  const { ast, errors } = parse(opts.query ?? "");
  if (errors.length) throw new Error(`invalid_request: ${errors[0].message}`);
  const pred = compile(ast, ctx);
  const archived = mentionsArchived(ast.where);
  const items = ctx.index.itemList.filter((i) => (archived || !i.archived) && pred(i));
  const rows = def.rows(ctx, items, opts.params ?? {});
  return opts.limit ? rows.slice(0, opts.limit) : rows;
}

registerDataset({
  name: "items",
  description: "One row per work item matching the query, flattened with names and the state kind.",
  columns: [
    { name: "key", type: "string", description: "Item key, e.g. WRK-42" },
    { name: "title", type: "string", description: "Title" },
    { name: "state", type: "string", description: "Workflow state name" },
    { name: "kind", type: "string", description: "State kind: triage, backlog, unstarted, started, completed, canceled" },
    { name: "status", type: "string", description: "Category: open, active or done" },
    { name: "priority", type: "string", description: "Urgent, High, Medium, Low or No priority" },
    { name: "priority_value", type: "number", description: "0 none, 1 urgent … 4 low" },
    { name: "assignee", type: "string", description: "Assignee's name, or null" },
    { name: "labels", type: "string", description: "Label names, comma-separated" },
    { name: "estimate", type: "number", description: "Points, or null" },
    { name: "due", type: "date", description: "Due date (YYYY-MM-DD), or null" },
    { name: "project", type: "string", description: "Project name, or null" },
    { name: "cycle", type: "string", description: "Cycle name, or null" },
    { name: "parent", type: "string", description: "Parent key, or null" },
    { name: "blocked", type: "boolean", description: "Blocked by an unfinished item" },
    { name: "created_by", type: "string", description: "Creator's name" },
  ],
  rows: (ctx, items) => items.map((i) => ({
    key: i.key, title: i.title, state: ctx.index.stateByKey.get(i.state)?.name ?? i.state, kind: i.kind, status: i.category,
    priority: PRIORITIES[i.priority].name, priority_value: i.priority, assignee: i.assignee ? personName(ctx.index, i.assignee) : null,
    labels: i.labels.map((l) => ctx.index.labelByKey.get(l)?.name ?? l).join(", "), estimate: i.estimate, due: i.due,
    project: i.project ? ctx.index.projectById.get(i.project)?.name ?? null : null,
    cycle: i.cycle ? ctx.index.cycleById.get(i.cycle)?.name ?? null : null,
    parent: i.parent ? ctx.index.items.get(i.parent)?.key ?? null : null,
    blocked: (ctx.index.blockedBy.get(i.id)?.length ?? 0) > 0,
    created_by: i.created_by ? personName(ctx.index, i.created_by) : null,
  })),
});
