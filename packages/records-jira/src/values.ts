// Fixed vocabularies shared by the JQL parser, the mappers and the router.

import type { Priority, WorkflowCategory } from "@records/contracts";

// ---------------------------------------------------------------------------------------------
// Priorities
//
// urgent → Highest, high → High, medium → Medium, low → Low; `none` is an absent priority field.
// Jira's default scheme also has Lowest (id 5). Decision: Lowest is accepted as an alias of `low`
// on input (writes and JQL), so clients with a hard-coded Lowest do not fail, but it is never
// emitted: /priority lists four priorities and reads show Low.

export type JiraPriority = { id: string; name: string; value: Exclude<Priority, "none">; statusColor: string; description: string };

export const JIRA_PRIORITIES: readonly JiraPriority[] = [
  { id: "1", name: "Highest", value: "urgent", statusColor: "#d04437", description: "This problem will block progress." },
  { id: "2", name: "High", value: "high", statusColor: "#f15C75", description: "Serious problem that could block progress." },
  { id: "3", name: "Medium", value: "medium", statusColor: "#f79232", description: "Has the potential to affect progress." },
  { id: "4", name: "Low", value: "low", statusColor: "#707070", description: "Minor problem or easily worked around." },
];

/** Accepted on input only. */
const PRIORITY_ALIASES: Record<string, Exclude<Priority, "none">> = { lowest: "low", "5": "low" };

/** Resolve a Jira priority name or id (case-insensitive) to a domain priority, or null. */
export function priorityFromJira(nameOrId: string): Exclude<Priority, "none"> | null {
  const s = nameOrId.trim().toLowerCase();
  const found = JIRA_PRIORITIES.find((p) => p.id === s || p.name.toLowerCase() === s);
  return found?.value ?? PRIORITY_ALIASES[s] ?? null;
}

export function priorityToJira(priority: Priority): JiraPriority | null {
  return JIRA_PRIORITIES.find((p) => p.value === priority) ?? null;
}

// ---------------------------------------------------------------------------------------------
// Status categories (todo → new, in_progress → indeterminate, done → done)

export type JiraStatusCategory = { id: number; key: string; colorName: string; name: string; category: WorkflowCategory };

export const JIRA_STATUS_CATEGORIES: readonly JiraStatusCategory[] = [
  { id: 2, key: "new", colorName: "blue-gray", name: "To Do", category: "todo" },
  { id: 4, key: "indeterminate", colorName: "yellow", name: "In Progress", category: "in_progress" },
  { id: 3, key: "done", colorName: "green", name: "Done", category: "done" },
];

export function statusCategoryToJira(category: WorkflowCategory): JiraStatusCategory {
  return JIRA_STATUS_CATEGORIES.find((c) => c.category === category)!;
}

/** By name ("To Do"), key ("new") or id ("2"), case-insensitive; also the domain value ("todo"). */
export function statusCategoryFromJira(value: string): WorkflowCategory | null {
  const s = value.trim().toLowerCase();
  const found = JIRA_STATUS_CATEGORIES.find(
    (c) => c.name.toLowerCase() === s || c.key === s || String(c.id) === s || c.category === s,
  );
  return found?.category ?? null;
}

// ---------------------------------------------------------------------------------------------
// The one issue type

export const TASK_ISSUE_TYPE = {
  id: "10001",
  name: "Task",
  description: "A task that needs to be done.",
} as const;

export function isTaskIssueType(ref: { id?: unknown; name?: unknown } | null | undefined): boolean {
  if (!ref || typeof ref !== "object") return false;
  if (ref.id !== undefined) return String(ref.id) === TASK_ISSUE_TYPE.id;
  if (typeof ref.name === "string") return ref.name.trim().toLowerCase() === "task";
  return false;
}
