import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { encodeContent, serializeArchive } from './archive.mjs'
import { buildGadget } from './build.mjs'

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')
const repo = join(pkg, '../..')
const FILES = ['server.js', 'client.js', 'README.md']
const FIXED_DATE = '2026-09-23T00:00:00.000Z'
export const paths = { sidecar: join(repo, 'formats/tessera.json'), archive: join(repo, 'formats/tessera.gadget'), lock: join(pkg, 'gadget.lock.json') }
// No bindings: any declared binding forces New through /blueprint/<id> setup, and the platform has
// no optional flag. A connector is added later in the gadget's Connections tab.
export const BINDINGS = Object.freeze({})
export async function readDist(distDir) { return Object.fromEntries(await Promise.all(FILES.map(async name => [name, await readFile(join(distDir, name), 'utf8')]))) }
export function contentHash(files) { const hash = createHash('sha256'); for (const name of Object.keys(files).toSorted()) hash.update(name).update('\0').update(files[name]).update('\0'); return hash.digest('hex') }
export function packArchive(files, sidecar) {
  return serializeArchive({ title: sidecar.title, description: sidecar.description, author: sidecar.author, created: FIXED_DATE, lastUpdated: FIXED_DATE, version: sidecar.revision, bindings: BINDINGS, output: sidecar.output }, encodeContent(files))
}
/** Builds the gadget from source into a temporary directory and returns its files, so a stale dist/ cannot pass. */
export async function freshFiles(build = buildGadget) {
  const dir = await mkdtemp(join(tmpdir(), 'tessera-gadget-'))
  try { await build(dir); return await readDist(dir) } finally { await rm(dir, { recursive: true, force: true }) }
}
/** Why the committed archive does not match `files`, or [] when it is current. */
export function staleReasons(files, { sidecar, lock, archive }) {
  const hash = contentHash(files); const reasons = []
  if (lock.contentHash !== hash) reasons.push('gadget.lock.json content hash differs from a fresh build')
  if (lock.revision !== sidecar.revision) reasons.push(`gadget.lock.json revision ${lock.revision} differs from formats/tessera.json revision ${sidecar.revision}`)
  if (Buffer.compare(Buffer.from(packArchive(files, sidecar)), Buffer.from(archive)) !== 0) reasons.push('formats/tessera.gadget differs from a fresh build')
  return reasons
}
async function readCommitted() {
  const sidecar = JSON.parse(await readFile(paths.sidecar, 'utf8')); const lock = JSON.parse(await readFile(paths.lock, 'utf8').catch(() => '{"revision":0,"contentHash":""}'))
  const archive = new Uint8Array(await readFile(paths.archive).catch(() => Buffer.alloc(0)))
  return { sidecar, lock, archive }
}
async function main() {
  if (process.argv.includes('--check')) {
    const committed = await readCommitted(); const reasons = staleReasons(await freshFiles(), committed)
    if (reasons.length) { console.error(`formats/tessera.gadget is stale (${reasons.join('; ')}); run: pnpm --filter blueprint-tessera pack:gadget`); process.exit(1) }
    console.log(`formats/tessera.gadget is current (revision ${committed.sidecar.revision})`); return
  }
  const files = await readDist(join(pkg, 'dist')); const hash = contentHash(files); const { sidecar, lock } = await readCommitted()
  if (lock.contentHash !== hash) { sidecar.revision = Math.max(sidecar.revision, lock.revision) + (lock.contentHash ? 1 : 0); await writeFile(paths.sidecar, JSON.stringify(sidecar, null, 2) + '\n'); await writeFile(paths.lock, JSON.stringify({ revision: sidecar.revision, contentHash: hash }, null, 2) + '\n') }
  const bytes = packArchive(files, sidecar); await writeFile(paths.archive, bytes); console.log(`packed formats/tessera.gadget (${bytes.byteLength} bytes, revision ${sidecar.revision})`)
}
if (import.meta.url === `file://${process.argv[1]}`) await main()
