// Packs dist/ into formats/whiteboard.gadget, the bundled-format archive the Workshop build installs
// (see cloudflare-os/packages/workshop-backend/format-blueprints/README.md).
//
//   node scripts/pack-gadget.mjs            pack; bumps formats/whiteboard.json `revision` when code changed
//   node scripts/pack-gadget.mjs --check    exit 1 if formats/whiteboard.gadget is stale versus dist/
//
// The installer only reinstalls a format when its `revision` (or presentation) changes, so a code
// change without a bump would never reach existing deployments. gadget.lock.json records the
// content hash the current revision was packed from.

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeContent, serializeArchive } from "./archive.mjs";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(pkg, "../..");
const FILES = ["server.js", "client.js", "README.md"];
// Archive dates are inert once installed (the sidecar owns presentation); fixed for reproducibility.
const FIXED_DATE = "2026-09-16T00:00:00.000Z";

export const paths = {
  sidecar: join(repo, "formats/whiteboard.json"),
  archive: join(repo, "formats/whiteboard.gadget"),
  lock: join(pkg, "gadget.lock.json"),
};

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

/**
 * @param {Record<string, string>} files
 * @param {{title: string, description: string, author: object, output: object, revision: number}} sidecar
 */
export function packArchive(files, sidecar) {
  const metadata = {
    title: sidecar.title,
    description: sidecar.description,
    author: sidecar.author,
    created: FIXED_DATE,
    lastUpdated: FIXED_DATE,
    version: sidecar.revision,
    bindings: {},
    output: sidecar.output,
  };
  return serializeArchive(metadata, encodeContent(files));
}

async function main() {
  const check = process.argv.includes("--check");
  const files = await readDist(join(pkg, "dist"));
  const hash = contentHash(files);
  const sidecarText = await readFile(paths.sidecar, "utf8");
  const sidecar = JSON.parse(sidecarText);
  const lock = JSON.parse(await readFile(paths.lock, "utf8").catch(() => '{"revision":0,"contentHash":""}'));

  if (check) {
    const expected = packArchive(files, sidecar);
    const actual = new Uint8Array(await readFile(paths.archive).catch(() => Buffer.alloc(0)));
    const stale = lock.contentHash !== hash || lock.revision !== sidecar.revision ||
      Buffer.compare(Buffer.from(expected), Buffer.from(actual)) !== 0;
    if (stale) {
      console.error("formats/whiteboard.gadget is stale; run: pnpm --filter blueprint-whiteboard pack:gadget");
      process.exit(1);
    }
    console.log(`formats/whiteboard.gadget is current (revision ${sidecar.revision})`);
    return;
  }

  if (lock.contentHash !== hash) {
    sidecar.revision = Math.max(sidecar.revision, lock.revision) + (lock.contentHash ? 1 : 0);
    await writeFile(paths.sidecar, JSON.stringify(sidecar, null, 2) + "\n");
    await writeFile(paths.lock, JSON.stringify({ revision: sidecar.revision, contentHash: hash }, null, 2) + "\n");
  }
  const bytes = packArchive(files, sidecar);
  await writeFile(paths.archive, bytes);
  console.log(`packed formats/whiteboard.gadget (${bytes.byteLength} bytes, revision ${sidecar.revision})`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
