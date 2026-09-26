// @ts-check
// Building and validating Records `work.*` command inputs before anything is sent, so the person
// gets a precise message instead of a refusal after approval. Mirrors the service's rules
// (brief-service.md); the service stays the authority.

import { LIMITS, KINDS, PROJECT_STATES, RELATION_KINDS, isIsoDate, validTitle } from "../../shared/model/work.js";
import { sameValue } from "../../shared/replica.js";
import { validRank } from "../../shared/rank.js";

export const V1_FIELDS = Object.freeze(["title", "description", "status", "extensions"]);
export const PLANNING_FIELDS = Object.freeze([...V1_FIELDS, "state", "priority", "assignee", "labels", "estimate", "start_date", "due_date", "parent", "project", "cycle", "rank", "archived"]);
const ACTOR = /^[a-z][a-z0-9-]{0,39}:.+$/;
const UUIDISH = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @typedef {{ ok: true, input: Record<string, unknown> } | { ok: false, error: string, field?: string }} Built */

/** @param {string} error @param {string} [field] @returns {Built} */
const fail = (error, field) => ({ ok: false, error, field });

/**
 * Validates work_item fields (as in a work.create or work.update input).
 * @param {Record<string, unknown>} fields @param {{ planning: boolean, create?: boolean, current?: Record<string, unknown> }} caps
 *   `current`: the item's committed data (for cross-field rules such as due ≥ start)
 * @returns {Built}
 */
export function checkItemFields(fields, caps) {
  /** @type {Record<string, unknown>} */
  const input = {};
  const allowed = caps.planning ? PLANNING_FIELDS : V1_FIELDS;
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || key === "id") continue;
    if (!allowed.includes(key)) {
      if (!caps.planning && PLANNING_FIELDS.includes(key)) return fail("This datastore does not have planning fields yet (Records migration 010). Only title, description and status can change.", key);
      return fail(`Unknown field “${key}”.`, key);
    }
    if (value === null) {
      if (key === "title" || caps.create) continue;
      if (key === "status" || key === "state") return fail("An item always has a state.", key);
      input[key] = null;
      continue;
    }
    switch (key) {
      case "title": {
        const t = validTitle(value);
        if (!t.ok) return fail(t.error, key);
        input.title = t.title;
        break;
      }
      case "description":
        if (typeof value !== "string") return fail("A description is text.", key);
        if (value.length > LIMITS.description) return fail(`Descriptions can be at most ${LIMITS.description.toLocaleString("en")} characters.`, key);
        input.description = value;
        break;
      case "status":
        if (!["open", "active", "done"].includes(/** @type {string} */ (value))) return fail("Status is open, active or done.", key);
        input.status = value;
        break;
      case "state":
        if (typeof value !== "string" || !value) return fail("Choose a workflow state.", key);
        input.state = value;
        break;
      case "priority":
        if (!Number.isInteger(value) || /** @type {number} */ (value) < 0 || /** @type {number} */ (value) > 4) return fail("Priority is 0 (none) to 4 (low).", key);
        input.priority = value;
        break;
      case "assignee":
        if (typeof value !== "string" || !ACTOR.test(value)) return fail("Choose a person to assign.", key);
        input.assignee = value;
        break;
      case "labels": {
        if (!Array.isArray(value)) return fail("Labels are a list.", key);
        const labels = value.map((l) => (typeof l === "string" ? l.trim() : ""));
        // eslint-disable-next-line no-control-regex
        if (labels.some((l) => !l || l.length > LIMITS.label || /[\u0000-\u001f\u007f]/.test(l))) return fail(`Each label is 1–${LIMITS.label} characters.`, key);
        if (new Set(labels).size !== labels.length) return fail("A label can be used once per item.", key);
        if (labels.length > LIMITS.labels) return fail(`An item can have at most ${LIMITS.labels} labels.`, key);
        input.labels = labels;
        break;
      }
      case "estimate":
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > LIMITS.estimate) return fail(`An estimate is a number from 0 to ${LIMITS.estimate}.`, key);
        input.estimate = value;
        break;
      case "start_date": case "due_date":
        if (!isIsoDate(value)) return fail("Dates look like 2026-09-30.", key);
        input[key] = value;
        break;
      case "parent": case "project": case "cycle":
        if (typeof value !== "string" || !UUIDISH.test(value)) return fail(`Choose a ${key}.`, key);
        input[key] = value;
        break;
      case "rank":
        if (typeof value !== "string" || !validRank(value)) return fail("That position is not valid.", key);
        input.rank = value;
        break;
      case "archived":
        if (typeof value !== "boolean") return fail("Archived is yes or no.", key);
        input.archived = value;
        break;
      case "extensions":
        if (typeof value !== "object" || Array.isArray(value)) return fail("Extensions are an object.", key);
        input.extensions = value;
        break;
    }
  }
  if (caps.create && !("title" in input)) return fail("Enter a title.", "title");
  if (caps.create && typeof fields.id === "string" && UUIDISH.test(fields.id)) input.id = fields.id;
  // A field in the input (even null, which clears it) wins over the committed value.
  const start = "start_date" in input ? input.start_date : caps.current?.start_date;
  const due = "due_date" in input ? input.due_date : caps.current?.due_date;
  if (typeof start === "string" && typeof due === "string" && due < start && (input.start_date || input.due_date)) return fail("The due date is before the start date.", input.due_date ? "due_date" : "start_date");
  return { ok: true, input };
}

