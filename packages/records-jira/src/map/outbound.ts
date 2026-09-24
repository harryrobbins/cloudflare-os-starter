// Domain records → Jira JSON. v2 carries rich text as plain text (the stored Markdown, as-is);
// v3 carries ADF converted from the Markdown.

import type { PrincipalRef, Priority } from "@records/contracts";

import { adfToMarkdown, markdownToAdf, type AdfDoc } from "../adf/index.js";
import type { JiraComment, JiraCustomFieldDef, JiraIssue, JiraProject, JiraUser, JiraWorkflowState } from "../port.js";
import { JIRA_PRIORITIES, JIRA_STATUS_CATEGORIES, TASK_ISSUE_TYPE, priorityToJira, statusCategoryToJira } from "../values.js";

export type ApiVersion = 2 | 3;

export type MapContext = {
  version: ApiVersion;
  /** Absolute URL of the Jira root, without a trailing slash: `https://host/…/jira`. */
  baseUrl: string;
  projects: Map<string, JiraProject>;
  states: Map<string, JiraWorkflowState>;
  customFields: JiraCustomFieldDef[];
};

export const api = (ctx: Pick<MapContext, "baseUrl" | "version">, path: string) => `${ctx.baseUrl}/rest/api/${ctx.version}/${path}`;

/** Jira's timestamp format: `2026-09-24T10:15:30.000+0000`. */
export function jiraDate(iso: string): string {
  return new Date(iso).toISOString().replace("Z", "+0000");
}

export function richText(markdown: string, version: ApiVersion): string | AdfDoc | null {
  if (!markdown) return null;
  return version === 2 ? markdown : markdownToAdf(markdown);
}

export { adfToMarkdown };

// ---------------------------------------------------------------------------------------------
// Users

export function userToJira(
  ctx: Pick<MapContext, "baseUrl" | "version">,
  ref: PrincipalRef,
  extra: Partial<Pick<JiraUser, "active" | "emailAddress" | "timeZone">> = {},
): Record<string, unknown> {
  return {
    self: api(ctx, `user?accountId=${encodeURIComponent(ref.id)}`),
    accountId: ref.id,
    accountType: ref.kind === "service" ? "app" : "atlassian",
    displayName: ref.displayName,
    active: extra.active ?? true,
    ...(extra.emailAddress ? { emailAddress: extra.emailAddress } : {}),
    timeZone: extra.timeZone ?? "UTC",
  };
}

export function memberToJira(ctx: Pick<MapContext, "baseUrl" | "version">, user: JiraUser): Record<string, unknown> {
  return userToJira(ctx, user.principal, user);
}

// ---------------------------------------------------------------------------------------------
// Vocabularies

export function statusCategoryJson(ctx: Pick<MapContext, "baseUrl" | "version">, cat: (typeof JIRA_STATUS_CATEGORIES)[number]) {
  return { self: api(ctx, `statuscategory/${cat.id}`), id: cat.id, key: cat.key, colorName: cat.colorName, name: cat.name };
}

export function statusToJira(ctx: Pick<MapContext, "baseUrl" | "version">, state: JiraWorkflowState): Record<string, unknown> {
  return {
    self: api(ctx, `status/${state.jiraId}`),
    description: "",
    name: state.name,
    untranslatedName: state.name,
    id: String(state.jiraId),
    statusCategory: statusCategoryJson(ctx, statusCategoryToJira(state.category)),
  };
}

export function priorityJson(ctx: Pick<MapContext, "baseUrl" | "version">, p: (typeof JIRA_PRIORITIES)[number]) {
  return { self: api(ctx, `priority/${p.id}`), statusColor: p.statusColor, description: p.description, name: p.name, id: p.id };
}

export function priorityFieldToJira(ctx: Pick<MapContext, "baseUrl" | "version">, priority: Priority): Record<string, unknown> | null {
  const p = priorityToJira(priority);
  return p ? { self: api(ctx, `priority/${p.id}`), name: p.name, id: p.id } : null;
}

export function issueTypeToJira(ctx: Pick<MapContext, "baseUrl" | "version">): Record<string, unknown> {
  return {
    self: api(ctx, `issuetype/${TASK_ISSUE_TYPE.id}`),
    id: TASK_ISSUE_TYPE.id,
    description: TASK_ISSUE_TYPE.description,
    name: TASK_ISSUE_TYPE.name,
    untranslatedName: TASK_ISSUE_TYPE.name,
    subtask: false,
    hierarchyLevel: 0,
  };
}

// ---------------------------------------------------------------------------------------------
// Projects

