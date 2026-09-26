// @ts-check
// Facts about the Records `work` module (API v1 plus the additive planning model of migration
// 010) shared by the client, the gadget server and WQL. Pure: no DOM, no platform.
//
// A datastore without migration 010 ("v1-only") has only title, description, status and
// extensions on work_item and no other entities. Everything here tolerates absent fields.

export const CATEGORIES = /** @type {const} */ (["open", "active", "done"]);
export const CATEGORY_LABELS = { open: "Open", active: "Active", done: "Done" };

/** Linear's fixed workflow categories; reports rely on them. */
export const KINDS = /** @type {const} */ (["triage", "backlog", "unstarted", "started", "completed", "canceled"]);
export const KIND_LABELS = { triage: "Triage", backlog: "Backlog", unstarted: "Unstarted", started: "Started", completed: "Completed", canceled: "Canceled" };
/** @type {Record<string, "open"|"active"|"done">} */
export const CATEGORY_OF_KIND = { triage: "open", backlog: "open", unstarted: "open", started: "active", completed: "done", canceled: "done" };
/** Default colour per kind (used when a state has no valid colour of its own). */
export const KIND_COLORS = { triage: "#b45bcf", backlog: "#8a8f98", unstarted: "#6b7280", started: "#d99100", completed: "#2f9e5b", canceled: "#9aa0a6" };

/**
 * Workflow states Records seeds in a datastore's first planning command (migration 010), in the
 * same commit as that command. Shown as virtual states until real `workflow_state` records arrive.
 */
export const DEFAULT_STATES = Object.freeze([
  { key: "triage", name: "Triage", kind: "triage", position: 0, color: "#fc7840" },
  { key: "backlog", name: "Backlog", kind: "backlog", position: 1, color: "#bec2c8" },
  { key: "todo", name: "Todo", kind: "unstarted", position: 2, color: "#e2e2e2" },
  { key: "in_progress", name: "In Progress", kind: "started", position: 3, color: "#f2c94c" },
  { key: "in_review", name: "In Review", kind: "started", position: 4, color: "#0f7488" },
  { key: "done", name: "Done", kind: "completed", position: 5, color: "#5e6ad2" },
  { key: "canceled", name: "Canceled", kind: "canceled", position: 6, color: "#95a2b3" },
]);

/** The three v1 statuses presented as states for datastores without migration 010. */
export const V1_STATES = Object.freeze([
  { key: "open", name: "Open", kind: "unstarted", position: 1 },
  { key: "active", name: "Active", kind: "started", position: 2 },
  { key: "done", name: "Done", kind: "completed", position: 3 },
]);

/** How an item with only a v1 `status` maps to a state key (brief-service.md). */
export const STATE_FOR_STATUS = { open: "todo", active: "in_progress", done: "done" };

/** Linear's priority scale. `rank` orders by urgency with "none" last. */
export const PRIORITIES = Object.freeze([
  { value: 0, key: "none", name: "No priority", rank: 5 },
  { value: 1, key: "urgent", name: "Urgent", rank: 1 },
  { value: 2, key: "high", name: "High", rank: 2 },
  { value: 3, key: "medium", name: "Medium", rank: 3 },
  { value: 4, key: "low", name: "Low", rank: 4 },
]);
/** Priorities in display order: urgent first, none last. */
export const PRIORITY_ORDER = Object.freeze([1, 2, 3, 4, 0]);

export const PROJECT_STATES = /** @type {const} */ (["planned", "active", "paused", "completed", "cancelled"]);
export const RELATION_KINDS = /** @type {const} */ (["blocks", "relates", "duplicates"]);

export const LIMITS = Object.freeze({
  title: 500, description: 20_000, labels: 20, label: 60, estimate: 1000, comment: 20_000, rank: 64,
  stateName: 60, stateKey: 40, wip: 100_000, position: 100_000, name: 200, goal: 2000,
});

/** Every entity the planning model adds (the snapshot may contain none of them). */
export const ENTITIES = /** @type {const} */ (["work_item", "project", "cycle", "workflow_state", "label", "relation", "comment"]);

const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * The record id inside a reference value. References (`parent`, `project`, `cycle`, relation
 * endpoints, comment `item`) are IRIs to other records; the id is the trailing UUID, whatever the
 * IRI scheme. A bare UUID is accepted too.
 * @param {unknown} value @returns {string|null}
 */
export function refId(value) {
  if (typeof value !== "string" || !value) return null;
  const match = UUID.exec(value.trim());
  return match ? match[1].toLowerCase() : null;
}

/**
 * The reference value this board sends for a record id. The storage column is a uuid, so the
 * bare id is the most portable form; the service accepts it for `reference` fields.
 * @param {string} id
 */
export function refOut(id) { return id; }

