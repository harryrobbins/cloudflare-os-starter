// Jira request payloads → domain inputs. Every problem is collected into Jira's
// `{ errorMessages: [], errors: { field: message } }` 400 body, worded as Jira words it.

import type { CreateIssueInput, EditIssueInput, Priority } from "@records/contracts";

import { AdfError, adfToMarkdown, validateAdf } from "../adf/index.js";
import { JIRA_MESSAGES, JiraError } from "../errors.js";
import type { JiraCustomFieldDef, JiraProject, JiraUser, JiraWorkflowState } from "../port.js";
import { isTaskIssueType, priorityFromJira } from "../values.js";
import type { ApiVersion } from "./outbound.js";

export type InboundContext = {
  version: ApiVersion;
  projects: JiraProject[];
  members: JiraUser[];
  customFields: JiraCustomFieldDef[];
  states: JiraWorkflowState[];
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Fields a client may send empty (e.g. `labels: []`) without losing anything. */
const EMPTY_TOLERATED = new Set(["labels", "components", "fixVersions", "versions"]);

/** Rich text in: v2 plain text (stored as-is), v3 ADF (converted to Markdown). */
export function richTextIn(value: unknown, version: ApiVersion): { ok: true; markdown: string } | { ok: false; message: string } {
  if (value === null || value === undefined) return { ok: true, markdown: "" };
  if (version === 2) {
    if (typeof value !== "string") return { ok: false, message: "Operation value must be a string" };
    return { ok: true, markdown: value };
  }
  if (typeof value === "string") return { ok: false, message: "Operation value must be an Atlassian Document (see the Atlassian Document Format)" };
  try {
    return { ok: true, markdown: adfToMarkdown(validateAdf(value)) };
  } catch (err) {
    if (err instanceof AdfError) return { ok: false, message: err.message };
    throw err;
  }
}

/** Fold `update: { field: [{ set: v }] }` into plain field values; other operations are refused. */
function collectFields(body: Obj, errors: Record<string, string>): Obj {
  const fields: Obj = isObj(body.fields) ? { ...body.fields } : {};
  if (body.fields !== undefined && !isObj(body.fields)) errors.fields = "fields must be an object";
  if (body.update !== undefined) {
    if (!isObj(body.update)) errors.update = "update must be an object";
    else {
      for (const [field, ops] of Object.entries(body.update)) {
        if (!Array.isArray(ops) || ops.length === 0) continue;
        if (ops.length !== 1 || !isObj(ops[0]) || !("set" in ops[0]) || Object.keys(ops[0]).length !== 1) {
          const op = isObj(ops[0]) ? Object.keys(ops[0])[0] ?? "?" : "?";
          errors[field] = `The operation '${op}' is not supported for the field '${field}'; use 'set' or fields.`;
          continue;
        }
        if (field in fields) errors[field] = `Field '${field}' is given in both fields and update.`;
        else fields[field] = ops[0].set;
      }
    }
  }
  for (const k of ["properties", "historyMetadata"]) {
    const v = body[k];
    if (v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0) && !(isObj(v) && Object.keys(v).length === 0)) {
      if (k === "properties") errors.properties = "Issue properties are not supported by this Jira-compatible API.";
    }
  }
  return fields;
}

function resolvePriority(value: unknown, errors: Record<string, string>): Priority | undefined {
  if (value === null) return "none";
  const ref = isObj(value) ? (value.id ?? value.name) : value;
  if (typeof ref !== "string" && typeof ref !== "number") {
    errors.priority = "Specify the Priority (id or name) in the string format";
    return undefined;
  }
  const p = priorityFromJira(String(ref));
  if (!p) {
    errors.priority = isObj(value) && value.id !== undefined ? `Priority with id '${ref}' does not exist` : `Priority name '${ref}' is not valid`;
    return undefined;
  }
  return p;
}

function resolveAssignee(value: unknown, ctx: InboundContext, errors: Record<string, string>): string | null | undefined {
  if (value === null) return null;
  const ref = isObj(value) ? ("accountId" in value ? value.accountId : value.id) : undefined;
  if (ref === null || ref === "-1") return null;
  if (typeof ref !== "string" || !ref) {
    errors.assignee = "Specify the assignee as an object with an accountId";
    return undefined;
  }
  if (!ctx.members.some((m) => m.principal.id === ref && m.active)) {
    errors.assignee = `User '${ref}' cannot be assigned issues.`;
    return undefined;
  }
  return ref;
}

function resolveProject(value: unknown, ctx: InboundContext, errors: Record<string, string>): string | undefined {
  const ref = isObj(value) ? (value.id !== undefined ? String(value.id) : value.key) : value;
  if (typeof ref !== "string" && typeof ref !== "number") {
    errors.project = "Specify a valid project ID or key";
    return undefined;
  }
  const s = String(ref);
  const p = ctx.projects.find((x) => String(x.jiraId) === s || x.key === s.toUpperCase() || x.id === s);
  if (!p) {
    errors.project = "Specify a valid project ID or key";
    return undefined;
  }
  return p.id;
}

function customValue(def: JiraCustomFieldDef, value: unknown, id: string, errors: Record<string, string>): string | number | boolean | null | undefined {
  if (value === null) return null;
  switch (def.type) {
    case "text":
      if (typeof value === "string") return value;
      errors[id] = "Operation value must be a string";
      return undefined;
    case "number":
      if (typeof value === "number" && Number.isFinite(value)) return value;
      errors[id] = "Operation value must be a number";
      return undefined;
    case "boolean":
      if (typeof value === "boolean") return value;
      errors[id] = "Operation value must be a boolean";
      return undefined;
    case "enum": {
      const v = isObj(value) ? (value.value ?? (value.id !== undefined ? def.options[Number(value.id) - 1] : undefined)) : value;
      if (typeof v === "string" && def.options.includes(v)) return v;
      errors[id] = `Option value '${String(isObj(value) ? value.value ?? value.id : value)}' is not valid`;
      return undefined;
    }
  }
}

