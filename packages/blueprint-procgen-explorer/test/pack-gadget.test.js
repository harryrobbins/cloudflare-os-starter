import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { parseArchive } from '../scripts/archive.mjs'
import { PROCGEN_BINDINGS, packArchive } from '../scripts/pack-gadget.mjs'

describe('gadget archive', () => {
  it('declares the required synthetic dataset capability', () => {
    const bytes = packArchive({ 'server.js': 'server', 'client.js': 'client', 'README.md': 'readme' }, { title: 'Explorer', description: 'test', author: { type: 'user', name: 'Test', id: 'test' }, output: { id: 'explorer', noun: 'Explorer', plural: 'Explorers', icon: 'table' }, revision: 1 })
    const archive = parseArchive(bytes)
    expect(archive.metadata.bindings).toEqual(PROCGEN_BINDINGS)
    expect(archive.files['client.js']).toBe('client')
  })

  it('keeps the stable blueprint id in its sidecar', async () => {
    const sidecar = JSON.parse(await readFile(new URL('../../../formats/procgen-explorer.json', import.meta.url), 'utf8'))
    expect(sidecar.blueprintId).toBe('format.procgen-explorer')
  })
})
