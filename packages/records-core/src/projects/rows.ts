// Projects module rows: mapping current-state rows to DTOs, and the shared lookups and validations
// that both reads (ProjectsService) and command handlers use. Everything here runs inside a
// transaction that already carries the trusted context.

import {
  RecordsError,
  type Comment,
  type Issue,
  type Priority,
  type PrincipalRef,
  type Project,
  type Workflow,
  type WorkflowCategory,
} from "@records/contracts";

import type { Tx } from "../db/context.js";

export type Row = Record<string, unknown>;

export const iso = (v: unknown) => (v as Date).toISOString();

function ref(row: Row, prefix: string): PrincipalRef {
  return {
    id: row[`${prefix}_id`] as string,
    displayName: row[`${prefix}_name`] as string,
    kind: row[`${prefix}_kind`] as "human" | "service",
  };
}

export function toProject(r: Row): Project {
  return {
    id: r.id as string,
    key: r.key as string,
    name: r.name as string,
    description: r.description as string,
    revision: r.revision as number,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

export function toIssue(r: Row): Issue {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    number: r.number as number,
    key: `${r.project_key as string}-${r.number as number}`,
    title: r.title as string,
    description: r.description as string,
    state: r.state as string,
    priority: r.priority as Priority,
    assignee: r.assignee_id ? ref(r, "assignee") : null,
    customFields: r.custom_fields as Issue["customFields"],
    revision: r.revision as number,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    createdBy: ref(r, "creator"),
    updatedBy: ref(r, "updater"),
  };
}

export function toComment(r: Row): Comment {
  return { id: r.id as string, issueId: r.issue_id as string, body: r.body as string, author: ref(r, "author"), createdAt: iso(r.created_at) };
}

/**
 * The numeric Jira id of a row (the `jira_id` identity columns, canonical plan §7 "Identifiers").
 * postgres.js returns bigint as a string; identity values stay far below 2^53.
 */
export function jiraIdOf(r: Row): number {
  return Number(r.jira_id);
}

/** An issue DTO with its numeric Jira id beside it (the row must come from `issueSelect`). */
export function toJiraIssue(r: Row): Issue & { jiraId: number } {
  return { ...toIssue(r), jiraId: jiraIdOf(r) };
}

/** A comment DTO with its numeric Jira id (rows selected as `c.*` plus the author join). */
export function toJiraComment(r: Row): Comment & { jiraId: number } {
  return { ...toComment(r), jiraId: jiraIdOf(r) };
}

/** SELECT list for issues with display joins. `WHERE` is appended by callers. */
export function issueSelect(tx: Tx, datastoreId: string) {
  return tx`
    SELECT i.*, p.key AS project_key,
           a.id AS assignee_id, a.display_name AS assignee_name, a.kind AS assignee_kind,
           c.id AS creator_id, c.display_name AS creator_name, c.kind AS creator_kind,
           u.id AS updater_id, u.display_name AS updater_name, u.kind AS updater_kind
      FROM projects.issues i
      JOIN projects.projects p ON p.id = i.project_id AND p.datastore_id = i.datastore_id
      LEFT JOIN records.principals a ON a.id = i.assignee_id
      JOIN records.principals c ON c.id = i.created_by
      JOIN records.principals u ON u.id = i.updated_by
     WHERE i.datastore_id = ${datastoreId}`;
}

/** SELECT list for comments with the author's display attributes. `WHERE` is appended by callers. */
export function commentSelect(tx: Tx, datastoreId: string) {
  return tx`
    SELECT c.*, p.id AS author_id, p.display_name AS author_name, p.kind AS author_kind
      FROM projects.comments c JOIN records.principals p ON p.id = c.author_id
     WHERE c.datastore_id = ${datastoreId}`;
}

/** The datastore's workflow, in the `Workflow` DTO shape (states by position, transitions sorted). */
export async function loadWorkflow(tx: Tx, datastoreId: string): Promise<Workflow> {
  const states = await tx`
    SELECT key, name, category, position FROM projects.workflow_states
     WHERE datastore_id = ${datastoreId} ORDER BY position, key`;
  const transitions = await tx`
    SELECT from_state, to_state FROM projects.workflow_transitions
     WHERE datastore_id = ${datastoreId} ORDER BY from_state, to_state`;
  return {
    states: states.map((s) => ({ key: s.key as string, name: s.name as string, category: s.category as WorkflowCategory, position: s.position as number })),
    transitions: transitions.map((t) => ({ from: t.from_state as string, to: t.to_state as string })),
  };
}

export async function loadIssue(tx: Tx, datastoreId: string, issueId: string): Promise<Issue> {
  const [row] = await tx`${issueSelect(tx, datastoreId)} AND i.id = ${issueId}`;
  if (!row) throw new RecordsError("not_found", "Unknown issue.");
  return toIssue(row);
}

export async function requireAssignable(tx: Tx, datastoreId: string, assigneeId: string | null | undefined): Promise<void> {
  if (!assigneeId) return;
  const [m] = await tx`
    SELECT 1 FROM records.memberships m JOIN records.principals p ON p.id = m.principal_id
     WHERE m.datastore_id = ${datastoreId} AND m.principal_id = ${assigneeId} AND p.status = 'active'`;
  if (!m) throw new RecordsError("validation_failed", "The assignee is not a member of this datastore.");
}

export async function validateCustomFields(tx: Tx, datastoreId: string, fields: Record<string, unknown>): Promise<void> {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const defs = await tx`
    SELECT key, type, options FROM projects.custom_fields WHERE datastore_id = ${datastoreId} AND key = ANY(${keys})`;
  const byKey = new Map(defs.map((d) => [d.key as string, d]));
  for (const [key, value] of Object.entries(fields)) {
    const def = byKey.get(key);
    if (!def) throw new RecordsError("validation_failed", `Unknown custom field ${key}.`);
    if (value === null) continue;
    const ok =
      (def.type === "text" && typeof value === "string") ||
      (def.type === "number" && typeof value === "number") ||
      (def.type === "boolean" && typeof value === "boolean") ||
      (def.type === "enum" && typeof value === "string" && (def.options as string[]).includes(value));
    if (!ok) throw new RecordsError("validation_failed", `Custom field ${key} expects ${def.type as string}.`);
  }
}

/**
 * Seed the default workflow for a new datastore (called inside createDatastore). Workflow rows are
 * configuration, not journaled entities; the creating transaction's provisioning right (migration
 * 0004) is what lets a data administrator write them for another owner.
 */
export async function seedWorkflow(tx: Tx, orgId: string, datastoreId: string, workflow: Workflow): Promise<void> {
  for (const s of workflow.states) {
    await tx`
      INSERT INTO projects.workflow_states (org_id, datastore_id, key, name, category, position)
      VALUES (${orgId}, ${datastoreId}, ${s.key}, ${s.name}, ${s.category}, ${s.position})`;
  }
  for (const t of workflow.transitions) {
    await tx`
      INSERT INTO projects.workflow_transitions (org_id, datastore_id, from_state, to_state)
      VALUES (${orgId}, ${datastoreId}, ${t.from}, ${t.to})`;
  }
}
