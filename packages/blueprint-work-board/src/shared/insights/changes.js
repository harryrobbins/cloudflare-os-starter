// @ts-check
// Proposed changes: turning an agent's (or Jev's) friendly change description into the exact
// Records command a person will apply, and describing it readably ("WRK-12 priority High →
// Urgent"). Pure; the gadget server validates proposals with it and re-validates on refresh.
//
// Friendly values accepted in `input`:
//   item references (id, parent, relation from/to, comment item): a key such as "WRK-12" or a record id
//   state: a state name or key ("In Review", "in_review")        priority: 0–4 or urgent/high/medium/low/none
//   assignee: a person's name, a Records actor id, or null        labels: names or keys; or labels_add / labels_remove
//   project: a project name; cycle: a cycle name, number, current, next or previous; null clears either

import { KIND_LABELS, PRIORITIES, isIsoDate } from "../model/work.js";
import { personName, relationsFor } from "../model/index.js";
import { checkEntityInput, checkItemFields, updateInput } from "../../client/store/commands.js";
import { findCycle } from "../datasets/flow.js";

export const PROPOSAL_COMMANDS = Object.freeze(["work.update", "work.create", "work.relation.create", "work.relation.update", "work.comment.create", "work.label.create"]);
const ITEM_FIELDS = new Set(["title", "description", "state", "status", "priority", "assignee", "labels", "labels_add", "labels_remove", "estimate", "start_date", "due_date", "parent", "project", "cycle", "archived", "rank"]);
const ACTOR = /^[a-z][a-z0-9-]{0,39}:.+$/;
const PRIORITY_WORDS = { none: 0, urgent: 1, high: 2, medium: 3, low: 4, "no priority": 0 };

/**
 * @typedef {import("../model/index.js").WorkIndex} WorkIndex
 * @typedef {import("../model/index.js").ItemView} ItemView
 * @typedef {{ field: string, label: string, from: string, to: string }} DiffLine
 * @typedef {{ command: string, input: Record<string, unknown>, revision?: number, item_id: string|null, key: string|null,
 *   diff: DiffLine[], text: string, noop: boolean }} NormalisedChange
 */

/** @param {string} message */
const invalid = (message) => new Error(`invalid_request: ${message}`);
/** @param {unknown} v @returns {v is Record<string, any>} */
const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
/** @param {string} s @param {number} n */
const clip = (s, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** @param {WorkIndex} ix @param {unknown} ref @param {string} what */
export function resolveItem(ix, ref, what = "item") {
  if (typeof ref !== "string" || !ref.trim()) throw invalid(`${what} must be an item key such as ${ix.keyPrefix}-12.`);
  const text = ref.trim();
  const numeric = /^(?:[A-Za-z][A-Za-z0-9]*-)?(\d+)$/.exec(text);
  const item = numeric ? ix.byNumber.get(Number(numeric[1])) : ix.items.get(text.toLowerCase()) ?? [...ix.items.values()].find((i) => i.key === text);
  if (!item) throw new Error(`not_found: No item ${text}.`);
  return item;
}

/** @param {WorkIndex} ix @param {unknown} v */
function resolveStateKey(ix, v) {
  const t = String(v ?? "").trim().toLowerCase();
  const s = ix.states.find((x) => x.key.toLowerCase() === t || x.name.toLowerCase() === t);
  if (!s) throw invalid(`Unknown state “${v}”. States: ${ix.states.map((x) => x.name).join(", ")}.`);
  return s.key;
}

/** @param {unknown} v */
function resolvePriority(v) {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 4) return v;
  const t = String(v ?? "").trim().toLowerCase();
  if (/^[0-4]$/.test(t)) return Number(t);
  const p = /** @type {Record<string, number>} */ (PRIORITY_WORDS)[t];
  if (p === undefined) throw invalid(`Unknown priority “${v}”: use urgent, high, medium, low or none (or 1–4, 0 for none).`);
  return p;
}

