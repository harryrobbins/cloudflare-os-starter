// @ts-check
// An in-memory Records `work` datastore that behaves like the real service after migration 010
// (packages/records-service/sql/010-work-planning.sql) behind the Records connector
// (packages/gatekeeper-records-service). Runs in Node (vitest) and in the browser
// (harness/serve.mjs bundles it with esbuild).
//
// What it mirrors from the SQL:
//   - one command = one commit = one journal `seq`; every record written by it gets that seq as
//     its revision. The first command in a datastore without workflow states also creates the 7
//     default states in the SAME commit (ordinals 1-7, after the command's own record at 0);
//   - record `data` holds every column except metadata, with NULL columns ABSENT (not null);
//     `null` in an update clears a field; `labels: []` is stored as absent; items always carry
//     title, status, description, extensions, number, state and archived;
//   - references (parent, project, cycle, relation from/to, comment item) are bare UUIDs; ids are
//     unique across every work entity; every create accepts an optional client `id`;
//   - validation and SQLSTATEs: 400 invalid, 403 not allowed, 404 unknown record, 409 conflict
//     (duplicate id/key, cycle overlap, duplicate active relation — `relates` is symmetric —,
//     parent loop, category change of a used state), 412 stale revision, 428 revision missing;
//   - change pages never split a commit; the journal carries no `created_at` (the real
//     pull_changes strips it) and records no timestamps, unless `timestamps: true` (harness extra).
// What it mirrors from the connector: viewer assertions checked against its own intent digest,
// pending actions, and its outcome strings `Records refused the command (<status>)` (no detail)
// and `Approval was denied`.
//
// A datastore WITHOUT migration 010 is `planning: false`: only work_item with title, description,
// status and extensions, and only work.create / work.update.

import { recordsOsIntentDigest } from "../../records-service/src/cloudflare-os.ts";

export const DATASTORE = "7c1e4b52-3a0d-4d7e-9b1f-2f6a8c9d0e11";

/** records_work.default_states() */
export const DEFAULT_STATES = Object.freeze([
  { key: "triage", name: "Triage", kind: "triage", position: 0, color: "#fc7840" },
  { key: "backlog", name: "Backlog", kind: "backlog", position: 1, color: "#bec2c8" },
  { key: "todo", name: "Todo", kind: "unstarted", position: 2, color: "#e2e2e2" },
  { key: "in_progress", name: "In Progress", kind: "started", position: 3, color: "#f2c94c" },
  { key: "in_review", name: "In Review", kind: "started", position: 4, color: "#0f7488" },
  { key: "done", name: "Done", kind: "completed", position: 5, color: "#5e6ad2" },
  { key: "canceled", name: "Canceled", kind: "canceled", position: 6, color: "#95a2b3" },
]);
/** @type {Record<string, "open"|"active"|"done">} */
const CATEGORY = { triage: "open", backlog: "open", unstarted: "open", started: "active", completed: "done", canceled: "done" };
const DEFAULT_KIND = { open: "unstarted", active: "started", done: "completed" };
const ENTITIES = ["work_item", "project", "cycle", "workflow_state", "label", "relation", "comment"];
const COMMANDS = ["work.create", "work.update", "work.project.create", "work.project.update", "work.cycle.create", "work.cycle.update",
  "work.state.create", "work.state.update", "work.label.create", "work.label.update", "work.relation.create", "work.relation.update",
  "work.comment.create", "work.comment.update"];
const ENTITY_OF = { project: "project", cycle: "cycle", state: "workflow_state", label: "label", relation: "relation", comment: "comment" };
const STATUS_OF = { invalid_request: 400, forbidden: 403, not_found: 404, conflict: 409, stale_revision: 412, revision_required: 428 };

