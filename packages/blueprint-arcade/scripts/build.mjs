// Bundles the gadget into the three files a Cloudflare OS gadget is made of:
//   dist/server.js  the `Gadget` Durable Object and `ExportHandler`, one ESM module (unminified,
//                   so it stays legible in the Workshop editor)
//   dist/client.js  the UI and engine, one minified ESM module (the iframe cannot import siblings)
//   dist/README.md  what the in-Workshop agent reads before calling the RPC surface
// and, for the multi-user harness only, dist/harness-core.js (the service with its starters).
//
// `import x from "./file?raw"` imports a file's text: the starter cartridges and the README.

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
  await build({
    ...common,
    entryPoints: [join(pkg, "src/server/index.js")],
    outfile: join(outDir, "server.js"),
    platform: "neutral",
    external: ["cloudflare:workers"],
    plugins: [raw],
    banner: { js: "// Arcade gadget server. Built from packages/blueprint-arcade; edit there, not here." },
  });
  await build({
    ...common,
    entryPoints: [join(pkg, "src/client/main.js")],
    outfile: join(outDir, "client.js"),
    platform: "browser",
    minify: true,
    plugins: [raw],
    banner: { js: "// Arcade gadget client. Built from packages/blueprint-arcade; edit there, not here." },
  });
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
