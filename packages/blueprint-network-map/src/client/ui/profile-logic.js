// @ts-check
// Pure logic behind the Profile panel and list mode: tag parsing, field input conversion, bulk and
// delete op building, merge planning, loop ordering, connection grouping and sort comparators.
// Nothing here touches the DOM or the store, so it runs (and is tested) in node.

import {
  LIMITS, canonicalJson, cleanFieldValue, cleanStringList, cleanUrl, loopProblem, normalizeLabel, stepEnds,
} from "../../shared/protocol.js";

/** Ops per app.apply call for bulk edits and deletes. */
export const BULK_CHUNK = 1000;

/** @param {unknown} a @param {unknown} b */
export const sameValue = (a, b) => canonicalJson(a ?? null) === canonicalJson(b ?? null);

/**
 * @template T
 * @param {T[]} list @param {number} [size]
 * @returns {T[][]}
 */
export function chunk(list, size = BULK_CHUNK) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Text inputs
// ---------------------------------------------------------------------------------------------

/**
 * "a, b ,A,, c" -> ["a", "b", "c"]: trimmed, case-insensitively distinct, clamped to the limits.
 * @param {string} text @param {{max?: number, each?: number}} [opts]
 */
export function parseList(text, { max = LIMITS.tags, each = LIMITS.tag } = {}) {
  return cleanStringList(String(text ?? "").split(","), max, each);
}

/** @param {string} text */
export const parseTags = (text) => parseList(text, { max: LIMITS.tags, each: LIMITS.tag });
/** @param {string} text */
export const parseAliases = (text) => parseList(text, { max: LIMITS.aliases, each: LIMITS.label });

/** Choices typed one per line or comma-separated. @param {string} text */
export function parseChoices(text) {
  return cleanStringList(String(text ?? "").split(/[\n,]/), LIMITS.choices, LIMITS.choice);
}

/**
 * A field control's raw value to the value sent in a patch: null clears the field.
 * Raw shapes: string (text, longtext, number, date, choice, url), {from, to} strings (daterange),
 * boolean (bool), string[] (multichoice).
 * @param {import("../../shared/protocol.js").FieldDef} def @param {unknown} raw
 * @returns {{value: unknown}|{error: string}}
 */
export function parseFieldInput(def, raw) {
  const empty = raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")
    || (Array.isArray(raw) && !raw.length) || raw === false;
  if (def.kind === "daterange") {
    const r = /** @type {any} */ (raw ?? {});
    const from = r.from || null, to = r.to || null;
    if (!from && !to) return { value: null };
    const value = cleanFieldValue(def, { from, to });
    return value === undefined ? { error: `“${def.name}”: the start must be a valid date on or before the end` } : { value };
  }
  if (empty) return { value: null };
  if (def.kind === "url" && !cleanUrl(raw)) return { error: `“${def.name}” needs a web address starting with https:// or http://` };
  if (def.kind === "number" && !Number.isFinite(Number(raw))) return { error: `“${def.name}” needs a number` };
  const value = cleanFieldValue(def, raw);
  if (value === undefined) return { error: `Invalid value for “${def.name}”` };
  return { value };
}

/**
 * A stored field value as display text (lists, the list-mode grid).
 * @param {import("../../shared/protocol.js").FieldDef|undefined} def @param {unknown} v
 */
export function formatFieldValue(def, v) {
  if (v === undefined || v === null || v === "") return "";
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "object") {
    const r = /** @type {any} */ (v);
    if (def?.kind === "daterange" || "from" in r || "to" in r) return `${r.from ?? "…"} – ${r.to ?? "…"}`;
    return canonicalJson(v);
  }
  return String(v);
}

// ---------------------------------------------------------------------------------------------
// Op building
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {{kind: "type", typeId: string|null} | {kind: "tag", tag: string}
 *   | {kind: "field", fieldId: string, value: unknown}} BulkAction
 */