// valid_input specs from the SQL: key → allowed JSON types.
const S = "string", SN = "string|null", NN = "number|null", B = "boolean";
const SPECS = {
  item: { id: S, title: S, status: S, description: S, extensions: "object", state: S, priority: NN, assignee: SN, labels: "array|null", estimate: NN,
    start_date: SN, due_date: SN, parent: SN, project: SN, cycle: SN, rank: SN, archived: B },
  v1item: { id: S, title: S, status: S, description: S, extensions: "object" },
  project: { id: S, name: S, description: S, state: S, lead: SN, start_date: SN, target_date: SN, color: SN, archived: B },
  cycle: { id: S, name: SN, starts_on: S, ends_on: S, goal: SN },
  stateCreate: { id: S, key: S, name: S, kind: S, category: S, position: "number", color: SN, wip_limit: NN },
  stateUpdate: { id: S, name: S, kind: S, category: S, position: "number", color: SN, wip_limit: NN },
  labelCreate: { id: S, key: S, name: S, color: SN, description: S, archived: B },
  labelUpdate: { id: S, name: S, color: SN, description: S, archived: B },
  relationCreate: { id: S, from: S, to: S, kind: S },
  relationUpdate: { id: S, active: B },
  commentCreate: { id: S, item: S, body: S },
  commentUpdate: { id: S, body: S },
};

/** @param {string} code @param {string} message */
const fail = (code, message) => new Error(`${code}: ${message}`);
/** @param {string} message */ const bad = (message) => fail("invalid_request", message);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTOR = /^[a-z][a-z0-9-]{0,39}:[!-~]{1,255}$/;
const COLOR = /^#[0-9A-Fa-f]{6}$/;

/** @param {unknown} v */
function jsonType(v) { return v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "object" ? "object" : typeof v; }
/** valid_input(). @param {any} input @param {Record<string, string>} spec @param {string} message */
function validInput(input, spec, message) {
  if (jsonType(input) !== "object") throw bad(message);
  for (const [k, v] of Object.entries(input)) if (!(k in spec) || !spec[k].split("|").includes(jsonType(v))) throw bad(message);
}
/** A `::uuid` cast. @param {unknown} v @param {string} message */
function uuid(v, message) { if (typeof v !== "string" || !UUID.test(v)) throw bad(message); return v.toLowerCase(); }
/** records_work.to_date(). @param {unknown} v */
function toDate(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(v)) throw bad("Dates must be YYYY-MM-DD");
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw bad("Dates must be real calendar dates (YYYY-MM-DD)");
  return v;
}
/** records_work.valid_label(). @param {unknown} v */
function validLabel(v) { return typeof v === "string" && v.length >= 1 && v.length <= 60 && v === v.trim() && !/[\u0000-\u001f\u007f]/.test(v); }
/** records_work.label_array(). @param {unknown} v */
function labelArray(v) {
  if (v === null || v === undefined) return null;
  if (!Array.isArray(v) || v.some((e) => typeof e !== "string")) throw bad("Labels must be an array of strings");
  if (!v.length) return null;
  if (v.length > 20 || !v.every(validLabel) || new Set(v).size !== v.length) throw bad("Labels: at most 20, each 1-60 characters without surrounding spaces, no duplicates");
  return [...v];
}
/** An integer column cast (`::smallint`, `::integer`). @param {unknown} v @param {number} min @param {number} max @param {string} message */
function int(v, min, max, message) {
  if (v === null || v === undefined) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw bad(message);
  return v;
}
/** Top-level NULLs absent, as records_work.record() presents rows. @param {Record<string, any>} data */
function present(data) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const [k, v] of Object.entries(data)) if (v !== null && v !== undefined) out[k] = v;
  return out;
}
/** @param {Record<string, any>} input @param {string} key @param {any} current @param {(v: any) => any} convert */
const set = (input, key, current, convert = (v) => v) => (key in input ? convert(input[key]) : current);

/**
 * @typedef {{ id: string, entity: string, revision: number, created_by: string, updated_by: string, created_at: string, updated_at: string, data: Record<string, any> }} Row
 * @typedef {{ id: number, command: string, input: any, options: any, actor: string, digest: string, outcome: any }} Action
 * @typedef {{ seq: number, actor: string, at: string, entries: any[], undo: { id: string, prev: Row|undefined }[] }} Tx
 */

