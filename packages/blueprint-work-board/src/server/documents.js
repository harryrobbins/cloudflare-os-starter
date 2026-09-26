// @ts-check
// The gadget server's own documents: shared saved views (`view:<id>`), per-viewer preferences
// (`pref:<viewerId>`) and board settings (`settings`). Business data never lives here; it is in
// Records. Each document is one small value (the platform caps a value at 128 KiB; V8 stores
// numbers larger than JSON does, so the caps below are measured in JSON and kept far lower).
//
// `storage` is the Durable Object storage API subset { get, put, delete, list({prefix}) }, so the
// same module runs over an in-memory map in tests and in the harness.

import { parse } from "../shared/wql/index.js";
import { validKeyPrefix } from "../shared/model/work.js";

export const DOC_LIMITS = Object.freeze({ viewBytes: 16 * 1024, prefsBytes: 8 * 1024, views: 200, name: 80, query: 2000 });
export const LAYOUTS = /** @type {const} */ (["board", "list"]);
/** Layouts other screens may add (the Insights brief adds "insights"). */
const extraLayouts = new Set();
/** @param {string} layout */
export function registerLayout(layout) { extraLayouts.add(layout); }

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const FIELD = /^(?:[a-z_]{1,32}|ext\.[A-Za-z0-9_]{1,64})$/;
const DENSITIES = ["comfortable", "compact"];
const PROPERTIES = ["key", "priority", "assignee", "labels", "estimate", "due", "project", "cycle", "progress", "blocked", "comments", "state"];

/**
 * @typedef {{
 *   id: string, name: string, query: string, layout: string, columnsBy: string, swimlanesBy: string|null,
 *   sort: { field: string, dir: "asc"|"desc" }[],
 *   display: { density: "comfortable"|"compact", properties: string[], showSubIssues: boolean, showArchived: boolean,
 *     hideEmptyLanes: boolean, hideEmptyColumns: boolean|null, listColumns: string[] },
 *   shared: true, created_by: string|null, updated_by: string|null, updated_at: string, version: number,
 * }} ViewDoc
 * @typedef {{ shortcuts: boolean, lastViewId: string|null, draft: Record<string, unknown>|null, collapsedColumns: string[],
 *   collapsedLanes: string[], reduceMotion: boolean, version: number }} Prefs
 * @typedef {{ keyPrefix: string|null, version: number }} Settings
 */

/** @param {string} message */
const invalid = (message) => new Error(`invalid_request: ${message}`);

/** @param {unknown} value */
function jsonBytes(value) { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }

/** @param {unknown} value @param {number} max @param {string} what */
function text(value, max, what, { required = false } = {}) {
  if (value === undefined || value === null) { if (required) throw invalid(`${what} is required.`); return ""; }
  if (typeof value !== "string") throw invalid(`${what} must be text.`);
  const trimmed = value.trim();
  if (required && !trimmed) throw invalid(`${what} is required.`);
  if (trimmed.length > max) throw invalid(`${what} can be at most ${max} characters.`);
  return trimmed;
}

/** @param {unknown} value @param {string} what */
function field(value, what) {
  if (typeof value !== "string" || !FIELD.test(value)) throw invalid(`${what} must be a field name.`);
  return value;
}

/**
 * Validates and normalises a view. Unknown keys are dropped; wrong types are refused.
 * @param {any} input @param {ViewDoc|null} existing
 * @returns {Omit<ViewDoc, "created_by"|"updated_by"|"updated_at"|"version">}
 */