/** @param {WorkIndex} ix @param {unknown} v */
function resolvePerson(ix, v) {
  if (v === null || v === "" || v === undefined) return null;
  if (typeof v !== "string") throw invalid("assignee is a person's name or a Records actor id.");
  const t = v.trim();
  if (ACTOR.test(t) && !/\s/.test(t)) return t;
  const people = [...ix.people.values()];
  const exact = people.filter((p) => p.name.toLowerCase() === t.toLowerCase());
  const loose = exact.length ? exact : people.filter((p) => p.name.toLowerCase().startsWith(t.toLowerCase()) || p.id.toLowerCase().includes(`:${t.toLowerCase()}`));
  if (loose.length === 1) return loose[0].id;
  if (loose.length > 1) throw invalid(`“${v}” matches ${loose.map((p) => p.name).join(", ")}; be more specific.`);
  throw invalid(`Nobody called “${v}” is on this board. People: ${people.map((p) => p.name).join(", ")}.`);
}

/** @param {WorkIndex} ix @param {unknown} v */
function resolveLabel(ix, v) {
  const t = String(v ?? "").trim();
  const l = ix.labels.find((x) => x.key.toLowerCase() === t.toLowerCase() || x.name.toLowerCase() === t.toLowerCase());
  return l?.key ?? t;
}

/** @param {WorkIndex} ix @param {string} field @param {unknown} v @param {string} today */
function resolveRef(ix, field, v, today) {
  if (v === null) return null;
  if (field === "parent") return resolveItem(ix, v, "parent").id;
  if (field === "project") {
    const t = String(v).trim().toLowerCase();
    const p = ix.projects.find((x) => x.name.toLowerCase() === t || x.id === t);
    if (!p) throw invalid(`Unknown project “${v}”. Projects: ${ix.projects.map((x) => x.name).join(", ") || "none"}.`);
    return p.id;
  }
  try { return findCycle(ix, v, today).id; } catch (err) { throw invalid(String(/** @type {Error} */ (err).message).replace(/^invalid_request:\s*/, "")); }
}

/**
 * Friendly work_item fields → exact command fields.
 * @param {WorkIndex} ix @param {Record<string, any>} input @param {ItemView|null} item @param {string} today
 */
function itemFields(ix, input, item, today) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (k === "id") continue;
    if (!ITEM_FIELDS.has(k)) throw invalid(`Unknown field “${k}”. Fields: ${[...ITEM_FIELDS].join(", ")}.`);
    if (k === "state") out.state = resolveStateKey(ix, v);
    else if (k === "priority") out.priority = resolvePriority(v);
    else if (k === "assignee") out.assignee = resolvePerson(ix, v);
    else if (k === "labels") { if (!Array.isArray(v)) throw invalid("labels is a list."); out.labels = [...new Set(v.map((l) => resolveLabel(ix, l)))]; }
    else if (k === "parent" || k === "project" || k === "cycle") out[k] = resolveRef(ix, k, v, today);
    else if ((k === "due_date" || k === "start_date") && v !== null && !isIsoDate(v)) throw invalid(`${k} is a date like 2026-10-30.`);
    else if (k !== "labels_add" && k !== "labels_remove") out[k] = v;
  }
  if (input.labels_add !== undefined || input.labels_remove !== undefined) {
    if (input.labels !== undefined) throw invalid("Use labels, or labels_add/labels_remove, not both.");
    const add = Array.isArray(input.labels_add) ? input.labels_add.map((l) => resolveLabel(ix, l)) : [];
    const remove = new Set(Array.isArray(input.labels_remove) ? input.labels_remove.map((l) => resolveLabel(ix, l)) : []);
    out.labels = [...new Set([...(item?.labels ?? []), ...add])].filter((l) => !remove.has(l));
  }
  return out;
}

