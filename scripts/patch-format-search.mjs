#!/usr/bin/env node
// Patches upstream's bundled Docs, Sheets and Slides so each instance pushes its text to
// omni-search (docs/plans/omni-search.md, "Bundled Docs, Sheets and Slides").
//
//   node scripts/patch-format-search.mjs            patch upstream's pairs into formats/
//   node scripts/patch-format-search.mjs --check    exit 1 if formats/ is not what a patch would give
//   --from <dir>  --to <dir>                        override the source / destination directories
//
// Source: cloudflare-os/packages/workshop-backend/format-blueprints/<name>.{gadget,json}, the pristine
// upstream pairs. Destination: formats/<name>.{gadget,json}. Re-run it after re-copying or bumping
// the submodule (docs/customization.md, "Bundled formats").
//
// What it injects into each server.js:
//   * a hook on every content mutation (Docs/Sheets: the mutation queue every write goes through;
//     Slides: #broadcast, which every save, undo and redo calls) and on subscribe (so an instance
//     that was wired after it was last edited is indexed the next time someone opens it);
//   * a debounced push (3 s quiet, at most 30 s behind a continuous edit) that reads the stored
//     document, extracts plain text and calls `env.SEARCH.put({externalId, kind, title, body,
//     updatedAt})`. It does nothing unless `typeof env.SEARCH !== "undefined"`, runs outside the
//     save path, and catches everything, so indexing can never fail or delay a save.
//
// The SEARCH binding is not declared in the archive's BlueprintBinding metadata: the platform has
// no optional binding, and any declared binding makes New route through blueprint setup, so every
// new Doc would demand a search connection. The agent wires the ambient Search capsule into a
// gadget with setGadgetBinding (overseer.ts, "Singleton gatekeepers ... provisioned as ambient
// capsules"), or a person binds it from Connections.
//
// None of the formats has a whole-document delete (deleting the gadget happens in the Overseer and
// never reaches gadget code), so `remove()` is never called; clearing a document re-pushes it empty.
//
// Revision: the sidecar and archive `revision`/`version` become upstream revision * 100 +
// PATCH_VERSION, so a patched pair never shares a revision with any upstream one (a deployment
// reinstalls on any revision change) and still rises when upstream bumps. Bump PATCH_VERSION
// whenever the injected code changes.
//
// Refuses, naming the format and anchor, when an anchor it patches or a name the injected code
// relies on is missing or ambiguous, so an upstream change is loud rather than silently unindexed.
// On an archive that already carries this patch version it is a no-op.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeContent, parseArchive, serializeArchive } from "../packages/blueprint-kanban/scripts/archive.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const UPSTREAM_DIR = join(repo, "cloudflare-os/packages/workshop-backend/format-blueprints");
export const FORMATS_DIR = join(repo, "formats");

/** Bump when the injected code changes; it is part of the revision. At most 99. */
export const PATCH_VERSION = 1;
export const MARKER = "cfos-search-push";
const MARKER_LINE = new RegExp(`// ${MARKER} v(\\d+)`);

// ---------------------------------------------------------------------------
// Injected code
// ---------------------------------------------------------------------------

