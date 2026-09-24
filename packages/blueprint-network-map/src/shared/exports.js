// @ts-check
// Exports (docs/plans/network-map-blueprint.md §5.9): pure writers over the stored map as the
// core's getMap() returns it, {meta, objects, positions}. Objects are keyed by id prefix
// (e element, c connection, l loop, v view, t type, f field); positions are per-layout columns
// {layout, ids, x, y, pin, v}.
//
//   buildBackup / parseBackup   the lossless native JSON backup, with a migration registry
//   toKumuJson                  Kumu project-style JSON
//   toElementsCsv / toConnectionsCsv   Kumu spreadsheet layout, spreadsheet-safe
//   toGraphml / toGexf          XML graph formats for yEd, Gephi, Cytoscape and friends
//
// Foreign formats are not lossless: views, decoration rules and presentations exist only in the
// native backup.

import { SCHEMA_VERSION, isObject } from "./protocol.js";

export const BACKUP_FORMAT = "cloudflare-os-network-map";
export const BACKUP_VERSION = 1;
const SHARED_LAYOUT = "shared";

/**
 * @typedef {{meta?: any, objects?: any[], positions?: {layout: string, ids: string[], x: number[], y: number[], pin?: string, v?: number[]}[]}} StoredMap
 */

/** @param {StoredMap} map */
function indexMap(map) {
  const objects = Array.isArray(map?.objects) ? map.objects.filter((o) => isObject(o) && typeof o.id === "string") : [];
  /** @type {Map<string, any>} */
  const byId = new Map(objects.map((o) => [o.id, o]));
  /** @param {string} p */
  const of = (p) => objects.filter((o) => o.id[0] === p);
  return { byId, elements: of("e"), connections: of("c"), loops: of("l"), types: of("t"), fields: of("f") };
}

/** @param {any} f @param {"element"|"connection"} kind */
const applies = (f, kind) => f.appliesTo === "both" || f.appliesTo === kind || (kind === "element" && f.appliesTo === undefined);

/**
 * A field value as flat text: lists joined with "|", date ranges as "from/to".
 * @param {unknown} v @returns {string}
 */
function flatValue(v) {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map((x) => String(x)).join("|");
  if (isObject(v)) return v.from !== undefined || v.to !== undefined ? `${v.from ?? ""}/${v.to ?? ""}` : "";
  return String(v);
}

// ---------------------------------------------------------------------------------------------
// Native backup
// ---------------------------------------------------------------------------------------------

/**
 * The lossless backup: every stored object and every layout's positions as given.
 * @param {StoredMap} map
 */
export function buildBackup(map) {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    title: typeof map?.meta?.title === "string" ? map.meta.title : "",
    description: typeof map?.meta?.description === "string" ? map.meta.description : "",
    objects: structuredClone(Array.isArray(map?.objects) ? map.objects : []),
    positions: structuredClone(Array.isArray(map?.positions) ? map.positions : []),
  };
}

/**
 * Migration registry. MIGRATIONS[n] reads a version-n backup: for n below BACKUP_VERSION it
 * returns the version n + 1 document; the entry for BACKUP_VERSION is the final step (identity,
 * plus shape repair). A new format version adds its entry and turns the previous one into an
 * upgrade.
 * @type {Readonly<Record<number, (doc: any) => any>>}
 */
export const MIGRATIONS = Object.freeze({
  1: (doc) => ({
    ...doc,
    title: typeof doc.title === "string" ? doc.title : "",
    description: typeof doc.description === "string" ? doc.description : "",
    objects: doc.objects.filter((/** @type {any} */ o) => isObject(o) && typeof o.id === "string"),
    positions: Array.isArray(doc.positions) ? doc.positions.filter((/** @type {any} */ p) => isObject(p) && typeof p.layout === "string" && Array.isArray(p.ids)) : [],
  }),
});

/**
 * @param {unknown} text a backup file's text
 * @returns {{ok: true, backup: any, from: number}|{ok: false, problems: string[]}}
 */