/**
 * One update op per element the action changes (elements it would not change are skipped).
 * @param {any[]} elements @param {BulkAction} action
 * @returns {any[]}
 */
export function bulkOps(elements, action) {
  const ops = [];
  for (const e of elements) {
    if (!e || e.id?.[0] !== "e") continue;
    if (action.kind === "type") {
      if ((e.typeId ?? null) === (action.typeId ?? null)) continue;
      ops.push({ op: "update", id: e.id, patch: { typeId: action.typeId ?? null } });
    } else if (action.kind === "tag") {
      const tags = e.tags ?? [];
      const key = action.tag.toLowerCase();
      if (!action.tag || tags.some((/** @type {string} */ t) => t.toLowerCase() === key) || tags.length >= LIMITS.tags) continue;
      ops.push({ op: "update", id: e.id, patch: { tags: [...tags, action.tag] } });
    } else if (action.kind === "field") {
      if (sameValue(e.fields?.[action.fieldId], action.value)) continue;
      ops.push({ op: "update", id: e.id, patch: { fields: { [action.fieldId]: action.value ?? null } } });
    }
  }
  return ops;
}

/**
 * Delete ops for a selection, in the order the server cascades: loops, connections, elements.
 * A connection is skipped when one of its ends is deleted too (the cascade removes it); types,
 * fields and views are never deleted from here.
 * @param {Iterable<string>} ids @param {(id: string) => any} get
 */
export function deleteOps(ids, get) {
  const list = [...new Set(ids)].filter((id) => get(id) && "lce".includes(id[0]));
  const elements = new Set(list.filter((id) => id[0] === "e"));
  const rank = (/** @type {string} */ id) => "lce".indexOf(id[0]);
  return list
    .filter((id) => id[0] !== "c" || (!elements.has(get(id).from) && !elements.has(get(id).to)))
    .sort((a, b) => rank(a) - rank(b))
    .map((id) => ({ op: "delete", id }));
}

// ---------------------------------------------------------------------------------------------
// Connections of an element
// ---------------------------------------------------------------------------------------------

/**
 * An element's connections by how they meet it. Self-links count as outgoing.
 * @param {string} id @param {string[]} connectionIds @param {(id: string) => any} get
 * @returns {{outgoing: {conn: any, other: string}[], incoming: {conn: any, other: string}[], undirected: {conn: any, other: string}[]}}
 */
export function groupConnections(id, connectionIds, get) {
  /** @type {ReturnType<typeof groupConnections>} */
  const out = { outgoing: [], incoming: [], undirected: [] };
  for (const cid of connectionIds) {
    const conn = get(cid);
    if (!conn) continue;
    const other = conn.from === id ? conn.to : conn.from;
    if (conn.direction !== "directed") out.undirected.push({ conn, other });
    else if (conn.from === id) out.outgoing.push({ conn, other });
    else out.incoming.push({ conn, other });
  }
  return out;
}

/**
 * Elements whose label or an alias contains `query` (normalised), best first: exact, prefix, other.
 * @param {Iterable<any>} elements @param {string} query @param {{limit?: number, exclude?: Set<string>}} [opts]
 */
export function searchElements(elements, query, { limit = 8, exclude = new Set() } = {}) {
  const q = normalizeLabel(query);
  if (!q) return [];
  /** @type {[number, any][]} */
  const hits = [];
  for (const e of elements) {
    if (exclude.has(e.id)) continue;
    const names = [e.label, ...(e.aliases ?? [])].map(normalizeLabel);
    let rank = 3;
    for (const n of names) rank = Math.min(rank, n === q ? 0 : n.startsWith(q) ? 1 : n.includes(q) ? 2 : 3);
    if (rank < 3) hits.push([rank, e]);
  }
  hits.sort((a, b) => a[0] - b[0] || collator.compare(a[1].label, b[1].label));
  return hits.slice(0, limit).map(([, e]) => e);
}

