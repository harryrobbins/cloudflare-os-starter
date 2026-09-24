// @ts-check
// Compiles the "Emoji & symbols" data for the icon picker into one checked-in, client-only module:
//
//   src/client/generated/unicode-data.js   every current emoji with its CLDR name (British English),
//                                          group, subgroup, keywords and skin tone template, plus
//                                          the curated symbols (./symbols.mjs) with their Unicode
//                                          names, and the licence texts of both sources
//
// Called by scripts/build-icon-packs.mjs, which writes it (or, with --check, compares it) together
// with the icon packs and THIRD_PARTY_NOTICES.md. Reads only the pinned emojibase-data files named
// below; the installed version must match. Deterministic: same sources, same bytes.
//
// Nothing here reaches the server bundle: emoji are plain text on the board, so the server needs
// no emoji data (src/shared/graphemes.js keeps multi-code-point emoji whole on both sides).

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SYMBOL_GROUPS, SYMBOL_NAMES_UNICODE_VERSION } from "./symbols.mjs";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "../..");

export const UNICODE_OUTPUT = join(pkg, "src/client/generated/unicode-data.js");

/** The pinned emoji dataset. */
export const EMOJI_SOURCE = Object.freeze({
  package: "emojibase-data",
  version: "17.0.0",
  url: "https://github.com/milesj/emojibase",
  /** Emoji version the dataset covers (Unicode Emoji 17.0, September 2025). */
  emojiVersion: "17.0",
  /** Names and keywords: CLDR annotations for British English, plus the US English ones as keywords. */
  locale: "en-gb",
  files: ["en-gb/data.json", "en-gb/messages.json", "en/data.json"],
});

/** Size budget of the generated module (client bundle only). */
export const UNICODE_BUDGET_BYTES = 200 * 1024;
const MAX_KEYWORDS = 12;
/** The light skin tone modifier: a skin tone template holds it where a tone goes. */
export const TONE_PLACEHOLDER = "\u{1F3FB}";

/** emojibase group key -> the picker's category id and label. "component" (bare skin tones and hair styles) is left out. */
const GROUPS = /** @type {Record<string, {id: string, label: string}>} */ ({
  "smileys-emotion": { id: "smileys", label: "Smileys & emotion" },
  "people-body": { id: "people", label: "People & body" },
  "animals-nature": { id: "nature", label: "Animals & nature" },
  "food-drink": { id: "food", label: "Food & drink" },
  "travel-places": { id: "travel", label: "Travel & places" },
  activities: { id: "activities", label: "Activities" },
  objects: { id: "objects", label: "Objects" },
  symbols: { id: "symbols", label: "Symbols" },
  flags: { id: "flags", label: "Flags" },
});

/** @param {string} hexcode "1F468-200D-1F469" */
export const fromHexcode = (hexcode) => String.fromCodePoint(...hexcode.split("-").map((x) => parseInt(x, 16)));

/** Lower-case words of a name, for dropping keywords that repeat it. @param {string} s */
const words = (s) => s.toLowerCase().split(/[^\p{L}\p{N}+]+/u).filter(Boolean);

/**
 * Keywords worth keeping: lower-case, unique, not a word of the name, at most MAX_KEYWORDS.
 * @param {string} name @param {unknown[]} raw
 */
export function cleanKeywords(name, raw) {
  const nameWords = new Set(words(name));
  /** @type {string[]} */
  const out = [];
  for (const t of raw) {
    const k = String(t).trim().toLowerCase().replace(/\s+/g, " ");
    if (!k || k.includes(",") || k.length > 32 || nameWords.has(k) || k === name.toLowerCase() || out.includes(k)) continue;
    out.push(k);
    if (out.length >= MAX_KEYWORDS) break;
  }
  return out;
}

/**
 * The skin tone template of an emoji: its light-skin-tone form (every person in it light), in
 * which each U+1F3FB is where the chosen tone's modifier goes. Null when it takes no skin tone.
 * @param {any} e emojibase entry
 */
export function skinTemplate(e) {
  if (!Array.isArray(e.skins)) return null;
  const light = e.skins.find((/** @type {any} */ s) => s.tone === 1 || (Array.isArray(s.tone) && s.tone.every((/** @type {number} */ t) => t === 1)));
  return light ? fromHexcode(light.hexcode) : null;
}

