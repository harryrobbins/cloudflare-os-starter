// The table crosses capnweb on its way to the frame (GadgetUI bridges the facet to the iframe over
// a MessagePort session). This checks a 10,000 x 15 table survives serialisation intact and stays
// well under capnweb's 32 MiB message limit.
import { newMessagePortRpcSession, RpcTarget } from 'capnweb'
import { describe, expect, it } from 'vitest'
import { createCore, MAX_RESULT_BYTES } from '../src/server/core.js'

const value = (r, c) => [`row ${r} "quoted" é`, r * 1.5 - c, r % 3 === 0, new Date(Date.UTC(2023, 0, 1) + r * 3_600_000).toISOString()][c % 4]

function table(rows, cols) {
  const types = ['string', 'number', 'boolean', 'timestamp']
  const columns = Array.from({ length: cols }, (_, c) => ({ name: `col_${c}`, type: types[c % 4], ...(c === 1 ? { semantic: 'currency_minor', currency: 'GBP' } : {}) }))
  return { name: 'Big table', columns, rows: Array.from({ length: rows }, (_row, r) => columns.map((_column, c) => (r + c) % 97 === 0 ? null : value(r, c))), truncated: true, totalRows: 50_000 }
}

describe('capnweb round-trip', () => {
  it('carries a 10,000 x 15 table through a MessagePort session unchanged', async () => {
    const data = table(10_000, 15)
    expect(JSON.stringify(data).length).toBeLessThan(MAX_RESULT_BYTES)
    class Facet extends RpcTarget { loadTable() { return data } }
    const channel = new MessageChannel()
    const server = newMessagePortRpcSession(channel.port1, new Facet())
    const client = newMessagePortRpcSession(channel.port2)
    try {
      const received = await client.loadTable('PROCGEN', 'big', { maxRows: 10_000 })
      expect(received).toEqual(data)
    } finally {
      client[Symbol.dispose]?.(); server[Symbol.dispose]?.(); channel.port1.close(); channel.port2.close()
    }
  })

  it('carries core errors to the caller as rejections', async () => {
    const core = createCore({ env: {}, storage: { get: async () => undefined, put: async () => {} } })
    class Facet extends RpcTarget { loadTable(...args) { return core.loadTable(...args) } }
    const channel = new MessageChannel()
    const server = newMessagePortRpcSession(channel.port1, new Facet())
    const client = newMessagePortRpcSession(channel.port2)
    try {
      await expect(client.loadTable('PROCGEN', 'orders')).rejects.toThrow('Connections tab')
    } finally {
      client[Symbol.dispose]?.(); server[Symbol.dispose]?.(); channel.port1.close(); channel.port2.close()
    }
  })
})
