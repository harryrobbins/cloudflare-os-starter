// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createExplorer } from '../src/client/app.js'

const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function fakeGadget(count) {
  const records = Array.from({ length: count }, (_, i) => ({ id: uuid(i + 1), entity: 'work_item', revision: i + 1, data: { title: `Item ${i + 1}`, status: 'open', description: '', extensions: {}, ...(i === 0 ? { legacy_key: 'ENG-1' } : {}) } }))
  const journal = []
  const calls = []
  let state = {}
  return {
    calls, journal,
    async getSetup() { return { connected: true, error: null, connection: { url: 'records-service://datastore/x/work/v1/read', datastore: 'ds', binding: 'b-1', label: 'Team <b>work</b>', moduleId: 'work', apiMajor: 1, access: 'read', scopes: ['work.read'] } } },
    async describe() { return { id: 'ds', module_id: 'work', api_major: 1, permission_epoch: 1, granted_scopes: ['work.read'], modules: [{ id: 'work', api_majors: [1], scopes: ['work.read', 'work.write'], entities: ['work_item'], commands: ['work.create', 'work.update'] }] } },
    async model() { return { moduleId: 'work', apiMajor: 1, schemas: { work_item: { type: 'object' } }, profile: { version: '1.0.0', vocabulary: { id: 'https://schema.org/', version: '30.1' }, entities: { work_item: { term: 'urn:records:work:WorkItem', fields: { title: { term: 'https://schema.org/name', type: 'string', required: true }, status: { type: 'string', enum: ['open', 'active', 'done'] }, description: { type: 'string' }, extensions: { type: 'object' } } } } } } },
    async records(query) {
      calls.push(query)
      if (query.id) return { records: records.filter(r => r.id === query.id), seq: 10, permission_epoch: 1 }
      const after = query.after ?? ''
      return { records: records.filter(r => r.id > after).slice(0, query.limit ?? 100), seq: 10, permission_epoch: 1 }
    },
    async changes(after, epoch) { const page = journal.filter(c => c.seq > after); return { changes: page, cursor: page.at(-1)?.seq ?? after, permission_epoch: epoch ?? 1 } },
    async getState() { return state },
    async setState(next) { state = next; return next },
  }
}

const buttonNamed = (root, text) => [...root.querySelectorAll('button')].find(b => b.textContent === text)
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('Records Explorer', () => {
  it('browses entities, pages, inspects and follows activity', async () => {
    const gadget = fakeGadget(50)
    const root = document.createElement('main'); document.body.append(root)
    const app = createExplorer({ gadget, root, timers: false })
    await app.ready

    expect(root.querySelector('.rail').textContent).toContain('work_item')
    expect(root.querySelector('.meta').textContent).toContain('Team <b>work</b>')
    expect(root.querySelector('.meta b')).toBeNull()
    expect(root.querySelectorAll('tbody tr')).toHaveLength(50)
    expect(root.textContent).toContain('Filter loaded rows only')

    root.querySelector('tbody button.link').click(); await flush()
    const inspector = root.querySelector('.inspector')
    expect(inspector.textContent).toContain('legacy_key')
    expect(inspector.textContent).toContain('not in profile')
    expect(inspector.textContent).toContain('https://schema.org/name')
    buttonNamed(inspector, 'Close').click(); await flush()

    buttonNamed(root, 'Next').click(); await flush(); await flush()
    expect(gadget.calls.at(-1)).toEqual({ entity: 'work_item', limit: 50, after: uuid(50) })
    expect(root.textContent).toContain('End of records')
    expect(buttonNamed(root, 'Next').disabled).toBe(true)
    buttonNamed(root, 'Previous').click(); await flush()
    expect(root.querySelectorAll('tbody tr')).toHaveLength(50)

    buttonNamed(root, 'Activity').click(); await flush()
    expect(root.textContent).toContain('not full history')
    gadget.journal.push({ seq: 11, ordinal: 0, entity: 'work_item', record_id: uuid(3), revision: 11, data: { title: 'Renamed' } })
    await app.pollActivity(); await flush()
    expect(root.querySelector('.activity').textContent).toContain('Renamed')
    expect(app.state.activity.cursor).toBe(11)
    app.dispose()
  })

  it('shows an explicit state when not connected', async () => {
    const root = document.createElement('main')
    const app = createExplorer({ gadget: { async getSetup() { return { connected: false, connection: null, error: null } } }, root, timers: false })
    await app.ready
    expect(root.textContent).toContain('Connect a Records datastore')
    expect(buttonNamed(root, 'Retry')).toBeTruthy()
  })

  it('shows an empty datastore', async () => {
    const root = document.createElement('main')
    const app = createExplorer({ gadget: fakeGadget(0), root, timers: false })
    await app.ready
    expect(root.textContent).toContain('No records yet')
  })
})
