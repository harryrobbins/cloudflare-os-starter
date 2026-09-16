// Static file server for the multi-user harness. No watching, no bundling: run
// `node scripts/build.mjs` first, then reload the page after rebuilding.
//
//   node harness/serve.mjs [--port 8790]
//
// Serves /harness/*, /dist/* and /src/* from this package (the harness imports src/core and
// src/shared as browser ES modules). Prints "HARNESS_URL <url>" once listening.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOTS = { harness: join(pkg, "harness"), dist: join(pkg, "dist"), src: join(pkg, "src") };
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const argPort = process.argv.indexOf("--port");
const requested = Number(argPort !== -1 ? process.argv[argPort + 1] : process.env.PORT || 8790);
const HOST = process.env.HOST || "127.0.0.1";

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://x");
    if (url.pathname === "/" || url.pathname === "/harness") {
      res.writeHead(302, { location: "/harness/" + url.search });
      res.end();
      return;
    }
    const [, top, ...rest] = decodeURIComponent(url.pathname).split("/");
    const root = ROOTS[/** @type {keyof typeof ROOTS} */ (top)];
    if (!root) return notFound(res);
    let file = normalize(join(root, ...rest));
    if (file !== root && !file.startsWith(root + sep)) return notFound(res);
    let info = await stat(file).catch(() => null);
    if (info?.isDirectory()) {
      file = join(file, "index.html");
      info = await stat(file).catch(() => null);
    }
    if (!info?.isFile()) return notFound(res);
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(String(err));
  }
});

/** @param {import("node:http").ServerResponse} res */
function notFound(res) {
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}

let port = requested;
server.on("error", (err) => {
  if (/** @type {any} */ (err).code === "EADDRINUSE" && port < requested + 20) {
    port++;
    server.listen(port, HOST);
  } else {
    console.error(err);
    process.exit(1);
  }
});
server.on("listening", () => {
  console.log(`HARNESS_URL http://${HOST}:${port}/harness/`);
});
server.listen(port, HOST);

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { server.close(); process.exit(0); });
