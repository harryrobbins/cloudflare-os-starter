// @ts-check
// Server-side reads for the agent: a short-lived replica of the datastore (snapshot, then journal
// pulls at most every `ttlMs`) and the same WQL the UI runs, so `query()` returns exactly what a
// person sees with the same filter. Results are plain JSON.

import { buildIndex, itemByKey, personName, progressOf, relationsFor } from "../shared/model/index.js";
import { CATEGORY_LABELS, PRIORITIES, localDay } from "../shared/model/work.js";
import { createReplica } from "../shared/replica.js";
import { check, describe, format, parse, run } from "../shared/wql/index.js";

const MAX_LIMIT = 500;
const ITEM_FIELDS = ["key", "title", "state", "status", "priority", "assignee", "labels", "estimate", "due", "start", "project", "cycle", "parent", "created_by", "updated_by", "archived", "description"];

/** @param {string} message */
const invalid = (message) => new Error(`invalid_request: ${message}`);

/**
 * @param {() => import("../shared/replica.js").ReplicaSource} getSource the Records session
 * @param {{ ttlMs?: number, now?: () => number, settings?: () => Promise<{ keyPrefix: string|null }>, label?: () => Promise<string|null> }} [options]
 */
export function createQueryCache(getSource, options = {}) {
  const ttlMs = options.ttlMs ?? 5_000;
  const now = options.now ?? (() => Date.now());
  const replica = createReplica({ now });
  let freshAt = 0;
  /** @type {Promise<void>|null} */
  let syncing = null;
  /** @type {{ version: number, prefix: string, index: import("../shared/model/index.js").WorkIndex }|null} */
  let cached = null;

  async function sync() {
    if (now() - freshAt < ttlMs && replica.loaded) return;
    syncing ??= (async () => {
      const source = getSource();
      if (!replica.loaded) await replica.load(source);
      else await replica.pull(source);
      freshAt = now();
    })().finally(() => { syncing = null; });
    await syncing;
  }

  async function index() {
    await sync();
    const settings = options.settings ? await options.settings() : { keyPrefix: null };
    const label = options.label ? await options.label() : null;
    const prefix = settings.keyPrefix ?? "";
    if (!cached || cached.version !== replica.version || cached.prefix !== prefix) {
      cached = { version: replica.version, prefix, index: buildIndex(replica.records.values(), { keyPrefix: settings.keyPrefix, label, times: replica.times }) };
    }
    return cached.index;
  }

  /** @param {import("../shared/model/index.js").WorkIndex} ix @param {string|null} viewer */
  function context(ix, viewer) {
    const t = now();
    return { index: ix, viewer, now: t, today: new Date(t).toISOString().slice(0, 10) };
  }

  /**
   * A plain-JSON summary of an item.
   * @param {import("../shared/model/index.js").WorkIndex} ix @param {import("../shared/model/index.js").ItemView} item
   * @param {string[]} [fields]
   */
  function toJson(ix, item, fields = ITEM_FIELDS) {
    const state = ix.stateByKey.get(item.state);
    /** @type {Record<string, unknown>} */
    const all = {
      key: item.key, id: item.id, revision: item.revision, title: item.title, description: item.description,
      state: state?.name ?? item.state, state_key: item.state, kind: item.kind, status: item.category,
      priority: PRIORITIES[item.priority].name, assignee: item.assignee ? personName(ix, item.assignee) : null, assignee_id: item.assignee,
      labels: item.labels, estimate: item.estimate, due: item.due, start: item.start,
      project: item.project ? ix.projectById.get(item.project)?.name ?? item.project : null,
      cycle: item.cycle ? ix.cycleById.get(item.cycle)?.name ?? item.cycle : null,
      parent: item.parent ? ix.items.get(item.parent)?.key ?? item.parent : null,
      created_by: item.created_by ? personName(ix, item.created_by) : null,
      updated_by: item.updated_by ? personName(ix, item.updated_by) : null,
      blocked_by: (ix.blockedBy.get(item.id) ?? []).map((id) => ix.items.get(id)?.key ?? id),
      archived: item.archived, rank: item.rank, number: item.number, extensions: item.ext,
    };
    /** @type {Record<string, unknown>} */
    const out = { key: all.key };
    for (const f of fields) if (f in all) out[f] = all[f];
    if (fields.includes("state")) out.status = all.status;
    return out;
  }

  return {
    /** For tests and the harness. */
    replica,
    index,
    /**
     * Runs WQL over the datastore.
     * @param {unknown} wql @param {{ limit?: number, fields?: string[], viewer?: string|null }} [opts]
     */
    async query(wql, opts = {}) {
      if (typeof wql !== "string") throw invalid("query needs WQL text, e.g. \"state:\\\"In Progress\\\" assignee:me\".");
      if (wql.length > 2000) throw invalid("Queries can be at most 2,000 characters.");
      const limit = Math.max(1, Math.min(MAX_LIMIT, Number(opts.limit ?? 50) || 50));
      const fields = Array.isArray(opts.fields) && opts.fields.length ? opts.fields.filter((f) => typeof f === "string") : ITEM_FIELDS.filter((f) => f !== "description");
      const { ast, errors } = parse(wql);
      if (errors.length) throw invalid(`${errors[0].message} (at character ${errors[0].start + 1})${errors[0].suggestions.length ? ` Did you mean ${errors[0].suggestions.map((s) => `“${s}”`).join(" or ")}?` : ""}`);
      const ix = await index();
      const ctx = context(ix, opts.viewer ?? null);
      const problems = check(ast, ctx);
      if (problems.length) throw invalid(`${problems[0].message}${problems[0].suggestions.length ? ` Did you mean ${problems[0].suggestions.map((s) => `“${s}”`).join(" or ")}?` : ""}`);
      const matched = run(ast, ctx);
      return {
        query: format(ast), description: describe(ast, ctx), total: matched.length, truncated: matched.length > limit,
        items: matched.slice(0, limit).map((item) => toJson(ix, item, fields)),
      };
    },
    /** @param {unknown} wql */
    async describeQuery(wql) {
      if (typeof wql !== "string") throw invalid("describeQuery needs WQL text.");
      const { ast, errors } = parse(wql);
      const ix = await index();
      const ctx = context(ix, null);
      return { query: format(ast), description: describe(ast, ctx), errors: [...errors, ...(errors.length ? [] : check(ast, ctx))] };
    },
    /** One item with its relations, sub-issues and comments. @param {unknown} key */
    async item(key) {
      if (typeof key !== "string" || !key.trim()) throw invalid("item needs a key such as WRK-12.");
      const ix = await index();
      const item = itemByKey(ix, key);
      if (!item) throw new Error(`not_found: No item ${key}.`);
      const rel = relationsFor(ix, item.id);
      const keyOf = (/** @type {string} */ id) => ix.items.get(id)?.key ?? id;
      return {
        ...toJson(ix, item, [...ITEM_FIELDS]),
        progress: progressOf(ix, item.id),
        sub_issues: (ix.children.get(item.id) ?? []).map((c) => toJson(ix, c, ["title", "state", "assignee"])),
        blocks: rel.blocks.map((r) => keyOf(r.to)), blocked_by_all: rel.blockedBy.map((r) => keyOf(r.from)),
        relates: rel.relates.map((r) => keyOf(r.from === item.id ? r.to : r.from)),
        duplicates: rel.duplicates.map((r) => keyOf(r.to)),
        comments: (ix.comments.get(item.id) ?? []).map((c) => ({ by: c.created_by ? personName(ix, c.created_by) : null, body: c.body, edited: c.edited })),
      };
    },
    /** Workflow states, labels, projects, cycles and people: the vocabulary for WQL. */
    async vocabulary() {
      const ix = await index();
      const today = localDay(new Date(now()));
      return {
        keyPrefix: ix.keyPrefix, planning: ix.planning, today,
        states: ix.states.map((s) => ({ key: s.key, name: s.name, kind: s.kind, category: CATEGORY_LABELS[s.category], wip_limit: s.wipLimit })),
        labels: ix.labels.map((l) => ({ key: l.key, name: l.name })),
        projects: ix.projects.map((p) => ({ name: p.name, state: p.state })),
        cycles: ix.cycles.map((c) => ({ name: c.name, starts_on: c.start, ends_on: c.end })),
        people: [...ix.people.values()].map((p) => ({ id: p.id, name: p.name })),
        items: ix.itemList.length,
      };
    },
    /** Forget everything (e.g. after a connection change). */
    reset() { replica.reset(); cached = null; freshAt = 0; },
  };
}