/** Values the service stores as absent: null, undefined and empty label lists. @param {unknown} v */
const empty = (v) => v === null || v === undefined || (Array.isArray(v) && v.length === 0);

/**
 * A work.update input with only the fields that differ from the item's committed data (null
 * clears). Returns null when nothing would change.
 * @param {{ id: string, raw: { data: Record<string, unknown> } }} item
 * @param {Record<string, unknown>} patch @param {{ planning: boolean }} caps
 * @returns {Built|null}
 */
export function updateInput(item, patch, caps) {
  /** @type {Record<string, unknown>} */
  const changed = {};
  for (const [key, value] of Object.entries(patch)) {
    const current = item.raw.data[key];
    if (empty(current) && empty(value)) continue;
    if (!sameValue(current ?? null, value ?? null)) changed[key] = key === "labels" && empty(value) ? null : value;
  }
  if (!Object.keys(changed).length) return null;
  const built = checkItemFields(changed, { ...caps, current: item.raw.data });
  if (!built.ok) return built;
  return { ok: true, input: { id: item.id, ...built.input } };
}

/**
 * The patch that undoes `input` on `item` (its values before the change).
 * @param {{ raw: { data: Record<string, unknown> } }} item @param {Record<string, unknown>} input
 */
export function inversePatch(item, input) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of Object.keys(input)) {
    if (key === "id") continue;
    out[key] = item.raw.data[key] ?? null;
  }
  // Moving back to a state restores its status too.
  if ("status" in out && out.status === null) delete out.status;
  if ("state" in out && out.state === null) delete out.state;
  return out;
}

/** @param {unknown} value @param {number} max @param {string} what */
function name(value, max, what) {
  const t = typeof value === "string" ? value.trim() : "";
  if (!t) return { error: `Enter a ${what}.` };
  if (t.length > max) return { error: `A ${what} can be at most ${max} characters.` };
  return { value: t };
}

const COLOR = /^#[0-9a-f]{6}$/i;

/**
 * Validates planning-entity inputs (settings dialog, relations, comments).
 * @param {string} command @param {Record<string, any>} input @returns {Built}
 */