type Common = {
  title?: string;
  description?: string;
  priority?: Priority;
  assigneeId?: string | null;
  customFields?: Record<string, string | number | boolean | null>;
  projectId?: string;
};

function mapFields(fields: Obj, ctx: InboundContext, errors: Record<string, string>, mode: "create" | "edit"): Common {
  const out: Common = {};
  for (const [id, value] of Object.entries(fields)) {
    switch (id) {
      case "summary":
        if (typeof value !== "string" || !value.trim()) errors.summary = "You must specify a summary of the issue.";
        else out.title = value;
        break;
      case "description": {
        const r = richTextIn(value, ctx.version);
        if (r.ok) out.description = r.markdown;
        else errors.description = r.message;
        break;
      }
      case "priority": {
        const p = resolvePriority(value, errors);
        if (p) out.priority = p;
        break;
      }
      case "assignee": {
        const a = resolveAssignee(value, ctx, errors);
        if (a !== undefined) out.assigneeId = a;
        break;
      }
      case "project":
        if (mode === "edit") errors.project = JIRA_MESSAGES.fieldCannotBeSet("project");
        else {
          const p = resolveProject(value, ctx, errors);
          if (p) out.projectId = p;
        }
        break;
      case "issuetype":
        if (!isTaskIssueType(isObj(value) ? value : null)) errors.issuetype = "The issue type selected is invalid.";
        break;
      default: {
        const custom = /^customfield_(\d+)$/.exec(id);
        const def = custom ? ctx.customFields.find((d) => d.jiraId === Number(custom[1])) : undefined;
        if (def) {
          const v = customValue(def, value, id, errors);
          if (v !== undefined) (out.customFields ??= {})[def.key] = v;
        } else if (EMPTY_TOLERATED.has(id) && Array.isArray(value) && value.length === 0) {
          // Nothing to set.
        } else errors[id] = JIRA_MESSAGES.fieldCannotBeSet(id);
      }
    }
  }
  return out;
}

/** `POST /issue` body → CreateIssueInput. */
export function parseCreateIssue(body: unknown, ctx: InboundContext): CreateIssueInput {
  if (!isObj(body)) throw JiraError.badRequest("The request body must be a JSON object.");
  const errors: Record<string, string> = {};
  const fields = collectFields(body, errors);
  const common = mapFields(fields, ctx, errors, "create");
  if (!("summary" in fields)) errors.summary ??= "You must specify a summary of the issue.";
  if (!("project" in fields)) errors.project ??= "Specify a valid project ID or key";
  let state: string | undefined;
  if (body.transition !== undefined) {
    const id = isObj(body.transition) ? String(body.transition.id ?? "") : "";
    const target = ctx.states.find((s) => String(s.jiraId) === id);
    if (!target) errors.transition = JIRA_MESSAGES.transitionInvalid(id);
    else state = target.key;
  }
  if (Object.keys(errors).length) throw JiraError.fields(errors);
  const { projectId, ...rest } = common;
  return { projectId: projectId!, title: rest.title!, ...rest, ...(state ? { state } : {}) };
}

/** `PUT /issue/{key}` body → an edit patch. An empty patch means "nothing to change". */
export function parseEditIssue(body: unknown, ctx: InboundContext): EditIssueInput["patch"] {
  if (!isObj(body)) throw JiraError.badRequest("The request body must be a JSON object.");
  const errors: Record<string, string> = {};
  const fields = collectFields(body, errors);
  const { projectId: _ignored, ...patch } = mapFields(fields, ctx, errors, "edit");
  if (body.transition !== undefined) errors.transition = "Use POST /issue/{issueIdOrKey}/transitions to change the status.";
  if (Object.keys(errors).length) throw JiraError.fields(errors);
  return patch;
}

/** `POST /issue/{key}/transitions` body → target state key, checked against the current state. */
export function parseTransition(body: unknown, ctx: InboundContext, workflowEdges: { from: string; to: string }[], current: string): string {
  if (!isObj(body) || !isObj(body.transition)) throw JiraError.fields({ transition: "Missing 'transition' identifier" });
  const id = body.transition.id;
  if (id === undefined || id === null) throw JiraError.fields({ transition: "Missing 'transition' identifier" });
  const errors: Record<string, string> = {};
  const fields = collectFields(body, errors);
  for (const f of Object.keys(fields)) errors[f] = JIRA_MESSAGES.fieldCannotBeSet(f);
  if (Object.keys(errors).length) throw JiraError.fields(errors);
  const target = ctx.states.find((s) => String(s.jiraId) === String(id));
  if (!target || !workflowEdges.some((e) => e.from === current && e.to === target.key)) {
    throw JiraError.badRequest(JIRA_MESSAGES.transitionInvalid(String(id)));
  }
  return target.key;
}

/** `POST /issue/{key}/comment` body → Markdown. */
export function parseCommentBody(body: unknown, version: ApiVersion): string {
  if (!isObj(body)) throw JiraError.badRequest("The request body must be a JSON object.");
  if (body.visibility !== undefined && body.visibility !== null) {
    throw JiraError.fields({ visibility: "Comment visibility restrictions are not supported by this Jira-compatible API." });
  }
  const r = richTextIn(body.body, version);
  if (!r.ok) throw JiraError.fields({ comment: r.message });
  if (!r.markdown.trim()) throw JiraError.fields({ comment: "Comment body can not be empty!" });
  return r.markdown;
}