async function readSource() {
  const root = join(pkg, "node_modules", EMOJI_SOURCE.package);
  const installed = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (installed.version !== EMOJI_SOURCE.version) {
    throw new Error(`${EMOJI_SOURCE.package} ${installed.version} is installed but the build pins ${EMOJI_SOURCE.version}; run pnpm install`);
  }
  const hash = createHash("sha256");
  /** @type {Record<string, any>} */
  const files = {};
  for (const f of EMOJI_SOURCE.files) {
    const bytes = await readFile(join(root, f));
    hash.update(f).update("\0").update(bytes).update("\0");
    files[f] = JSON.parse(bytes.toString("utf8"));
  }
  const licence = (await readFile(join(root, "LICENSE"), "utf8")).trim();
  const unicodeLicence = (await readFile(join(pkg, "scripts/unicode/UNICODE-LICENSE-V3.txt"), "utf8")).trim();
  return { files, licence, unicodeLicence, sha256: hash.digest("hex") };
}

/**
 * Compiles the emoji and symbol groups. Pure apart from reading the pinned files.
 */
export async function compileUnicode() {
  const src = await readSource();
  const gb = /** @type {any[]} */ (src.files["en-gb/data.json"]);
  const us = new Map(/** @type {any[]} */ (src.files["en/data.json"]).map((e) => [e.hexcode, e]));
  const messages = src.files["en-gb/messages.json"];
  /** @type {Map<number, any>} */
  const groupByOrder = new Map(messages.groups.map((/** @type {any} */ g) => [g.order, g]));
  /** @type {Map<number, any>} */
  const subByOrder = new Map(messages.subgroups.map((/** @type {any} */ g) => [g.order, g]));

  /** @type {Map<string, {id: string, label: string, subgroups: Map<string, {id: string, label: string, emoji: any[]}>}>} */
  const groups = new Map();
  for (const key of Object.keys(GROUPS)) groups.set(key, { ...GROUPS[key], subgroups: new Map() });
  let count = 0, toned = 0;
  const seen = new Set();
  for (const e of gb.toSorted((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity))) {
    if (typeof e.group !== "number") continue; // bare regional indicators
    const g = groupByOrder.get(e.group);
    const group = g && groups.get(g.key);
    if (!group) continue; // components
    const sub = subByOrder.get(e.subgroup);
    if (!sub) throw new Error(`emoji ${e.hexcode}: unknown subgroup ${e.subgroup}`);
    // The fully-qualified form: a lone code point that defaults to text presentation (such as
    // U+2764 HEAVY BLACK HEART) takes U+FE0F so it shows as an emoji.
    const char = fromHexcode(e.hexcode) + (e.type === 0 && !e.hexcode.includes("-") ? "\uFE0F" : "");
    if (seen.has(char)) throw new Error(`duplicate emoji ${e.hexcode}`);
    seen.add(char);
    const name = String(e.label).trim();
    const usEntry = us.get(e.hexcode);
    const keywords = cleanKeywords(name, [
      ...(e.tags ?? []),
      ...(usEntry && usEntry.label !== e.label ? [usEntry.label] : []),
      ...(usEntry?.tags ?? []),
    ]);
    const entry = [char, name, keywords.join(",")];
    const template = skinTemplate(e);
    if (template) { entry.push(template); toned++; }
    let s = group.subgroups.get(sub.key);
    if (!s) group.subgroups.set(sub.key, s = { id: sub.key, label: sub.message, emoji: [] });
    s.emoji.push(entry);
    count++;
  }
  const emoji = [...groups.values()].map((g) => ({
    id: g.id, label: g.label,
    subgroups: [...g.subgroups.values()].map((s) => [s.id, s.label, s.emoji]),
  }));

  const seenSymbols = new Set();
  const symbols = SYMBOL_GROUPS.map((g) => ({
    id: g.id, label: g.label,
    symbols: g.symbols.map(([ch, name, extra]) => {
      if (!ch || seenSymbols.has(ch)) throw new Error(`symbols: bad or duplicate ${JSON.stringify(ch)}`);
      if (!/^[A-Z0-9 -]+$/.test(name)) throw new Error(`symbols: ${JSON.stringify(ch)} needs its Unicode name`);
      seenSymbols.add(ch);
      const lower = name.toLowerCase();
      return [ch, lower, cleanKeywords(lower, extra.split(" ").filter(Boolean)).join(",")];
    }),
  }));
  const symbolCount = symbols.reduce((n, g) => n + g.symbols.length, 0);
  return {
    emoji, symbols, count, toned, symbolCount,
    source: {
      package: EMOJI_SOURCE.package, version: EMOJI_SOURCE.version, url: EMOJI_SOURCE.url,
      emojiVersion: EMOJI_SOURCE.emojiVersion, locale: EMOJI_SOURCE.locale, sha256: src.sha256,
      symbolNamesUnicodeVersion: SYMBOL_NAMES_UNICODE_VERSION,
    },
    licence: src.licence,
    unicodeLicence: src.unicodeLicence,
  };
}

