// @ts-check
// Named datasets for reports and the agent: plain rows computed from the normalised index and the
// journal (per-item timelines). Both the Reports screen and the gadget server's `dataset()` read
// through `computeDataset`, so a chart and the agent's answer always agree.
//
// Each dataset declares its columns (name, type, description) and parameters so the agent has a
// data dictionary (`listDatasets()`), resolves and validates its parameters, and writes a
// one-sentence plain-English summary of its rows (the chart's text alternative).
//
// All datasets accept a WQL query that selects items by their CURRENT values (archived items only
// when the query mentions `archived`). Days are UTC dates; see timeline.js.

import { compile, format, mentionsArchived, parse } from "../wql/index.js";

/**
 * @typedef {import("../model/index.js").WorkIndex} WorkIndex
 * @typedef {import("../model/index.js").ItemView} ItemView
 * @typedef {import("../replica.js").HistoryEntry} HistoryEntry
 * @typedef {{ index: WorkIndex, viewer: string|null, now: number, today: string, history?: Map<string, HistoryEntry[]>,
 *   historyComplete?: boolean, historyVersion?: number }} DatasetContext
 * @typedef {{ name: string, type: "string"|"number"|"date"|"instant"|"boolean", description: string }} Column
 * @typedef {{
 *   name: string, title?: string, description: string, columns: Column[], params?: Record<string, string>,
 *   history?: boolean,
 *   resolve?: (params: Record<string, unknown>, ctx: DatasetContext) => Record<string, unknown>,
 *   rows: (ctx: DatasetContext, items: ItemView[], params: Record<string, any>) => Record<string, unknown>[],
 *   summary?: (rows: Record<string, any>[], ctx: DatasetContext, params: Record<string, any>) => string,
 * }} Dataset
 * @typedef {{ name: string, params: Record<string, unknown>, query: string, columns: Column[], rows: Record<string, unknown>[],
 *   total: number, truncated: boolean, summary: string, history: { used: boolean, complete: boolean } }} DatasetResult
 */

/** @type {Map<string, Dataset>} */
const DATASETS = new Map();

/** @param {Dataset} def */
export function registerDataset(def) { DATASETS.set(def.name, def); }
/** @param {string} name */
export function datasetDef(name) { return DATASETS.get(name) ?? null; }
/** Names, descriptions, parameters and columns of every dataset (the data dictionary). */
export function listDatasets() {
  return [...DATASETS.values()].map(({ name, title, description, columns, params, history }) => ({
    name, title: title ?? name, description, params: params ?? {}, columns, usesHistory: history === true,
  }));
}

/** @param {string} message */
export const invalid = (message) => new Error(`invalid_request: ${message}`);

/**
 * The items a query selects (archived only when the query mentions them).
 * @param {DatasetContext} ctx @param {string} [query]
 */
export function selectItems(ctx, query = "") {
  if (typeof query !== "string") throw invalid("A query is WQL text.");
  if (query.length > 2000) throw invalid("Queries can be at most 2,000 characters.");
  const { ast, errors } = parse(query);
  if (errors.length) throw invalid(`${errors[0].message} (at character ${errors[0].start + 1})${errors[0].suggestions.length ? ` Did you mean ${errors[0].suggestions.map((s) => `“${s}”`).join(" or ")}?` : ""}`);
  const pred = compile(ast, ctx);
  const archived = mentionsArchived(ast.where);
  return { items: ctx.index.itemList.filter((i) => (archived || !i.archived) && pred(i)), query: format(ast) };
}

/**
 * A dataset's rows, resolved parameters and summary for the items matching `query`.
 * @param {string} name @param {DatasetContext} ctx
 * @param {{ query?: string, params?: Record<string, unknown>, limit?: number }} [opts]
 * @returns {DatasetResult}
 */
export function computeDataset(name, ctx, opts = {}) {
  const def = DATASETS.get(name);
  if (!def) throw new Error(`not_found: No dataset “${name}”. Available: ${[...DATASETS.keys()].join(", ")}.`);
  const raw = opts.params ?? {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid("params must be an object.");
  const known = Object.keys(def.params ?? {});
  for (const key of Object.keys(raw)) {
    if (!known.includes(key)) throw invalid(`The ${name} dataset has no parameter “${key}”${known.length ? `; it takes ${known.join(", ")}` : ""}.`);
  }
  const params = def.resolve ? def.resolve(raw, ctx) : { ...raw };
  const { items, query } = selectItems(ctx, opts.query ?? "");
  const rows = def.rows(ctx, items, params);
  const limit = opts.limit === undefined ? rows.length : Math.max(1, Math.min(10_000, Math.floor(Number(opts.limit)) || 1));
  return {
    name, params, query, columns: def.columns, rows: rows.slice(0, limit), total: rows.length, truncated: rows.length > limit,
    summary: def.summary ? def.summary(rows, ctx, params) : `${rows.length} ${rows.length === 1 ? "row" : "rows"}.`,
    history: { used: def.history === true, complete: ctx.historyComplete !== false },
  };
}

/**
 * Rows only (kept for callers that need nothing else).
 * @param {string} name @param {DatasetContext} ctx @param {{ query?: string, params?: Record<string, unknown>, limit?: number }} [opts]
 */
export function runDataset(name, ctx, opts = {}) {
  return computeDataset(name, ctx, opts).rows;
}

