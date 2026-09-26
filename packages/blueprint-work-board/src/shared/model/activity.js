// @ts-check
// Journal entries as readable sentence fragments ("moved from Todo to In Progress"), shared by the
// detail panel's activity list and the gadget server's history() for the agent.

import { PRIORITIES, shortDate } from "./work.js";
import { personName } from "./index.js";

/**
 * @typedef {import("./index.js").WorkIndex} WorkIndex
 * @typedef {import("../replica.js").HistoryEntry} HistoryEntry
 */

/**
 * One journal entry as a sentence fragment ("moved from Todo to In Progress").
 * @param {HistoryEntry} e @param {WorkIndex} index @param {string} today
 */
export function describeEntry(e, index, today) {
  if (e.created) return "created the item";
  const d = e.diff;
  /** @type {string[]} */
  const parts = [];
  const stateName = (/** @type {unknown} */ k) => index.stateByKey.get(String(k))?.name ?? String(k ?? "");
  if (d.state) parts.push(d.state[0] ? `moved from ${stateName(d.state[0])} to ${stateName(d.state[1])}` : `moved to ${stateName(d.state[1])}`);
  else if (d.status) parts.push(`changed status to ${String(d.status[1])}`);
  if (d.title) parts.push(`renamed it to “${String(d.title[1] ?? "")}”`);
  if (d.description) parts.push("edited the description");
  if (d.priority) parts.push(Number(d.priority[1]) ? `set priority to ${PRIORITIES[Number(d.priority[1])]?.name ?? d.priority[1]}` : "removed the priority");
  if (d.assignee) parts.push(d.assignee[1] ? `assigned it to ${personName(index, /** @type {string} */ (d.assignee[1]))}` : "unassigned it");
  if (d.labels) {
    const before = new Set(/** @type {string[]} */ (d.labels[0] ?? [])), after = new Set(/** @type {string[]} */ (d.labels[1] ?? []));
    const added = [...after].filter((l) => !before.has(l)), removed = [...before].filter((l) => !after.has(l));
    const name = (/** @type {string} */ l) => index.labelByKey.get(l)?.name ?? l;
    if (added.length) parts.push(`added ${added.length === 1 ? "label" : "labels"} ${added.map(name).join(", ")}`);
    if (removed.length) parts.push(`removed ${removed.length === 1 ? "label" : "labels"} ${removed.map(name).join(", ")}`);
  }
  if (d.estimate) parts.push(d.estimate[1] === null ? "removed the estimate" : `estimated it at ${d.estimate[1]}`);
  if (d.due_date) parts.push(d.due_date[1] ? `set the due date to ${shortDate(String(d.due_date[1]), today)}` : "removed the due date");
  if (d.start_date) parts.push(d.start_date[1] ? `set the start date to ${shortDate(String(d.start_date[1]), today)}` : "removed the start date");
  if (d.parent) { const p = index.items.get(String(d.parent[1] ?? "")); parts.push(p ? `moved it under ${p.key}` : "removed the parent"); }
  if (d.project) { const p = index.projectById.get(String(d.project[1] ?? "")); parts.push(p ? `moved it to ${p.name}` : "removed it from its project"); }
  if (d.cycle) { const cy = index.cycleById.get(String(d.cycle[1] ?? "")); parts.push(cy ? `added it to ${cy.name}` : "removed it from its cycle"); }
  if (d.archived) parts.push(d.archived[1] ? "archived it" : "restored it");
  if (d.rank && !parts.length) parts.push("reordered it");
  if (d.extensions) parts.push("updated custom fields");
  if (!parts.length) return "";
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
