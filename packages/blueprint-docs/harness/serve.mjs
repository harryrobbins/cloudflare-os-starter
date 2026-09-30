// Static file server for the Docs harness. Run `node scripts/build.mjs` first (it serves the
// built dist/client.js), then reload after rebuilding. The fake server is the REAL
// src/server/index.js, bundled on each request with "cloudflare:workers" shimmed.
//
//   node harness/serve.mjs [--port 8791]     prints "HARNESS_URL <url>" once listening

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOTS = { harness: join(pkg, "harness"), dist: join(pkg, "dist") };
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

async function serverBundle() {
  const result = await build({
    entryPoints: [join(pkg, "src/server/index.js")],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
    alias: { "cloudflare:workers": join(pkg, "harness/cf-shim.js") },
    logLevel: "warning",
  });
  return result.outputFiles[0].text;
}

const argPort = process.argv.indexOf("--port");
const requested = Number(argPort !== -1 ? process.argv[argPort + 1] : process.env.PORT || 8791);
const HOST = process.env.HOST || "127.0.0.1";

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://x");
    if (url.pathname === "/" || url.pathname === "/harness") {
      res.writeHead(302, { location: "/harness/" + url.search });
      res.end();
      return;
    }
    if (url.pathname === "/harness/server.js") {
      res.writeHead(200, { "content-type": TYPES[".js"], "cache-control": "no-store" });
      res.end(await serverBundle());
      return;
    }
    const [, top, ...rest] = decodeURIComponent(url.pathname).split("/");
    const root = ROOTS[top];
    if (!root) return notFound(res);
    let file = normalize(join(root, ...rest));
    if (file !== root && !file.startsWith(root + sep)) return notFound(res);
    let info = await stat(file).catch(() => null);
    if (info?.isDirectory()) {
      file = join(file, "index.html");
      info = await stat(file).catch(() => null);
    }
    if (!info?.isFile()) return notFound(res);
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(await readFile(file));
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(String(err?.stack || err));
  }
});

function notFound(res) {
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}

let port = requested;
server.on("error", (err) => {
  if (err.code === "EADDRINUSE" && port < requested + 20) {
    port++;
    server.listen(port, HOST);
  } else {
    console.error(err);
    process.exit(1);
  }
});
server.on("listening", () => console.log(`HARNESS_URL http://${HOST}:${port}/harness/`));
server.listen(port, HOST);
