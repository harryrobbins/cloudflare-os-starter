// @ts-check
// An in-memory Records `work` datastore implementing the migration-010 planning contract
// (docs/plans/work-board/brief-service.md, as amended by plan.md: workflow states carry `kind`).
// Runs in Node (vitest) and in the browser (harness/serve.mjs bundles it with esbuild).
//
// It plays both the Records service (validation, journal, snapshot, changes) and the connector's
// approval path (viewer assertions checked against the connector's own intent digest, pending
// actions, the connector's exact rejection strings). Contract decisions this fake makes, which
// the real service is expected to share:
//   - references (parent, project, cycle, relation from/to, comment item) are accepted as a bare
//     UUID or any IRI ending in one, and stored/returned as the bare lowercase UUID;
//   - `null` in work.update clears an optional field; data always carries every field (nulls for
//     unset ones, `labels: []`, `archived: false`), like jsonb_build_object over the row;
//   - rejected actions read exactly `Records refused the command (<status>)` (400 validation,
//     403 not allowed, 404 unknown record, 412 stale revision, 428 revision missing) or
//     `Approval was denied`.

import { recordsOsIntentDigest } from "../../records-service/src/cloudflare-os.ts";

export const DATASTORE = "7c1e4b52-3a0d-4d7e-9b1f-2f6a8c9d0e11";

const KINDS = ["triage", "backlog", "unstarted", "started", "completed", "canceled"];
/** @type {Record<string, "open"|"active"|"done">} */
const CATEGORY = { triage: "open", backlog: "open", unstarted: "open", started: "active", completed: "done", canceled: "done" };
const PREFERRED = { open: "todo", active: "in_progress", done: "done" };
export const DEFAULT_STATES = [
  { key: "backlog", name: "Backlog", kind: "backlog", position: 1, color: "#8a8f98" },
  { key: "todo", name: "Todo", kind: "unstarted", position: 2, color: "#6b7280" },
  { key: "in_progress", name: "In Progress", kind: "started", position: 3, color: "#d99100" },
  { key: "in_review", name: "In Review", kind: "started", position: 4, color: "#2f80ed" },
  { key: "done", name: "Done", kind: "completed", position: 5, color: "#2f9e5b" },
  { key: "cancelled", name: "Canceled", kind: "canceled", position: 6, color: "#9aa0a6" },
];
const ENTITIES = ["work_item", "project", "cycle", "workflow_state", "label", "relation", "comment"];
const COMMANDS = ["work.create", "work.update", "work.project.create", "work.project.update", "work.cycle.create", "work.cycle.update",
  "work.state.create", "work.state.update", "work.label.create", "work.label.update", "work.relation.create", "work.relation.update",
  "work.comment.create", "work.comment.update"];
const ITEM_FIELDS = ["title", "description", "status", "state", "priority", "assignee", "labels", "estimate", "start_date", "due_date",
  "parent", "project", "cycle", "rank", "archived", "extensions"];
const V1_FIELDS = ["title", "description", "status", "extensions"];
const ENTITY_OF = { project: "project", cycle: "cycle", state: "workflow_state", label: "label", relation: "relation", comment: "comment" };
const STATUS_OF_ERROR = { invalid_request: 400, forbidden: 403, not_found: 404, stale_revision: 412, revision_required: 428, conflict: 409 };

/** @param {string} message */ const bad = (message) => new Error(`invalid_request: ${message}`);
const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ACTOR = /^[a-z][a-z0-9-]{0,39}:.+/;
const COLOR = /^#[0-9a-f]{6}$/i;