export class FakeRecords {
  /**
   * @param {{ planning?: boolean, access?: "read"|"write", module?: string, epoch?: number, label?: string,
   *   approval?: "manual"|"auto", timestamps?: boolean, now?: () => number, datastore?: string, binding?: string }} [options]
   *   `timestamps`: records carry created_at/updated_at and journal entries created_at. The real
   *   service does neither; this is a harness-only extra, off by default.
   */
  constructor({ planning = true, access = "write", module = "work", epoch = 1, label = "Team work", approval = "manual",
    timestamps = false, now = () => Date.now(), datastore = DATASTORE, binding = "b-1" } = {}) {
    this.planning = planning;
    this.module = module;
    this.epoch = epoch;
    this.approval = approval;
    this.timestamps = timestamps;
    this.now = now;
    this.seq = 0;
    this.nextId = 1;
    /** @type {Map<string, Row>} */ this.rows = new Map();
    /** @type {Map<string, Set<string>>} ids per entity */ this.byEntity = new Map();
    /** Journal entries in (seq, ordinal) order; each keeps its commit time in `created_at` (stripped on read unless `timestamps`). @type {any[]} */
    this.journal = [];
    /** @type {Map<number, Action>} */ this.actions = new Map();
    /** @type {Map<string, Action>} */ this.byKey = new Map();
    /** @type {Map<string, {viewer: string, binding: string, digest: string}>} */ this.assertions = new Map();
    /** @type {any[][]} */ this.calls = [];
    /** @type {Map<string, {message: string, count: number}>} */ this.failures = new Map();
    /** @type {Tx|null} */ this.tx = null;
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
    if (!action.outcome) action.outcome = this.#applyOutcome(action);
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
    if (this.rows.size > limit) throw fail("too_large", "Datastore exceeds bounded snapshot; export workflow required");
    const records = [...this.rows.values()].sort((a, b) => a.id.localeCompare(b.id)).map((r) => this.#present(r));
    return { records, seq: this.seq, permission_epoch: this.epoch, complete: true };
  }

  /** Pages of at most 100 entries, extended to the end of the last commit (pages never split a commit). */
  changes(after = 0, epoch = undefined, limit = 100) {
    if (epoch !== undefined && epoch !== null && epoch !== this.epoch) throw fail("reset_required", "Permission epoch changed; reset cache");
    if (!Number.isInteger(after) || after < 0 || after > this.seq) throw bad("Invalid cursor");
    let start = this.journal.findIndex((e) => e.seq > after);
    if (start < 0) start = this.journal.length;
    const first = this.journal.slice(start, start + limit);
    const last = first.at(-1)?.seq ?? after;
    let end = start + first.length;
    while (end < this.journal.length && this.journal[end].seq === last) end++;
    const out = this.journal.slice(start, end).map((e) => {
      const { created_at, ...rest } = e;
      return this.timestamps ? { ...rest, created_at } : rest;
    });
    return { changes: out, cursor: first.length === limit ? last : this.seq, permission_epoch: this.epoch };
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
    if (this.connectionInfo.access !== "write") throw fail("read_only", "This connection is read only.");
    const asserted = this.assertions.get(options?.viewerAssertion);
    this.assertions.delete(options?.viewerAssertion);
    const intent = {
      datastore: this.connectionInfo.datastore, binding: this.connectionInfo.binding, moduleId: "work", apiMajor: 1,
      command, input, expectedRevision: options?.revision ?? null, idempotencyKey: options?.idempotencyKey,
    };
    const digest = await recordsOsIntentDigest(/** @type {any} */ (intent));
    if (!asserted || asserted.binding !== "RECORDS" || asserted.digest !== digest) throw fail("forbidden", "The viewer assertion does not match this command.");
    const key = String(options.idempotencyKey);
    const previous = this.byKey.get(key);
    if (previous) {
      if (previous.digest !== digest) throw fail("conflict", "This idempotency key was used for a different command.");
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
    if (!action) throw fail("not_found", "Unknown Records action");
    return action.outcome ?? { status: "pending", actionId };
  }

  /** @param {Action} action */
  #applyOutcome(action) {
    try {
      const record = this.run(action.command, action.input, { actor: action.actor, revision: action.options.revision });
      return { status: "applied", result: { record, seq: this.seq, permission_epoch: this.epoch } };
    } catch (err) {
      const code = /^([a-z_]+):/.exec(String(/** @type {Error} */ (err).message))?.[1] ?? "invalid_request";
      return { status: "rejected", reason: `Records refused the command (${/** @type {any} */ (STATUS_OF)[code] ?? 400})` };
    }
  }

  // -------------------------------------------------------------------------------------------
  // Commands

  #newId() {
    const n = this.nextId++;
    return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
  }