export function normaliseView(input, existing = null) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid("A view must be an object.");
  const id = input.id ?? existing?.id;
  if (typeof id !== "string" || !ID.test(id)) throw invalid("A view id must be 1–64 lowercase letters, digits, - or _.");
  const name = text(input.name, DOC_LIMITS.name, "The view name", { required: true });
  const query = text(input.query ?? "", DOC_LIMITS.query, "The query");
  const { errors } = parse(query);
  if (errors.length) throw invalid(`The query has an error: ${errors[0].message}`);
  const layout = input.layout ?? "board";
  if (!LAYOUTS.includes(layout) && !extraLayouts.has(layout)) throw invalid(`Unknown layout “${String(layout)}”.`);
  const columnsBy = field(input.columnsBy ?? "state", "columnsBy");
  const swimlanesBy = input.swimlanesBy === null || input.swimlanesBy === undefined || input.swimlanesBy === "" ? null : field(input.swimlanesBy, "swimlanesBy");
  const sortIn = input.sort ?? [];
  if (!Array.isArray(sortIn) || sortIn.length > 5) throw invalid("sort must be a list of at most 5 fields.");
  const sort = sortIn.map((/** @type {any} */ s) => ({ field: field(s?.field, "A sort field"), dir: /** @type {"asc"|"desc"} */ (s?.dir === "desc" ? "desc" : "asc") }));
  const d = input.display && typeof input.display === "object" ? input.display : {};
  const list = (/** @type {unknown} */ v, /** @type {string[]|null} */ allowed, /** @type {string[]} */ fallback) => {
    if (!Array.isArray(v)) return fallback;
    return [...new Set(v.filter((x) => typeof x === "string" && (allowed ? allowed.includes(x) : FIELD.test(x))))].slice(0, 24);
  };
  const display = {
    density: /** @type {"comfortable"|"compact"} */ (DENSITIES.includes(d.density) ? d.density : "comfortable"),
    properties: list(d.properties, PROPERTIES, PROPERTIES.filter((p) => p !== "state")),
    showSubIssues: d.showSubIssues !== false,
    showArchived: d.showArchived === true,
    hideEmptyLanes: d.hideEmptyLanes === true,
    // null: automatic (hidden while the view filters, shown otherwise)
    hideEmptyColumns: typeof d.hideEmptyColumns === "boolean" ? d.hideEmptyColumns : null,
    listColumns: list(d.listColumns, null, ["key", "title", "state", "priority", "assignee", "labels", "estimate", "due", "updated"]),
  };
  return { id, name, query, layout, columnsBy, swimlanesBy, sort, display, shared: true };
}

/** Unique short strings from a list (at most 200). @param {unknown} v @returns {string[]} */
const stringList = (v) => Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === "string" && x.length <= 200))].slice(0, 200) : [];

/** @param {any} input @returns {Omit<Prefs, "version">} */
export function normalisePrefs(input) {
  const p = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  let draft = null;
  if (p.draft && typeof p.draft === "object" && !Array.isArray(p.draft)) {
    draft = p.draft;
    if (jsonBytes(draft) > 4096) throw invalid("The saved draft is too large.");
  }
  const out = {
    shortcuts: p.shortcuts !== false,
    lastViewId: typeof p.lastViewId === "string" && ID.test(p.lastViewId) ? p.lastViewId : null,
    draft, collapsedColumns: stringList(p.collapsedColumns), collapsedLanes: stringList(p.collapsedLanes),
    reduceMotion: p.reduceMotion === true,
  };
  if (jsonBytes(out) > DOC_LIMITS.prefsBytes) throw invalid("Preferences are too large.");
  return out;
}

/**
 * @param {{ get: (key: string) => Promise<any>, put: (key: string, value: any) => Promise<void>,
 *   delete: (key: string) => Promise<boolean|void>, list: (options: { prefix: string }) => Promise<Map<string, any>> }} storage
 * @param {{ now?: () => number }} [options]
 */
