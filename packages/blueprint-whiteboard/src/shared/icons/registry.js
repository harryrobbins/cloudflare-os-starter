// @ts-check
// Icon and stencil packs: lookup by stable id, search, default sizes and styles, and the geometry
// the shared renderer draws. The data is src/shared/generated/icon-packs.js, compiled at build time
// by scripts/build-icon-packs.mjs from pinned sources; nothing here parses SVG or fetches anything.
//
// Ids: a pack id is "<name>.<version>" (e.g. "tabler.1"), an icon id is kebab-case within its pack
// (e.g. "database"). A published (packId, iconId) keeps resolving to the same geometry forever; a
// materially changed glyph ships in a new pack version (the build enforces this with a ledger).
//
// Kinds: "stencil" packs (diagram shapes) stretch to the object's box, take its fill colour, hold
// text and draw lines in world units like a rectangle. "glyph" packs (symbols) keep their aspect
// ratio inside the box, draw in the object's line colour at a line width in the icon's own units
// (so it scales with the icon), and hold no text; a fill colour draws a rounded tile behind them.

import { ICON_PACKS } from "../generated/icon-packs.js";

/**
 * @typedef {object} IconDef
 * @property {string} id
 * @property {string} label
 * @property {string} category
 * @property {string[]} tags
 * @property {[number, number]} vb
 * @property {[string, string][]} shapes  [paint, pathData]; see the generated module's header
 * @property {[number, number, number, number]} [textBox]  fractions of the box
 */

/**
 * @typedef {object} IconPack
 * @property {string} id
 * @property {string} name
 * @property {"stencil"|"glyph"} kind
 * @property {Record<string, any>} source
 * @property {{spdx: string, copyright: string, text?: string}} licence
 * @property {{id: string, label: string}[]} categories
 * @property {IconDef[]} icons
 */

/**
 * An icon with its pack, as returned by lookups.
 * @typedef {IconDef & {pack: IconPack, packId: string, kind: "stencil"|"glyph"}} IconEntry
 */

/**
 * What findIcons and the picker expose (no geometry).
 * @typedef {object} IconSummary
 * @property {string} packId
 * @property {string} iconId
 * @property {string} label
 * @property {string} category        category id within the pack
 * @property {string} categoryLabel
 * @property {string[]} tags
 * @property {"stencil"|"glyph"} kind
 * @property {number} aspect          intrinsic width / height
 * @property {boolean} text           whether the icon holds text
 */

export const PACK_ID_RE = /^[a-z][a-z0-9-]{0,31}\.[0-9]{1,4}$/;
export const ICON_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Default size of a glyph icon's longer side, in world units. */
export const GLYPH_SIZE = 96;
/** Line width a new icon gets (world units for stencils, icon units for glyphs). */
export const DEFAULT_ICON_STROKE = 2;
/** Default ink when an icon's line colour is "none" but it must draw something. */
export const DEFAULT_INK = "#1f2937";

/** @type {readonly IconPack[]} */
export const PACKS = /** @type {any} */ (ICON_PACKS);

/** @type {Map<string, IconEntry>} */
const BY_KEY = new Map();
/** @type {IconEntry[]} */
const ALL = [];
for (const pack of PACKS) {
  for (const icon of pack.icons) {
    const entry = /** @type {IconEntry} */ (Object.freeze({ ...icon, pack, packId: pack.id, kind: pack.kind }));
    BY_KEY.set(pack.id + "/" + icon.id, entry);
    ALL.push(entry);
  }
}

/** @param {unknown} v @returns {v is string} */
export const isPackId = (v) => typeof v === "string" && PACK_ID_RE.test(v);
/** @param {unknown} v @returns {v is string} */
export const isIconId = (v) => typeof v === "string" && ICON_ID_RE.test(v);

/**
 * @param {unknown} packId @param {unknown} iconId
 * @returns {IconEntry|null}
 */
export function getIcon(packId, iconId) {
  if (!isPackId(packId) || !isIconId(iconId)) return null;
  return BY_KEY.get(packId + "/" + iconId) ?? null;
}

/** @param {unknown} packId @returns {IconPack|null} */
export function getPack(packId) {
  return PACKS.find((p) => p.id === packId) ?? null;
}

/**
 * Resolves a caller's reference: {packId, iconId}, "pack/icon", or a bare icon id (first pack that
 * has it, in pack order).
 * @param {unknown} ref
 * @returns {IconEntry|null}
 */