/** @param {unknown} v @param {string} what */
function text(v, what, min, max) {
  if (typeof v !== "string") throw bad(`${what} must be text`);
  if (v.trim().length < min || v.length > max) throw bad(`${what} must be ${min}–${max} characters`);
  return v;
}
/** @param {unknown} v @param {string} what */
function date(v, what) {
  if (typeof v !== "string" || !DATE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw bad(`${what} must be an ISO date`);
  return v;
}
/** @param {unknown} v @param {string} what */
function color(v, what) { if (typeof v !== "string" || !COLOR.test(v)) throw bad(`${what} must be #rrggbb`); return v.toLowerCase(); }
/** @param {unknown} v @param {string} what */
function bool(v, what) { if (typeof v !== "boolean") throw bad(`${what} must be true or false`); return v; }

/**
 * @typedef {{ id: string, entity: string, revision: number, created_by: string, updated_by: string, created_at: string, updated_at: string, data: Record<string, any> }} Row
 * @typedef {{ id: number, command: string, input: any, options: any, actor: string, digest: string, outcome: any }} Action
 */

export class FakeRecords {
  /**
   * @param {{ planning?: boolean, access?: "read"|"write", module?: string, epoch?: number, label?: string,
   *   approval?: "manual"|"auto", timestamps?: boolean, now?: () => number, datastore?: string, binding?: string }} [options]
   */
  constructor({ planning = true, access = "write", module = "work", epoch = 1, label = "Team work", approval = "manual",
    timestamps = true, now = () => Date.now(), datastore = DATASTORE, binding = "b-1" } = {}) {
    this.planning = planning;
    this.module = module;
    this.epoch = epoch;
    this.approval = approval;
    this.timestamps = timestamps;
    this.now = now;
    this.seq = 0;
    this.nextId = 1;
    this.itemNumber = 0;
    this.cycleNumber = 0;
    /** @type {Map<string, Row>} */ this.rows = new Map();
    /** @type {Map<string, Set<string>>} ids per entity */ this.byEntity = new Map();
    /** @type {any[]} */ this.journal = [];
    /** @type {Map<number, Action>} */ this.actions = new Map();
    /** @type {Map<string, Action>} */ this.byKey = new Map();
    /** @type {Map<string, {viewer: string, binding: string, digest: string}>} */ this.assertions = new Map();
    /** @type {any[][]} */ this.calls = [];
    /** @type {Map<string, {message: string, count: number}>} */ this.failures = new Map();
    this.connectionInfo = {
      url: `records-service://datastore/${datastore}/work/v1/${access}`, datastore, binding, label,
      moduleId: "work", apiMajor: 1, access, scopes: access === "write" ? ["work.read", "work.write"] : ["work.read"],
    };
  }

  // -------------------------------------------------------------------------------------------
  // Controls

  /** @param {"manual"|"auto"} mode */ setApproval(mode) { this.approval = mode; }
  /** @param {number} n */ setEpoch(n) { this.epoch = n; }
  /** The next `count` calls of a session method throw `message`. @param {string} method @param {string} message */
  failNext(method, message, count = 1) { this.failures.set(method, { message, count }); }
  pendingActions() { return [...this.actions.values()].filter((a) => !a.outcome); }
  /** @param {number} actionId */
  approve(actionId) {
    const action = this.actions.get(actionId);
    if (!action) throw new Error(`Unknown action ${actionId}`);
    if (!action.outcome) action.outcome = this.#applyOutcome(action.command, action.input, action.actor, action.options.revision);
    return action.outcome;
  }
  /** @param {number} actionId */
  reject(actionId, reason = "Approval was denied") {
    const action = this.actions.get(actionId);
    if (action && !action.outcome) action.outcome = { status: "rejected", reason };
  }
  approveAll() { return this.pendingActions().map((a) => this.approve(a.id)); }

  /** A one-use viewer assertion as the Workshop host mints it. @param {string} viewerId @param {string} binding @param {string} digest */
  createViewerAssertion(viewerId, binding, digest) {
    const token = `assertion-${this.assertions.size + 1}-${Math.random().toString(36).slice(2, 8)}`;
    this.assertions.set(token, { viewer: viewerId, binding, digest });
    return token;
  }

  // -------------------------------------------------------------------------------------------
  // Records surface

  session() {
    const self = this;
    /** @template T @param {string} name @param {any[]} args @param {() => T} fn */
    const call = async (name, args, fn) => {
      self.calls.push([name, ...args]);
      const failure = self.failures.get(name);
      if (failure && failure.count > 0) {
        failure.count--;
        throw new Error(failure.message);
      }
      return structuredClone(await fn());
    };
    return {
      connection: () => call("connection", [], () => self.connectionInfo),
      describe: () => call("describe", [], () => self.describe()),
      model: () => call("model", [], () => self.model()),
      /** @param {number} [limit] */ snapshot: (limit) => call("snapshot", [limit], () => self.snapshot(limit)),
      /** @param {number} [after] @param {number} [epoch] */ changes: (after, epoch) => call("changes", [after, epoch], () => self.changes(after, epoch)),
      /** @param {any} [query] */ records: (query) => call("records", [query], () => self.records(query)),
      /** @param {string} command @param {any} input @param {any} options */
      command: (command, input, options) => call("command", [command, input, options], () => self.command(command, input, options)),
      /** @param {number} id */ getOutcome: (id) => call("getOutcome", [id], () => self.getOutcome(id)),
    };
  }

  describe() {
    return {
      id: this.connectionInfo.datastore, module_id: this.module, api_major: 1, permission_epoch: this.epoch,
      granted_scopes: this.connectionInfo.scopes,
      modules: [{
        id: this.module, api_majors: [1], scopes: ["work.read", "work.write"],
        entities: this.planning ? ENTITIES : ["work_item"], commands: this.planning ? COMMANDS : ["work.create", "work.update"],
      }],
    };
  }

  model() {
    const f = (/** @type {string} */ term, /** @type {string} */ type, extra = {}) => ({ term, type, ...extra });
    /** @type {Record<string, any>} */
    const item = {
      title: f("https://schema.org/name", "string", { required: true, minLength: 1, maxLength: 500 }),
      status: f("urn:records:work:status", "string", { enum: ["open", "active", "done"] }),
      description: f("https://schema.org/description", "string"),
      extensions: f("urn:records:extensions", "object"),
    };
    const entities = /** @type {Record<string, any>} */ ({ work_item: { term: "urn:records:work:WorkItem", fields: item } });
    if (this.planning) {
      Object.assign(item, {
        number: f("urn:records:work:number", "integer"), state: f("urn:records:work:state", "string"),
        priority: f("urn:records:work:priority", "integer"), assignee: f("urn:records:work:assignee", "string"),
        labels: f("https://schema.org/keywords", "array"), estimate: f("urn:records:work:estimate", "number"),
        start_date: f("https://schema.org/startDate", "string"), due_date: f("https://schema.org/endDate", "string"),
        parent: f("urn:records:work:parent", "reference"), project: f("urn:records:work:project", "reference"),
        cycle: f("urn:records:work:cycle", "reference"), rank: f("urn:records:work:rank", "string"),
        archived: f("urn:records:work:archived", "boolean"),
      });
      entities.project = { term: "https://schema.org/Project", fields: { name: f("https://schema.org/name", "string") } };
      entities.cycle = { term: "urn:records:work:Cycle", fields: { name: f("https://schema.org/name", "string") } };
      entities.workflow_state = { term: "urn:records:work:WorkflowState", fields: { key: f("urn:records:work:key", "string"), kind: f("urn:records:work:kind", "string") } };
      entities.label = { term: "urn:records:work:Label", fields: { key: f("urn:records:work:key", "string") } };
      entities.relation = { term: "urn:records:work:Relation", fields: { kind: f("urn:records:work:kind", "string") } };
      entities.comment = { term: "https://schema.org/Comment", fields: { body: f("https://schema.org/text", "string") } };
    }
    return { moduleId: "work", apiMajor: 1, profile: { id: "urn:records:profile:work", version: this.planning ? "1.1.0" : "1.0.0", entities }, schemas: {} };
  }

  /** @param {Row} row */
  #present(row) {
    /** @type {any} */
    const out = { id: row.id, entity: row.entity, revision: row.revision, created_by: row.created_by, updated_by: row.updated_by, data: row.data };
    if (this.timestamps) { out.created_at = row.created_at; out.updated_at = row.updated_at; }
    return out;
  }

  snapshot(limit = 1000) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw bad("Invalid snapshot limit");
    if (this.rows.size > limit) throw new Error("too_large: Datastore exceeds bounded snapshot; export workflow required");
    const records = [...this.rows.values()].sort((a, b) => a.id.localeCompare(b.id)).map((r) => this.#present(r));
    return { records, seq: this.seq, permission_epoch: this.epoch, complete: true };
  }

  changes(after = 0, epoch = undefined) {
    if (epoch !== undefined && epoch !== null && epoch !== this.epoch) throw new Error("reset_required: Permission epoch changed; reset cache");
    if (!Number.isInteger(after) || after < 0 || after > this.seq) throw bad("Invalid cursor");
    const page = [];
    for (const entry of this.journal) { if (entry.seq > after) { page.push(entry); if (page.length === 100) break; } }
    const out = page.map((e) => {
      const { created_at, ...rest } = e;
      return this.timestamps ? { ...rest, created_at } : rest;
    });
    return { changes: out, cursor: page.length === 100 ? page[99].seq : this.seq, permission_epoch: this.epoch };
  }

  /** @param {{ entity?: string, id?: string, after?: string, limit?: number }} [query] */
  records(query = {}) {
    const limit = query.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw bad("Invalid limit");
    const rows = [...this.rows.values()].filter((r) => (!query.entity || r.entity === query.entity) && (!query.id || r.id === query.id)
      && (!query.after || r.id > query.after)).sort((a, b) => a.id.localeCompare(b.id)).slice(0, limit);
    return { records: rows.map((r) => this.#present(r)), seq: this.seq, permission_epoch: this.epoch };
  }

  /** @param {string} command @param {any} input @param {{ viewerAssertion: string, idempotencyKey: string, revision?: number }} options */
  async command(command, input, options) {
    if (this.connectionInfo.access !== "write") throw new Error("read_only: This connection is read only.");
    const asserted = this.assertions.get(options?.viewerAssertion);
    this.assertions.delete(options?.viewerAssertion);
    const intent = {
      datastore: this.connectionInfo.datastore, binding: this.connectionInfo.binding, moduleId: "work", apiMajor: 1,
      command, input, expectedRevision: options?.revision ?? null, idempotencyKey: options?.idempotencyKey,
    };
    const digest = await recordsOsIntentDigest(/** @type {any} */ (intent));
    if (!asserted || asserted.binding !== "RECORDS" || asserted.digest !== digest) throw new Error("forbidden: The viewer assertion does not match this command.");
    const key = String(options.idempotencyKey);
    const previous = this.byKey.get(key);
    if (previous) {
      if (previous.digest !== digest) throw new Error("conflict: This idempotency key was used for a different command.");
      return previous.outcome ?? { status: "pending", actionId: previous.id };
    }
    /** @type {Action} */
    const action = { id: this.actions.size + 1, command, input: structuredClone(input), options: { ...options }, actor: `cloudflare-os:${asserted.viewer}`, digest, outcome: null };
    this.actions.set(action.id, action);
    this.byKey.set(key, action);
    if (this.approval === "auto") return this.approve(action.id);
    return { status: "pending", actionId: action.id };
  }

  /** @param {number} actionId */
  getOutcome(actionId) {
    const action = this.actions.get(actionId);
    if (!action) throw new Error("not_found: Unknown Records action");
    return action.outcome ?? { status: "pending", actionId };
  }

  /** @param {string} command @param {any} input @param {string} actor @param {number|undefined} revision */
  #applyOutcome(command, input, actor, revision) {
    try {
      const record = this.run(command, input, { actor, revision });
      return { status: "applied", result: { record, seq: this.seq, permission_epoch: this.epoch } };
    } catch (err) {
      const code = /** @type {keyof typeof STATUS_OF_ERROR} */ (/^([a-z_]+):/.exec(String(/** @type {Error} */ (err).message))?.[1] ?? "invalid_request");
      return { status: "rejected", reason: `Records refused the command (${STATUS_OF_ERROR[code] ?? 400})` };
    }
  }

  // -------------------------------------------------------------------------------------------
  // Commands

  #newId() {
    const n = this.nextId++;
    return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
  }

  /** @param {string} id @param {string} entity @param {Record<string, any>} data @param {string} actor */
  #commit(id, entity, data, actor) {
    this.seq += 1;
    const at = new Date(this.now()).toISOString();
    const prev = this.rows.get(id);
    /** @type {Row} */
    const row = { id, entity, revision: this.seq, created_by: prev?.created_by ?? actor, updated_by: actor, created_at: prev?.created_at ?? at, updated_at: at, data };
    this.rows.set(id, row);
    if (!prev) { let set = this.byEntity.get(entity); if (!set) this.byEntity.set(entity, set = new Set()); set.add(id); }
    this.journal.push({ seq: this.seq, ordinal: 0, entity, record_id: id, revision: this.seq, actor, data: structuredClone(data), created_at: at });
    return this.#present(row);
  }

  /** @param {string} entity */
  #all(entity) { return [...(this.byEntity.get(entity) ?? [])].map((id) => /** @type {Row} */ (this.rows.get(id))); }

  /** @param {unknown} value @param {string} entity @param {string} what */
  #ref(value, entity, what) {
    const m = typeof value === "string" ? UUID.exec(value.trim()) : null;
    const id = m?.[1].toLowerCase();
    if (!id || this.rows.get(id)?.entity !== entity) throw bad(`${what} must name an existing ${entity}`);
    return id;
  }

  /** @param {string} id @param {string} entity @param {number|undefined} revision */
  #existing(id, entity, revision) {
    const row = typeof id === "string" ? this.rows.get(id) : undefined;
    if (!row || row.entity !== entity) throw new Error(`not_found: No ${entity} ${id}`);
    if (revision === undefined || revision === null) throw new Error("revision_required: Updates need the record's revision");
    if (row.revision !== revision) throw new Error("stale_revision: The record changed since that revision");
    return row;
  }

  #seedStates() {
    if (!this.planning || this.#all("workflow_state").length) return;
    for (const s of DEFAULT_STATES) this.#commit(this.#newId(), "workflow_state", { ...s, category: CATEGORY[s.kind], wip_limit: null }, "records:operator:seed");
  }

  /** @param {Record<string, any>} input @param {string[]} allowed */
  #onlyKeys(input, allowed) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw bad("Input must be an object");
    for (const k of Object.keys(input)) if (!allowed.includes(k)) throw bad(`Unknown field ${k}`);
  }

  /**
   * Applies a command as `actor` (no approval). Returns the presented record or throws a coded
   * error (`invalid_request:`, `not_found:`, `stale_revision:`, `revision_required:`, `forbidden:`).
   * @param {string} command @param {any} input @param {{ actor?: string, revision?: number }} [opts]
   */
  run(command, input, { actor = "records:operator:test", revision } = {}) {
    if (this.planning ? !COMMANDS.includes(command) : !["work.create", "work.update"].includes(command)) throw bad(`Unknown command ${command}`);
    this.#seedStates();
    if (command === "work.create" || command === "work.update") return this.#item(command === "work.create", input, actor, revision);
    const [, noun, verb] = command.split(".");
    const entity = /** @type {any} */ (ENTITY_OF)[noun];
    const create = verb === "create";
    const row = create ? null : this.#existing(input?.id, entity, revision);
    const data = /** @type {(input: any, current: Record<string, any>|null, actor: string, id: string) => Record<string, any>} */ (/** @type {any} */ (this)[`_${noun}`]).call(this, input, row ? structuredClone(row.data) : null, actor, row?.id ?? "");
    return this.#commit(row?.id ?? this.#newId(), entity, data, actor);
  }

  /** @param {boolean} create @param {any} input @param {string} actor @param {number|undefined} revision */
  #item(create, input, actor, revision) {
    const fields = this.planning ? ITEM_FIELDS : V1_FIELDS;
    this.#onlyKeys(input, create ? fields : ["id", ...fields]);
    const row = create ? null : this.#existing(input.id, "work_item", revision);
    /** @type {Record<string, any>} */
    const data = row ? structuredClone(row.data) : this.planning
      ? { title: "", description: "", status: "open", state: null, priority: 0, assignee: null, labels: [], estimate: null, start_date: null,
        due_date: null, parent: null, project: null, cycle: null, rank: null, archived: false, extensions: {} }
      : { title: "", description: "", status: "open", extensions: {} };
    if (create && input.title === undefined) throw bad("title is required");
    const v = input;
    if ("title" in v) data.title = text(v.title, "title", 1, 500);
    if ("description" in v) data.description = v.description === null ? "" : text(v.description, "description", 0, 20000);
    if ("extensions" in v) {
      if (v.extensions === null) data.extensions = {};
      else if (typeof v.extensions !== "object" || Array.isArray(v.extensions)) throw bad("extensions must be an object");
      else data.extensions = v.extensions;
    }
    if ("status" in v && !["open", "active", "done"].includes(v.status)) throw bad("status must be open, active or done");
    if (!this.planning) {
      if ("status" in v) data.status = v.status;
      return this.#commit(row?.id ?? this.#newId(), "work_item", data, actor);
    }
    /** @param {string} key @param {(x: any) => any} check */
    const opt = (key, check) => { if (key in v) data[key] = v[key] === null ? (key === "labels" ? [] : key === "archived" ? false : key === "priority" ? 0 : null) : check(v[key]); };
    opt("priority", (x) => { if (!Number.isInteger(x) || x < 0 || x > 4) throw bad("priority must be 0–4"); return x; });
    opt("assignee", (x) => { if (typeof x !== "string" || !ACTOR.test(x) || x.length > 300) throw bad("assignee must be an actor id"); return x; });
    opt("labels", (x) => {
      if (!Array.isArray(x) || x.length > 20) throw bad("labels must be at most 20");
      for (const l of x) text(l, "a label", 1, 60);
      if (new Set(x).size !== x.length) throw bad("labels must not repeat");
      return [...x];
    });
    opt("estimate", (x) => { if (typeof x !== "number" || !Number.isFinite(x) || x < 0 || x > 1000) throw bad("estimate must be 0–1000"); return x; });
    opt("start_date", (x) => date(x, "start_date"));
    opt("due_date", (x) => date(x, "due_date"));
    opt("project", (x) => this.#ref(x, "project", "project"));
    opt("cycle", (x) => this.#ref(x, "cycle", "cycle"));
    opt("rank", (x) => text(x, "rank", 0, 64));
    opt("archived", (x) => bool(x, "archived"));
    const id = row?.id ?? this.#newId();
    opt("parent", (x) => {
      const parent = this.#ref(x, "work_item", "parent");
      for (let at = parent, hops = 0; at; at = this.rows.get(at)?.data.parent, hops++) {
        if (at === id || hops > 10_000) throw bad("parent would make a cycle");
      }
      return parent;
    });
    // State and status stay consistent.
    const states = this.#all("workflow_state").map((r) => r.data).sort((a, b) => a.position - b.position);
    if ("state" in v && v.state !== null) {
      const state = states.find((s) => s.key === v.state);
      if (!state) throw bad(`state ${v.state} does not exist`);
      if ("status" in v && v.status !== state.category) throw bad("status and state disagree");
      data.state = state.key;
      data.status = state.category;
    } else if ("status" in v || create) {
      const status = v.status ?? "open";
      const current = states.find((s) => s.key === data.state);
      if (!current || current.category !== status) {
        const pick = states.find((s) => s.key === /** @type {any} */ (PREFERRED)[status] && s.category === status) ?? states.find((s) => s.category === status);
        data.state = pick?.key ?? null;
      }
      data.status = status;
    }
    if (create) data.number = ++this.itemNumber;
    return this.#commit(id, "work_item", data, actor);
  }

  /** @param {any} v @param {Record<string, any>|null} cur @param {string} _actor @param {string} id */
  _state(v, cur, _actor, id) {
    this.#onlyKeys(v, cur ? ["id", "name", "kind", "position", "color", "wip_limit"] : ["key", "name", "kind", "position", "color", "wip_limit"]);
    const d = cur ?? { key: "", name: "", kind: "unstarted", category: "open", position: 0, color: "#6b7280", wip_limit: null };
    const before = cur?.category;
    if (!cur) {
      if (typeof v.key !== "string" || !/^[a-z][a-z0-9_]{0,39}$/.test(v.key)) throw bad("key must be lowercase letters, digits and _");
      if (this.#all("workflow_state").some((r) => r.data.key === v.key)) throw bad("key already exists");
      d.key = v.key;
      if (v.name === undefined || v.kind === undefined) throw bad("name and kind are required");
      if (v.position === undefined) d.position = Math.max(0, ...this.#all("workflow_state").map((r) => r.data.position)) + 1;
    }
    if ("name" in v) d.name = text(v.name, "name", 1, 60);
    if ("kind" in v) { if (!KINDS.includes(v.kind)) throw bad("unknown kind"); d.kind = v.kind; d.category = CATEGORY[v.kind]; }
    if ("position" in v) { if (typeof v.position !== "number" || !Number.isFinite(v.position)) throw bad("position must be a number"); d.position = v.position; }
    if ("color" in v) d.color = color(v.color, "color");
    if ("wip_limit" in v) { if (v.wip_limit !== null && (!Number.isInteger(v.wip_limit) || v.wip_limit < 1 || v.wip_limit > 999)) throw bad("wip_limit must be 1–999"); d.wip_limit = v.wip_limit; }
    if (cur && before !== d.category) {
      // Items in a state whose kind moved category follow it.
      for (const item of this.#all("work_item")) if (item.data.state === d.key) this.#commit(item.id, "work_item", { ...item.data, status: d.category }, "records:operator:seed");
    }
    void id;
    return d;
  }

  /** @param {any} v @param {Record<string, any>|null} cur @param {string} _a @param {string} id */
  _label(v, cur, _a, id) {
    this.#onlyKeys(v, cur ? ["id", "name", "color", "description", "archived"] : ["key", "name", "color", "description"]);
    const d = cur ?? { key: "", name: "", color: "#8a8f98", description: "", archived: false };
    if (!cur) {
      d.key = text(v.key, "key", 1, 60).trim();
      if (this.#all("label").some((r) => r.data.key === d.key && r.id !== id)) throw bad("label key already exists");
      d.name = d.key;
    }
    if ("name" in v) d.name = text(v.name, "name", 1, 60);
    if ("color" in v) d.color = color(v.color, "color");
    if ("description" in v) d.description = v.description === null ? "" : text(v.description, "description", 0, 2000);
    if ("archived" in v) d.archived = bool(v.archived, "archived");
    return d;
  }

  /** @param {any} v @param {Record<string, any>|null} cur */
  _project(v, cur) {
    this.#onlyKeys(v, [...(cur ? ["id"] : []), "name", "description", "state", "lead", "start_date", "target_date", "color", "archived"]);
    const d = cur ?? { name: "", description: "", state: "planned", lead: null, start_date: null, target_date: null, color: "#5b6ee1", archived: false };
    if (!cur && v.name === undefined) throw bad("name is required");
    if ("name" in v) d.name = text(v.name, "name", 1, 120);
    if ("description" in v) d.description = v.description === null ? "" : text(v.description, "description", 0, 20000);
    if ("state" in v) { if (!["planned", "active", "paused", "completed", "cancelled"].includes(v.state)) throw bad("unknown project state"); d.state = v.state; }
    if ("lead" in v) { if (v.lead !== null && (typeof v.lead !== "string" || !ACTOR.test(v.lead))) throw bad("lead must be an actor id"); d.lead = v.lead; }
    for (const k of ["start_date", "target_date"]) if (k in v) d[k] = v[k] === null ? null : date(v[k], k);
    if ("color" in v) d.color = color(v.color, "color");
    if ("archived" in v) d.archived = bool(v.archived, "archived");
    return d;
  }

  /** @param {any} v @param {Record<string, any>|null} cur @param {string} _a @param {string} id */
  _cycle(v, cur, _a, id) {
    this.#onlyKeys(v, [...(cur ? ["id"] : []), "name", "starts_on", "ends_on", "goal"]);
    const d = cur ?? { name: "", number: 0, starts_on: "", ends_on: "", goal: "" };
    if (!cur && (v.starts_on === undefined || v.ends_on === undefined)) throw bad("starts_on and ends_on are required");
    if ("name" in v) d.name = v.name === null ? "" : text(v.name, "name", 0, 120);
    if ("starts_on" in v) d.starts_on = date(v.starts_on, "starts_on");
    if ("ends_on" in v) d.ends_on = date(v.ends_on, "ends_on");
    if ("goal" in v) d.goal = v.goal === null ? "" : text(v.goal, "goal", 0, 2000);
    if (d.ends_on < d.starts_on) throw bad("ends_on must not be before starts_on");
    for (const other of this.#all("cycle")) {
      if (other.id !== id && d.starts_on <= other.data.ends_on && other.data.starts_on <= d.ends_on) throw bad("cycles must not overlap");
    }
    if (!cur) d.number = ++this.cycleNumber;
    return d;
  }

  /** @param {any} v @param {Record<string, any>|null} cur @param {string} _a @param {string} id */
  _relation(v, cur, _a, id) {
    if (cur) {
      this.#onlyKeys(v, ["id", "active"]);
      if ("active" in v) {
        const active = bool(v.active, "active");
        if (active && !cur.active) this.#noDuplicateRelation(cur.from, cur.to, cur.kind, id);
        cur.active = active;
      }
      return cur;
    }
    this.#onlyKeys(v, ["from", "to", "kind"]);
    const from = this.#ref(v.from, "work_item", "from"), to = this.#ref(v.to, "work_item", "to");
    if (!["blocks", "relates", "duplicates"].includes(v.kind)) throw bad("kind must be blocks, relates or duplicates");
    if (from === to) throw bad("an item cannot relate to itself");
    this.#noDuplicateRelation(from, to, v.kind, "");
    return { from, to, kind: v.kind, active: true };
  }

  /** @param {string} from @param {string} to @param {string} kind @param {string} except */
  #noDuplicateRelation(from, to, kind, except) {
    if (this.#all("relation").some((r) => r.id !== except && r.data.active && r.data.kind === kind && r.data.from === from && r.data.to === to)) throw bad("that relation already exists");
  }

  /** @param {any} v @param {Record<string, any>|null} cur @param {string} actor @param {string} id */
  _comment(v, cur, actor, id) {
    if (cur) {
      this.#onlyKeys(v, ["id", "body"]);
      if (this.rows.get(id)?.created_by !== actor) throw new Error("forbidden: Only the author can edit a comment");
      if ("body" in v) { cur.body = text(v.body, "body", 1, 20000); cur.edited = true; }
      return cur;
    }
    this.#onlyKeys(v, ["item", "body"]);
    return { item: this.#ref(v.item, "work_item", "item"), body: text(v.body, "body", 1, 20000), edited: false };
  }
}