export function createDocuments(storage, options = {}) {
  const now = options.now ?? (() => Date.now());

  /** @param {unknown} viewerId */
  function viewerKey(viewerId) {
    if (typeof viewerId !== "string" || !viewerId || viewerId.length > 200) throw invalid("A viewer id is required.");
    return `pref:${viewerId}`;
  }

  return {
    /** Every saved view, oldest first. @returns {Promise<ViewDoc[]>} */
    async listViews() {
      const views = [...(await storage.list({ prefix: "view:" })).values()];
      return views.toSorted((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")) || a.name.localeCompare(b.name));
    },
    /**
     * Creates or replaces a view. `expectedVersion` (optional) refuses a stale overwrite.
     * @param {any} input @param {{ actor?: string|null, expectedVersion?: number }} [opts]
     */
    async saveView(input, opts = {}) {
      const id = input?.id;
      const existing = typeof id === "string" ? await storage.get(`view:${id}`) : null;
      if (opts.expectedVersion !== undefined && existing && existing.version !== opts.expectedVersion) {
        throw new Error("conflict: Someone else saved this view first. Reload it and try again.");
      }
      if (!existing && (await storage.list({ prefix: "view:" })).size >= DOC_LIMITS.views) throw invalid(`A board can hold at most ${DOC_LIMITS.views} views.`);
      const view = normaliseView(input, existing);
      const at = new Date(now()).toISOString();
      const doc = {
        ...view, created_by: existing?.created_by ?? opts.actor ?? null, updated_by: opts.actor ?? null,
        created_at: existing?.created_at ?? at, updated_at: at, version: (existing?.version ?? 0) + 1,
      };
      if (jsonBytes(doc) > DOC_LIMITS.viewBytes) throw invalid("The view is too large.");
      await storage.put(`view:${view.id}`, doc);
      return doc;
    },
    /** @param {unknown} id */
    async deleteView(id) {
      if (typeof id !== "string" || !ID.test(id)) throw invalid("Unknown view.");
      const existed = await storage.get(`view:${id}`);
      if (!existed) throw new Error("not_found: That view no longer exists.");
      await storage.delete(`view:${id}`);
      return { deleted: id };
    },
    /** @param {unknown} viewerId @returns {Promise<Prefs>} */
    async getPrefs(viewerId) {
      const stored = await storage.get(viewerKey(viewerId));
      return stored ?? { ...normalisePrefs({}), version: 0 };
    },
    /** @param {unknown} viewerId @param {any} prefs */
    async savePrefs(viewerId, prefs) {
      const key = viewerKey(viewerId);
      const existing = await storage.get(key);
      const doc = { ...normalisePrefs(prefs), version: (existing?.version ?? 0) + 1 };
      await storage.put(key, doc);
      return doc;
    },
    /** @returns {Promise<Settings>} */
    async getSettings() {
      return (await storage.get("settings")) ?? { keyPrefix: null, version: 0 };
    },
    /** @param {any} settings @param {{ actor?: string|null }} [opts] */
    async saveSettings(settings, opts = {}) {
      const keyPrefix = settings?.keyPrefix === null || settings?.keyPrefix === "" ? null : settings?.keyPrefix;
      if (keyPrefix !== null && !validKeyPrefix(keyPrefix)) throw invalid("A key prefix is 2–10 capital letters or digits, starting with a letter.");
      const existing = await storage.get("settings");
      const doc = { keyPrefix, version: (existing?.version ?? 0) + 1, updated_by: opts.actor ?? null };
      await storage.put("settings", doc);
      return doc;
    },
  };
}

export const PEOPLE_LIMITS = Object.freeze({ people: 500, bytes: 64 * 1024, name: 80, actor: 300 });
const ACTOR = /^[a-z][a-z0-9-]{0,39}:[!-~]{1,255}$/;

/**
 * @typedef {{ name: string|null, alias: string|null, seen: number }} PersonEntry
 * @typedef {{ actor: string, name: string|null, alias: string|null, displayName: string|null, seen: number }} Person
 */

/** @param {{ people: Record<string, PersonEntry> }} doc @returns {Person[]} */
const listPeople = (doc) => Object.entries(doc.people).map(([actor, p]) => ({ actor, name: p.name, alias: p.alias, displayName: p.alias ?? p.name, seen: p.seen }))
  .toSorted((a, b) => String(a.displayName ?? a.actor).localeCompare(String(b.displayName ?? b.actor)));

/**
 * Display names for Records actors. A viewer's own name is learned when they use the board
 * (`cloudflare-os:<viewer.id>` → gadgetViewer.displayName, the connector's actor mapping); anyone
 * can set an alias for an actor (e.g. a service credential → "Import bot"). One bounded document:
 * at most 500 people and 64 KiB, forgetting the longest-unseen entries without an alias first.
 * @param {Parameters<typeof createDocuments>[0]} storage @param {{ now?: () => number }} [options]
 */
export function createPeople(storage, options = {}) {
  const now = options.now ?? (() => Date.now());
  // Writes are read-modify-write of one document; storage calls interleave across awaits, so
  // they run one at a time or concurrent viewers would overwrite each other.
  /** @type {Promise<unknown>} */
  let chain = Promise.resolve();
  /** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  const serial = (fn) => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };
  /** @returns {Promise<{ people: Record<string, PersonEntry>, version: number }>} */
  const load = async () => (await storage.get("people")) ?? { people: {}, version: 0 };
  /** @param {{ people: Record<string, PersonEntry>, version: number }} doc */
  async function save(doc) {
    const entries = Object.entries(doc.people);
    // Forget the longest-unseen people (aliases last) until within bounds.
    entries.sort(([, a], [, b]) => (a.alias ? 1 : 0) - (b.alias ? 1 : 0) || a.seen - b.seen);
    while (entries.length > PEOPLE_LIMITS.people || (entries.length && jsonBytes({ people: Object.fromEntries(entries) }) > PEOPLE_LIMITS.bytes)) entries.shift();
    const next = { people: Object.fromEntries(entries), version: doc.version + 1 };
    await storage.put("people", next);
    return next;
  }
  /** @param {unknown} value @param {string} what */
  const cleanName = (value, what) => {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value !== "string") throw invalid(`${what} must be text.`);
    const t = [...value].filter((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127).join("").trim();
    if (t.length > PEOPLE_LIMITS.name) throw invalid(`${what} can be at most ${PEOPLE_LIMITS.name} characters.`);
    return t || null;
  };
  return {
    async people() { return listPeople(await load()); },
    /** Records the signed-in viewer's display name. @param {unknown} viewer */
    rememberViewer(viewer) { return serial(() => remember(viewer)); },
    /** Sets (or clears, with null) the name shown for an actor. @param {unknown} actor @param {unknown} alias */
    setPersonAlias(actor, alias) { return serial(() => setAlias(actor, alias)); },
  };

  /** @param {unknown} viewer */
  async function remember(viewer) {
      const v = /** @type {any} */ (viewer);
      if (!v || typeof v.id !== "string" || !v.id || v.id.length > 200) throw invalid("A viewer with an id is required.");
      const actor = `cloudflare-os:${v.id}`;
      if (!ACTOR.test(actor)) throw invalid("That viewer id cannot be a Records actor.");
      const name = cleanName(v.displayName, "A display name");
      const doc = await load();
      const prev = doc.people[actor];
      const t = now();
      // Unchanged and seen within a day: nothing to write.
      if (prev && prev.name === name && t - prev.seen < 86_400_000) return listPeople(doc);
      doc.people[actor] = { name, alias: prev?.alias ?? null, seen: t };
      return listPeople(await save(doc));
  }
  /** @param {unknown} actor @param {unknown} alias */
  async function setAlias(actor, alias) {
      if (typeof actor !== "string" || actor.length > PEOPLE_LIMITS.actor || !ACTOR.test(actor)) throw invalid("That is not a Records actor.");
      const clean = cleanName(alias, "A name");
      const doc = await load();
      const prev = doc.people[actor];
      if (!prev && !clean) return listPeople(doc);
      doc.people[actor] = { name: prev?.name ?? null, alias: clean, seen: prev?.seen ?? now() };
      return listPeople(await save(doc));
  }
}

/** @param {any} v */
const cloneValue = (v) => (v === undefined ? undefined : structuredClone(v));

/** An in-memory stand-in for Durable Object storage (tests, harness). Values are structured-cloned. */
export function memoryStorage() {
  /** @type {Map<string, any>} */
  const map = new Map();
  return {
    map,
    async get(/** @type {string} */ key) { return cloneValue(map.get(key)); },
    async put(/** @type {string} */ key, /** @type {any} */ value) { map.set(key, cloneValue(value)); },
    async delete(/** @type {string} */ key) { return map.delete(key); },
    async list({ prefix = "" } = {}) {
      return new Map([...map].filter(([k]) => k.startsWith(prefix)).toSorted(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, cloneValue(v)]));
    },
  };
}
