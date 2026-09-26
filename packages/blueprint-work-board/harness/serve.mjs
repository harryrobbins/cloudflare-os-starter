// @ts-check
// Static server for the Work Board harness. /harness/parent.js is bundled with esbuild on each
// request (the real gadget server api.js, the fake Records service, the seed and capnweb);
// /dist/client.js is served as built, so rebuild with `node scripts/build.mjs` and reload.
//
//   node harness/serve.mjs [--port 8795] [--dist dist]   then open http://127.0.0.1:8795/?seed=300
//
// Binds 127.0.0.1 only. Prints "HARNESS_URL <url>" once listening. No file watching.

import { build } from "esbuild";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const harness = join(pkg, "harness");
const argDist = process.argv.indexOf("--dist");
const dist = argDist !== -1 ? resolve(process.argv[argDist + 1]) : join(pkg, "dist");
const require = createRequire(join(pkg, "package.json"));
/** @type {Record<string, string>} */
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".md": "text/markdown; charset=utf-8" };

/** The browser build of capnweb, the file Vite's `capnweb?raw` yields for GadgetUI.tsx. */
function capnwebBrowserFile() {
  return join(dirname(require.resolve("capnweb")), "index.js");
}
/** @type {import("esbuild").Plugin} */
const rawCapnweb = {
  name: "capnweb-raw",
  setup(b) {
    b.onResolve({ filter: /^capnweb\?raw$/ }, () => ({ path: capnwebBrowserFile(), namespace: "raw" }));
    b.onLoad({ filter: /.*/, namespace: "raw" }, async (args) => ({ contents: await readFile(args.path, "utf8"), loader: "text" }));
  },
};

async function bundleParent() {
  const result = await build({
    entryPoints: [join(harness, "parent.js")], bundle: true, write: false, format: "esm", platform: "browser",
    target: "es2022", charset: "utf8", sourcemap: "inline", logLevel: "warning", plugins: [rawCapnweb], conditions: ["browser"],
  });
  return result.outputFiles[0].contents;
}

const argPort = process.argv.indexOf("--port");
const port = Number(argPort !== -1 ? process.argv[argPort + 1] : process.env.PORT || 8795);
const HOST = "127.0.0.1";

const server = createServer(async (req, res) => {
  const send = (/** @type {number} */ code, /** @type {string} */ type, /** @type {any} */ body) => { res.writeHead(code, { "content-type": type, "cache-control": "no-store" }); res.end(body); };
  try {
    const url = new URL(req.url || "/", "http://x");
    const path = decodeURIComponent(url.pathname);
    if (path === "/" || path === "/index.html") return send(200, TYPES[".html"], await readFile(join(harness, "index.html")));
    if (path === "/harness/parent.js") return send(200, TYPES[".js"], await bundleParent());
    if (path.startsWith("/dist/")) {
      const file = normalize(join(dist, path.slice("/dist/".length)));
      if (!file.startsWith(dist + sep) || !(await stat(file).catch(() => null))?.isFile()) return send(404, "text/plain", "not found");
      return send(200, TYPES[extname(file)] || "application/octet-stream", await readFile(file));
    }
    send(404, "text/plain", "not found");
  } catch (error) {
    send(500, "text/plain", String(/** @type {any} */ (error)?.stack || error));
  }
});
server.on("error", (error) => { console.error(error); process.exit(1); });
server.listen(port, HOST, () => console.log(`HARNESS_URL http://${HOST}:${port}/`));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { server.close(); process.exit(0); });
