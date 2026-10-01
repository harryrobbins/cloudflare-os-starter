// Builds the gadget's files into dist/ (see .agents/skills/author-adaptable-blueprints/SKILL.md):
//   dist/server.js      src/server/index.js verbatim: the `Gadget` Durable Object (with
//                       describeGadget()) and `ExportHandler`; its local imports point at server.lib.js
//   dist/server.lib.js  ESM bundle of what server.js imports (whiteboard rules, hub, storage, backup)
//   dist/client.js      src/client/main.js verbatim, starting with its adapt block; its imports read
//                       from `gadgetLib`
//   dist/client.lib.js  `var gadgetLib = ...`: the store, UI shell, canvas and everything else the
//                       entry imports. The platform loads it before client.js in the same module.
//   dist/README.md      what the in-Workshop agent reads, including "Adapting this gadget"
// Everything is unminified so it stays legible in the Workshop editor, but agents read and edit
// only client.js and server.js.

import * as esbuild from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildClientEntry, buildServerEntry } from "../../../scripts/gadget-entry.mjs";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(pkg, "dist");

export async function buildGadget(outDir = dist) {
  await mkdir(outDir, { recursive: true });
  const server = await buildServerEntry({
    esbuild,
    entry: join(pkg, "src/server/index.js"),
    outDir,
    banner: "// Whiteboard gadget server: the RPC surface (see describeGadget() below). Source: packages/blueprint-whiteboard/src/server/index.js.",
    library: { minify: false },
  });
  const client = await buildClientEntry({
    esbuild,
    entry: join(pkg, "src/client/main.js"),
    outDir,
    banner: "// Whiteboard gadget client: the main view. Adapt it in the block below. Source: packages/blueprint-whiteboard/src/client/main.js.",
    library: { minify: false },
  });
  await copyFile(join(pkg, "src/README.md"), join(outDir, "README.md"));
  return { outDir, server, client };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { server, client } = await buildGadget();
  const kb = (/** @type {number} */ n) => `${(n / 1024).toFixed(1)} KiB`;
  console.log(`built ${dist}: client.js ${kb(client.clientBytes)}, client.lib.js ${kb(client.libraryBytes)}, ` +
    `server.js ${kb(server.serverBytes)}, server.lib.js ${kb(server.libraryBytes)}`);
}