  /** @param {string} entity */
  #all(entity) { return [...(this.byEntity.get(entity) ?? [])].map((id) => /** @type {Row} */ (this.rows.get(id))); }

  /** Writes a record in the current commit. @param {string} id @param {string} entity @param {Record<string, any>} data @param {number} ordinal */
  #write(id, entity, data, ordinal) {
    const tx = /** @type {Tx} */ (this.tx);
    const prev = this.rows.get(id);
    tx.undo.push({ id, prev });
    const clean = present(data);
    /** @type {Row} */
    const row = { id, entity, revision: tx.seq, created_by: prev?.created_by ?? tx.actor, updated_by: tx.actor, created_at: prev?.created_at ?? tx.at, updated_at: tx.at, data: clean };
    this.rows.set(id, row);
    if (!prev) { let ids = this.byEntity.get(entity); if (!ids) this.byEntity.set(entity, ids = new Set()); ids.add(id); }
    tx.entries.push({ seq: tx.seq, ordinal, entity, record_id: id, revision: tx.seq, actor: tx.actor, data: structuredClone(clean), created_at: tx.at });
    return this.#present(row);
  }

  /** A create's id: the client's (must be a free UUID) or a new one. @param {any} input */
  #createId(input) {
    if (!("id" in input)) return this.#newId();
    const id = uuid(input.id, "Invalid id");
    if (this.rows.has(id)) throw fail("conflict", "Record already exists");
    return id;
  }

  /** @param {any} input @param {string} entity @param {number|undefined} expected */
  #existing(input, entity, expected) {
    if (expected === undefined || expected === null) throw fail("revision_required", "Revision required");
    const id = uuid(input.id, "Invalid id");
    const row = this.rows.get(id);
    if (!row || row.entity !== entity) throw fail("not_found", "Record unavailable");
    if (row.revision !== expected) throw fail("stale_revision", "Stale revision");
    return row;
  }

  /** records_work.ensure_states(): the default states join the first command's commit. */
  #ensureStates() {
    if (!this.planning || this.#all("workflow_state").length) return;
    for (const s of DEFAULT_STATES) this.#write(this.#newId(), "workflow_state", { ...s, category: CATEGORY[s.kind] }, s.position + 1);
  }

  /**
   * Applies one command as one commit, as `actor`, without approval. Returns the presented record
   * or throws `<code>: <SQL message>` (invalid_request, forbidden, not_found, conflict,
   * stale_revision, revision_required); a failed command changes nothing.
   * @param {string} command @param {any} input @param {{ actor?: string, revision?: number }} [opts]
   */
  run(command, input, { actor = "records:operator:test", revision } = {}) {
    if (this.planning ? !COMMANDS.includes(command) : !["work.create", "work.update"].includes(command)) throw bad(`Unknown command ${command}`);
    const saved = { seq: this.seq, nextId: this.nextId };
    this.tx = { seq: this.seq + 1, actor, at: new Date(this.now()).toISOString(), entries: [], undo: [] };
    try {
      let record;
      if (command === "work.create" || command === "work.update") record = this.#item(command === "work.create", input, revision);
      else {
        const [, noun, verb] = command.split(".");
        record = /** @type {any} */ (this)[`_${noun}`](verb === "create", input ?? {}, revision, /** @type {any} */ (ENTITY_OF)[noun]);
      }
      this.seq = this.tx.seq;
      this.journal.push(...this.tx.entries.sort((a, b) => a.ordinal - b.ordinal));
      return record;
    } catch (err) {
      for (const { id, prev } of this.tx.undo.reverse()) {
        if (prev) this.rows.set(id, prev);
        else { const row = this.rows.get(id); this.rows.delete(id); if (row) this.byEntity.get(row.entity)?.delete(id); }
      }
      Object.assign(this, saved);
      throw err;
    } finally {
      this.tx = null;
    }
  }

  /** records_work.apply (work.create / work.update). @param {boolean} create @param {any} input @param {number|undefined} expected */
  #item(create, input, expected) {
    validInput(input, this.planning ? SPECS.item : SPECS.v1item, "Invalid work fields");
    this.#ensureStates();
    const v = input;
    let row = null, id;
    if (create) {
      if (expected !== undefined && expected !== null) throw bad("Create cannot have revision");
      id = this.#createId(v);
    } else {
      row = this.#existing(v, "work_item", expected);
      id = row.id;
    }
    const cur = row?.data ?? {};
    const title = set(v, "title", cur.title);
    if (typeof title !== "string" || title.length < 1 || title.length > 500) throw bad("Title must be 1-500 characters");
    if ("status" in v && !["open", "active", "done"].includes(v.status)) throw bad("Status must be open, active or done");
    /** @type {Record<string, any>} */
    const data = { title, description: set(v, "description", cur.description ?? ""), extensions: set(v, "extensions", cur.extensions ?? {}) };
    if (!this.planning) {
      data.status = set(v, "status", cur.status ?? "open");
      return this.#write(id, "work_item", data, 0);
    }
    const st = this.#resolveState(v.state, v.status, cur.state, cur.status);
    data.status = st.category;
    data.state = st.key;
    let parent = cur.parent ?? null;
    if ("parent" in v && v.parent !== null) {
      parent = uuid(v.parent, "Unknown parent item");
      if (parent === id) throw bad("An item cannot be its own parent");
      if (this.rows.get(parent)?.entity !== "work_item") throw bad("Unknown parent item");
      if (!create) for (let at = parent, hops = 0; at && hops < 100_000; at = this.rows.get(at)?.data.parent, hops++) {
        if (at === id) throw fail("conflict", "Parent would create a cycle");
      }
    } else if ("parent" in v) parent = null;
    const ref = (/** @type {string} */ key, /** @type {string} */ entity, /** @type {string} */ message) => set(v, key, cur[key] ?? null, (x) => {
      if (x === null) return null;
      const target = uuid(x, message);
      if (this.rows.get(target)?.entity !== entity) throw bad(message);
      return target;
    });
    const project = ref("project", "project", "Unknown project");
    const cycle = ref("cycle", "cycle", "Unknown cycle");
    const start = set(v, "start_date", cur.start_date ?? null, toDate);
    const due = set(v, "due_date", cur.due_date ?? null, toDate);
    if (start && due && due < start) throw bad("Due date is before start date");
    const rank = set(v, "rank", cur.rank ?? null, (x) => { if (x !== null && !/^[!-~]{1,64}$/.test(x)) throw bad("Rank must be 1-64 printable ASCII characters"); return x; });
    const assignee = set(v, "assignee", cur.assignee ?? null, (x) => { if (x !== null && !ACTOR.test(x)) throw bad("Assignee must be an actor id like <namespace>:<id>"); return x; });
    const estimate = set(v, "estimate", cur.estimate ?? null, (x) => { if (x !== null && (x < 0 || x > 1000)) throw bad("Estimate must be a number from 0 to 1000"); return x; });
    Object.assign(data, {
      number: create ? Math.max(0, ...this.#all("work_item").map((r) => r.data.number ?? 0)) + 1 : cur.number,
      priority: set(v, "priority", cur.priority ?? null, (x) => int(x, 0, 4, "Priority must be an integer from 0 to 4")),
      assignee, labels: set(v, "labels", cur.labels ?? null, labelArray), estimate, start_date: start, due_date: due,
      parent, project, cycle, rank, archived: set(v, "archived", cur.archived ?? false),
    });
    return this.#write(id, "work_item", data, 0);
  }

  /** records_work.resolve_state(). @param {string|undefined} wantedState @param {string|undefined} wantedStatus @param {string|undefined} currentState @param {string|undefined} currentStatus */
  #resolveState(wantedState, wantedStatus, currentState, currentStatus) {
    const states = this.#all("workflow_state").map((r) => r.data);
    if (wantedState !== undefined) {
      const s = states.find((x) => x.key === wantedState);
      if (!s) throw bad("Unknown workflow state");
      if (wantedStatus !== undefined && wantedStatus !== s.category) throw bad("State and status disagree");
      return s;
    }
    const current = states.find((x) => x.key === currentState);
    if (current && (wantedStatus === undefined || wantedStatus === current.category)) return current;
    const category = wantedStatus ?? currentStatus ?? "open";
    const pick = states.filter((s) => s.category === category).sort((a, b) =>
      Number(b.kind === /** @type {any} */ (DEFAULT_KIND)[category]) - Number(a.kind === /** @type {any} */ (DEFAULT_KIND)[category]) || a.position - b.position || a.key.localeCompare(b.key))[0];
    if (!pick) throw bad("No workflow state has that status");
    return pick;
  }

  /** records_work.apply_project(). @param {boolean} create @param {any} v @param {number|undefined} expected */
  _project(create, v, expected) {
    validInput(v, SPECS.project, "Invalid project fields");
    this.#ensureStates();
    const row = create ? null : this.#existing(v, "project", expected);
    if (create && expected !== undefined && expected !== null) throw bad("Create cannot have revision");
    const id = row?.id ?? this.#createId(v);
    const cur = row?.data ?? {};
    const name = set(v, "name", cur.name);
    if (name === undefined) throw bad("Invalid project fields: name is required");
    if (name.length < 1 || name.length > 200) throw bad("Project name must be 1-200 characters");
    const description = set(v, "description", cur.description ?? "");
    if (description.length > 20000) throw bad("Project description is at most 20000 characters");
    const state = set(v, "state", cur.state ?? "planned");
    if (!["planned", "active", "paused", "completed", "cancelled"].includes(state)) throw bad("Project state must be planned, active, paused, completed or cancelled");
    const lead = set(v, "lead", cur.lead ?? null);
    if (lead !== null && !ACTOR.test(lead)) throw bad("Lead must be an actor id like <namespace>:<id>");
    const start = set(v, "start_date", cur.start_date ?? null, toDate), target = set(v, "target_date", cur.target_date ?? null, toDate);
    if (start && target && target < start) throw bad("Target date is before start date");
    const color = set(v, "color", cur.color ?? null);
    if (color !== null && !COLOR.test(color)) throw bad("Colours are #rrggbb");
    return this.#write(id, "project", { name, description, state, lead, start_date: start, target_date: target, color, archived: set(v, "archived", cur.archived ?? false) }, 0);
  }

  /** records_work.apply_cycle(). @param {boolean} create @param {any} v @param {number|undefined} expected */
  _cycle(create, v, expected) {
    validInput(v, SPECS.cycle, "Invalid cycle fields");
    this.#ensureStates();
    const row = create ? null : this.#existing(v, "cycle", expected);
    if (create && expected !== undefined && expected !== null) throw bad("Create cannot have revision");
    const id = row?.id ?? this.#createId(v);
    if (create && !("starts_on" in v && "ends_on" in v)) throw bad("A cycle needs starts_on and ends_on");
    const cur = row?.data ?? {};
    const start = set(v, "starts_on", cur.starts_on, toDate), end = set(v, "ends_on", cur.ends_on, toDate);
    if (end < start) throw bad("A cycle cannot end before it starts");
    if (this.#all("cycle").some((c) => c.id !== id && start <= c.data.ends_on && c.data.starts_on <= end)) throw fail("conflict", "Cycle dates overlap another cycle");
    const name = set(v, "name", cur.name ?? null), goal = set(v, "goal", cur.goal ?? null);
    if (name !== null && (name.length < 1 || name.length > 200)) throw bad("Cycle name must be 1-200 characters");
    if (goal !== null && (goal.length < 1 || goal.length > 2000)) throw bad("Cycle goal must be 1-2000 characters");
    const number = cur.number ?? Math.max(0, ...this.#all("cycle").map((c) => c.data.number)) + 1;
    return this.#write(id, "cycle", { name, number, starts_on: start, ends_on: end, goal }, 0);
  }

  /** records_work.apply_state(). @param {boolean} create @param {any} v @param {number|undefined} expected */
  _state(create, v, expected) {
    validInput(v, create ? SPECS.stateCreate : SPECS.stateUpdate, "Invalid workflow state fields");
    if (v.category !== undefined && !["open", "active", "done"].includes(v.category)) throw bad("Category must be open, active or done");
    if (v.kind !== undefined && !(v.kind in CATEGORY)) throw bad("Workflow state kind must be triage, backlog, unstarted, started, completed or canceled");
    this.#ensureStates();
    const states = this.#all("workflow_state");
    let row = null, kind;
    if (create) {
      if (expected !== undefined && expected !== null) throw bad("Create cannot have revision");
      if (v.kind === undefined && v.category === undefined) throw bad("A workflow state needs a kind");
      kind = v.kind ?? /** @type {any} */ (DEFAULT_KIND)[v.category];
    } else {
      row = this.#existing(v, "workflow_state", expected);
      kind = v.kind ?? (v.category === undefined || v.category === row.data.category ? row.data.kind : /** @type {any} */ (DEFAULT_KIND)[v.category]);
    }
    if (v.category !== undefined && CATEGORY[kind] !== v.category) throw bad("Kind and category disagree");
    const id = row?.id ?? this.#createId(v);
    const cur = row?.data ?? {};
    const key = create ? v.key : cur.key;
    if (typeof key !== "string" || !/^[a-z][a-z0-9_]{0,39}$/.test(key)) throw bad("Workflow state keys are 1-40 lowercase letters, digits or _, starting with a letter");
    const name = set(v, "name", cur.name);
    if (typeof name !== "string" || name.length < 1 || name.length > 60) throw bad("Workflow state name must be 1-60 characters");
    const position = "position" in v ? int(v.position, 0, 100000, "Position must be an integer from 0 to 100000")
      : cur.position ?? (states.length ? Math.max(...states.map((s) => s.data.position)) + 1 : 0);
    const color = set(v, "color", cur.color ?? null);
    if (color !== null && !COLOR.test(color)) throw bad("Colours are #rrggbb");
    const wip = set(v, "wip_limit", cur.wip_limit ?? null, (x) => int(x, 1, 100000, "WIP limit must be an integer from 1 to 100000"));
    if (create && states.some((s) => s.data.key === key)) throw fail("conflict", "Workflow state key already exists");
    if (row && CATEGORY[kind] !== row.data.category && this.#all("work_item").some((i) => i.data.state === key)) {
      throw fail("conflict", "Workflow state is in use; its category cannot change");
    }
    return this.#write(id, "workflow_state", { key, name, kind, category: CATEGORY[kind], position, color, wip_limit: wip }, 0);
  }

  /** records_work.apply_label(). @param {boolean} create @param {any} v @param {number|undefined} expected */
  _label(create, v, expected) {
    validInput(v, create ? SPECS.labelCreate : SPECS.labelUpdate, "Invalid label fields");
    this.#ensureStates();
    const row = create ? null : this.#existing(v, "label", expected);
    if (create && expected !== undefined && expected !== null) throw bad("Create cannot have revision");
    const id = row?.id ?? this.#createId(v);
    const cur = row?.data ?? {};
    const key = create ? v.key : cur.key;
    if (!validLabel(key)) throw bad("Label keys are 1-60 characters without surrounding spaces");
    const name = set(v, "name", cur.name ?? key);
    if (name.length < 1 || name.length > 60) throw bad("Label name must be 1-60 characters");
    const color = set(v, "color", cur.color ?? null);
    if (color !== null && !COLOR.test(color)) throw bad("Colours are #rrggbb");
    const description = set(v, "description", cur.description ?? "");
    if (description.length > 2000) throw bad("Label description is at most 2000 characters");
    if (create && this.#all("label").some((l) => l.data.key === key)) throw fail("conflict", "Label key already exists");
    return this.#write(id, "label", { key, name, color, description, archived: set(v, "archived", cur.archived ?? false) }, 0);
  }

  /** records_work.apply_relation(). @param {boolean} create @param {any} v @param {number|undefined} expected */
  _relation(create, v, expected) {
    validInput(v, create ? SPECS.relationCreate : SPECS.relationUpdate, "Invalid relation fields");
    this.#ensureStates();
    let row = null, from, to, kind;
    if (create) {
      if (expected !== undefined && expected !== null) throw bad("Create cannot have revision");
      if (v.from === undefined || v.to === undefined || v.kind === undefined) throw bad("A relation needs from, to and kind");
      from = uuid(v.from, "Unknown work item"); to = uuid(v.to, "Unknown work item"); kind = v.kind;
      if (!["blocks", "relates", "duplicates"].includes(kind)) throw bad("Relation kind must be blocks, relates or duplicates");
      if (from === to) throw bad("An item cannot relate to itself");
      if (this.rows.get(from)?.entity !== "work_item" || this.rows.get(to)?.entity !== "work_item") throw bad("Unknown work item");
    } else {
      row = this.#existing(v, "relation", expected);
      ({ from, to, kind } = row.data);
    }
    const id = row?.id ?? this.#createId(v);
    const active = v.active ?? row?.data.active ?? true;
    if (active && this.#all("relation").some((x) => x.id !== id && x.data.active && x.data.kind === kind
      && ((x.data.from === from && x.data.to === to) || (kind === "relates" && x.data.from === to && x.data.to === from)))) {
      throw fail("conflict", "Relation already exists");
    }
    return this.#write(id, "relation", { from, to, kind, active: create ? true : active }, 0);
  }

  /** records_work.apply_comment(); only the author may edit (403). @param {boolean} create @param {any} v @param {number|undefined} expected */
  _comment(create, v, expected) {
    validInput(v, create ? SPECS.commentCreate : SPECS.commentUpdate, "Invalid comment fields");
    this.#ensureStates();
    const row = create ? null : this.#existing(v, "comment", expected);
    if (create && expected !== undefined && expected !== null) throw bad("Create cannot have revision");
    if (row && row.created_by !== /** @type {Tx} */ (this.tx).actor) throw fail("forbidden", "Only the author can edit a comment");
    const id = row?.id ?? this.#createId(v);
    let item = row?.data.item;
    if (create) {
      item = typeof v.item === "string" && UUID.test(v.item) ? v.item.toLowerCase() : null;
      if (!item || this.rows.get(item)?.entity !== "work_item") throw bad("Unknown work item");
    }
    const body = set(v, "body", row?.data.body);
    if (typeof body !== "string" || body.length < 1 || body.length > 20000) throw bad("Comment body must be 1-20000 characters");
    return this.#write(id, "comment", { item, body, edited: Boolean(row?.data.edited) || (row ? body !== row.data.body : false) }, 0);
  }
}