export function resolveIcon(ref) {
  if (typeof ref === "string") {
    const slash = ref.indexOf("/");
    if (slash > 0) return getIcon(ref.slice(0, slash), ref.slice(slash + 1));
    return ALL.find((e) => e.id === ref) ?? null;
  }
  if (ref && typeof ref === "object") {
    const r = /** @type {any} */ (ref);
    const iconId = r.iconId ?? r.id;
    if (r.packId !== undefined && r.packId !== null) return getIcon(r.packId, iconId);
    return typeof iconId === "string" ? resolveIcon(iconId) : null;
  }
  return null;
}

/** Every icon in pack order. @returns {readonly IconEntry[]} */
export function allIcons() {
  return ALL;
}

/** @param {IconEntry} e @returns {IconSummary} */
export function iconSummary(e) {
  return {
    packId: e.packId, iconId: e.id, label: e.label, category: e.category,
    categoryLabel: e.pack.categories.find((c) => c.id === e.category)?.label ?? e.category,
    tags: [...e.tags], kind: e.kind, aspect: Math.round((e.vb[0] / e.vb[1]) * 1000) / 1000, text: !!e.textBox,
  };
}

/**
 * Size and style a new object of this icon gets.
 * @param {IconEntry} e
 * @returns {{w: number, h: number, style: {fill: string, stroke: string, strokeWidth: number, textColor: string, fontSize: number, align: "center"}}}
 */
export function iconDefaults(e) {
  const [vw, vh] = e.vb;
  const stencil = e.kind === "stencil";
  const scale = stencil ? 1 : GLYPH_SIZE / Math.max(vw, vh);
  return {
    w: Math.round(vw * scale * 100) / 100, h: Math.round(vh * scale * 100) / 100,
    style: {
      fill: stencil ? "#ffffff" : "none", stroke: DEFAULT_INK, strokeWidth: DEFAULT_ICON_STROKE,
      textColor: DEFAULT_INK, fontSize: 18, align: "center",
    },
  };
}

/**
 * A size keeping the icon's aspect ratio with its longer side `size`.
 * @param {IconEntry} e @param {number} size
 */
export function sizeFor(e, size) {
  const [vw, vh] = e.vb;
  const k = size / Math.max(vw, vh);
  return { w: Math.round(vw * k * 100) / 100, h: Math.round(vh * k * 100) / 100 };
}

/**
 * Text box of an icon object in world units (unrotated), or null when its icon holds no text.
 * @param {{packId?: string, iconId?: string, x: number, y: number, w: number, h: number}} o
 */
export function iconTextBox(o) {
  const e = getIcon(o.packId, o.iconId);
  if (!e?.textBox) return null;
  const [fx, fy, fw, fh] = e.textBox;
  return { x: o.x + o.w * fx, y: o.y + o.h * fy, w: o.w * fw, h: o.h * fh };
}

/**
 * Where the icon's view box lands inside the object's box: stretched for stencils, centred at its
 * aspect ratio ("contain") for glyphs. `sx`, `sy` scale view box units to world units.
 * @param {IconEntry} e @param {{x: number, y: number, w: number, h: number}} box
 * @returns {{x: number, y: number, w: number, h: number, sx: number, sy: number}}
 */
export function iconPlacement(e, box) {
  const [vw, vh] = e.vb;
  if (e.kind === "stencil") return { x: box.x, y: box.y, w: box.w, h: box.h, sx: box.w / vw, sy: box.h / vh };
  const s = Math.min(box.w / vw, box.h / vh);
  const w = vw * s, h = vh * s;
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h, sx: s, sy: s };
}

const TOKEN_RE = /[MLCZ]|-?(?:[0-9]+\.?[0-9]*|\.[0-9]+)/g;
const ARITY = /** @type {Record<string, number>} */ ({ M: 2, L: 2, C: 6, Z: 0 });

/**
 * Compiled path data as commands and flat coordinates. Throws on anything outside the compiled
 * format (absolute M, L, C, Z and plain numbers), so corrupt data never reaches the renderer.
 * @param {string} d
 * @returns {{cmds: string[], nums: number[]}}
 */
