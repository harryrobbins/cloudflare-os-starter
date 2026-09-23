import { describe, expect, it, vi } from 'vitest'
import { isBrokenStubError } from '../src/client/helpers.js'
import { createCore, isMissingMethod, jsonBytes, PROBE_RETRY_MS, SIZE_FAILURE_MS, STATE_KEY } from '../src/server/core.js'
import { mapColumns, procgen } from '../src/server/sources/procgen.js'
import { fakeProcgen, memoryStorage } from './fake-procgen.js'

const queries = session => session.calls.filter(([name]) => name === 'query')
const never = () => new Promise(() => {})
const probes = session => session.calls.filter(([name]) => name === 'describeDataset').length

describe('procgen adapter', () => {
  it('pages 100 rows at a time with a fixed limit and stops at the cap', async () => {
    const session = fakeProcgen()
    const table = await procgen.loadTable(session, 'orders', { maxRows: 250 })
    expect(table.rows).toHaveLength(250)
    expect(queries(session).map(([, request]) => request.limit)).toEqual([100, 100, 100])
    expect(queries(session)[1][1].cursor).toBeTruthy()
    expect(table).toMatchObject({ name: 'Orders', truncated: true, totalRows: 10_000 })
  })

  it('reads a whole small table and reports it complete', async () => {
    const session = fakeProcgen()
    const table = await procgen.loadTable(session, 'daily_metrics', { maxRows: 2_000 })
    expect(table.rows).toHaveLength(730)
    expect(table.truncated).toBe(false)
    expect(table.totalRows).toBe(730)
    expect(queries(session)).toHaveLength(8)
  })

  it('uses a limit under 100 when the cap is smaller', async () => {
    const session = fakeProcgen()
    const table = await procgen.loadTable(session, 'customers', { maxRows: 7 })
    expect(table.rows).toHaveLength(7)
    expect(queries(session)).toHaveLength(1)
    expect(queries(session)[0][1]).toEqual({ collection: 'customers', limit: 7 })
  })

  it('maps fields to columns: drops json, keeps timestamps and semantics, adds currency', async () => {
    const events = await procgen.loadTable(fakeProcgen(), 'events', { maxRows: 3 })
    expect(events.columns.map(c => c.name)).toEqual(['id', 'customer_id', 'event_type', 'occurred_at'])
    expect(events.columns[3]).toEqual({ name: 'occurred_at', type: 'timestamp' })
    expect(events.columns[0]).toEqual({ name: 'id', type: 'string', semantic: 'id' })
    expect(events.rows[0]).toHaveLength(4)

    const metrics = await procgen.loadTable(fakeProcgen(), 'daily_metrics', { maxRows: 1 })
    expect(metrics.columns.find(c => c.name === 'revenue_minor')).toEqual({ name: 'revenue_minor', type: 'number', semantic: 'currency_minor', currency: 'USD' })
    expect(metrics.columns.find(c => c.name === 'conversion_rate')).toEqual({ name: 'conversion_rate', type: 'number' })
    const date = metrics.columns.findIndex(c => c.name === 'date')
    expect(metrics.rows[0][date]).toBe('2023-01-01T00:00:00.000Z')

    const items = await procgen.loadTable(fakeProcgen(), 'order_items', { maxRows: 1 })
    expect(items.columns.find(c => c.name === 'unit_price_minor')).toEqual({ name: 'unit_price_minor', type: 'number', semantic: 'currency_minor' })
  })

  it('ignores a malformed currency code and fills missing values with null', () => {
    expect(mapColumns([{ name: 'x_minor', type: 'number', semanticType: 'currency_minor' }], { currency_code: 'dollars' })).toEqual([{ name: 'x_minor', type: 'number', semantic: 'currency_minor' }])
  })

  it('lists tables with exactRecords as numbers', async () => {
    const tables = await procgen.listTables(fakeProcgen())
    expect(tables.find(t => t.name === 'orders')).toMatchObject({ name: 'orders', title: 'Orders', exactRecords: 10_000 })
  })

  it('stops paging on a repeated cursor or a page that adds no rows, and skips null records', async () => {
    const pages = [
      { schema: { fields: [{ name: 'id', type: 'number' }], exactRecords: '1000' }, records: [null, { id: 1 }, 'x', { id: 2 }], nextCursor: 'a' },
      { records: [{ id: 3 }], nextCursor: 'a' },
      { records: [{ id: 4 }], nextCursor: 'b' },
    ]
    const repeat = { query: vi.fn(async () => pages[repeat.query.mock.calls.length - 1]) }
    const table = await procgen.loadTable(repeat, 't', { maxRows: 500 })
    expect(table.rows).toEqual([[1], [2], [3]])
    expect(repeat.query).toHaveBeenCalledTimes(2)
    expect(table).toMatchObject({ truncated: true, totalRows: 1000 })

    let n = 0
    const empty = { query: vi.fn(async () => ({ schema: { fields: [{ name: 'id', type: 'number' }] }, records: n++ ? [] : [{ id: 1 }], nextCursor: `c${n}` })) }
    const stalled = await procgen.loadTable(empty, 't', { maxRows: 500 })
    expect(stalled.rows).toEqual([[1]])
    expect(empty.query).toHaveBeenCalledTimes(2)
    expect(stalled.truncated).toBe(true)

    const nulls = { query: vi.fn(async () => ({ schema: null, records: [null], nextCursor: 'z' })) }
    expect((await procgen.loadTable(nulls, 't', { maxRows: 5 })).rows).toEqual([])
    expect(nulls.query).toHaveBeenCalledTimes(1)
  })

  it('hands each page\'s new rows to onPage, which can abort the read', async () => {
    const session = fakeProcgen()
    const seen = []
    await expect(procgen.loadTable(session, 'orders', { maxRows: 1_000, onPage: rows => { seen.push(rows.length); if (seen.length === 2) throw new Error('stop') } })).rejects.toThrow('stop')
    expect(seen).toEqual([100, 100])
    expect(queries(session)).toHaveLength(2)
  })

  it('probes: procgen answers with a scenario, other services do not', async () => {
    expect(await procgen.probe(fakeProcgen())).toEqual({ title: 'Synthetic Data', description: 'commerce, v1, small profile, seed demo' })
    expect(await procgen.probe({ describeDataset: async () => ({ name: 'other' }) })).toBeNull()
  })
})

