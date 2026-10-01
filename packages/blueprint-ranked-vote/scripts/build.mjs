// Builds the gadget files a Cloudflare OS gadget is made of (see
// .agents/skills/author-adaptable-blueprints/SKILL.md):
//   dist/server.js      src/server/index.js verbatim: the `Gadget` RPC surface, describeGadget() and
//                       `ExportHandler`, its local imports pointed at server.lib.js
//   dist/server.lib.js  the vote's rules, storage and fan-out (src/core), one ESM module
//   dist/client.js      src/client/main.js verbatim: the adapt block and the page it composes
//   dist/client.lib.js  the UI engine (src/client/app.js, connect.js, styles.js), loaded first
//   dist/README.md      what the in-Workshop agent reads before calling or adapting the gadget

import * as esbuild from "esbuild";
import { copyFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildClientEntry, buildServerEntry } from "../../../scripts/gadget-entry.mjs";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");

/** @param {string} outDir */
export async function buildGadget(outDir) {
  await buildServerEntry({
    esbuild, entry: join(pkg, "src/server/index.js"), outDir,
    banner: "// Ranked Vote gadget server: the RPC surface. Source: packages/blueprint-ranked-vote/src/server/index.js.",
  });
  await buildClientEntry({
    esbuild, entry: join(pkg, "src/client/main.js"), outDir,
    banner: "// Ranked Vote gadget client: the main view. Adapt it in the block below. Source: packages/blueprint-ranked-vote/src/client/main.js.",
    library: { minify: true },
  });
  await copyFile(join(pkg, "src/README.md"), join(outDir, "README.md"));
}

const at = process.argv.indexOf("--out");
const out = at !== -1 ? resolve(process.argv[at + 1]) : join(pkg, "dist");
if (import.meta.url === `file://${process.argv[1]}`) {
  await buildGadget(out);
  console.log(`built ${out}`);
}