/** Shared by all three formats. `__cfosSearchExtract(storage)` is appended per format. */
function runtime(kind) {
  return `

// ---------------------------------------------------------------------------
// ${MARKER} v${PATCH_VERSION}: injected by scripts/patch-format-search.mjs (cloudflare-os-starter).
// When this gadget's env has a SEARCH binding (the omni-search capsule, wired in with
// setGadgetBinding), its text is pushed to search a few seconds after each change. Unbound
// instances do nothing. Best-effort by design: it runs outside the save path and every step is
// caught, so indexing can never fail or delay a save.
// ---------------------------------------------------------------------------
const __CFOS_SEARCH = {
  kind: ${JSON.stringify(kind)},
  idKey: "cfos-search:externalId",
  debounceMs: 3000,
  maxWaitMs: 30000,
  timeoutMs: 20000,
  maxTitle: 300,
  maxBody: 200000,
};

function __cfosSearchSchedule(gadget, reason) {
  try {
    const env = gadget.env;
    if (!env || typeof env.SEARCH === "undefined") return;
    const s = gadget.__cfosSearch ||
      (gadget.__cfosSearch = { timer: null, since: null, running: false, again: false, last: null });
    const now = Date.now();
    if (s.since === null) s.since = now;
    if (s.timer) clearTimeout(s.timer);
    const wait = Math.max(0, Math.min(__CFOS_SEARCH.debounceMs, s.since + __CFOS_SEARCH.maxWaitMs - now));
    s.timer = setTimeout(() => {
      s.timer = null;
      s.since = null;
      __cfosSearchFlush(gadget).catch(() => {});
    }, wait);
  } catch (err) {
    // Never let indexing reach the caller; \`reason\` ("edit", "open") is for debugging only.
  }
}

async function __cfosSearchFlush(gadget) {
  const s = gadget.__cfosSearch;
  if (s.running) { s.again = true; return; }
  s.running = true;
  let timer = null;
  try {
    const env = gadget.env;
    if (!env || typeof env.SEARCH === "undefined") return;
    const storage = gadget.ctx.storage;
    const extracted = await __cfosSearchExtract(storage);
    if (!extracted) return;
    let externalId = await storage.get(__CFOS_SEARCH.idKey);
    // A blank or untouched instance is not worth a search result until someone writes in it.
    if (!externalId && extracted.trivial) return;
    const title = String(extracted.title || "").slice(0, __CFOS_SEARCH.maxTitle);
    const body = String(extracted.body || "").slice(0, __CFOS_SEARCH.maxBody);
    const fingerprint = title + "\\n" + body;
    if (fingerprint === s.last) return;
    if (!externalId) {
      // Gadget code cannot see its own workpiece id, and one search account spans every workspace
      // of its owner, so each instance mints a stable id of its own on first push.
      externalId = __CFOS_SEARCH.kind + ":" + crypto.randomUUID();
      await storage.put(__CFOS_SEARCH.idKey, externalId);
    }
    await Promise.race([
      env.SEARCH.put({
        externalId,
        kind: __CFOS_SEARCH.kind,
        title,
        body,
        updatedAt: Number(extracted.updatedAt) || Date.now(),
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("SEARCH.put timed out")), __CFOS_SEARCH.timeoutMs);
      }),
    ]);
    s.last = fingerprint;
  } catch (err) {
    try { console.warn("[${MARKER}] not indexed:", String((err && err.message) || err)); } catch {}
  } finally {
    if (timer) clearTimeout(timer);
    s.running = false;
    if (s.again) { s.again = false; __cfosSearchSchedule(gadget, "again"); }
  }
}

function __cfosSearchHtmlText(html) {
  return String(html == null ? "" : html)
    .replace(/<(script|style)\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>/gi, " ")
    .replace(/<br\\s*\\/?>/gi, "\\n")
    .replace(/<\\/(p|div|h[1-6]|li|tr|blockquote|pre|ul|ol|table)\\s*>/gi, "\\n")
    .replace(/<\\/(td|th)\\s*>/gi, "\\t")
    .replace(/<!--[\\s\\S]*?-->|<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, entity) => {
      const lower = entity.toLowerCase();
      const code = lower.startsWith("#x") ? parseInt(lower.slice(2), 16)
        : lower.startsWith("#") ? parseInt(lower.slice(1), 10) : -1;
      if (code >= 0) return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
      return { amp: "&", lt: "<", gt: ">", quot: "\\"", apos: "'", nbsp: " " }[lower] || whole;
    })
    .replace(/[ \\t\\f\\v\\u00a0]+/g, " ")
    .replace(/ ?\\n ?/g, "\\n")
    .replace(/\\n{3,}/g, "\\n\\n")
    .trim();
}
`;
}

const EXTRACT_DOCS = `
// Docs: "document:v2" -> { title, blocks: [{ id, html }], lastModified }. A legacy (pre-v2) document
// is skipped; its first v2 client converts it, which is itself a mutation and triggers a push.
async function __cfosSearchExtract(storage) {
  const doc = await storage.get("document:v2");
  if (!doc || !Array.isArray(doc.blocks)) return null;
  const title = String(doc.title || "").trim() || "Untitled document";
  const body = doc.blocks.map((block) => __cfosSearchHtmlText(block && block.html))
    .filter(Boolean).join("\\n\\n");
  return {
    title,
    body,
    updatedAt: doc.lastModified,
    trivial: !body && title === "Untitled document",
  };
}
`;