// ---------------------------------------------------------------------------------------------
// Loops from a selection
// ---------------------------------------------------------------------------------------------

/** Work cap for the traversal search (a simple cycle needs one step per connection). */
const LOOP_SEARCH_BUDGET = 200_000;

/**
 * Orders selected connections into one closed traversal that uses each exactly once: every step
 * leaves from where the previous one arrived, and directed connections are walked forwards.
 * @param {string[]} ids @param {(id: string) => any} get
 * @returns {{steps: {c: string, fwd: boolean}[]}|{error: string}}
 */
export function orderLoop(ids, get) {
  const conns = [...new Set(ids)].map(get);
  if (conns.length < 1) return { error: "Select the connections that form the loop." };
  if (conns.some((c) => !c || c.id?.[0] !== "c")) return { error: "Select only connections to make a loop." };
  if (conns.length > LIMITS.loopSteps) return { error: `A loop may have at most ${LIMITS.loopSteps} connections.` };
  const found = findCircuit(conns, true);
  if (found === "budget") return { error: "These connections are too tangled to order automatically; select a simpler cycle." };
  if (!found) {
    const loose = findCircuit(conns, false);
    return {
      error: loose && loose !== "budget"
        ? "These connections form a cycle, but some directed connections point against it."
        : "These connections do not form one closed loop: each must lead into the next and the last back to the first.",
    };
  }
  const problem = loopProblem(found, get);
  return problem ? { error: problem } : { steps: found };
}

/**
 * Depth-first search for a circuit through every connection (small n; bounded work).
 * @param {any[]} conns @param {boolean} respectDirection
 * @returns {{c: string, fwd: boolean}[]|null|"budget"}
 */
