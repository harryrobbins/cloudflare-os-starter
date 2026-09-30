// Bundles the gadget into the three files a Cloudflare OS gadget is made of:
//   dist/server.js  the `Gadget` Durable Object and `ExportHandler`, one ESM module
//   dist/client.js  the UI, one ESM module (the iframe cannot import siblings)
//   dist/README.md  what the in-Workshop agent reads before calling the RPC surface
// The embedded whiteboard (packages/blueprint-whiteboard/src/embed) is bundled into both.
// Output is deliberately unminified so the code stays legible in the Workshop editor.

import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(pkg, "dist");

const common = {
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: false,
  legalComments: "none",
  charset: "utf8",
  logLevel: "warning",
};

export async function buildGadget(outDir = dist) {
  await mkdir(outDir, { recursive: true });
  await build({
    ...common,
    entryPoints: [join(pkg, "src/server/index.js")],
    outfile: join(outDir, "server.js"),
    platform: "neutral",
    external: ["cloudflare:workers"],
    banner: { js: "// Docs with Drawings gadget server. Built from packages/blueprint-docs; edit there, not here." },
  });
  await build({
    ...common,
    entryPoints: [join(pkg, "src/client/main.js")],
    outfile: join(outDir, "client.js"),
    platform: "browser",
    banner: { js: "// Docs with Drawings gadget client. Built from packages/blueprint-docs; edit there, not here." },
  });
  await copyFile(join(pkg, "src/README.md"), join(outDir, "README.md"));
  return outDir;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await buildGadget();
  console.log("built", dist);
}
