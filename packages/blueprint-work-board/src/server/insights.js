// @ts-check
// The gadget server's insight surface: the data dictionary and dataset rows (computed from the
// cached snapshot plus the complete journal), the Reports screen's batched read, report
// documents (`report:<id>`, built-ins overridable and hideable), summaries for chat answers and
// an item's history. Every method validates input and returns plain JSON; errors are
// `code: detail`.

import { computeDataset, listDatasets } from "../shared/datasets/index.js";
import { BUILTIN_REPORTS, builtinReport } from "../shared/insights/builtins.js";
import { REPORT_LIMITS, normaliseReport, validateReport } from "../shared/insights/validate.js";
import { describeEntry } from "../shared/model/activity.js";
import { itemByKey, personName } from "../shared/model/index.js";
import { NONE, property } from "../shared/model/properties.js";
import { describe as describeWql, parse } from "../shared/wql/index.js";
import { KINDS, KIND_LABELS } from "../shared/model/work.js";
import { selectItems } from "../shared/datasets/registry.js";
import { deleteLarge, getLarge, listLarge, putLarge } from "./large.js";

/** @param {string} message */
const invalid = (message) => new Error(`invalid_request: ${message}`);
const SUMMARY_BY = ["state", "status", "kind", "assignee", "priority", "label", "project", "cycle", "parent", "created_by", "due"];
const CACHE_SIZE = 64;
/** Grouping by state kind (not a board property). */
const KIND_PROPERTY = {
  noneLabel: "No kind",
  keysOf: (/** @type {import("../shared/model/index.js").ItemView} */ i) => [i.kind],
  groups: () => KINDS.map((k) => ({ key: k, label: /** @type {Record<string, string>} */ (KIND_LABELS)[k] })),
};

/**
 * @param {{ queries: ReturnType<typeof import("./query.js").createQueryCache>, storage: import("./large.js").Storage, now?: () => number }} options
 */