/** A readable value of a field. @param {WorkIndex} ix @param {string} field @param {unknown} v */
export function showValue(ix, field, v) {
  if (v === null || v === undefined || (Array.isArray(v) && !v.length)) return "none";
  switch (field) {
    case "state": return ix.stateByKey.get(String(v))?.name ?? String(v);
    case "priority": return PRIORITIES[Number(v)]?.name ?? String(v);
    case "assignee": return personName(ix, String(v));
    case "labels": return /** @type {string[]} */ (v).map((l) => ix.labelByKey.get(l)?.name ?? l).join(", ");
    case "parent": return ix.items.get(String(v))?.key ?? String(v);
    case "project": return ix.projectById.get(String(v))?.name ?? String(v);
    case "cycle": return ix.cycleById.get(String(v))?.name ?? String(v);
    case "archived": return v ? "archived" : "not archived";
    case "title": return `“${clip(String(v))}”`;
    case "description": return clip(String(v).replace(/\s+/g, " "), 40) || "none";
    case "kind": return /** @type {Record<string, string>} */ (KIND_LABELS)[String(v)] ?? String(v);
    default: return String(v);
  }
}
const LABELS = { state: "State", status: "Status", priority: "Priority", assignee: "Assignee", labels: "Labels", estimate: "Estimate", due_date: "Due", start_date: "Start", parent: "Parent", project: "Project", cycle: "Cycle", archived: "Archived", title: "Title", description: "Description", rank: "Position" };

/** @param {WorkIndex} ix @param {Record<string, unknown>} fields @param {Record<string, unknown>} before */
function diffOf(ix, fields, before) {
  return Object.entries(fields).filter(([k]) => k !== "id" && k !== "rank" && !(k === "status" && "state" in fields)).map(([k, v]) => {
    const label = /** @type {Record<string, string>} */ (LABELS)[k] ?? k;
    if (k === "labels") {
      const was = new Set(/** @type {string[]} */ (before.labels ?? [])), now = new Set(/** @type {string[]} */ (v ?? []));
      const added = [...now].filter((l) => !was.has(l)), removed = [...was].filter((l) => !now.has(l));
      const name = (/** @type {string} */ l) => ix.labelByKey.get(l)?.name ?? l;
      return { field: k, label, from: showValue(ix, k, before.labels), to: [added.length ? `+ ${added.map(name).join(", ")}` : "", removed.length ? `− ${removed.map(name).join(", ")}` : ""].filter(Boolean).join(" ") || showValue(ix, k, v) };
    }
    return { field: k, label, from: showValue(ix, k, before[k]), to: showValue(ix, k, v) };
  });
}

/**
 * Validates and normalises one proposed change against the current datastore.
 * @param {WorkIndex} ix @param {unknown} change @param {{ today: string, planning: boolean }} ctx
 * @returns {NormalisedChange}
 */
