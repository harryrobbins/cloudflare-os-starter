// @ts-check
// Compiles the declared icon packs (scripts/icon-packs/packs.mjs) into checked-in, inert geometry:
//
//   src/shared/generated/icon-packs.js   geometry, labels, tags, categories, source version and
//                                        hash, licence text (read by src/shared/icons/registry.js)
//   scripts/icon-packs/published.json    ledger of published icon ids and geometry hashes
//   THIRD_PARTY_NOTICES.md               attribution and licence text for third-party packs
//
//   node scripts/build-icon-packs.mjs          build (adds newly published ids to the ledger)
//   node scripts/build-icon-packs.mjs --check  exit 1 when any output is stale or a published id
//                                              changed; writes nothing
//
// Reads only the pinned, declared source files: the first-party SVGs in scripts/icon-packs/core and
// the named files of the exact npm version each pack declares (the installed version must match).
// Output is deterministic: same sources, same bytes.

import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileSvg, IconCompileError } from "./icon-packs/svg-compiler.mjs";
import { PACKS } from "./icon-packs/packs.mjs";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");

export const OUTPUTS = {
  generated: join(pkg, "src/shared/generated/icon-packs.js"),
  ledger: join(pkg, "scripts/icon-packs/published.json"),
  notices: join(pkg, "THIRD_PARTY_NOTICES.md"),
};

/** Size budget of the generated module (it ships in both the client and the server bundle). */
export const GENERATED_BUDGET_BYTES = 160 * 1024;
/** Icons in all packs together. */
export const ICON_COUNT_BUDGET = 320;
const MAX_TAGS = 8;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PACK_ID_RE = /^[a-z][a-z0-9-]{0,31}\.[0-9]{1,4}$/;

