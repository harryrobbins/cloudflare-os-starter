// @ts-check
// WQL field registry and small shared helpers (edit distance suggestions, value quoting).

/**
 * @typedef {"enum"|"state"|"kind"|"number"|"date"|"instant"|"person"|"labels"|"text"|"ref-item"|"project"|"cycle"|"bool"|"key"|"ext"} FieldType
 * @typedef {{ name: string, aliases: string[], type: FieldType, doc: string, sortable: boolean }} Field
 */

/** @param {string} name @param {FieldType} type @param {string} doc @param {string[]} [aliases] @param {boolean} [sortable] @returns {Field} */
const f = (name, type, doc, aliases = [], sortable = false) => ({ name, aliases, type, doc, sortable });

/** @type {Field[]} */
export const FIELDS = [
  f("status", "enum", "Status category: open, active or done", ["category"]),
  f("state", "state", "Workflow state, by name or key", [], true),
  f("kind", "kind", "Workflow state kind: triage, backlog, unstarted, started, completed, canceled"),
  f("priority", "enum", "urgent, high, medium, low or none (0–4); < means more urgent", [], true),
  f("assignee", "person", "Assigned person: me, none, or a name", [], true),
  f("created_by", "person", "Who created the item", ["creator"]),
  f("updated_by", "person", "Who last changed the item"),
  f("label", "labels", "Has the label (any of a,b)", ["labels"]),
  f("estimate", "number", "Estimate in points", [], true),
  f("start", "date", "Start date", ["start_date"], true),
  f("due", "date", "Due date; due:<7d means due within 7 days (overdue included)", ["due_date"], true),
  f("created", "instant", "When the item was created", ["created_at"], true),
  f("updated", "instant", "When the item last changed", ["updated_at"], true),
  f("parent", "ref-item", "Parent item key, or none"),
  f("project", "project", "Project name, or none", [], true),
  f("cycle", "cycle", "Cycle name or number, current, next, previous, or none", [], true),
  f("key", "key", "Item key (WRK-42) or number; ranges 1..10", ["number"], true),
  f("text", "text", "Title or description contains"),
  f("title", "text", "Title contains", [], true),
  f("description", "text", "Description contains"),
  f("archived", "bool", "true or false"),
  f("rank", "text", "Manual order (sort only)", [], true),
];

const BY_NAME = new Map();
for (const field of FIELDS) for (const n of [field.name, ...field.aliases]) BY_NAME.set(n, field);

/** Resolves a field name or alias (case-insensitive), including `ext.<name>`. @param {string} name @returns {Field|null} */
export function fieldByName(name) {
  const lower = String(name ?? "").toLowerCase();
  const known = BY_NAME.get(lower);
  if (known) return known;
  const ext = /^ext\.([A-Za-z0-9_-]+)$/.exec(String(name ?? ""));
  return ext ? { name: `ext.${ext[1]}`, aliases: [], type: "ext", doc: `Extension field ${ext[1]}`, sortable: true } : null;
}

/** Types that support <, <=, >, >= and ranges. */
export const COMPARABLE = new Set(["enum", "kind", "state", "number", "date", "instant", "key", "ext"]);

export const PREDICATES = ["blocked", "blocking", "overdue", "archived", "parent", "sub", "unassigned", "unestimated", "stale", "open", "active", "done"];
export const KEYWORDS = ["AND", "OR", "NOT"];

/** @param {string} a @param {string} b */
export function distance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

/** Up to three close candidates ("did you mean"). @param {string} word @param {Iterable<string>} candidates */
export function closest(word, candidates) {
  const w = word.toLowerCase();
  const limit = Math.max(1, Math.floor(w.length / 3)) + 1;
  /** @type {[number, string][]} */
  const scored = [];
  const seen = new Set();
  for (const c of candidates) {
    if (seen.has(c)) continue;
    seen.add(c);
    const lc = c.toLowerCase();
    const d = lc.startsWith(w) || w.startsWith(lc) ? 0.5 : distance(w, lc);
    if (d <= limit) scored.push([d, c]);
  }
  return scored.toSorted((a, b) => a[0] - b[0] || a[1].localeCompare(b[1])).slice(0, 3).map((s) => s[1]);
}

/** @param {string} prefix @param {string[]} suggestions */
export function didYouMean(prefix, suggestions) {
  return suggestions.length ? `${prefix} Did you mean “${suggestions[0]}”?` : prefix;
}

/** Quotes a term value when it would not survive as a bare value. @param {string} value */
export function quoteValue(value) {
  return value === "" || /[\s(),"\\]|\.\./.test(value) || /^[<>=]/.test(value) ? quote(value) : value;
}

/** Quotes free text when it would not read back as one bare word. @param {string} value */
export function quoteText(value) {
  return value === "" || /[\s()"\\:]/.test(value) || value.startsWith("-") || KEYWORDS.includes(value.toUpperCase()) ? quote(value) : value;
}

/** @param {string} value */
function quote(value) { return `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`; }