export function parseBackup(text) {
  let raw;
  try {
    let s = typeof text === "string" ? text : "";
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    raw = JSON.parse(s);
  } catch {
    return { ok: false, problems: ["This is not valid JSON."] };
  }
  if (!isObject(raw) || raw.format !== BACKUP_FORMAT) return { ok: false, problems: ["This is not a network map backup."] };
  const version = raw.version;
  if (!Number.isSafeInteger(version) || version < 1) return { ok: false, problems: ["This backup has no valid format version."] };
  if (version > BACKUP_VERSION) {
    return { ok: false, problems: [`This backup was made by a newer version of the network map (format version ${version}); this one reads up to version ${BACKUP_VERSION}.`] };
  }
  if (!Array.isArray(raw.objects)) return { ok: false, problems: ["This backup has no objects list."] };
  let doc = raw;
  for (let v = version; v <= BACKUP_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (!step) return { ok: false, problems: [`No migration from backup format version ${v}.`] };
    doc = step(doc);
  }
  return { ok: true, backup: { ...doc, version: BACKUP_VERSION }, from: version };
}

// ---------------------------------------------------------------------------------------------
// Kumu JSON
// ---------------------------------------------------------------------------------------------

const RESERVED_ELEMENT_ATTRS = new Set(["label", "element type", "description", "tags"]);
const RESERVED_CONNECTION_ATTRS = new Set(["label", "connection type", "description", "tags", "strength", "polarity"]);

/**
 * Kumu project-style JSON. Stored ids are the `_id`s; types and fields appear by name. A field
 * whose name clashes with a built-in attribute is written as "<name> (field)". Polarity is written
 * as a "polarity" attribute when set. Views and presentations are not included: Kumu project JSON
 * does not carry presentations either, and our decoration rules have no Kumu equivalent here.
 * @param {StoredMap} map
 */