export function normaliseChange(ix, change, ctx) {
  if (!isObject(change)) throw invalid("Each change is { command, input, revision?, reason? }.");
  const { command } = change;
  if (typeof command !== "string" || !PROPOSAL_COMMANDS.includes(command)) throw invalid(`command must be one of ${PROPOSAL_COMMANDS.join(", ")}; got ${JSON.stringify(command)}.`);
  const input = isObject(change.input) ? change.input : null;
  if (!input) throw invalid(`${command} needs an input object.`);
  if (change.revision !== undefined && !(Number.isInteger(change.revision) && change.revision > 0)) throw invalid("revision is a positive whole number (from item()).");

  if (command === "work.update") {
    const item = resolveItem(ix, input.id, "input.id");
    if (change.revision !== undefined && change.revision !== item.revision) {
      throw new Error(`conflict: ${item.key} changed since you read it (revision ${change.revision}, now ${item.revision}). Read it again with item("${item.key}") and propose again.`);
    }
    const fields = itemFields(ix, input, item, ctx.today);
    if (!Object.keys(fields).length) throw invalid(`The change to ${item.key} sets no fields.`);
    const built = updateInput(item, fields, { planning: ctx.planning });
    if (built && !built.ok) throw invalid(`${item.key}: ${built.error}`);
    const exact = built ? built.input : { id: item.id };
    const diff = diffOf(ix, exact, item.raw.data);
    const text = built ? `${item.key} ${diff.map((d) => `${d.label.toLowerCase()} ${d.from} → ${d.to}`).join("; ")}` : `${item.key} already has these values`;
    return { command, input: exact, revision: item.revision, item_id: item.id, key: item.key, diff, text, noop: !built };
  }
  if (command === "work.create") {
    const fields = itemFields(ix, input, null, ctx.today);
    if (!fields.state && !fields.status && ctx.planning) fields.state = (ix.states.find((s) => s.kind === "triage") ?? ix.states.find((s) => s.kind === "unstarted") ?? ix.states[0])?.key;
    const built = checkItemFields(fields, { planning: ctx.planning, create: true });
    if (!built.ok) throw invalid(built.error);
    const parent = typeof built.input.parent === "string" ? ix.items.get(built.input.parent) : null;
    const diff = diffOf(ix, built.input, {}).filter((d) => d.field !== "title");
    const title = String(built.input.title);
    return { command, input: built.input, item_id: null, key: null, diff, noop: false,
      text: `${parent ? `New sub-issue under ${parent.key}` : "New item"}: “${clip(title)}”${diff.some((d) => d.field !== "description" && d.field !== "parent") ? ` (${diff.filter((d) => d.field !== "description" && d.field !== "parent").map((d) => `${d.label.toLowerCase()} ${d.to}`).join(", ")})` : ""}` };
  }
  if (command === "work.relation.create" || command === "work.relation.update") {
    const kind = input.kind ?? "blocks";
    if (!["blocks", "relates", "duplicates"].includes(kind)) throw invalid("kind is blocks, relates or duplicates.");
    const from = resolveItem(ix, input.from, "input.from"), to = resolveItem(ix, input.to, "input.to");
    const verb = kind === "blocks" ? "blocks" : kind === "duplicates" ? "duplicates" : "relates to";
    if (command === "work.relation.create") {
      const built = checkEntityInput(command, { from: from.id, to: to.id, kind });
      if (!built.ok) throw invalid(built.error);
      const exists = relationsFor(ix, from.id)[kind === "blocks" ? "blocks" : kind === "duplicates" ? "duplicates" : "relates"].some((r) => r.to === to.id || (kind === "relates" && r.from === to.id));
      return { command, input: built.input, item_id: from.id, key: from.key, diff: [], text: exists ? `${from.key} already ${verb} ${to.key}` : `${from.key} ${verb} ${to.key}`, noop: exists };
    }
    const rel = ix.relations.find((r) => r.active && r.kind === kind && ((r.from === from.id && r.to === to.id) || (kind === "relates" && r.from === to.id && r.to === from.id)));
    if (!rel) throw new Error(`not_found: ${from.key} does not ${verb.replace(/s( to)?$/, "$1")} ${to.key}.`);
    if (input.active !== false) throw invalid("work.relation.update removes a relation: set active to false.");
    return { command, input: { id: rel.id, active: false }, revision: rel.revision, item_id: rel.id, key: from.key, diff: [], text: `Remove: ${from.key} ${verb} ${to.key}`, noop: false };
  }
  if (command === "work.comment.create") {
    const item = resolveItem(ix, input.item, "input.item");
    const built = checkEntityInput(command, { item: item.id, body: input.body });
    if (!built.ok) throw invalid(built.error);
    return { command, input: built.input, item_id: item.id, key: item.key, diff: [], text: `Comment on ${item.key}: “${clip(String(built.input.body).replace(/\s+/g, " "), 80)}”`, noop: false };
  }
  // work.label.create
  const built = checkEntityInput(command, { ...input, key: input.key ?? String(input.name ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") });
  if (!built.ok) throw invalid(built.error);
  const exists = ix.labels.some((l) => l.key === built.input.key || l.name.toLowerCase() === String(built.input.name).toLowerCase());
  return { command, input: built.input, item_id: null, key: null, diff: [], text: exists ? `Label “${built.input.name}” already exists` : `New label “${built.input.name}”`, noop: exists };
}