describe('core state', () => {
  it('opens on the demo default and round-trips a validated state with a server rev', async () => {
    const storage = memoryStorage()
    const core = createCore({ env: {}, storage })
    expect(await core.getState()).toEqual({ source: { kind: 'demo' }, rev: 0 })
    const view = { layout: 'bars', color: 'Status', sort: '', bucket: 'Region', filters: [{ field: 'Status', labels: ['Open', 'Closed'] }] }
    const saved = await core.setState({ source: { kind: 'demo', key: 'tax-cases:3000' }, view, rev: 0 })
    expect(saved).toEqual({ source: { kind: 'demo', key: 'tax-cases:3000' }, view, rev: 1 })
    expect(await core.getState()).toEqual(saved)
    const next = await core.setState({ source: { kind: 'connector', sourceId: 'PROCGEN', table: 'orders', maxRows: 20_000 } })
    expect(next).toEqual({ source: { kind: 'connector', sourceId: 'PROCGEN', table: 'orders', maxRows: 10_000 }, rev: 2 })
    expect(storage.map.get(STATE_KEY)).toEqual(next)
  })

  it('rejects invalid state without overwriting the stored one', async () => {
    const storage = memoryStorage()
    const core = createCore({ env: {}, storage })
    await core.setState({ source: { kind: 'demo' } })
    await expect(core.setState({ source: { kind: 'connector', sourceId: 'PROCGEN', table: '../x' } })).rejects.toThrow('table name')
    expect((await core.getState()).rev).toBe(1)
  })
})