export function parseCompiledPath(d) {
  /** @type {string[]} */
  const cmds = [];
  /** @type {number[]} */
  const nums = [];
  if (typeof d !== "string" || /[^MLCZ0-9.\- ]/.test(d)) throw new Error("bad compiled path");
  let need = 0;
  for (const m of d.matchAll(TOKEN_RE)) {
    const t = m[0];
    if (Object.hasOwn(ARITY, t)) {
      if (need) throw new Error("bad compiled path");
      cmds.push(t);
      need = ARITY[t];
    } else {
      if (!need) throw new Error("bad compiled path");
      const v = Number(t);
      if (!Number.isFinite(v)) throw new Error("bad compiled path");
      nums.push(v);
      need--;
    }
  }
  if (need || cmds[0] !== "M") throw new Error("bad compiled path");
  return { cmds, nums };
}

/** @type {WeakMap<IconEntry, {paint: string, cmds: string[], nums: number[]}[]>} */
const PARSED = new WeakMap();

/**
 * The icon's shapes, parsed once and cached.
 * @param {IconEntry} e
 */
export function iconPaths(e) {
  let parsed = PARSED.get(e);
  if (!parsed) {
    parsed = e.shapes.map(([paint, d]) => ({ paint, ...parseCompiledPath(d) }));
    PARSED.set(e, parsed);
  }
  return parsed;
}

// ---------------------------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------------------------

/** @param {string} s */
const words = (s) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** @param {string} needle @param {string} hay  true when needle's letters appear in order in hay */
function subsequence(needle, hay) {
  let i = 0;
  for (let k = 0; k < hay.length && i < needle.length; k++) if (hay[k] === needle[i]) i++;
  return i === needle.length;
}

/** @type {WeakMap<IconEntry, {id: string, idWords: string[], labelWords: string[], tags: string[], tagWords: string[], category: string[]}>} */
const SEARCH = new WeakMap();

/** @param {IconEntry} e */
function searchFields(e) {
  let f = SEARCH.get(e);
  if (!f) {
    const cat = e.pack.categories.find((c) => c.id === e.category);
    f = {
      id: e.id, idWords: words(e.id), labelWords: words(e.label), tags: e.tags.map((t) => t.toLowerCase()),
      tagWords: e.tags.flatMap(words), category: [...words(e.category), ...words(cat?.label ?? ""), ...words(e.pack.name)],
    };
    SEARCH.set(e, f);
  }
  return f;
}

/**
 * Score of one query word against an icon: 0 when it does not match at all.
 * @param {string} q @param {ReturnType<typeof searchFields>} f
 */
function wordScore(q, f) {
  if (f.id === q) return 100;
  let best = 0;
  if (f.idWords.includes(q) || f.labelWords.includes(q)) best = 60;
  else if (f.idWords.some((w) => w.startsWith(q)) || f.labelWords.some((w) => w.startsWith(q))) best = 40;
  if (best < 30 && (f.tags.includes(q) || f.tagWords.includes(q))) best = 30;
  if (best < 20 && f.tagWords.some((w) => w.startsWith(q))) best = 20;
  if (best < 12 && f.category.some((w) => w === q || w.startsWith(q))) best = 12;
  if (best < 8 && q.length >= 3 && (f.id.includes(q) || f.tags.some((t) => t.includes(q)))) best = 8;
  if (best < 2 && q.length >= 3 && subsequence(q, f.id)) best = 2;
  return best;
}

/**
 * Searches every pack (or one). Every query word must match (id, label, tags, category or pack
 * name; prefixes and, for longer words, in-order letters of the id count). An empty query lists
 * icons in pack order. Results are best first; ties keep pack order.
 * @param {unknown} query
 * @param {{packId?: unknown, category?: unknown, limit?: unknown}} [opts]  limit: 1..500, default 20
 * @returns {IconEntry[]}
 */
export function searchIcons(query, { packId, category, limit } = {}) {
  const max = typeof limit === "number" && Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.trunc(limit))) : 20;
  const q = typeof query === "string" ? words(query.slice(0, 200)).slice(0, 8) : [];
  /** @type {{e: IconEntry, score: number, i: number}[]} */
  const hits = [];
  ALL.forEach((e, i) => {
    if (packId !== undefined && packId !== null && packId !== "" && e.packId !== packId) return;
    if (category !== undefined && category !== null && category !== "" && e.category !== category) return;
    let score = 0;
    const f = searchFields(e);
    for (const w of q) {
      const s = wordScore(w, f);
      if (!s) return;
      score += s;
    }
    hits.push({ e, score, i });
  });
  hits.sort((a, b) => b.score - a.score || a.i - b.i);
  return hits.slice(0, max).map((h) => h.e);
}
