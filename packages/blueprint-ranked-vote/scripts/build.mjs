// Bundles the gadget into the three files a Cloudflare OS gadget is made of:
//   dist/server.js  the `Gadget` Durable Object and `ExportHandler`, one ESM module (unminified,
//                   so it stays legible in the Workshop editor)
//   dist/client.js  the UI, one minified ESM module (the iframe cannot import siblings)
//   dist/README.md  what the in-Workshop agent reads before calling the RPC surface

import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const common = { bundle: true, format: "esm", target: "es2022", legalComments: "none", charset: "utf8", logLevel: "warning" };

/** @param {string} outDir */
export async function buildGadget(outDir) {
  await mkdir(outDir, { recursive: true });
  await build({
    ...common,
    entryPoints: [join(pkg, "src/server/index.js")],
    outfile: join(outDir, "server.js"),
    platform: "neutral",
    external: ["cloudflare:workers"],
    banner: { js: "// Ranked vote gadget server. Built from packages/blueprint-ranked-vote; edit there, not here." },
  });
  await build({
    ...common,
    entryPoints: [join(pkg, "src/client/main.js")],
    outfile: join(outDir, "client.js"),
    platform: "browser",
    minify: true,
    banner: { js: "// Ranked vote gadget client. Built from packages/blueprint-ranked-vote; edit there, not here." },
  });
  await copyFile(join(pkg, "src/README.md"), join(outDir, "README.md"));
}

const at = process.argv.indexOf("--out");
const out = at !== -1 ? resolve(process.argv[at + 1]) : join(pkg, "dist");
if (import.meta.url === `file://${process.argv[1]}`) {
  await buildGadget(out);
  console.log(`built ${out}`);
}
