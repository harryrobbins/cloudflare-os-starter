// Static server for the Tessera fidelity harness (plan Part C). No watching: /harness/parent.js is
// bundled with esbuild on each request (the real src/server/core.js, test/fake-procgen.js and
// capnweb), and /dist/client.js is served as built, so rebuild with `node scripts/build.mjs` and
// reload the page.
//
//   node harness/serve.mjs [--port 8791]     then open http://127.0.0.1:8791/  (add ?procgen=1)
//
// Binds 127.0.0.1 only. Prints "HARNESS_URL <url>" once listening.

import { build } from 'esbuild'
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')
const harness = join(pkg, 'harness')
const dist = join(pkg, 'dist')
const require = createRequire(join(pkg, 'package.json'))
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' }

/** The browser build of capnweb, the file Vite's `capnweb?raw` yields for GadgetUI.tsx:10. */
function capnwebBrowserFile() {
  const entry = require.resolve('capnweb') // the "import"/"require" condition: dist/index.(c)js
  return join(dirname(entry), 'index.js')
}

/** esbuild plugin: `capnweb?raw` imports the capnweb browser bundle as a string, as Vite does. */
const rawCapnweb = {
  name: 'capnweb-raw',
  setup(b) {
    b.onResolve({ filter: /^capnweb\?raw$/ }, () => ({ path: capnwebBrowserFile(), namespace: 'raw' }))
    b.onLoad({ filter: /.*/, namespace: 'raw' }, async args => ({ contents: await readFile(args.path, 'utf8'), loader: 'text' }))
  },
}

async function bundleParent() {
  const result = await build({
    entryPoints: [join(harness, 'parent.js')], bundle: true, write: false, format: 'esm', platform: 'browser',
    target: 'es2022', charset: 'utf8', sourcemap: 'inline', logLevel: 'warning', plugins: [rawCapnweb],
    inject: [join(harness, 'buffer-shim.js')], conditions: ['browser'],
  })
  return result.outputFiles[0].contents
}

const argPort = process.argv.indexOf('--port')
const port = Number(argPort !== -1 ? process.argv[argPort + 1] : process.env.PORT || 8791)
const HOST = '127.0.0.1'

const server = createServer(async (req, res) => {
  const send = (status, type, body) => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body) }
  try {
    const url = new URL(req.url || '/', 'http://x')
    const path = decodeURIComponent(url.pathname)
    if (path === '/' || path === '/harness' || path === '/harness/' || path === '/index.html') return send(200, TYPES['.html'], await readFile(join(harness, 'index.html')))
    if (path === '/harness/parent.js') return send(200, TYPES['.js'], await bundleParent())
    if (path.startsWith('/dist/')) {
      const file = normalize(join(dist, path.slice('/dist/'.length)))
      if (!file.startsWith(dist + sep) || !(await stat(file).catch(() => null))?.isFile()) return send(404, 'text/plain', 'not found')
      return send(200, TYPES[extname(file)] || 'application/octet-stream', await readFile(file))
    }
    send(404, 'text/plain', 'not found')
  } catch (error) {
    send(500, 'text/plain', String(error?.stack || error))
  }
})

server.on('error', error => { console.error(error); process.exit(1) })
server.listen(port, HOST, () => console.log(`HARNESS_URL http://${HOST}:${port}/`))
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(); process.exit(0) })