const EXTRACT_SHEETS = `
// Sheets: "meta" -> { title, sheetOrder, sheets: { id: { name } }, lastModified },
// "cells:<id>" -> { A1: { value } }. Each sheet becomes "## <name>" then one line per row, its
// non-empty cells joined by " | ". Formulas are skipped (only their source text is stored).
// Capped at 20,000 cells and 500 characters a cell; the body cap applies on top.
async function __cfosSearchExtract(storage) {
  const meta = await storage.get("meta");
  if (!meta || !Array.isArray(meta.sheetOrder)) return null;
  const title = String(meta.title || "").trim() || "Untitled spreadsheet";
  const maxCells = 20000;
  const parts = [];
  let seen = 0;
  let size = 0;
  for (const sheetId of meta.sheetOrder) {
    if (seen >= maxCells || size >= __CFOS_SEARCH.maxBody) break;
    const cells = (await storage.get("cells:" + sheetId)) || {};
    const rows = new Map();
    for (const [ref, cell] of Object.entries(cells)) {
      if (++seen > maxCells) break;
      let value = cell && cell.value != null ? String(cell.value).trim() : "";
      if (!value || value.startsWith("=")) continue;
      const match = /^([A-Z]+)([0-9]+)$/.exec(ref);
      if (!match) continue;
      let column = 0;
      for (const ch of match[1]) column = column * 26 + ch.charCodeAt(0) - 64;
      const row = Number(match[2]);
      if (value.length > 500) value = value.slice(0, 500) + "…";
      if (!rows.has(row)) rows.set(row, []);
      rows.get(row).push([column, value.replace(/\\s+/g, " ")]);
    }
    if (!rows.size) continue;
    const name = String((meta.sheets && meta.sheets[sheetId] && meta.sheets[sheetId].name) || "Sheet");
    const lines = ["## " + name];
    for (const row of [...rows.keys()].sort((a, b) => a - b)) {
      lines.push(rows.get(row).sort((a, b) => a[0] - b[0]).map((entry) => entry[1]).join(" | "));
    }
    const text = lines.join("\\n");
    parts.push(text);
    size += text.length;
  }
  const body = parts.join("\\n\\n");
  return {
    title,
    body,
    updatedAt: meta.lastModified,
    trivial: !body && title === "Untitled spreadsheet",
  };
}
`;

const EXTRACT_SLIDES = `
// Slides: "deck" -> { slides: [{ blocks: [{ type, props }] }] }. The deck has no title of its own,
// so it is the first slide title. Each slide becomes "Slide N: <title>" then its blocks' text
// props. The untouched starter deck (initialDeck()) counts as blank.
const __CFOS_SEARCH_TEXT_PROPS = ["eyebrow", "title", "text", "body", "label", "alt"];
async function __cfosSearchExtract(storage) {
  const deck = await storage.get("deck");
  if (!deck || !Array.isArray(deck.slides)) return null;
  const clean = (value) => __cfosSearchHtmlText(value).replace(/\\s*\\n\\s*/g, " ").trim();
  const lines = [];
  let deckTitle = "";
  deck.slides.forEach((slide, index) => {
    const blocks = Array.isArray(slide && slide.blocks) ? slide.blocks : [];
    const titleBlock = blocks.find((b) => b && b.type === "title" && b.props && clean(b.props.text));
    const slideTitle = titleBlock ? clean(titleBlock.props.text) : "";
    if (!deckTitle && slideTitle) deckTitle = slideTitle;
    const texts = [];
    for (const block of blocks) {
      if (!block || block === titleBlock || !block.props || typeof block.props !== "object") continue;
      if (block.type === "logo") continue;
      for (const key of __CFOS_SEARCH_TEXT_PROPS) {
        const value = block.props[key];
        if (typeof value !== "string") continue;
        const text = key === "text" || key === "body" ? __cfosSearchHtmlText(value) : clean(value);
        if (text) texts.push(text);
      }
    }
    lines.push("Slide " + (index + 1) + (slideTitle ? ": " + slideTitle : "") +
      (texts.length ? "\\n" + texts.join("\\n") : ""));
  });
  let trivial = false;
  try { trivial = JSON.stringify(deck.slides) === JSON.stringify(initialDeck().slides); } catch {}
  return {
    title: deckTitle || "Untitled deck",
    body: lines.join("\\n\\n"),
    updatedAt: Date.now(),
    trivial,
  };
}
`;

