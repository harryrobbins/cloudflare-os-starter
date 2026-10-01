import * as esbuild from "esbuild";
import { buildClientEntry, buildServerEntry } from "../../../scripts/gadget-entry.mjs";
// Builds readable client.js/server.js entries and their prebuilt *.lib.js libraries.
// The platform loads client.lib.js before client.js in the same module scope.
// README.md and package-specific assets are packed alongside them.

import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(pkg, "dist");

export async function buildGadget(outDir = dist) {
  await mkdir(outDir, { recursive: true });
  await buildServerEntry({ esbuild, entry: join(pkg, "src/server/index.js"), outDir,
    banner: "// Board gadget server: readable RPC surface. Source: packages/blueprint-kanban/src/server.",
    library: { absWorkingDir: pkg } });
  await buildClientEntry({ esbuild, entry: join(pkg, "src/client/main.js"), outDir,
    banner: "// Board gadget client: readable view and adapt block. Source: packages/blueprint-kanban/src/client.",
    library: { absWorkingDir: pkg, minify: false } });
  await copyFile(join(pkg, "src/README.md"), join(outDir, "README.md"));
  return outDir;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await buildGadget();
  console.log("built", dist);
}
