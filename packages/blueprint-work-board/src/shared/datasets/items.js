// @ts-check
// The `items` dataset: one flattened row per work item matching the query.

import { registerDataset } from "./registry.js";
import { PRIORITIES } from "../model/work.js";
import { personName } from "../model/index.js";

/** @param {number|null} t */
const iso = (t) => (t === null ? null : new Date(t).toISOString());

registerDataset({
  name: "items",
  title: "Items",
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
    { name: "created_at", type: "instant", description: "When the item was created (ISO 8601 UTC), or null when unknown" },
    { name: "updated_at", type: "instant", description: "When the item last changed (ISO 8601 UTC), or null when unknown" },
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
    created_at: iso(i.created), updated_at: iso(i.updated),
  })),
  summary: (rows) => {
    const by = (/** @type {string} */ s) => rows.filter((r) => r.status === s).length;
    if (!rows.length) return "No items match.";
    return `${rows.length.toLocaleString("en")} ${rows.length === 1 ? "item" : "items"}: ${by("open")} open, ${by("active")} in progress and ${by("done")} done${rows.some((r) => r.blocked) ? `; ${rows.filter((r) => r.blocked).length} blocked` : ""}.`;
  },
});
