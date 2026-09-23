import { build } from 'esbuild'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(pkg, 'dist')
const require = createRequire(join(pkg, 'package.json'))
/** Budget from docs/plans/tessera-blueprint.md; formats are base64-inlined into the Workshop Worker. */
const CLIENT_BUDGET_BYTES = 1.5 * 1024 * 1024
const kb = n => `${(n / 1024).toFixed(1)} KB`
// absWorkingDir: esbuild's path comments are relative to it, so the output (and the lock hash) must not depend on the caller's cwd.
const common = { absWorkingDir: pkg, bundle: true, format: 'esm', target: 'es2022', legalComments: 'none', logLevel: 'warning' }
const browser = { ...common, platform: 'browser', minify: true, charset: 'ascii' }

/**
 * The layout worker entry: Tessera's `tessera/worker` export once the library refactor lands,
 * else the same file by path in the linked checkout (scratch/tessera/src/layout/worker.ts).
 */
export function workerEntry() {
  try { return require.resolve('tessera/worker') } catch {}
  const fallback = join(pkg, 'node_modules/tessera/src/layout/worker.ts')
  if (existsSync(fallback)) return fallback
  throw new Error('Cannot find the Tessera layout worker: install the tessera dependency (pnpm install).')
}

/**
 * Bundles the worker as one ES module and returns it as a `data:` URL. The gadget CSP allows
 * `data:` scripts (worker-src falls back to script-src) and blocks `blob:`, so this is the only
 * way to run it off the main thread.
 */
export async function workerDataUrl() {
  const result = await build({ ...browser, entryPoints: [workerEntry()], write: false })
  return `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`
}

export async function buildGadget(outDir = dist) {
  await mkdir(outDir, { recursive: true })
  await build({ ...common, minify: false, charset: 'utf8', entryPoints: [join(pkg, 'src/server/index.js')], outfile: join(outDir, 'server.js'), platform: 'neutral', external: ['cloudflare:workers'], banner: { js: '// Tessera Mosaic server. Edit packages/blueprint-tessera.' } })
  const worker = await workerDataUrl()
  await build({ ...browser, entryPoints: [join(pkg, 'src/client/main.js')], outfile: join(outDir, 'client.js'), loader: { '.css': 'text', '.csv': 'text' }, define: { WORKER_DATA_URL: JSON.stringify(worker) }, banner: { js: '// Tessera Mosaic client. Edit packages/blueprint-tessera.' } })
  await copyFile(join(pkg, 'src/README.md'), join(outDir, 'README.md'))
  const size = (await stat(join(outDir, 'client.js'))).size
  console.log(`client.js ${kb(size)} (layout worker ${kb(worker.length)} as a data: URL; budget ${kb(CLIENT_BUDGET_BYTES)})`)
  if (size > CLIENT_BUDGET_BYTES) console.warn('client.js is over the 1.5 MB budget: review the bundle (see the plan\'s Risks section).')
  return outDir
}

if (import.meta.url === `file://${process.argv[1]}`) await buildGadget()
