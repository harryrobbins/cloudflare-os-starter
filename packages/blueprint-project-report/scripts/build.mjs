// Bundles the gadget into the files a Cloudflare OS gadget is made of:
//   dist/server.js                 the `Gadget` Durable Object, one ESM module
//   dist/client.js                 the UI, one ESM module (the iframe cannot import siblings)
//   dist/README.md                 what the in-Workshop agent reads before calling the RPC surface
//   dist/service-requirement.json  the Records service requirement (module, API major, scopes)
// Output is deliberately unminified so the code stays legible in the Workshop editor.

import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(pkg, "dist");
const NAME = "Project report";

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
    banner: { js: `// ${NAME} gadget server. Built from packages/blueprint-project-report; edit there, not here.` },
  });
  await build({
    ...common,
    entryPoints: [join(pkg, "src/client/main.js")],
    outfile: join(outDir, "client.js"),
    platform: "browser",
    banner: { js: `// ${NAME} gadget client. Built from packages/blueprint-project-report; edit there, not here.` },
  });
  await copyFile(join(pkg, "src/README.md"), join(outDir, "README.md"));
  await copyFile(join(pkg, "src/service-requirement.json"), join(outDir, "service-requirement.json"));
  return outDir;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await buildGadget();
  console.log("built", dist);
}
