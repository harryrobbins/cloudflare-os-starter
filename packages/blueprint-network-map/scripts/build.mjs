// Bundles the gadget into the three files a Cloudflare OS gadget is made of:
//   dist/server.js  the `Gadget` Durable Object and `ExportHandler`, one ESM module (unminified,
//                   so it stays legible in the Workshop editor)
//   dist/client.js  the UI, one minified ESM module (the iframe cannot import siblings), with the
//                   layout worker inlined as a data: URL (the CSP blocks blob: workers)
//   dist/README.md  what the in-Workshop agent reads before calling the RPC surface
//
// Budgets (docs/plans/network-map-blueprint.md §2): client JS ≤ 1.5 MiB in total, the core
// ≤ 700 KiB. The build fails when a budget is exceeded; the archive budget is checked by
// pack-gadget.mjs.

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
  await build({
    ...common,
    entryPoints: [join(pkg, "src/server/index.js")],
    outfile: join(outDir, "server.js"),
    platform: "neutral",
    minify: false,
    external: ["cloudflare:workers"],
    banner: { js: "// Network map gadget server. Built from packages/blueprint-network-map; edit there, not here." },
  });
  const worker = await build({
    ...common,
    entryPoints: [join(pkg, "src/client/layout/force-worker.js")],
    write: false,
    platform: "browser",
    minify: true,
  });
  const workerCode = worker.outputFiles[0].text;
  const workerUrl = "data:text/javascript;base64," + Buffer.from(workerCode).toString("base64");
  const client = await build({
    ...common,
    entryPoints: [join(pkg, "src/client/main.js")],
    outfile: join(outDir, "client.js"),
    platform: "browser",
    minify: true,
    metafile: true,
    define: { LAYOUT_WORKER_URL: JSON.stringify(workerUrl) },
    plugins: [pureNodeImageDefaults],
    banner: { js: "// Network map gadget client. Built from packages/blueprint-network-map; edit there, not here." },
  });
  await copyFile(join(pkg, "src/README.md"), join(outDir, "README.md"));
  const clientBytes = Object.values(client.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
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