export function createInsights({ queries, storage, now = () => Date.now() }) {
  /** @type {Map<string, any>} */
  const cache = new Map();

  /** @param {string|null} viewer */
  async function datasetContext(viewer) {
    const f = await queries.full();
    const t = now();
    return { ctx: { index: f.index, viewer, now: t, today: new Date(t).toISOString().slice(0, 10), history: f.history, historyComplete: f.complete, historyVersion: f.historyVersion }, full: f };
  }

  /**
   * @param {string} name @param {{ params?: any, query?: any, limit?: any, viewer?: any }} opts
   * @param {Awaited<ReturnType<typeof datasetContext>>} dc
   */
  function run(name, opts, dc) {
    if (typeof name !== "string" || !name) throw invalid("dataset needs a dataset name; call datasets() for the list.");
    const viewer = typeof opts.viewer === "string" ? opts.viewer : null;
    const key = JSON.stringify([dc.ctx.index.records.size, dc.full.historyVersion, queries.replica.version, name, opts.params ?? {}, opts.query ?? "", opts.limit ?? null, viewer, Math.floor(dc.ctx.now / 60_000)]);
    const hit = cache.get(key);
    if (hit) { cache.delete(key); cache.set(key, hit); return hit; }
    const result = computeDataset(name, { ...dc.ctx, viewer }, { params: opts.params, query: opts.query ?? "", limit: opts.limit });
    cache.set(key, result);
    while (cache.size > CACHE_SIZE) cache.delete(/** @type {string} */ (cache.keys().next().value));
    return result;
  }

  /** Stored report documents (overrides of built-ins, hidden markers and custom reports). */
  async function stored() {
    return /** @type {any[]} */ (await listLarge(storage, "report:"));
  }

  return {
    /** The data dictionary: every dataset with its parameters and columns. */
    datasets() { return listDatasets(); },

    /**
     * One dataset's rows for the items matching `query` (WQL).
     * @param {unknown} name @param {{ params?: Record<string, unknown>, query?: string, limit?: number, viewer?: string|null }} [opts]
     */
    async dataset(name, opts = {}) {
      if (opts && typeof opts !== "object") throw invalid("dataset options are { params, query, limit }.");
      const dc = await datasetContext(null);
      const r = run(/** @type {string} */ (name), { ...opts, limit: opts.limit ?? 2000 }, dc);
      return { ...r, history: { ...r.history, complete: dc.full.complete } };
    },

    /**
     * The Reports screen's batched read: several datasets in one call (one RPC for a whole screen).
     * `query` (the view's filter) is combined with each report's own query.
     * @param {{ query?: string, reports?: { id: string, dataset: string, params?: Record<string, unknown>, query?: string }[], viewer?: string|null }} [opts]
     */
    async insights(opts = {}) {
      const list = Array.isArray(opts.reports) ? opts.reports : [];
      if (list.length > 24) throw invalid("At most 24 reports at a time.");
      const base = typeof opts.query === "string" ? opts.query.trim() : "";
      if (base) { const { errors } = parse(base); if (errors.length) throw invalid(`The filter has an error: ${errors[0].message}`); }
      const dc = await datasetContext(typeof opts.viewer === "string" ? opts.viewer : null);
      /** @type {Record<string, any>} */
      const results = {};
      for (const r of list) {
        const id = String(r?.id ?? "");
        const own = typeof r?.query === "string" ? r.query.trim() : "";
        const query = base && own ? `(${base}) (${own})` : base || own;
        try {
          const out = run(String(r?.dataset ?? ""), { params: r?.params ?? {}, query, viewer: opts.viewer ?? null }, dc);
          results[id] = { rows: out.rows, summary: out.summary, params: out.params, total: out.total, error: null };
        } catch (err) {
          results[id] = { rows: [], summary: "", params: r?.params ?? {}, total: 0, error: err instanceof Error ? err.message : String(err) };
        }
      }
      return { history: { complete: dc.full.complete }, results, at: new Date(dc.ctx.now).toISOString() };
    },

    /** Built-in reports (with any saved changes) then saved custom reports; hidden ones flagged. */
    async listReports() {
      const docs = await stored();
      const byId = new Map(docs.map((d) => [d.id, d]));
      const out = BUILTIN_REPORTS.map((b) => {
        const o = byId.get(b.id);
        if (o?.hidden) return { ...b, hidden: true };
        return o ? { ...b, ...o, builtin: true, customised: true } : { ...b, customised: false, hidden: false };
      });
      for (const d of docs.toSorted((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")))) {
        if (!builtinReport(d.id)) out.push({ ...d, builtin: false, hidden: false });
      }
      return out;
    },

    /** Checks a report without saving it. @param {unknown} doc */
    validateReport(doc) {
      const r = validateReport(doc, { requireId: false });
      return { valid: r.valid, errors: r.errors, kind: r.kind, bytes: r.bytes };
    },

    /**
     * Creates or replaces a report. Saving with a built-in's id customises that built-in.
     * @param {any} doc @param {{ actor?: string|null, expectedVersion?: number }} [opts]
     */
    async saveReport(doc, opts = {}) {
      if (!doc || typeof doc !== "object") throw invalid("A report is an object: { id, title, dataset, params, query, spec }.");
      const input = { ...doc };
      if (input.id === undefined && typeof input.title === "string") input.id = `${input.title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "report"}-${Math.floor(now()).toString(36).slice(-5)}`;
      const clean = normaliseReport(input);
      const key = `report:${clean.id}`;
      const existing = await getLarge(storage, key);
      if (opts.expectedVersion !== undefined && existing && existing.version !== opts.expectedVersion) throw new Error("conflict: Someone else saved this report first. Reload it and try again.");
      if (!existing && !builtinReport(clean.id) && (await stored()).filter((d) => !builtinReport(d.id)).length >= REPORT_LIMITS.reports) throw invalid(`A board can hold at most ${REPORT_LIMITS.reports} reports.`);
      const at = new Date(now()).toISOString();
      const saved = {
        ...clean, created_by: existing?.created_by ?? opts.actor ?? null, updated_by: opts.actor ?? null,
        created_at: existing?.created_at ?? at, updated_at: at, version: (existing?.version ?? 0) + 1,
      };
      await putLarge(storage, key, saved);
      return saved;
    },

    /**
     * Deletes a saved report. For a built-in, hides it (restoreReport brings it back).
     * @param {unknown} id @param {{ actor?: string|null }} [opts]
     */
    async deleteReport(id, opts = {}) {
      if (typeof id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) throw invalid("Unknown report.");
      if (builtinReport(id)) {
        await putLarge(storage, `report:${id}`, { id, hidden: true, updated_by: opts.actor ?? null, updated_at: new Date(now()).toISOString(), version: 1 });
        return { deleted: id, hidden: true };
      }
      if (!(await storage.get(`report:${id}`))) throw new Error("not_found: That report no longer exists.");
      await deleteLarge(storage, `report:${id}`);
      return { deleted: id, hidden: false };
    },

    /** Brings back a hidden or customised built-in report as shipped. @param {unknown} id */
    async restoreReport(id) {
      if (typeof id !== "string" || !builtinReport(id)) throw invalid("Only built-in reports can be restored.");
      await deleteLarge(storage, `report:${id}`);
      return { restored: id };
    },

    /**
     * Counts for a chat answer: how many items match, broken down by up to four properties.
     * @param {{ query?: string, by?: string|string[], viewer?: string|null }} [opts]
     */
    async summary(opts = {}) {
      const byList = opts.by === undefined ? ["state", "assignee", "priority"] : Array.isArray(opts.by) ? opts.by : [opts.by];
      if (byList.length > 4) throw invalid("summary takes at most four `by` properties.");
      for (const b of byList) {
        if (typeof b !== "string" || (!SUMMARY_BY.includes(b) && !/^ext\.[A-Za-z0-9_]{1,64}$/.test(b))) throw invalid(`by is one of ${SUMMARY_BY.join(", ")} or ext.<field>; got ${JSON.stringify(b)}.`);
      }
      const ix = await queries.index();
      const ctx = queries.context(ix, typeof opts.viewer === "string" ? opts.viewer : null);
      const { items, query } = selectItems(ctx, typeof opts.query === "string" ? opts.query : "");
      const g = { index: ix, today: ctx.today, viewer: ctx.viewer };
      /** @type {Record<string, { value: string, count: number, points: number }[]>} */
      const by = {};
      for (const field of byList) {
        const p = field === "kind" ? KIND_PROPERTY : property(field);
        if (!p) throw invalid(`Cannot group by ${field}.`);
        /** @type {Map<string, { count: number, points: number }>} */
        const acc = new Map();
        for (const i of items) for (const k of p.keysOf(i, g)) { const a = acc.get(k) ?? { count: 0, points: 0 }; a.count++; a.points += i.estimate ?? 0; acc.set(k, a); }
        const labels = new Map(p.groups(g, items).map((grp) => [grp.key, grp.label]));
        by[field] = [...acc].map(([k, a]) => ({ value: labels.get(k) ?? (k === NONE ? p.noneLabel : k), count: a.count, points: Math.round(a.points * 10) / 10 }))
          .toSorted((a, b) => b.count - a.count || a.value.localeCompare(b.value));
      }
      const overdue = items.filter((i) => i.due && i.due < ctx.today && i.category !== "done").length;
      return {
        query, description: describeWql(parse(query).ast, ctx), total: items.length,
        points: Math.round(items.reduce((s, i) => s + (i.estimate ?? 0), 0) * 10) / 10,
        open: items.filter((i) => i.category === "open").length, in_progress: items.filter((i) => i.category === "active").length, done: items.filter((i) => i.category === "done").length,
        blocked: items.filter((i) => (ix.blockedBy.get(i.id)?.length ?? 0) > 0).length, overdue,
        unassigned: items.filter((i) => !i.assignee && i.category !== "done").length, by,
      };
    },

    /**
     * An item's change history from the journal, newest first, as readable sentences.
     * @param {unknown} key @param {{ limit?: number }} [opts]
     */
    async history(key, opts = {}) {
      if (typeof key !== "string" || !key.trim()) throw invalid("history needs a key such as WRK-12.");
      const f = await queries.full();
      const item = itemByKey(f.index, key);
      if (!item) throw new Error(`not_found: No item ${key}.`);
      const limit = Math.max(1, Math.min(200, Number(opts.limit ?? 50) || 50));
      const today = new Date(now()).toISOString().slice(0, 10);
      const entries = [...(f.history.get(item.id) ?? [])].toSorted((a, b) => b.seq - a.seq);
      const comments = (f.index.comments.get(item.id) ?? []).map((c) => ({ at: c.created, by: c.created_by ? personName(f.index, c.created_by) : null, body: c.body }));
      return {
        key: item.key, title: item.title, complete: f.complete, total: entries.length,
        entries: entries.slice(0, limit).map((e) => ({
          at: e.at === null ? null : new Date(e.at).toISOString(), actor: e.actor ? personName(f.index, e.actor) : null,
          text: `${e.actor ? personName(f.index, e.actor) : "Someone"} ${describeEntry(e, f.index, today) || "changed it"}`,
          changes: Object.fromEntries(Object.entries(e.diff).filter(([k]) => k !== "rank" && !(e.created && ["description", "extensions", "number", "status"].includes(k))).map(([k, [a, b]]) => [k, { from: a, to: b }])),
        })),
        comments: comments.map((c) => ({ ...c, at: c.at === null ? null : new Date(c.at).toISOString() })),
      };
    },
  };
}