const HOOK = (reason) => `    __cfosSearchSchedule(this, "${reason}"); // ${MARKER}\n`;
const MUTATION_QUEUE_ANCHOR = "  enqueueMutation(fn) {\n    const result = this.mutationQueue.then(fn);\n    this.mutationQueue = result.catch(() => {});\n";
const MUTATION_QUEUE_HOOK =
  `    result.then(() => __cfosSearchSchedule(this, "edit"), () => {}); // ${MARKER}\n`;

/**
 * Per format: the anchors it inserts after (each must occur exactly once), the text the injected
 * code relies on (each must occur at least once), and the extractor.
 */
export const FORMATS = {
  "workspace-docs": {
    kind: "doc",
    hooks: [
      { anchor: MUTATION_QUEUE_ANCHOR, insert: MUTATION_QUEUE_HOOK },
      { anchor: "  async subscribe(callback, client = {}) {\n", insert: HOOK("open") },
    ],
    requires: [
      'const DEFAULT_TITLE = "Untitled document";',
      'this.ctx.storage.put("document:v2", ',
      "export class Gadget extends DurableObject {",
    ],
    extract: EXTRACT_DOCS,
  },
  "workspace-sheets": {
    kind: "sheet",
    hooks: [
      { anchor: MUTATION_QUEUE_ANCHOR, insert: MUTATION_QUEUE_HOOK },
      { anchor: "  async subscribe(callback, client = {}) {\n", insert: HOOK("open") },
    ],
    requires: [
      'const DEFAULT_TITLE = "Untitled spreadsheet";',
      'this.ctx.storage.put("meta", meta)',
      'this.ctx.storage.put("cells:" + sheetId, cells)',
      "export class Gadget extends DurableObject {",
    ],
    extract: EXTRACT_SHEETS,
  },
  "workspace-slides": {
    kind: "slides",
    hooks: [
      { anchor: "  async #broadcast(deck) {\n", insert: HOOK("edit") },
      { anchor: "  async subscribe(cb) {\n", insert: HOOK("open") },
    ],
    requires: [
      'const STORAGE_KEY = "deck";',
      "function initialDeck() {",
      "super(state, env);",
      "export class Gadget extends DurableObject {",
    ],
    extract: EXTRACT_SLIDES,
  },
};

// ---------------------------------------------------------------------------
// Patching
// ---------------------------------------------------------------------------

export class PatchError extends Error {}

/** @param {string} source */
export function patchedVersionOf(source) {
  const match = MARKER_LINE.exec(source);
  return match ? Number(match[1]) : null;
}

/**
 * Returns the patched server.js, or the input unchanged if it already carries this patch version.
 * @param {string} name a key of FORMATS
 * @param {string} source upstream server.js
 */
export function patchServer(name, source) {
  const format = FORMATS[name];
  if (!format) throw new PatchError(`${name}: not a format this script patches`);
  const existing = patchedVersionOf(source);
  if (existing === PATCH_VERSION) return source;
  if (existing !== null) {
    throw new PatchError(`${name}: server.js already carries ${MARKER} v${existing}, not v${PATCH_VERSION}. ` +
      `Re-copy the pristine upstream pair and patch that.`);
  }
  if (source.includes("__cfosSearch")) {
    throw new PatchError(`${name}: server.js mentions __cfosSearch but has no ${MARKER} marker; refusing to guess`);
  }
  for (const text of format.requires) {
    if (!source.includes(text)) {
      throw new PatchError(`${name}: upstream server.js changed: expected ${JSON.stringify(text)}. ` +
        `Review the injected code in scripts/patch-format-search.mjs against the new server.js.`);
    }
  }
  let out = source;
  for (const { anchor, insert } of format.hooks) {
    const count = out.split(anchor).length - 1;
    if (count !== 1) {
      throw new PatchError(`${name}: anchor ${JSON.stringify(anchor)} found ${count} times, expected once. ` +
        `Upstream server.js changed; update the hook in scripts/patch-format-search.mjs.`);
    }
    out = out.replace(anchor, () => anchor + insert);
  }
  return out.replace(/\n*$/, "\n") + runtime(format.kind) + format.extract;
}

/** @param {number} upstreamRevision */
export function patchedRevision(upstreamRevision) {
  return upstreamRevision * 100 + PATCH_VERSION;
}

