import * as esbuild from "esbuild";
import { buildClientEntry, buildServerEntry } from "../../../scripts/gadget-entry.mjs";
// Builds readable client.js/server.js entries and their prebuilt *.lib.js libraries.
// The platform loads client.lib.js before client.js in the same module scope.
// README.md and package-specific assets are packed alongside them.

import { build } from "esbuild";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(pkg, "dist");

export const BUDGETS = { clientCoreBytes: 700 * 1024, clientTotalBytes: 1.5 * 1024 * 1024 };

/**
 * @sigma/node-image builds two default programs at import time (NodeImageProgram,
 * NodePictogramProgram), and each probes WebGL; without WebGL that throws before the app can fall
 * back to the list. We use neither, so the calls are annotated pure and esbuild drops them.
 */
const pureNodeImageDefaults = {
  name: "pure-node-image-defaults",
  setup(b) {
    b.onLoad({ filter: /sigma-node-image\.esm\.js$/ }, async (args) => {
      const code = await readFile(args.path, "utf8");
      const patched = code.replace(/^var (NodeImageProgram|NodePictogramProgram) = createNodeImageProgram\(/gm, "var $1 = /* @__PURE__ */ createNodeImageProgram(");
      if (patched === code) throw new Error("@sigma/node-image changed: update pureNodeImageDefaults in scripts/build.mjs");
      return { contents: patched, loader: "js" };
    });
  },
};

const common = {
  bundle: true,
  format: "esm",
  target: "es2022",
  legalComments: "none",
  charset: "utf8",
  logLevel: "warning",
};

export async function buildGadget(outDir = dist) {
  await mkdir(outDir, { recursive: true });
  await buildServerEntry({ esbuild, entry: join(pkg, "src/server/index.js"), outDir,
    banner: "// Network Map gadget server: readable RPC surface. Source: packages/blueprint-network-map/src/server.",
    library: { absWorkingDir: pkg } });
  const worker = await build({
    ...common,
    entryPoints: [join(pkg, "src/client/layout/force-worker.js")],
    write: false,
    platform: "browser",
    minify: true,
  });
  const workerCode = worker.outputFiles[0].text;
  const workerUrl = "data:text/javascript;base64," + Buffer.from(workerCode).toString("base64");
  const clientEntry = await buildClientEntry({ esbuild, entry: join(pkg, "src/client/main.js"), outDir,
    banner: "// Network Map gadget client: readable view and adapt block. Source: packages/blueprint-network-map/src/client.",
    library: { absWorkingDir: pkg, minify: true, define: { LAYOUT_WORKER_URL: JSON.stringify(workerUrl) }, plugins: [pureNodeImageDefaults] } });
  await copyFile(join(pkg, "src/README.md"), join(outDir, "README.md"));
  const clientBytes = clientEntry.clientBytes + clientEntry.libraryBytes;
  const sizes = { clientBytes, workerBytes: workerCode.length };
  if (clientBytes > BUDGETS.clientCoreBytes) throw new Error(`client.js is ${clientBytes} bytes; the core budget is ${BUDGETS.clientCoreBytes}`);
  if (clientBytes > BUDGETS.clientTotalBytes) throw new Error(`client JS is ${clientBytes} bytes; the budget is ${BUDGETS.clientTotalBytes}`);
  return { outDir, sizes };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const at = process.argv.indexOf("--out");
  const out = at !== -1 ? resolve(process.argv[at + 1]) : dist;
  const { sizes } = await buildGadget(out);
  console.log(`built ${out}: client ${sizes.clientBytes} bytes (worker ${sizes.workerBytes} inlined)`);
}
