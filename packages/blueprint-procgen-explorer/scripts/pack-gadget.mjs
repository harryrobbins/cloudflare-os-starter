import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { encodeContent, serializeArchive } from './archive.mjs'

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')
const repo = join(pkg, '../..')
const FILES = ['server.js', 'client.js', 'README.md']
const FIXED_DATE = '2026-09-17T00:00:00.000Z'
export const paths = { sidecar: join(repo, 'formats/procgen-explorer.json'), archive: join(repo, 'formats/procgen-explorer.gadget'), lock: join(pkg, 'gadget.lock.json') }
export const PROCGEN_BINDINGS = {
  PROCGEN: {
    title: 'Synthetic Data',
    description: 'The finite, deterministic synthetic dataset to explore.',
    type: 'gatekeeper',
    gatekeeperName: 'procgen',
    typeUrlPattern: 'procgen://commerce/v1/:seed/:profile',
  },
}
export async function readDist(distDir) { return Object.fromEntries(await Promise.all(FILES.map(async name => [name, await readFile(join(distDir, name), 'utf8')]))) }
export function contentHash(files) { const hash = createHash('sha256'); for (const name of Object.keys(files).toSorted()) hash.update(name).update('\0').update(files[name]).update('\0'); return hash.digest('hex') }
export function packArchive(files, sidecar) {
  return serializeArchive({ title: sidecar.title, description: sidecar.description, author: sidecar.author, created: FIXED_DATE, lastUpdated: FIXED_DATE, version: sidecar.revision, bindings: PROCGEN_BINDINGS, output: sidecar.output }, encodeContent(files))
}
async function main() {
  const check = process.argv.includes('--check'); const files = await readDist(join(pkg, 'dist')); const hash = contentHash(files)
  const sidecar = JSON.parse(await readFile(paths.sidecar, 'utf8')); const lock = JSON.parse(await readFile(paths.lock, 'utf8').catch(() => '{"revision":0,"contentHash":""}'))
  if (check) {
    const expected = packArchive(files, sidecar); const actual = new Uint8Array(await readFile(paths.archive).catch(() => Buffer.alloc(0)))
    if (lock.contentHash !== hash || lock.revision !== sidecar.revision || Buffer.compare(Buffer.from(expected), Buffer.from(actual)) !== 0) { console.error('formats/procgen-explorer.gadget is stale; run: pnpm --filter blueprint-procgen-explorer pack:gadget'); process.exit(1) }
    console.log(`formats/procgen-explorer.gadget is current (revision ${sidecar.revision})`); return
  }
  if (lock.contentHash !== hash) { sidecar.revision = Math.max(sidecar.revision, lock.revision) + (lock.contentHash ? 1 : 0); await writeFile(paths.sidecar, JSON.stringify(sidecar, null, 2) + '\n'); await writeFile(paths.lock, JSON.stringify({ revision: sidecar.revision, contentHash: hash }, null, 2) + '\n') }
  const bytes = packArchive(files, sidecar); await writeFile(paths.archive, bytes); console.log(`packed formats/procgen-explorer.gadget (${bytes.byteLength} bytes, revision ${sidecar.revision})`)
}
if (import.meta.url === `file://${process.argv[1]}`) await main()