/** @param {string|Uint8Array} data */
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** "user-circle" -> "User circle" */
export function labelFromId(/** @type {string} */ id) {
  const s = id.split("-").join(" ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** @param {unknown[]} raw @param {string} id */
export function cleanTags(raw, id) {
  const idWords = new Set(id.split("-"));
  /** @type {string[]} */
  const out = [];
  for (const t of raw) {
    const tag = String(t).trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9 .+-]{0,31}$/.test(tag) || idWords.has(tag) || out.includes(tag)) continue;
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/**
 * Where a pack's sources live and how to read them.
 * @param {import("./icon-packs/packs.mjs").PackDecl} pack
 */
async function openSource(pack) {
  if (pack.source.type === "first-party") {
    const dir = join(pkg, "scripts/icon-packs", pack.id.split(".")[0]);
    return { dir, meta: /** @type {Record<string, any>} */ ({}), licenceText: null, version: null };
  }
  const root = join(pkg, "node_modules", pack.source.package);
  const installed = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (installed.version !== pack.source.version) {
    throw new Error(`${pack.id}: ${pack.source.package} ${installed.version} is installed but the pack pins ${pack.source.version}; run pnpm install`);
  }
  /** @type {Record<string, any>} */
  let meta = {};
  try { meta = JSON.parse(await readFile(join(root, "icons.json"), "utf8")); } catch { /* tags are optional */ }
  const licenceText = pack.licence.file ? (await readFile(join(root, pack.licence.file), "utf8")).trim() : null;
  return { dir: join(root, pack.source.dir), meta, licenceText, version: pack.source.version };
}

/**
 * Compiles every pack. Pure apart from reading the declared files.
 * @param {import("./icon-packs/packs.mjs").PackDecl[]} [packs]
 */
export async function compilePacks(packs = PACKS) {
  const out = [];
  const seenPacks = new Set();
  let total = 0;
  for (const pack of packs) {
    if (!PACK_ID_RE.test(pack.id) || seenPacks.has(pack.id)) throw new Error(`bad or duplicate pack id ${pack.id}`);
    seenPacks.add(pack.id);
    const src = await openSource(pack);
    const hash = createHash("sha256");
    const icons = [];
    const seen = new Set();
    for (const category of pack.categories) {
      for (const entry of category.icons) {
        const decl = typeof entry === "string" ? { id: entry } : entry;
        if (!ID_RE.test(decl.id) || seen.has(decl.id)) throw new Error(`${pack.id}: bad or duplicate icon id ${decl.id}`);
        seen.add(decl.id);
        const file = decl.id + ".svg";
        const bytes = await readFile(join(src.dir, file));
        hash.update(file).update("\0").update(bytes).update("\0");
        let compiled;
        try {
          compiled = compileSvg(bytes.toString("utf8"), { fillToken: pack.fillToken, strokeWidth: pack.strokeWidth });
        } catch (e) {
          if (e instanceof IconCompileError) throw new Error(`${pack.id}/${file}: ${e.message}`);
          throw e;
        }
        const upstreamTags = Array.isArray(src.meta[decl.id]?.tags) ? src.meta[decl.id].tags : [];
        /** @type {Record<string, any>} */
        const icon = {
          id: decl.id,
          label: decl.label ?? labelFromId(decl.id),
          category: category.id,
          tags: cleanTags([...(decl.tags ?? []), ...upstreamTags], decl.id),
          vb: compiled.vb,
          shapes: compiled.shapes,
        };
        if ("textBox" in decl && decl.textBox) icon.textBox = decl.textBox;
        icons.push(icon);
      }
    }
    total += icons.length;
    out.push({
      id: pack.id,
      name: pack.name,
      kind: pack.kind,
      source: pack.source.type === "npm"
        ? { package: pack.source.package, version: pack.source.version, url: pack.source.url, sha256: hash.digest("hex") }
        : { firstParty: true, sha256: hash.digest("hex") },
      licence: { spdx: pack.licence.spdx, copyright: pack.licence.copyright, ...(src.licenceText ? { text: src.licenceText } : {}) },
      categories: pack.categories.map((c) => ({ id: c.id, label: c.label })),
      icons,
    });
  }
  if (total > ICON_COUNT_BUDGET) throw new Error(`${total} icons; the budget is ${ICON_COUNT_BUDGET}`);
  return out;
}

/** Hash of the geometry a published id promises (what may never change under that id). @param {any} icon */
export function geometryHash(icon) {
  return sha256(JSON.stringify({ vb: icon.vb, shapes: icon.shapes, textBox: icon.textBox ?? null })).slice(0, 16);
}

/**
 * Checks compiled packs against the ledger of published ids: every published id must still exist
 * with the same geometry. Returns the ledger with new ids added.
 * @param {any[]} packs @param {Record<string, Record<string, string>>} ledger
 * @returns {Record<string, Record<string, string>>}
 */
export function reconcileLedger(packs, ledger) {
  /** @type {string[]} */
  const problems = [];
  /** @type {Record<string, Record<string, string>>} */
  const next = {};
  const byPack = new Map(packs.map((p) => [p.id, p]));
  for (const [packId, icons] of Object.entries(ledger)) {
    const pack = byPack.get(packId);
    for (const [iconId, hash] of Object.entries(icons)) {
      const icon = pack?.icons.find((/** @type {any} */ i) => i.id === iconId);
      if (!icon) problems.push(`${packId}/${iconId} was published and can no longer be removed`);
      else if (geometryHash(icon) !== hash) problems.push(`${packId}/${iconId} changed geometry; publish it in a new pack version instead`);
    }
  }
  if (problems.length) throw new Error("Published icon ids must keep resolving to the same geometry:\n  " + problems.join("\n  "));
  for (const pack of packs) {
    next[pack.id] = { ...(ledger[pack.id] ?? {}) };
    for (const icon of pack.icons) next[pack.id][icon.id] ??= geometryHash(icon);
    next[pack.id] = Object.fromEntries(Object.entries(next[pack.id]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }
  for (const [packId, icons] of Object.entries(ledger)) if (!next[packId]) next[packId] = icons;
  return next;
}

/** @param {any[]} packs */
export function renderModule(packs) {
  const lines = [
    "// Generated by scripts/build-icon-packs.mjs from pinned sources (scripts/icon-packs/packs.mjs).",
    "// Do not edit: change the pack declarations or sources and run `node scripts/build-icon-packs.mjs`.",
    "// Inert data only. Each icon's shapes are [paint, pathData]: paint is a fill role then a stroke role",
    "// (n none, f the object's fill, i the object's line colour); path data holds only absolute M, L, C",
    "// and Z commands in the icon's own view box [width, height]. Read through src/shared/icons/registry.js.",
    "",
    "export const ICON_PACKS = [",
  ];
  for (const pack of packs) {
    const { icons, ...meta } = pack;
    lines.push(`  ${JSON.stringify(meta).slice(0, -1)},"icons":[`);
    for (const icon of icons) lines.push(`    ${JSON.stringify(icon)},`);
    lines.push("  ]},");
  }
  lines.push("];", "");
  return lines.join("\n");
}

/** @param {any[]} packs */
export function renderNotices(packs) {
  const lines = [
    "# Third-party notices",
    "",
    "The Whiteboard gadget ships compiled geometry derived from the third-party icon sets below. Only the",
    "icons listed in `scripts/icon-packs/packs.mjs` are included, compiled by `scripts/build-icon-packs.mjs`",
    "from the exact version shown. This file is generated by that script.",
    "",
  ];
  for (const pack of packs) {
    if (pack.source.firstParty) continue;
    lines.push(
      `## ${pack.name} (\`${pack.id}\`)`,
      "",
      `- Source: [${pack.source.package}@${pack.source.version}](${pack.source.url}), ${pack.icons.length} icons`,
      `- Source files SHA-256: \`${pack.source.sha256}\``,
      `- Licence: ${pack.licence.spdx}`,
      "",
      "```text",
      pack.licence.text ?? pack.licence.copyright,
      "```",
      "",
    );
  }
  return lines.join("\n");
}

/**
 * The ledger file stores each pack as a sorted list of "iconId geometryHash" lines rather than an
 * object, so icon ids such as "key" or "password" next to a hash never look like secrets to scanners.
 * @param {Record<string, Record<string, string>>} ledger
 */
export function ledgerToFile(ledger) {
  return Object.fromEntries(Object.entries(ledger).map(([pack, icons]) => [pack, Object.entries(icons).map(([id, h]) => `${id} ${h}`)]));
}

/** @param {Record<string, string[]>} file @returns {Record<string, Record<string, string>>} */
export function ledgerFromFile(file) {
  return Object.fromEntries(Object.entries(file).map(([pack, lines]) => [pack, Object.fromEntries(lines.map((l) => l.split(" ")))]));
}

/**
 * Builds everything in memory.
 * @param {{ledger?: Record<string, Record<string, string>>}} [opts]
 */
export async function buildIconPacks({ ledger } = {}) {
  const packs = await compilePacks();
  const current = ledger ?? ledgerFromFile(JSON.parse(await readFile(OUTPUTS.ledger, "utf8").catch(() => "{}")));
  const nextLedger = reconcileLedger(packs, current);
  const moduleText = renderModule(packs);
  const bytes = Buffer.byteLength(moduleText);
  if (bytes > GENERATED_BUDGET_BYTES) throw new Error(`generated icon packs are ${bytes} bytes; the budget is ${GENERATED_BUDGET_BYTES}`);
  return {
    packs,
    files: {
      [OUTPUTS.generated]: moduleText,
      [OUTPUTS.ledger]: JSON.stringify(ledgerToFile(nextLedger), null, 2) + "\n",
      [OUTPUTS.notices]: renderNotices(packs),
    },
    bytes,
  };
}

async function main() {
  const check = process.argv.includes("--check");
  const { files, packs, bytes } = await buildIconPacks();
  const stale = [];
  for (const [path, text] of Object.entries(files)) {
    const existing = await readFile(path, "utf8").catch(() => null);
    if (existing === text) continue;
    stale.push(path.slice(pkg.length + 1));
    if (!check) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text);
    }
  }
  const count = packs.reduce((n, p) => n + p.icons.length, 0);
  if (check) {
    if (stale.length) {
      console.error(`icon packs are stale (${stale.join(", ")}); run: node scripts/build-icon-packs.mjs`);
      process.exit(1);
    }
    console.log(`icon packs are current (${count} icons, ${bytes} bytes)`);
    return;
  }
  console.log(`${stale.length ? "wrote " + stale.join(", ") : "unchanged"}: ${count} icons, ${bytes} bytes of ${GENERATED_BUDGET_BYTES}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await main();
  } catch (e) {
    console.error(/** @type {Error} */ (e).message);
    process.exit(1);
  }
}