/**
 * Rewrites only the sidecar's `revision`, keeping the rest of the file byte for byte.
 * @param {string} name @param {string} text @param {number} revision
 */
function withRevision(name, text, revision) {
  const pattern = /("revision"\s*:\s*)\d+/g;
  const count = text.match(pattern)?.length ?? 0;
  if (count !== 1) throw new PatchError(`${name}.json: expected one "revision", found ${count}`);
  const out = text.replace(pattern, (_, key) => key + revision);
  if (JSON.parse(out).revision !== revision) throw new PatchError(`${name}.json: revision rewrite failed`);
  return out;
}

/**
 * Patches one `.gadget`/`.json` pair. Already patched (this version) comes back byte-identical.
 * @param {string} name
 * @param {Uint8Array} archiveBytes
 * @param {string} sidecarText
 * @returns {{archive: Uint8Array, sidecar: string, revision: number, alreadyPatched: boolean}}
 */
export function patchPair(name, archiveBytes, sidecarText) {
  const sidecar = JSON.parse(sidecarText);
  if (!Number.isInteger(sidecar.revision) || sidecar.revision < 1) {
    throw new PatchError(`${name}.json: revision must be a positive integer`);
  }
  const { metadata, files } = parseArchive(archiveBytes);
  if (typeof files["server.js"] !== "string") throw new PatchError(`${name}.gadget: no server.js`);
  const server = patchServer(name, files["server.js"]);
  if (server === files["server.js"]) {
    // Already carries this patch version: leave both files exactly as they are.
    if (sidecar.revision % 100 !== PATCH_VERSION || metadata.version !== sidecar.revision) {
      throw new PatchError(`${name}: server.js is patched but revision ${sidecar.revision} / version ` +
        `${metadata.version} is not a patched revision; re-copy the upstream pair and patch that`);
    }
    return { archive: archiveBytes, sidecar: sidecarText, revision: sidecar.revision, alreadyPatched: true };
  }
  if (sidecar.revision >= 100) {
    throw new PatchError(`${name}.json: revision ${sidecar.revision} looks already patched (>= 100) ` +
      `but server.js is not; re-copy the upstream pair`);
  }
  const revision = patchedRevision(sidecar.revision);
  const archive = serializeArchive(
    { ...metadata, version: revision },
    encodeContent({ ...files, "server.js": server }));
  return { archive, sidecar: withRevision(name, sidecarText, revision), revision, alreadyPatched: false };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(argv) {
  const check = argv.includes("--check");
  const arg = (flag, dflt) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? resolve(argv[i + 1]) : dflt;
  };
  const from = arg("--from", UPSTREAM_DIR);
  const to = arg("--to", FORMATS_DIR);
  let stale = 0;
  for (const name of Object.keys(FORMATS)) {
    const archiveIn = new Uint8Array(await readFile(join(from, `${name}.gadget`)));
    const sidecarIn = await readFile(join(from, `${name}.json`), "utf8");
    const result = patchPair(name, archiveIn, sidecarIn);
    const archivePath = join(to, `${name}.gadget`);
    const sidecarPath = join(to, `${name}.json`);
    const currentArchive = await readFile(archivePath).catch(() => Buffer.alloc(0));
    const currentSidecar = await readFile(sidecarPath, "utf8").catch(() => "");
    const same = Buffer.compare(Buffer.from(result.archive), currentArchive) === 0 &&
      currentSidecar === result.sidecar;
    const note = result.alreadyPatched ? " (input already patched)" : "";
    if (check) {
      if (!same) stale++;
      console.log(`${name}: ${same ? "current" : "STALE"} (revision ${result.revision})${note}`);
      continue;
    }
    if (same) {
      console.log(`${name}: unchanged (revision ${result.revision})${note}`);
      continue;
    }
    await writeFile(archivePath, result.archive);
    await writeFile(sidecarPath, result.sidecar);
    console.log(`${name}: patched -> revision ${result.revision} (${result.archive.byteLength} bytes)${note}`);
  }
  if (stale) {
    console.error(`${stale} bundled format(s) differ from a fresh patch; run: node scripts/patch-format-search.mjs`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await main(process.argv.slice(2));
  } catch (err) {
    if (err instanceof PatchError) {
      console.error(`patch-format-search: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}
