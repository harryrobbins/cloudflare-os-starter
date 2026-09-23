// Packs dist/ into a `.gadget` archive.
//
//   node scripts/pack-gadget.mjs                      write dist/project-report.gadget (default; touches
//                                                     nothing outside this package)
//   node scripts/pack-gadget.mjs --formats <dir>      coordinator only: write <dir>/project-report.gadget
//                                                     and <dir>/project-report.json (from format.json),
//                                                     bumping `revision` via gadget.lock.json when code changed
//   node scripts/pack-gadget.mjs --check <dir>        exit 1 if <dir>/project-report.gadget is stale
//
// The archive metadata carries `bindings.RECORDS` (the Records gatekeeper binding). The formats
// sidecar may only hold blueprintId/title/description/output/author/revision, so the Records
// service requirement travels as `service-requirement.json` inside the archive content instead.

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeContent, serializeArchive } from "./archive.mjs";
import { BLUEPRINT_BINDINGS } from "../src/shared/records.js";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const STEM = "project-report";
export const FILES = ["server.js", "client.js", "README.md", "service-requirement.json"];
const FIXED_DATE = "2026-09-23T00:00:00.000Z";
const lockPath = join(pkg, "gadget.lock.json");

/** @param {string} distDir */
export async function readDist(distDir) {
  /** @type {Record<string, string>} */
  const files = {};
  for (const name of FILES) files[name] = await readFile(join(distDir, name), "utf8");
  return files;
}

/** @param {Record<string, string>} files */
export function contentHash(files) {
  const h = createHash("sha256");
  for (const name of Object.keys(files).toSorted()) h.update(name).update("\0").update(files[name]).update("\0");
  return h.digest("hex");
}

/** @param {Record<string, string>} files @param {any} sidecar */
export function packArchive(files, sidecar) {
  return serializeArchive({
    title: sidecar.title,
    description: sidecar.description,
    author: sidecar.author,
    created: FIXED_DATE,
    lastUpdated: FIXED_DATE,
    version: sidecar.revision,
    bindings: BLUEPRINT_BINDINGS,
    output: sidecar.output,
  }, encodeContent(files));
}

async function main() {
  const args = process.argv.slice(2);
  const flag = args.find((a) => a === "--formats" || a === "--check");
  const dir = flag ? args[args.indexOf(flag) + 1] : null;
  if (flag && !dir) throw new Error(`${flag} needs a directory`);
  const files = await readDist(join(pkg, "dist"));
  const hash = contentHash(files);
  const template = JSON.parse(await readFile(join(pkg, "format.json"), "utf8"));

  if (!flag) {
    const out = join(pkg, "dist", `${STEM}.gadget`);
    const bytes = packArchive(files, template);
    await writeFile(out, bytes);
    await writeFile(join(pkg, "dist", `${STEM}.json`), JSON.stringify(template, null, 2) + "\n");
    console.log(`packed ${out} (${bytes.byteLength} bytes)`);
    return;
  }

  const target = resolve(/** @type {string} */ (dir));
  const sidecarPath = join(target, `${STEM}.json`);
  const archivePath = join(target, `${STEM}.gadget`);
  const sidecar = JSON.parse(await readFile(sidecarPath, "utf8").catch(() => JSON.stringify(template)));
  const lock = JSON.parse(await readFile(lockPath, "utf8").catch(() => '{"revision":0,"contentHash":""}'));

  if (flag === "--check") {
    const expected = packArchive(files, sidecar);
    const actual = new Uint8Array(await readFile(archivePath).catch(() => Buffer.alloc(0)));
    if (lock.contentHash !== hash || lock.revision !== sidecar.revision || Buffer.compare(Buffer.from(expected), Buffer.from(actual)) !== 0) {
      console.error(`${archivePath} is stale; run: pnpm --filter blueprint-${STEM} pack:gadget -- --formats ${dir}`);
      process.exit(1);
    }
    console.log(`${archivePath} is current (revision ${sidecar.revision})`);
    return;
  }

  if (lock.contentHash !== hash) {
    sidecar.revision = Math.max(sidecar.revision ?? 1, lock.revision) + (lock.contentHash ? 1 : 0);
    await writeFile(lockPath, JSON.stringify({ revision: sidecar.revision, contentHash: hash }, null, 2) + "\n");
  }
  await writeFile(sidecarPath, JSON.stringify(sidecar, null, 2) + "\n");
  const bytes = packArchive(files, sidecar);
  await writeFile(archivePath, bytes);
  console.log(`packed ${archivePath} (${bytes.byteLength} bytes, revision ${sidecar.revision})`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