/** @param {unknown} value @returns {value is string} */
export function isIsoDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/** @param {unknown} value @returns {string|null} a YYYY-MM-DD date, or null */
export function dateOnly(value) {
  if (typeof value !== "string") return null;
  const head = value.slice(0, 10);
  return isIsoDate(head) ? head : null;
}

/** @param {unknown} value @returns {number|null} epoch ms, or null */
export function instant(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

/**
 * A readable name for a Records actor, as the board has always shown it: Cloudflare OS viewers
 * (`cloudflare-os:<account>`) by their account, others by kind. A display name learned from
 * `gadgetViewer` for that actor wins.
 * @param {unknown} actor
 * @param {Map<string, string>} [known] actor id → display name
 */
export function actorLabel(actor, known) {
  if (typeof actor !== "string" || !actor) return "unknown";
  const learned = known?.get(actor);
  if (learned) return learned;
  if (actor.startsWith("cloudflare-os:")) return actor.slice("cloudflare-os:".length) || actor;
  if (actor.startsWith("records:principal:")) return "a service credential";
  if (actor.startsWith("records:operator:")) return "an operator";
  return actor;
}

/** The Records actor id of a Cloudflare OS viewer. @param {{ id?: string }|null|undefined} viewer */
export function viewerActor(viewer) {
  return viewer?.id ? `cloudflare-os:${viewer.id}` : null;
}

/** Up to two initials for an avatar. @param {string} name */
export function initials(name) {
  const words = String(name || "?").replace(/@.*/, "").split(/[\s._\-+]+/).filter(Boolean);
  if (!words.length) return "?";
  const first = words[0][0] ?? "?";
  const second = words.length > 1 ? words[words.length - 1][0] : (words[0][1] ?? "");
  return (first + second).toUpperCase();
}

/** A stable small hash of a string (FNV-1a). @param {string} text */
export function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/**
 * A key prefix from the datastore label: "Team work" → "TW", "Website" → "WEB". 2–5 letters.
 * @param {unknown} label
 */
export function keyPrefixFrom(label) {
  const words = String(label ?? "").normalize("NFKD").replace(/[^A-Za-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  let prefix = words.length > 1 ? words.map((w) => w[0]).join("").slice(0, 4) : (words[0] ?? "").slice(0, 3);
  prefix = prefix.toUpperCase().replace(/^[0-9]+/, "");
  return prefix.length >= 2 ? prefix : "WRK";
}

/** @param {unknown} prefix */
export function validKeyPrefix(prefix) {
  return typeof prefix === "string" && /^[A-Z][A-Z0-9]{1,9}$/.test(prefix);
}

/** @param {string} kind @returns {"open"|"active"|"done"} */
export function categoryOfKind(kind) { return CATEGORY_OF_KIND[kind] ?? "open"; }

/** @param {unknown} color @param {string} fallback */
export function safeColor(color, fallback) {
  return typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : fallback;
}

/** @param {unknown} value @returns {0|1|2|3|4} */
export function priorityOf(value) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 4 ? /** @type {0|1|2|3|4} */ (n) : 0;
}

/** @param {number} value */
export function priorityInfo(value) { return PRIORITIES[priorityOf(value)]; }

/**
 * A title check shared by every write path.
 * @param {unknown} raw @returns {{ ok: true, title: string } | { ok: false, error: string }}
 */
export function validTitle(raw) {
  const title = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  if (!title) return { ok: false, error: "Enter a title." };
  if (title.length > LIMITS.title) return { ok: false, error: `Titles can be at most ${LIMITS.title} characters.` };
  return { ok: true, title };
}

/** Whether a datastore description names a work v1 datastore. @param {any} description */
export function isWorkV1(description) {
  return description?.module_id === "work" && description?.api_major === 1;
}

/**
 * Whether the datastore has the planning model (migration 010): the module manifest lists its
 * entities or commands, the model's profile declares them, or planning records exist.
 * @param {{ description?: any, model?: any, records?: { entity: string }[] }} facts
 */
export function hasPlanning({ description, model, records }) {
  const manifest = description?.modules?.find?.((/** @type {any} */ m) => m?.id === "work");
  if (manifest?.entities?.includes?.("workflow_state") || manifest?.commands?.includes?.("work.state.create")) return true;
  const fields = model?.profile?.entities?.work_item?.fields;
  if (model?.profile?.entities?.workflow_state || (fields && ("state" in fields || "number" in fields))) return true;
  return Boolean(records?.some((r) => r.entity !== "work_item" || "number" in (/** @type {any} */ (r).data ?? {})));
}

/** YYYY-MM-DD of a local date. @param {Date} date */
export function localDay(date) {
  const y = date.getFullYear(), m = date.getMonth() + 1, d = date.getDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Adds days to a YYYY-MM-DD date. @param {string} day @param {number} days */
export function addDays(day, days) {
  const t = Date.parse(`${day}T00:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` (YYYY-MM-DD). @param {string} a @param {string} b */
export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}