export function projectRefToJira(ctx: Pick<MapContext, "baseUrl" | "version">, p: JiraProject): Record<string, unknown> {
  return {
    self: api(ctx, `project/${p.jiraId}`),
    id: String(p.jiraId),
    key: p.key,
    name: p.name,
    projectTypeKey: "software",
    simplified: false,
  };
}

export function projectToJira(ctx: Pick<MapContext, "baseUrl" | "version">, p: JiraProject, full = true): Record<string, unknown> {
  return {
    expand: "description,lead,issueTypes,url,projectKeys,permissions,insight",
    ...projectRefToJira(ctx, p),
    style: "classic",
    isPrivate: false,
    entityId: p.id,
    uuid: p.id,
    ...(full
      ? {
          description: p.description,
          ...(p.lead ? { lead: userToJira(ctx, p.lead) } : {}),
          issueTypes: [issueTypeToJira(ctx)],
          assigneeType: "UNASSIGNED",
          properties: {},
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Fields

export type FieldDef = {
  id: string;
  name: string;
  custom: boolean;
  navigable: boolean;
  orderable: boolean;
  searchable: boolean;
  clauseNames: string[];
  schema: Record<string, unknown>;
};

export const SYSTEM_FIELDS: FieldDef[] = [
  { id: "summary", name: "Summary", custom: false, navigable: true, orderable: true, searchable: true, clauseNames: ["summary"], schema: { type: "string", system: "summary" } },
  { id: "description", name: "Description", custom: false, navigable: true, orderable: true, searchable: true, clauseNames: ["description"], schema: { type: "string", system: "description" } },
  { id: "status", name: "Status", custom: false, navigable: true, orderable: false, searchable: true, clauseNames: ["status"], schema: { type: "status", system: "status" } },
  { id: "priority", name: "Priority", custom: false, navigable: true, orderable: true, searchable: true, clauseNames: ["priority"], schema: { type: "priority", system: "priority" } },
  { id: "assignee", name: "Assignee", custom: false, navigable: true, orderable: true, searchable: true, clauseNames: ["assignee"], schema: { type: "user", system: "assignee" } },
  { id: "reporter", name: "Reporter", custom: false, navigable: true, orderable: false, searchable: false, clauseNames: [], schema: { type: "user", system: "reporter" } },
  { id: "creator", name: "Creator", custom: false, navigable: true, orderable: false, searchable: false, clauseNames: [], schema: { type: "user", system: "creator" } },
  { id: "project", name: "Project", custom: false, navigable: true, orderable: false, searchable: true, clauseNames: ["project"], schema: { type: "project", system: "project" } },
  { id: "issuetype", name: "Issue Type", custom: false, navigable: true, orderable: true, searchable: true, clauseNames: ["issuetype", "type"], schema: { type: "issuetype", system: "issuetype" } },
  { id: "created", name: "Created", custom: false, navigable: true, orderable: false, searchable: true, clauseNames: ["created", "createdDate"], schema: { type: "datetime", system: "created" } },
  { id: "updated", name: "Updated", custom: false, navigable: true, orderable: false, searchable: true, clauseNames: ["updated", "updatedDate"], schema: { type: "datetime", system: "updated" } },
  { id: "comment", name: "Comment", custom: false, navigable: false, orderable: true, searchable: false, clauseNames: [], schema: { type: "comments-page", system: "comment" } },
];

const CUSTOM_SCHEMA: Record<JiraCustomFieldDef["type"], { type: string; custom: string }> = {
  text: { type: "string", custom: "com.atlassian.jira.plugin.system.customfieldtypes:textfield" },
  number: { type: "number", custom: "com.atlassian.jira.plugin.system.customfieldtypes:float" },
  boolean: { type: "any", custom: "records:boolean" },
  enum: { type: "option", custom: "com.atlassian.jira.plugin.system.customfieldtypes:select" },
};

export function customFieldId(def: JiraCustomFieldDef): string {
  return `customfield_${def.jiraId}`;
}

export function customFieldToDef(def: JiraCustomFieldDef): FieldDef {
  const s = CUSTOM_SCHEMA[def.type];
  return {
    id: customFieldId(def),
    name: def.name,
    custom: true,
    navigable: true,
    orderable: true,
    searchable: false,
    clauseNames: [`cf[${def.jiraId}]`],
    schema: { type: s.type, custom: s.custom, customId: def.jiraId },
  };
}

export function fieldsToJira(customFields: JiraCustomFieldDef[]): Record<string, unknown>[] {
  return [...SYSTEM_FIELDS, ...customFields.map(customFieldToDef)].map((f) => ({ ...f, key: f.id, untranslatedName: f.name }));
}

/**
 * Which fields a request asked for. Jira's `fields` parameter: `*all`, `*navigable`, explicit ids,
 * and `-id` to exclude. Unknown ids are ignored, as Jira ignores them.
 */
export function fieldSelector(param: string[] | undefined, fallback: "*all" | "*navigable" | "none"): (id: string) => boolean {
  const tokens = (param ?? []).flatMap((p) => p.split(",")).map((t) => t.trim()).filter(Boolean);
  const list = tokens.length ? tokens : [fallback];
  let all = false;
  let navigable = false;
  const include = new Set<string>();
  const exclude = new Set<string>();
  for (const t of list) {
    if (t === "*all") all = true;
    else if (t === "*navigable") navigable = true;
    else if (t.startsWith("-")) exclude.add(t.slice(1));
    else include.add(t);
  }
  return (id) => {
    if (exclude.has(id)) return false;
    if (include.has(id) || all) return true;
    if (navigable) return id !== "comment";
    return false;
  };
}

function customValueToJira(def: JiraCustomFieldDef, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (def.type === "enum") return { value: String(value), id: String(def.options.indexOf(String(value)) + 1) };
  return value;
}

// ---------------------------------------------------------------------------------------------
// Issues and comments

export function commentToJira(ctx: Pick<MapContext, "baseUrl" | "version">, issue: { jiraId: number }, c: JiraComment): Record<string, unknown> {
  const author = userToJira(ctx, c.author);
  return {
    self: api(ctx, `issue/${issue.jiraId}/comment/${c.jiraId}`),
    id: String(c.jiraId),
    author,
    body: richText(c.body, ctx.version) ?? (ctx.version === 2 ? "" : { type: "doc", version: 1, content: [] }),
    updateAuthor: author,
    created: jiraDate(c.createdAt),
    updated: jiraDate(c.createdAt),
    jsdPublic: true,
  };
}

export function commentsPageToJira(
  ctx: Pick<MapContext, "baseUrl" | "version">,
  issue: { jiraId: number },
  page: { comments: JiraComment[]; total: number },
  startAt: number,
  maxResults: number,
) {
  return { comments: page.comments.map((c) => commentToJira(ctx, issue, c)), maxResults, total: page.total, startAt };
}

export function issueToJira(
  ctx: MapContext,
  issue: JiraIssue,
  select: (id: string) => boolean,
  extras: { comments?: { comments: JiraComment[]; total: number } } = {},
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  const state = ctx.states.get(issue.state);
  const project = ctx.projects.get(issue.projectId);
  if (select("summary")) fields.summary = issue.title;
  if (select("description")) fields.description = richText(issue.description, ctx.version);
  if (select("status") && state) fields.status = statusToJira(ctx, state);
  // `none` is an absent priority field (canonical plan §7).
  if (select("priority")) {
    const p = priorityFieldToJira(ctx, issue.priority);
    if (p) fields.priority = p;
  }
  if (select("assignee")) fields.assignee = issue.assignee ? userToJira(ctx, issue.assignee) : null;
  if (select("reporter")) fields.reporter = userToJira(ctx, issue.createdBy);
  if (select("creator")) fields.creator = userToJira(ctx, issue.createdBy);
  if (select("project") && project) fields.project = projectRefToJira(ctx, project);
  if (select("issuetype")) fields.issuetype = issueTypeToJira(ctx);
  if (select("created")) fields.created = jiraDate(issue.createdAt);
  if (select("updated")) fields.updated = jiraDate(issue.updatedAt);
  for (const def of ctx.customFields) {
    const id = customFieldId(def);
    if (select(id)) fields[id] = customValueToJira(def, issue.customFields[def.key]);
  }
  if (select("comment") && extras.comments) {
    fields.comment = commentsPageToJira(ctx, issue, extras.comments, 0, Math.max(extras.comments.comments.length, 1));
  }
  return {
    expand: "renderedFields,names,schema,operations,editmeta,changelog,versionedRepresentations",
    id: String(issue.jiraId),
    self: api(ctx, `issue/${issue.jiraId}`),
    key: issue.key,
    fields,
  };
}

/** A transition's id is its target state's jira id; the list is the workflow's edges from `current`. */
export function transitionsToJira(ctx: MapContext, current: string, workflow: { states: JiraWorkflowState[]; transitions: { from: string; to: string }[] }) {
  const targets = workflow.transitions
    .filter((t) => t.from === current)
    .map((t) => workflow.states.find((s) => s.key === t.to))
    .filter((s): s is JiraWorkflowState => !!s)
    .sort((a, b) => a.position - b.position);
  return {
    expand: "transitions",
    transitions: targets.map((s) => ({
      id: String(s.jiraId),
      name: s.name,
      to: statusToJira(ctx, s),
      hasScreen: false,
      isGlobal: true,
      isInitial: false,
      isAvailable: true,
      isConditional: false,
      looped: false,
    })),
  };
}