/** @param {Awaited<ReturnType<typeof compileUnicode>>} data */
export function renderUnicodeModule(data) {
  const lines = [
    "// Generated by scripts/build-icon-packs.mjs (scripts/unicode/build-unicode.mjs) from pinned sources.",
    "// Do not edit: change scripts/unicode/*.mjs and run `node scripts/build-icon-packs.mjs`.",
    "// Inert data only, client-only. EMOJI_GROUPS: {id, label, subgroups: [[id, label, emoji]]}; each",
    "// emoji is [text, CLDR name, comma-separated keywords, skin tone template?] where the template is",
    "// the light-skin-tone form with U+1F3FB wherever a skin tone modifier goes. SYMBOL_GROUPS: {id,",
    "// label, symbols: [[text, Unicode name (lower case), keywords]]}. Read through src/client/ui/unicode.js.",
    "",
    `export const UNICODE_SOURCE = ${JSON.stringify(data.source)};`,
    "",
    "export const EMOJI_GROUPS = [",
  ];
  for (const g of data.emoji) {
    lines.push(`  {"id":${JSON.stringify(g.id)},"label":${JSON.stringify(g.label)},"subgroups":[`);
    for (const [id, label, emoji] of g.subgroups) {
      lines.push(`    [${JSON.stringify(id)},${JSON.stringify(label)},[`);
      for (const e of emoji) lines.push(`      ${JSON.stringify(e)},`);
      lines.push("    ]],");
    }
    lines.push("  ]},");
  }
  lines.push("];", "", "export const SYMBOL_GROUPS = [");
  for (const g of data.symbols) {
    lines.push(`  {"id":${JSON.stringify(g.id)},"label":${JSON.stringify(g.label)},"symbols":[`);
    for (const s of g.symbols) lines.push(`    ${JSON.stringify(s)},`);
    lines.push("  ]},");
  }
  lines.push(
    "];",
    "",
    `export const UNICODE_LICENCES = ${JSON.stringify({ emojibase: data.licence, unicode: data.unicodeLicence })};`,
    "",
  );
  return lines.join("\n");
}

/** The THIRD_PARTY_NOTICES.md section for the emoji data. @param {Awaited<ReturnType<typeof compileUnicode>>} data */
export function renderUnicodeNotice(data) {
  return [
    `## Emoji names and keywords (${data.source.package})`,
    "",
    `- Source: [${data.source.package}@${data.source.version}](${data.source.url}), Emoji ${data.source.emojiVersion}, locale \`${data.source.locale}\`; ${data.count} emoji`,
    `- Source files SHA-256: \`${data.source.sha256}\``,
    "- Licence: MIT (the dataset); its names and keywords are derived from the Unicode CLDR annotations",
    "  and the Unicode emoji data files, Unicode-3.0 (below). The curated symbols' names are from the",
    `  Unicode Character Database (Unicode ${data.source.symbolNamesUnicodeVersion}), Unicode-3.0.`,
    "- No emoji images are shipped: emoji are drawn by the viewer's system font.",
    "",
    "```text",
    data.licence,
    "```",
    "",
    "```text",
    data.unicodeLicence,
    "```",
    "",
  ].join("\n");
}

/**
 * Builds the module in memory.
 */
export async function buildUnicode() {
  const data = await compileUnicode();
  const text = renderUnicodeModule(data);
  const bytes = Buffer.byteLength(text);
  if (bytes > UNICODE_BUDGET_BYTES) throw new Error(`generated unicode data is ${bytes} bytes; the budget is ${UNICODE_BUDGET_BYTES}`);
  return { data, text, bytes, notice: renderUnicodeNotice(data) };
}