function findCircuit(conns, respectDirection) {
  /** @type {Map<string, number[]>} */
  const at = new Map();
  conns.forEach((c, i) => {
    for (const end of new Set([c.from, c.to])) {
      let list = at.get(end);
      if (!list) at.set(end, (list = []));
      list.push(i);
    }
  });
  const orientations = (/** @type {any} */ c) => (c.from === c.to || (respectDirection && c.direction === "directed") ? [true] : [true, false]);
  const used = new Uint8Array(conns.length);
  /** @type {{c: string, fwd: boolean}[]} */
  const path = [];
  let budget = LOOP_SEARCH_BUDGET;
  let start = "";
  /** @param {string} node @returns {boolean|"budget"} */
  const walk = (node) => {
    if (--budget < 0) return "budget";
    if (path.length === conns.length) return node === start;
    for (const i of at.get(node) ?? []) {
      if (used[i]) continue;
      for (const fwd of orientations(conns[i])) {
        const [depart, arrive] = stepEnds(conns[i], fwd);
        if (depart !== node) continue;
        used[i] = 1;
        path.push({ c: conns[i].id, fwd });
        const r = walk(arrive);
        if (r) return r;
        path.pop();
        used[i] = 0;
      }
    }
    return false;
  };
  for (const fwd of orientations(conns[0])) {
    const [depart, arrive] = stepEnds(conns[0], fwd);
    start = depart;
    used[0] = 1;
    path.push({ c: conns[0].id, fwd });
    const r = walk(arrive);
    if (r === "budget") return "budget";
    if (r) return path;
    path.pop();
    used[0] = 0;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Merging elements
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {object} MergePlan
 * @property {any} survivor
 * @property {any[]} others                 elements deleted by the merge
 * @property {{conn: any, patch: {from?: string, to?: string}, selfLink: boolean}[]} repoint
 * @property {{fieldId: string, options: {elementId: string, value: unknown}[], chosen: string}[]} conflicts
 *   fields whose values differ; `chosen` (an element id) defaults to the survivor when it has one
 * @property {Record<string, {elementId: string, value: unknown}>} fields  non-conflicting values from the others
 * @property {string[]} aliases             survivor aliases ∪ others' labels and aliases
 * @property {string[]} tags
 * @property {{sourceId: string, key: string}[]} externalRefs
 * @property {{aliases: number, tags: number, externalRefs: number}} dropped  over the limits
 * @property {string|null} typeId           set when the survivor has no type and another has
 * @property {string|null} description      set when the survivor has none and another has
 * @property {any[]} loops                  loops using a re-pointed connection (they keep their ids)
 * @property {number} opCount
 */

/**
 * What merging `ids` into `survivorId` changes. Connections of the others are re-pointed to the
 * survivor (a connection between two merged elements becomes a self-link), labels become aliases,
 * tags and external refs are unioned, and field conflicts default to the survivor's value.
 * @param {{ids: string[], survivorId: string, get: (id: string) => any,
 *   connectionsOf: (id: string) => string[], loops: Iterable<any>}} args
 * @returns {MergePlan}
 */
export function planMerge({ ids, survivorId, get, connectionsOf, loops }) {
  const survivor = get(survivorId);
  const others = [...new Set(ids)].filter((id) => id !== survivorId).map(get).filter((e) => e?.id?.[0] === "e");
  const merged = new Set(others.map((e) => e.id));
  const target = (/** @type {string} */ end) => (merged.has(end) ? survivorId : end);

  /** @type {MergePlan["repoint"]} */
  const repoint = [];
  const seen = new Set();
  for (const e of others) {
    for (const cid of connectionsOf(e.id)) {
      const conn = get(cid);
      if (!conn || seen.has(cid)) continue;
      seen.add(cid);
      /** @type {{from?: string, to?: string}} */
      const patch = {};
      if (target(conn.from) !== conn.from) patch.from = target(conn.from);
      if (target(conn.to) !== conn.to) patch.to = target(conn.to);
      repoint.push({ conn, patch, selfLink: target(conn.from) === target(conn.to) });
    }
  }

  /** @type {MergePlan["conflicts"]} */
  const conflicts = [];
  /** @type {MergePlan["fields"]} */
  const fields = {};
  const all = [survivor, ...others];
  const fieldIds = new Set(all.flatMap((e) => Object.keys(e.fields ?? {})));
  for (const fid of fieldIds) {
    /** @type {{elementId: string, value: unknown}[]} */
    const options = [];
    for (const e of all) {
      const v = e.fields?.[fid];
      if (v === undefined || v === null || v === "") continue;
      if (!options.some((o) => sameValue(o.value, v))) options.push({ elementId: e.id, value: v });
    }
    if (options.length > 1) conflicts.push({ fieldId: fid, options, chosen: options[0].elementId });
    else if (options.length === 1 && options[0].elementId !== survivorId) fields[fid] = options[0];
  }

  const aliasPool = [...(survivor.aliases ?? []), ...others.flatMap((e) => [e.label, ...(e.aliases ?? [])])];
  const survivorKey = normalizeLabel(survivor.label);
  const aliasAll = cleanStringList(aliasPool.filter((a) => normalizeLabel(a) !== survivorKey), Infinity, LIMITS.label);
  const tagAll = cleanStringList(all.flatMap((e) => e.tags ?? []), Infinity, LIMITS.tag);
  /** @type {{sourceId: string, key: string}[]} */
  const refAll = [];
  const refSeen = new Set();
  for (const r of all.flatMap((e) => e.externalRefs ?? [])) {
    const k = r.sourceId + "\0" + r.key;
    if (!refSeen.has(k)) { refSeen.add(k); refAll.push({ sourceId: r.sourceId, key: r.key }); }
  }

  const touched = new Set(repoint.map((r) => r.conn.id));
  const affectedLoops = [...loops].filter((l) => (l.steps ?? []).some((/** @type {any} */ s) => touched.has(s.c)));
  const plan = {
    survivor, others, repoint, conflicts, fields,
    aliases: aliasAll.slice(0, LIMITS.aliases),
    tags: tagAll.slice(0, LIMITS.tags),
    externalRefs: refAll.slice(0, LIMITS.externalRefs),
    dropped: {
      aliases: Math.max(0, aliasAll.length - LIMITS.aliases),
      tags: Math.max(0, tagAll.length - LIMITS.tags),
      externalRefs: Math.max(0, refAll.length - LIMITS.externalRefs),
    },
    typeId: survivor.typeId ? null : others.find((e) => e.typeId)?.typeId ?? null,
    description: survivor.description ? null : others.find((e) => e.description)?.description ?? null,
    loops: affectedLoops,
    opCount: 0,
  };
  plan.opCount = repoint.length + 1 + others.length;
  return plan;
}

/**
 * The ops of a merge, for ONE app.apply: loops using re-pointed connections are deleted first and
 * recreated last (re-pointing one step at a time would break them in between, and the server checks
 * loops op by op), then connections are re-pointed, the survivor updated and the others deleted.
 * @param {MergePlan} plan
 * @param {Record<string, string>} choices  field id -> element id whose value wins (conflicts)
 * @param {(kind: string) => string} newId
 * @returns {any[]}
 */
export function mergeOps(plan, choices, newId) {
  const { survivor } = plan;
  // Loops keep their ids: the server checks them once the whole request has applied, so
  // re-pointing their connections one op at a time is fine.
  /** @type {any[]} */
  const ops = [];
  for (const r of plan.repoint) ops.push({ op: "update", id: r.conn.id, patch: r.patch });

  /** @type {Record<string, unknown>} */
  const fieldPatch = {};
  for (const [fid, { value }] of Object.entries(plan.fields)) fieldPatch[fid] = value;
  for (const c of plan.conflicts) {
    const winner = choices[c.fieldId] ?? c.chosen;
    const option = c.options.find((o) => o.elementId === winner) ?? c.options[0];
    if (!sameValue(survivor.fields?.[c.fieldId], option.value)) fieldPatch[c.fieldId] = option.value;
  }
  /** @type {Record<string, unknown>} */
  const patch = {};
  if (Object.keys(fieldPatch).length) patch.fields = fieldPatch;
  if (!sameValue(survivor.aliases ?? [], plan.aliases)) patch.aliases = plan.aliases;
  if (!sameValue(survivor.tags ?? [], plan.tags)) patch.tags = plan.tags;
  if (!sameValue(survivor.externalRefs ?? [], plan.externalRefs)) patch.externalRefs = plan.externalRefs;
  if (plan.typeId) patch.typeId = plan.typeId;
  if (plan.description) patch.description = plan.description;
  if (Object.keys(patch).length) ops.push({ op: "update", id: survivor.id, patch });

  for (const e of plan.others) ops.push({ op: "delete", id: e.id });
  void newId;
  return ops;
}

// ---------------------------------------------------------------------------------------------
// Sorting (list mode)
// ---------------------------------------------------------------------------------------------

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * Ascending order of two cell values: numbers numerically, text naturally ("Item 2" before
 * "Item 10"), booleans false first; empty values always last (also when descending, see sortRows).
 * @param {unknown} a @param {unknown} b
 */
export function compareCells(a, b) {
  const ea = isEmptyCell(a), eb = isEmptyCell(b);
  if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return collator.compare(String(a), String(b));
}

/** @param {unknown} v */
const isEmptyCell = (v) => v === undefined || v === null || v === "" || (typeof v === "number" && Number.isNaN(v));

/**
 * Sorts rows in place by `key` (stable; ties keep their order); empty cells stay last either way.
 * @template {Record<string, any>} R
 * @param {R[]} rows @param {string} key @param {"ascending"|"descending"} dir
 */
export function sortRows(rows, key, dir) {
  const sign = dir === "descending" ? -1 : 1;
  return rows.sort((ra, rb) => {
    const a = ra[key], b = rb[key];
    const ea = isEmptyCell(a), eb = isEmptyCell(b);
    if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
    return sign * compareCells(a, b);
  });
}
