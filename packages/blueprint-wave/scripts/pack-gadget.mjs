// Packs dist/ into formats/wave.gadget, the bundled-format archive the Workshop build installs
// (see cloudflare-os/packages/workshop-backend/format-blueprints/README.md).
//
//   node scripts/pack-gadget.mjs            pack; bumps formats/wave.json `revision` when code changed
//   node scripts/pack-gadget.mjs --check    exit 1 if formats/wave.gadget is stale versus dist/
//
// The installer only reinstalls a format when its `revision` (or presentation) changes, so a code
// change without a bump would never reach existing deployments. gadget.lock.json records the
// content hash the current revision was packed from; it is created on the first pack.
//
// The sidecar also owns `bindings` (what the gadget's `env` expects; the installer keeps the
// archive's copy verbatim). It is validated here against the platform's BlueprintBinding shape
// (cloudflare-os/packages/workshop-shared/src/api.ts) so a typo fails the pack, not the New menu.

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
  sidecar: join(repo, "formats/wave.json"),
  archive: join(repo, "formats/wave.gadget"),
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

// Binding names become keys of the gadget worker's `env`.
const BINDING_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const COMMON_KEYS = ["title", "description", "type", "spawnerOnly"];
const KEYS_BY_TYPE = {
  gatekeeper: ["gatekeeperName", "typeUrlPattern", "resourceUrl"],
  aiModel: ["suggestedModel"],
  agentSpawner: ["suggestedModel", "env"],
};

/**
 * Checks `bindings` against the platform's `Record<string, BlueprintBinding>` and returns it.
 * Every binding is mandatory at instantiation (the platform has no optional flag), so declare
 * only what New should ask for.
 * @param {unknown} bindings
 * @returns {Record<string, object>}
 */
export function validateBindings(bindings) {
  if (bindings === undefined) return {};
  if (!isRecord(bindings)) throw new Error("sidecar `bindings` must be an object keyed by binding name");
  for (const [name, b] of Object.entries(bindings)) {
    const at = `bindings.${name}`;
    if (!BINDING_NAME.test(name)) throw new Error(`${at}: name must match ${BINDING_NAME}`);
    if (!isRecord(b)) throw new Error(`${at}: must be an object`);
    if (typeof b.title !== "string" || !b.title.trim()) throw new Error(`${at}.title: non-empty string required`);
    if (typeof b.description !== "string") throw new Error(`${at}.description: string required (may be empty)`);
    if (b.spawnerOnly !== undefined && b.spawnerOnly !== true) throw new Error(`${at}.spawnerOnly: only \`true\``);
    const typed = KEYS_BY_TYPE[/** @type {keyof typeof KEYS_BY_TYPE} */ (b.type)];
    if (!typed) throw new Error(`${at}.type: one of ${Object.keys(KEYS_BY_TYPE).join(", ")}`);
    const unknown = Object.keys(b).filter((k) => !COMMON_KEYS.includes(k) && !typed.includes(k));
    if (unknown.length) throw new Error(`${at}: unknown field(s) ${unknown.join(", ")} for type ${b.type}`);
    if (b.type === "gatekeeper") {
      for (const k of ["gatekeeperName", "typeUrlPattern"]) {
        if (typeof b[k] !== "string" || !b[k]) throw new Error(`${at}.${k}: non-empty string required`);
      }
      if (b.resourceUrl !== undefined && typeof b.resourceUrl !== "string") throw new Error(`${at}.resourceUrl: string`);
    }
    if (b.suggestedModel !== undefined && !(b.type === "agentSpawner" && b.suggestedModel === null)) {
      const m = b.suggestedModel;
      if (!isRecord(m) || typeof m.provider !== "string" || typeof m.modelName !== "string") {
        throw new Error(`${at}.suggestedModel: {provider, modelName} required`);
      }
    }
    if (b.type === "agentSpawner") {
      if (!isRecord(b.env)) throw new Error(`${at}.env: object required`);
      for (const [envName, target] of Object.entries(b.env)) {
        const ok = isRecord(target) && (target.type === "gadget" ||
          (target.type === "binding" && typeof target.name === "string" && target.name in bindings));
        if (!ok) throw new Error(`${at}.env.${envName}: {type: "gadget"} or {type: "binding", name: <a binding>}`);
      }
    }
  }
  return /** @type {Record<string, object>} */ (bindings);
}

/** @param {unknown} v @returns {v is Record<string, any>} */
function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * @param {Record<string, string>} files
 * @param {{title: string, description: string, author: object, output: object, revision: number,
 *          bindings?: Record<string, object>}} sidecar
 */
export function packArchive(files, sidecar) {
  const metadata = {
    title: sidecar.title,
    description: sidecar.description,
    author: sidecar.author,
    created: FIXED_DATE,
    lastUpdated: FIXED_DATE,
    version: sidecar.revision,
    bindings: validateBindings(sidecar.bindings),
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
  validateBindings(sidecar.bindings);
  const lock = JSON.parse(await readFile(paths.lock, "utf8").catch(() => '{"revision":0,"contentHash":""}'));

  if (check) {
    const expected = packArchive(files, sidecar);
    const actual = new Uint8Array(await readFile(paths.archive).catch(() => Buffer.alloc(0)));
    const stale = lock.contentHash !== hash || lock.revision !== sidecar.revision ||
      Buffer.compare(Buffer.from(expected), Buffer.from(actual)) !== 0;
    if (stale) {
      console.error("formats/wave.gadget is stale; run: pnpm --filter blueprint-wave pack:gadget");
      process.exit(1);
    }
    console.log(`formats/wave.gadget is current (revision ${sidecar.revision})`);
    return;
  }

  if (lock.contentHash !== hash) {
    // First pack (no lock yet): the sidecar starts at 0 and ships as revision 1. Later packs bump.
    sidecar.revision = lock.contentHash ? Math.max(sidecar.revision, lock.revision) + 1 : Math.max(sidecar.revision, 1);
    await writeFile(paths.sidecar, JSON.stringify(sidecar, null, 2) + "\n");
    await writeFile(paths.lock, JSON.stringify({ revision: sidecar.revision, contentHash: hash }, null, 2) + "\n");
  }
  const bytes = packArchive(files, sidecar);
  await writeFile(paths.archive, bytes);
  console.log(`packed formats/wave.gadget (${bytes.byteLength} bytes, revision ${sidecar.revision})`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