export function toKumuJson(map) {
  const { byId, elements, connections, loops, fields } = indexMap(map);
  /** @param {string|undefined} id */
  const typeName = (id) => (id ? byId.get(id)?.name : undefined);
  /** @param {Record<string, any>} attrs @param {any} o @param {"element"|"connection"} kind @param {Set<string>} reserved */
  const addFields = (attrs, o, kind, reserved) => {
    for (const f of fields) {
      if (!applies(f, kind)) continue;
      const v = o.fields?.[f.id];
      if (v === undefined || v === null) continue;
      const name = reserved.has(String(f.name).toLowerCase()) ? `${f.name} (field)` : f.name;
      attrs[name] = isObject(v) ? flatValue(v) : structuredClone(v);
    }
  };
  return {
    elements: elements.map((e) => {
      /** @type {Record<string, any>} */
      const attributes = { label: e.label ?? "" };
      const t = typeName(e.typeId);
      if (t) attributes["element type"] = t;
      if (e.description) attributes.description = e.description;
      if (e.tags?.length) attributes.tags = [...e.tags];
      addFields(attributes, e, "element", RESERVED_ELEMENT_ATTRS);
      return { _id: e.id, attributes };
    }),
    connections: connections.map((c) => {
      /** @type {Record<string, any>} */
      const attributes = {};
      const t = typeName(c.typeId);
      if (t) attributes["connection type"] = t;
      if (c.label) attributes.label = c.label;
      if (c.description) attributes.description = c.description;
      if (c.tags?.length) attributes.tags = [...c.tags];
      if (typeof c.strength === "number") attributes.strength = c.strength;
      if (c.polarity === "+" || c.polarity === "-") attributes.polarity = c.polarity;
      addFields(attributes, c, "connection", RESERVED_CONNECTION_ATTRS);
      return { _id: c.id, from: c.from, to: c.to, direction: c.direction ?? "directed", attributes };
    }),
    loops: loops.map((l) => {
      /** @type {Record<string, any>} */
      const attributes = { label: l.label ?? "Loop" };
      if (l.description) attributes.description = l.description;
      return { _id: l.id, attributes, connections: (l.steps ?? []).map((/** @type {any} */ s) => s.c) };
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// CSV (Kumu spreadsheet layout)
// ---------------------------------------------------------------------------------------------

const FORMULA_START = new Set(["=", "+", "-", "@", "\t", "\r"]);
const PLAIN_NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/**
 * One CSV cell per RFC 4180, spreadsheet-safe: text starting with = + - @ tab or CR gets a
 * leading "'" so a spreadsheet does not run it as a formula; a plain number such as -3 or +2 is
 * left alone. Cells holding a comma, quote, CR or LF are quoted with quotes doubled.
 * @param {unknown} value
 */
export function csvEscape(value) {
  let s = value === null || value === undefined ? "" : typeof value === "string" ? value : flatValue(value);
  if (s && FORMULA_START.has(s[0]) && !PLAIN_NUMBER.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** @param {unknown[][]} rows */
const csvOf = (rows) => rows.map((r) => r.map(csvEscape).join(",")).join("\r\n") + "\r\n";

/**
 * Elements as Kumu's Elements sheet: ID, Label, Type, Description, Tags, then one column per
 * element field in field order.
 * @param {StoredMap} map
 */
export function toElementsCsv(map) {
  const { byId, elements, fields } = indexMap(map);
  const own = fields.filter((f) => applies(f, "element"));
  const rows = [["ID", "Label", "Type", "Description", "Tags", ...own.map((f) => f.name)]];
  for (const e of elements) {
    rows.push([
      e.id, e.label ?? "", e.typeId ? byId.get(e.typeId)?.name ?? "" : "", e.description ?? "", (e.tags ?? []).join("|"),
      ...own.map((f) => flatValue(e.fields?.[f.id])),
    ]);
  }
  return csvOf(rows);
}

/**
 * Connections as Kumu's Connections sheet: From and To (element labels), FromID and ToID (element
 * ids, so a re-import resolves endpoints exactly), Type, Direction, Label, Polarity, Strength,
 * Description, Tags, then one column per connection field.
 * @param {StoredMap} map
 */
export function toConnectionsCsv(map) {
  const { byId, connections, fields } = indexMap(map);
  const own = fields.filter((f) => applies(f, "connection"));
  const rows = [["From", "To", "FromID", "ToID", "Type", "Direction", "Label", "Polarity", "Strength", "Description", "Tags", ...own.map((f) => f.name)]];
  for (const c of connections) {
    rows.push([
      byId.get(c.from)?.label ?? c.from, byId.get(c.to)?.label ?? c.to, c.from, c.to,
      c.typeId ? byId.get(c.typeId)?.name ?? "" : "", c.direction ?? "directed", c.label ?? "",
      c.polarity === "+" || c.polarity === "-" ? c.polarity : "", typeof c.strength === "number" ? String(c.strength) : "",
      c.description ?? "", (c.tags ?? []).join("|"),
      ...own.map((f) => flatValue(c.fields?.[f.id])),
    ]);
  }
  return csvOf(rows);
}

// ---------------------------------------------------------------------------------------------
// XML (GraphML, GEXF)
// ---------------------------------------------------------------------------------------------

// Characters XML 1.0 forbids (C0 controls except tab, LF, CR; lone surrogates; U+FFFE/U+FFFF).
const XML_INVALID = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** @param {unknown} v */
export function xmlEscape(v) {
  return flatValue(v).replace(XML_INVALID, "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

/** @param {StoredMap} map @returns {Map<string, {x: number, y: number}>} */
function sharedPositions(map) {
  const out = new Map();
  const cols = (Array.isArray(map?.positions) ? map.positions : []).find((p) => p?.layout === SHARED_LAYOUT);
  if (!cols || !Array.isArray(cols.ids)) return out;
  cols.ids.forEach((id, i) => {
    const x = cols.x?.[i], y = cols.y?.[i];
    if (typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y)) out.set(id, { x, y });
  });
  return out;
}

/** @param {any} f */
const graphmlType = (f) => (f.kind === "number" ? "double" : f.kind === "bool" ? "boolean" : "string");

/**
 * GraphML: node keys label/type/description/tags (and x/y from the shared layout), edge keys
 * label/type/description/tags/polarity/strength/direction, one key per custom field (its id).
 * Undirected and mutual connections carry directed="false".
 * @param {StoredMap} map
 */
export function toGraphml(map) {
  const { byId, elements, connections, fields } = indexMap(map);
  const pos = sharedPositions(map);
  const out = ['<?xml version="1.0" encoding="UTF-8"?>',
    '<graphml xmlns="http://graphml.graphdrawing.org/xmlns" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://graphml.graphdrawing.org/xmlns http://graphml.graphdrawing.org/xmlns/1.0/graphml.xsd">'];
  /** @param {string} id @param {string} forWhat @param {string} name @param {string} type */
  const key = (id, forWhat, name, type) => out.push(`  <key id="${xmlEscape(id)}" for="${forWhat}" attr.name="${xmlEscape(name)}" attr.type="${type}"/>`);
  key("label", "node", "label", "string");
  key("type", "node", "type", "string");
  key("description", "node", "description", "string");
  key("tags", "node", "tags", "string");
  key("x", "node", "x", "double");
  key("y", "node", "y", "double");
  key("elabel", "edge", "label", "string");
  key("etype", "edge", "type", "string");
  key("edescription", "edge", "description", "string");
  key("etags", "edge", "tags", "string");
  key("polarity", "edge", "polarity", "string");
  key("strength", "edge", "strength", "double");
  key("direction", "edge", "direction", "string");
  for (const f of fields) key(f.id, f.appliesTo === "both" ? "all" : f.appliesTo === "connection" ? "edge" : "node", f.name, graphmlType(f));
  const title = typeof map?.meta?.title === "string" ? map.meta.title : "";
  out.push(`  <graph id="G" edgedefault="directed">`);
  if (title) out.push(`    <desc>${xmlEscape(title)}</desc>`);
  /** @param {string} k @param {unknown} v */
  const data = (k, v) => (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length) ? "" : `<data key="${xmlEscape(k)}">${xmlEscape(v)}</data>`);
  /** @param {any} o @param {"element"|"connection"} kind */
  const fieldData = (o, kind) => fields.filter((f) => applies(f, kind)).map((f) => data(f.id, o.fields?.[f.id])).join("");
  for (const e of elements) {
    const p = pos.get(e.id);
    out.push(`    <node id="${xmlEscape(e.id)}">` + data("label", e.label) + data("type", e.typeId ? byId.get(e.typeId)?.name : "") +
      data("description", e.description) + data("tags", e.tags) + (p ? data("x", p.x) + data("y", p.y) : "") + fieldData(e, "element") + "</node>");
  }
  for (const c of connections) {
    const undirected = c.direction === "undirected" || c.direction === "mutual";
    out.push(`    <edge id="${xmlEscape(c.id)}" source="${xmlEscape(c.from)}" target="${xmlEscape(c.to)}"${undirected ? ' directed="false"' : ""}>` +
      data("elabel", c.label) + data("etype", c.typeId ? byId.get(c.typeId)?.name : "") + data("edescription", c.description) + data("etags", c.tags) +
      data("polarity", c.polarity === "+" || c.polarity === "-" ? c.polarity : "") + data("strength", c.strength) + data("direction", c.direction ?? "directed") +
      fieldData(c, "connection") + "</edge>");
  }
  out.push("  </graph>", "</graphml>");
  return out.join("\n") + "\n";
}

/** @param {any} f */
const gexfType = (f) => (f.kind === "number" ? "double" : f.kind === "bool" ? "boolean" : "string");

/**
 * GEXF 1.3, static: node attributes type/description/tags plus element fields, edge attributes
 * type/description/tags/polarity/direction plus connection fields; strength is the edge weight.
 * Mutual connections use GEXF's own "mutual" edge type. Shared-layout positions are written as
 * viz:position.
 * @param {StoredMap} map
 */
export function toGexf(map) {
  const { byId, elements, connections, fields } = indexMap(map);
  const pos = sharedPositions(map);
  const title = typeof map?.meta?.title === "string" ? map.meta.title : "";
  const out = ['<?xml version="1.0" encoding="UTF-8"?>',
    '<gexf xmlns="http://gexf.net/1.3" xmlns:viz="http://gexf.net/1.3/viz" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://gexf.net/1.3 http://gexf.net/1.3/gexf.xsd" version="1.3">',
    `  <meta lastmodifieddate="${new Date().toISOString().slice(0, 10)}"><creator>Cloudflare OS Network Map</creator>${title ? `<description>${xmlEscape(title)}</description>` : ""}</meta>`,
    '  <graph mode="static" defaultedgetype="directed">'];
  const nodeFields = fields.filter((f) => applies(f, "element"));
  const edgeFields = fields.filter((f) => applies(f, "connection"));
  out.push('    <attributes class="node">',
    '      <attribute id="type" title="Type" type="string"/>',
    '      <attribute id="description" title="Description" type="string"/>',
    '      <attribute id="tags" title="Tags" type="string"/>',
    ...nodeFields.map((f) => `      <attribute id="${xmlEscape(f.id)}" title="${xmlEscape(f.name)}" type="${gexfType(f)}"/>`),
    "    </attributes>",
    '    <attributes class="edge">',
    '      <attribute id="type" title="Type" type="string"/>',
    '      <attribute id="description" title="Description" type="string"/>',
    '      <attribute id="tags" title="Tags" type="string"/>',
    '      <attribute id="polarity" title="Polarity" type="string"/>',
    '      <attribute id="direction" title="Direction" type="string"/>',
    ...edgeFields.map((f) => `      <attribute id="${xmlEscape(f.id)}" title="${xmlEscape(f.name)}" type="${gexfType(f)}"/>`),
    "    </attributes>");
  /** @param {[string, unknown][]} pairs */
  const attvalues = (pairs) => {
    const vals = pairs.filter(([, v]) => !(v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)))
      .map(([k, v]) => `<attvalue for="${xmlEscape(k)}" value="${xmlEscape(v)}"/>`);
    return vals.length ? `<attvalues>${vals.join("")}</attvalues>` : "";
  };
  out.push("    <nodes>");
  for (const e of elements) {
    const p = pos.get(e.id);
    out.push(`      <node id="${xmlEscape(e.id)}" label="${xmlEscape(e.label ?? "")}">` +
      attvalues([["type", e.typeId ? byId.get(e.typeId)?.name : ""], ["description", e.description], ["tags", e.tags], ...nodeFields.map((f) => /** @type {[string, unknown]} */ ([f.id, e.fields?.[f.id]]))]) +
      (p ? `<viz:position x="${p.x}" y="${p.y}" z="0.0"/>` : "") + "</node>");
  }
  out.push("    </nodes>", "    <edges>");
  for (const c of connections) {
    const type = c.direction === "undirected" ? "undirected" : c.direction === "mutual" ? "mutual" : "directed";
    out.push(`      <edge id="${xmlEscape(c.id)}" source="${xmlEscape(c.from)}" target="${xmlEscape(c.to)}" type="${type}"` +
      (c.label ? ` label="${xmlEscape(c.label)}"` : "") + (typeof c.strength === "number" ? ` weight="${c.strength}"` : "") + ">" +
      attvalues([["type", c.typeId ? byId.get(c.typeId)?.name : ""], ["description", c.description], ["tags", c.tags],
        ["polarity", c.polarity === "+" || c.polarity === "-" ? c.polarity : ""], ["direction", c.direction ?? "directed"],
        ...edgeFields.map((f) => /** @type {[string, unknown]} */ ([f.id, c.fields?.[f.id]]))]) + "</edge>");
  }
  out.push("    </edges>", "  </graph>", "</gexf>");
  return out.join("\n") + "\n";
}