describe('connector detection', () => {
  it('lists demo alone when nothing is bound', async () => {
    expect(await createCore({ env: {}, storage: memoryStorage() }).listSources()).toEqual([{ id: 'demo', kind: 'demo', title: 'Demo collections' }])
  })

  it('uses PROCGEN bindings without probing anything else, and caches detection', async () => {
    const other = { describeDataset: vi.fn(async () => ({ scenario: 'x' })) }
    const env = { PROCGEN: fakeProcgen(), PROCGEN_2: fakeProcgen({ seed: 'b' }), OTHER: other, GADGET: {}, SOME_VAR: 'text' }
    const core = createCore({ env, storage: memoryStorage() })
    const sources = await core.listSources()
    expect(sources.map(s => s.id)).toEqual(['demo', 'PROCGEN', 'PROCGEN_2'])
    expect(sources[1]).toMatchObject({ kind: 'procgen', title: 'Synthetic Data', description: 'commerce, v1, small profile, seed demo' })
    expect(sources[1].tables).toHaveLength(6)
    await core.listSources()
    expect(other.describeDataset).not.toHaveBeenCalled()
    expect(env.PROCGEN.calls.map(([name]) => name)).toEqual(['describeDataset', 'listCollections'])
  })

  it('finds a renamed procgen binding by probing, never GADGET, and skips non-procgen bindings', async () => {
    const gadget = { describeDataset: vi.fn() }
    const kv = { get: async () => null }
    const service = { describeDataset: async () => { throw new Error('no such method') } }
    const env = { DATA: fakeProcgen(), GADGET: gadget, KV: kv, SERVICE: service }
    const core = createCore({ env, storage: memoryStorage() })
    const sources = await core.listSources()
    expect(sources.map(s => s.id)).toEqual(['demo', 'DATA'])
    expect(gadget.describeDataset).not.toHaveBeenCalled()
  })

  it('gives each probe a timeout and probes an unrelated binding at most once', async () => {
    vi.useFakeTimers()
    try {
      const slow = { describeDataset: vi.fn(never) }
      const core = createCore({ env: { SLOW: slow, DATA: fakeProcgen() }, storage: memoryStorage() })
      const pending = core.listSources()
      await vi.advanceTimersByTimeAsync(3_000)
      expect((await pending).map(s => s.id)).toEqual(['demo', 'DATA'])
      await core.listSources()
      expect(slow.describeDataset).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })

  it('lists a failing PROCGEN binding with its error and retries it after the backoff', async () => {
    vi.useFakeTimers()
    try {
      let hang = true
      const session = fakeProcgen({ describe: () => hang ? never() : { scenario: 'commerce', version: 'v1', seedLabel: 's', sizeProfile: 'small' } })
      const core = createCore({ env: { PROCGEN: session }, storage: memoryStorage() })
      const pending = core.listSources()
      await vi.advanceTimersByTimeAsync(3_000)
      const [, failed] = await pending
      expect(failed).toMatchObject({ id: 'PROCGEN', kind: 'procgen', error: 'Binding PROCGEN did not answer within 3 s.' })
      await expect(core.loadTable('PROCGEN', 'orders')).rejects.toThrow('Data source PROCGEN is unavailable: Binding PROCGEN did not answer')
      hang = false
      expect((await core.listSources())[1].error).toBeTruthy()
      expect(session.calls.filter(([name]) => name === 'describeDataset')).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(PROBE_RETRY_MS)
      expect((await core.listSources())[1].tables).toHaveLength(6)
      expect(session.calls.filter(([name]) => name === 'describeDataset')).toHaveLength(2)
    } finally { vi.useRealTimers() }
  })

  it('caches each PROCGEN binding on its own: a failing one never re-probes a healthy one', async () => {
    vi.useFakeTimers()
    try {
      const good = fakeProcgen()
      let fail = true
      const bad = fakeProcgen({ describe: () => { if (fail) throw new Error('gatekeeper restarting'); return { scenario: 'commerce' } } })
      const core = createCore({ env: { PROCGEN: good, PROCGEN_2: bad }, storage: memoryStorage() })
      const first = await core.listSources()
      expect(first[2]).toMatchObject({ id: 'PROCGEN_2', error: 'gatekeeper restarting' })
      await core.listSources()
      await core.loadTable('PROCGEN', 'customers', { maxRows: 5 })
      expect(probes(good)).toBe(1)
      expect(probes(bad)).toBe(1)
      fail = false
      await vi.advanceTimersByTimeAsync(PROBE_RETRY_MS - 1)
      expect((await core.listSources())[2].error).toBe('gatekeeper restarting')
      await vi.advanceTimersByTimeAsync(1)
      expect((await core.listSources())[2].tables).toHaveLength(6)
      expect(probes(good)).toBe(1)
      expect(probes(bad)).toBe(2)
    } finally { vi.useRealTimers() }
  })

  it('never re-probes a fallback binding that answered or lacks the method, but retries a rejected one after the backoff', async () => {
    vi.useFakeTimers()
    try {
      const answered = { describeDataset: vi.fn(async () => ({ name: 'sessions' })) }
      const missing = { describeDataset: vi.fn(async () => { throw new Error('The RPC receiver does not implement the method "describeDataset".') }) }
      const kv = { get: vi.fn() }
      let flaky = true
      const renamed = fakeProcgen({ describe: () => { if (flaky) throw new Error('Network connection lost.'); return { scenario: 'commerce' } } })
      const core = createCore({ env: { ACTIVITY: answered, MISSING: missing, KV: kv, DATA: renamed }, storage: memoryStorage() })
      expect((await core.listSources()).map(s => s.id)).toEqual(['demo'])
      flaky = false
      expect((await core.listSources()).map(s => s.id)).toEqual(['demo'])
      await vi.advanceTimersByTimeAsync(PROBE_RETRY_MS)
      expect((await core.listSources()).map(s => s.id)).toEqual(['demo', 'DATA'])
      await vi.advanceTimersByTimeAsync(PROBE_RETRY_MS)
      await core.listSources()
      expect(answered.describeDataset).toHaveBeenCalledTimes(1)
      expect(missing.describeDataset).toHaveBeenCalledTimes(1)
      expect(renamed.calls.filter(([name]) => name === 'describeDataset')).toHaveLength(2)
    } finally { vi.useRealTimers() }
  })

  it('tells a missing method from a transient failure', () => {
    expect(isMissingMethod(new TypeError('stub.describeDataset is not a function'))).toBe(true)
    expect(isMissingMethod(new Error('The RPC receiver does not implement the method "describeDataset".'))).toBe(true)
    expect(isMissingMethod(new Error('Binding X did not answer within 3 s.'))).toBe(false)
    expect(isMissingMethod(new Error('Network connection lost.'))).toBe(false)
  })
})

describe('core loadTable', () => {
  it('defaults to 2,000 rows and clamps maxRows to 1-10,000', async () => {
    const env = { PROCGEN: fakeProcgen() }
    const core = createCore({ env, storage: memoryStorage() })
    expect((await core.loadTable('PROCGEN', 'orders')).rows).toHaveLength(2_000)
    expect((await core.loadTable('PROCGEN', 'customers', { maxRows: 0 })).rows).toHaveLength(1)
    const big = await core.loadTable('PROCGEN', 'events', { maxRows: 50_000 })
    expect(big.rows).toHaveLength(10_000)
    expect(big).toMatchObject({ truncated: true, totalRows: 50_000 })
  })

  it('caches tables in memory and serves smaller caps from a larger load', async () => {
    const session = fakeProcgen()
    const storage = memoryStorage()
    const core = createCore({ env: { PROCGEN: session }, storage })
    const first = await core.loadTable('PROCGEN', 'orders', { maxRows: 500 })
    const before = queries(session).length
    expect(await core.loadTable('PROCGEN', 'orders', { maxRows: 500 })).toBe(first)
    const smaller = await core.loadTable('PROCGEN', 'orders', { maxRows: 120 })
    expect(smaller.rows).toEqual(first.rows.slice(0, 120))
    expect(queries(session).length).toBe(before)
    await core.loadTable('PROCGEN', 'orders', { maxRows: 600 })
    expect(queries(session).length).toBe(before + 6)
    expect(storage.map.size).toBe(0)
  })

  it('serves any cap from a complete table without further reads', async () => {
    const session = fakeProcgen()
    const core = createCore({ env: { PROCGEN: session }, storage: memoryStorage() })
    await core.loadTable('PROCGEN', 'daily_metrics', { maxRows: 1_000 })
    const before = queries(session).length
    expect((await core.loadTable('PROCGEN', 'daily_metrics', { maxRows: 10_000 })).rows).toHaveLength(730)
    expect(queries(session).length).toBe(before)
  })

  it('names unknown tables and sources, and validates arguments before any read', async () => {
    const session = fakeProcgen()
    const core = createCore({ env: { PROCGEN: session }, storage: memoryStorage() })
    await expect(core.loadTable('PROCGEN', 'nope')).rejects.toThrow('Unknown table "nope" in PROCGEN; tables: customers, products, orders, order_items, events, daily_metrics.')
    await expect(core.loadTable('PROCGEN_9', 'orders')).rejects.toThrow("Connections tab")
    await expect(core.loadTable('PROCGEN', 'Orders; drop')).rejects.toThrow('Invalid table name')
    await expect(core.loadTable('demo', 'orders')).rejects.toThrow('Invalid source id')
    expect(queries(session)).toHaveLength(0)
  })

  it('refuses a result as soon as it passes the size guard, remembering the refusal briefly', async () => {
    vi.useFakeTimers()
    try {
      const session = fakeProcgen()
      const core = createCore({ env: { PROCGEN: session }, storage: memoryStorage(), maxResultBytes: 30_000 })
      const error = await core.loadTable('PROCGEN', 'orders', { maxRows: 10_000 }).catch(e => e)
      expect(error.message).toMatch(/^Too large: Orders passed the 0 MB limit at \d+ rows \(.* MB\); load fewer rows\.$/)
      expect(isBrokenStubError(error)).toBe(false)
      const reads = queries(session).length
      expect(reads).toBeLessThan(10) // of the 100 a 10,000-row load would make
      await expect(core.loadTable('PROCGEN', 'orders', { maxRows: 2_000 })).rejects.toThrow('Too large')
      expect(queries(session).length).toBe(reads)
      expect((await core.loadTable('PROCGEN', 'orders', { maxRows: 50 })).rows).toHaveLength(50)
      await vi.advanceTimersByTimeAsync(SIZE_FAILURE_MS)
      const before = queries(session).length
      await expect(core.loadTable('PROCGEN', 'orders', { maxRows: 2_000 })).rejects.toThrow('Too large')
      expect(queries(session).length).toBeGreaterThan(before)
    } finally { vi.useRealTimers() }
  })

  it('does not fail a smaller request that joined a larger load refused for size', async () => {
    const session = fakeProcgen()
    const core = createCore({ env: { PROCGEN: session }, storage: memoryStorage(), maxResultBytes: 30_000 })
    const [large, small] = await Promise.allSettled([
      core.loadTable('PROCGEN', 'orders', { maxRows: 10_000 }),
      core.loadTable('PROCGEN', 'orders', { maxRows: 30 }),
    ])
    expect(large.status).toBe('rejected')
    expect(small.status).toBe('fulfilled')
    expect(small.value.rows).toHaveLength(30)
  })

  it('counts UTF-8 bytes, not UTF-16 units', () => {
    expect(jsonBytes('é')).toBe(4)
  })

  it('prefixes gatekeeper errors so the client never mistakes them for its own dead stub', async () => {
    const session = fakeProcgen()
    const query = session.query
    let fail = 'query'
    session.query = async request => { if (fail === 'query') throw new Error('RPC session was disconnected'); return query(request) }
    const core = createCore({ env: { PROCGEN: session }, storage: memoryStorage() })
    const error = await core.loadTable('PROCGEN', 'orders', { maxRows: 5 }).catch(e => e)
    expect(error.message).toBe('Data source PROCGEN is unavailable: RPC session was disconnected')
    expect(isBrokenStubError(error)).toBe(false)
    expect(isBrokenStubError(new Error('RPC session was disconnected'))).toBe(true)

    const other = fakeProcgen()
    other.listCollections = async () => { throw new Error('Network connection lost.') }
    const listing = createCore({ env: { PROCGEN: other }, storage: memoryStorage() })
    const listError = await listing.loadTable('PROCGEN', 'orders').catch(e => e)
    expect(listError.message).toBe('Data source PROCGEN is unavailable: Network connection lost.')
    expect(isBrokenStubError(listError)).toBe(false)
    fail = ''
    expect((await core.loadTable('PROCGEN', 'orders', { maxRows: 5 })).rows).toHaveLength(5)
  })

  it('prefixes a failed source listing the same way', async () => {
    const env = {}
    Object.defineProperty(env, 'PROCGEN', { enumerable: true, get() { throw new Error('connection reset') } })
    const error = await createCore({ env, storage: memoryStorage() }).listSources().catch(e => e)
    expect(error.message).toBe('Data source list is unavailable: connection reset')
    expect(isBrokenStubError(error)).toBe(false)
  })
})
