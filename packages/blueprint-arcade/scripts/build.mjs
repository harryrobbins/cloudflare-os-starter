import * as esbuild from "esbuild";
import { buildClientEntry, buildServerEntry } from "../../../scripts/gadget-entry.mjs";
// Builds readable client.js/server.js entries and their prebuilt *.lib.js libraries.
// The platform loads client.lib.js before client.js in the same module scope.
// README.md and package-specific assets are packed alongside them.

import { build } from "esbuild";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const common = { bundle: true, format: "esm", target: "es2022", legalComments: "none", charset: "utf8", logLevel: "warning" };

/** @type {import("esbuild").Plugin} */
const raw = {
  name: "raw",
  setup(b) {
    // Package-relative paths: esbuild prints them as module comments, and an absolute path would
    // make the packed archive depend on where the checkout lives.
    b.onResolve({ filter: /\?raw$/ }, (args) => ({
      path: relative(pkg, resolve(args.resolveDir, args.path.slice(0, -4))).split(sep).join("/"),
      namespace: "raw",
    }));
    b.onLoad({ filter: /.*/, namespace: "raw" }, async (args) => ({ contents: await readFile(join(pkg, args.path), "utf8"), loader: "text" }));
  },
};

/** @param {string} outDir */
export async function buildGadget(outDir) {
  await mkdir(outDir, { recursive: true });
  await buildServerEntry({ esbuild, entry: join(pkg, "src/server/index.js"), outDir,
    banner: "// Arcade gadget server: readable RPC surface. Source: packages/blueprint-arcade/src/server.",
    library: { plugins: [raw] } });
  await buildClientEntry({ esbuild, entry: join(pkg, "src/client/main.js"), outDir,
    banner: "// Arcade gadget client: readable view and adapt block. Source: packages/blueprint-arcade/src/client.",
    library: { absWorkingDir: pkg, minify: true, plugins: [raw] } });
  await copyFile(join(pkg, "src/README.md"), join(outDir, "README.md"));
}

/** @param {string} outDir */
export async function buildHarnessCore(outDir) {
  await build({
    ...common,
    stdin: {
      contents: `export { ArcadeService, InMemoryRepository } from "./src/core/store.js";
export { TEMPLATES } from "./src/cartridges/sources.js";
export { STARTER_TUNES } from "./src/tunes/starter.js";`,
      resolveDir: pkg,
      sourcefile: "harness-core.js",
    },
    outfile: join(outDir, "harness-core.js"),
    platform: "browser",
    plugins: [raw],
  });
}

const at = process.argv.indexOf("--out");
const out = at !== -1 ? resolve(process.argv[at + 1]) : join(pkg, "dist");
if (import.meta.url === `file://${process.argv[1]}`) {
  await buildGadget(out);
  if (at === -1) await buildHarnessCore(out);
  console.log(`built ${out}`);
}
