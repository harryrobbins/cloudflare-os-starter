import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseArchive } from '../scripts/archive.mjs'
import { BINDINGS, contentHash, freshFiles, packArchive, staleReasons } from '../scripts/pack-gadget.mjs'

describe('gadget archive', () => {
  it('declares no bindings, so New is one click and opens on demo data', () => {
    const bytes = packArchive({ 'server.js': 'server', 'client.js': 'client', 'README.md': 'readme' }, { title: 'Tessera', description: 'test', author: { type: 'user', name: 'Test', id: 'test' }, output: { id: 'tessera', noun: 'Mosaic', plural: 'Mosaics', icon: 'chartBar' }, revision: 1 })
    const archive = parseArchive(bytes)
    expect(BINDINGS).toEqual({})
    expect(archive.metadata.bindings).toEqual({})
    expect(archive.files['client.js']).toBe('client')
  })

  it('keeps the stable blueprint id and only the allowed sidecar keys', async () => {
    const sidecar = JSON.parse(await readFile(new URL('../../../formats/tessera.json', import.meta.url), 'utf8'))
    expect(sidecar.blueprintId).toBe('format.tessera')
    expect(Object.keys(sidecar).every(key => ['blueprintId', 'title', 'description', 'output', 'author', 'revision', '$comment'].includes(key))).toBe(true)
  })

  it('--check compares a fresh build, not whatever is in dist/', async () => {
    const sidecar = { title: 'T', description: 'd', author: { type: 'user', name: 'n', id: 'i' }, output: { id: 'tessera' }, revision: 3 }
    const committedFiles = { 'server.js': 'old server', 'client.js': 'old client', 'README.md': 'readme' }
    const committed = { sidecar, lock: { revision: 3, contentHash: contentHash(committedFiles) }, archive: packArchive(committedFiles, sidecar) }
    expect(staleReasons(committedFiles, committed)).toEqual([])

    let builtInto = null
    const fresh = await freshFiles(async dir => {
      builtInto = dir
      await Promise.all(Object.entries({ ...committedFiles, 'client.js': 'new client' }).map(([name, text]) => writeFile(join(dir, name), text)))
    })
    expect(builtInto).not.toContain('/dist')
    expect(fresh['client.js']).toBe('new client')
    expect(staleReasons(fresh, committed)).toEqual(['gadget.lock.json content hash differs from a fresh build', 'formats/tessera.gadget differs from a fresh build'])
    expect(staleReasons(committedFiles, { ...committed, lock: { ...committed.lock, revision: 2 } })).toEqual(['gadget.lock.json revision 2 differs from formats/tessera.json revision 3'])
  })
})