export function checkEntityInput(command, input) {
  const out = { ...input };
  switch (command) {
    case "work.state.create": case "work.state.update": {
      if (command.endsWith("create") || "name" in input) { const n = name(input.name, LIMITS.stateName, "state name"); if (n.error) return fail(n.error, "name"); out.name = n.value; }
      if (command.endsWith("create")) {
        if (!/^[a-z][a-z0-9_]{0,39}$/.test(String(input.key ?? ""))) return fail("A state key is lowercase letters, digits and _ (e.g. in_qa).", "key");
      }
      if ("kind" in input && !KINDS.includes(input.kind)) return fail("Choose a kind.", "kind");
      if (command.endsWith("create") && !("kind" in input)) return fail("Choose a kind.", "kind");
      if ("color" in input && input.color !== null && !COLOR.test(input.color)) return fail("Colours look like #3366ff.", "color");
      if ("wip_limit" in input && input.wip_limit !== null && !(Number.isInteger(input.wip_limit) && input.wip_limit >= 1 && input.wip_limit <= LIMITS.wip)) return fail(`A WIP limit is a whole number from 1 to ${LIMITS.wip}, or empty.`, "wip_limit");
      if ("position" in input && !(Number.isInteger(input.position) && input.position >= 0 && input.position <= LIMITS.position)) return fail("Position is a whole number from 0 to 100,000.", "position");
      return { ok: true, input: out };
    }
    case "work.label.create": case "work.label.update": {
      if (command.endsWith("create") || "name" in input) { const n = name(input.name, LIMITS.label, "label name"); if (n.error) return fail(n.error, "name"); out.name = n.value; }
      if (command.endsWith("create")) out.key = String(input.key ?? out.name).trim().slice(0, LIMITS.label);
      if ("color" in input && input.color !== null && !COLOR.test(input.color)) return fail("Colours look like #3366ff.", "color");
      return { ok: true, input: out };
    }
    case "work.project.create": case "work.project.update": {
      if (command.endsWith("create") || "name" in input) { const n = name(input.name, LIMITS.name, "project name"); if (n.error) return fail(n.error, "name"); out.name = n.value; }
      if ("state" in input && !PROJECT_STATES.includes(input.state)) return fail("Choose a project state.", "state");
      for (const d of ["start_date", "target_date"]) if (input[d] !== undefined && input[d] !== null && !isIsoDate(input[d])) return fail("Dates look like 2026-09-30.", d);
      if (input.start_date && input.target_date && input.target_date < input.start_date) return fail("The target date is before the start date.", "target_date");
      return { ok: true, input: out };
    }
    case "work.cycle.create": case "work.cycle.update": {
      if ("name" in input && input.name !== null) { const n = name(input.name, LIMITS.name, "cycle name"); if (n.error) return fail(n.error, "name"); out.name = n.value; }
      for (const d of ["starts_on", "ends_on"]) {
        if (command.endsWith("create") && !isIsoDate(input[d])) return fail("A cycle needs a start and end date.", d);
        if (input[d] !== undefined && !isIsoDate(input[d])) return fail("Dates look like 2026-09-30.", d);
      }
      if (input.starts_on && input.ends_on && input.ends_on < input.starts_on) return fail("A cycle cannot end before it starts.", "ends_on");
      if (typeof input.goal === "string" && input.goal.length > LIMITS.goal) return fail(`A goal can be at most ${LIMITS.goal.toLocaleString("en")} characters.`, "goal");
      return { ok: true, input: out };
    }
    case "work.relation.create":
      if (!RELATION_KINDS.includes(input.kind)) return fail("Choose a relation.", "kind");
      if (!input.from || !input.to) return fail("Choose an item.", "to");
      if (input.from === input.to) return fail("An item cannot relate to itself.", "to");
      return { ok: true, input: out };
    case "work.relation.update":
      return { ok: true, input: out };
    case "work.comment.create": case "work.comment.update": {
      const body = typeof input.body === "string" ? input.body.trim() : "";
      if (!body) return fail("Write a comment first.", "body");
      if (body.length > LIMITS.comment) return fail(`Comments can be at most ${LIMITS.comment.toLocaleString("en")} characters.`, "body");
      out.body = body;
      return { ok: true, input: out };
    }
    default:
      return fail(`Unknown command ${command}.`);
  }
}

/** What a 409 means for each command (the service sends no detail to the gadget). */
const CONFLICT_REASONS = {
  "work.update": "It would make an item its own ancestor (a loop of parents).",
  "work.cycle.create": "Cycles cannot overlap; another cycle covers some of those dates.",
  "work.cycle.update": "Cycles cannot overlap; another cycle covers some of those dates.",
  "work.relation.create": "Those items are already related that way.",
  "work.state.create": "A state with that key already exists.",
  "work.state.update": "Items use this state, so its kind cannot move to another category (open, active, done).",
  "work.label.create": "A label with that key already exists.",
  "work.create": "Something with that id already exists.",
};

/**
 * A readable explanation of a refused or failed change. Records sends only a status code to the
 * gadget, so the command gives the context.
 * @param {string} code error code or "" @param {string} detail @param {string} [command]
 */
export function friendlyReason(code, detail, command = "") {
  const status = /\((\d{3})\)/.exec(detail)?.[1];
  const extra = /\(\d{3}\)\s*:\s*(.+)$/.exec(detail)?.[1];
  if (code === "stale_revision" || status === "412" || status === "428" || code === "revision_required") return "Someone changed this first. The board shows their version; make your change again if it is still needed.";
  if (/Approval was denied/i.test(detail)) return "The change was declined in the Workshop.";
  if (/revoked or changed/i.test(detail)) return "Your access changed before the change could be applied.";
  if (status === "409" || code === "conflict") return /** @type {Record<string, string>} */ (CONFLICT_REASONS)[command] ?? "It conflicts with existing data.";
  if (status === "400" || code === "invalid_request") return `The Records service refused this change as invalid${extra ? `: ${extra}` : ""}. Check the values and try again.`;
  if (status === "403" || code === "forbidden") return extra || (code === "forbidden" && detail ? detail : "You are not allowed to make this change.");
  if (status === "404" || code === "not_found") return "The item no longer exists or is not visible to you.";
  if (code === "read_only") return "This board is connected read-only.";
  if (code === "unavailable") return "The Records service could not be reached. Try again in a moment.";
  return detail || "The change could not be saved.";
}
