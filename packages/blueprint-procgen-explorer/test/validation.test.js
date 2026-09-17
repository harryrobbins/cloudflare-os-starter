import { describe, expect, it } from 'vitest'
import { aggregateRequest, explorerState, queryRequest } from '../src/shared/validation.js'

describe('client request validation', () => {
  it('normalizes bounded row queries', () => {
    expect(queryRequest({ collection: 'orders', fields: ['id', 'id'], predicates: [{ field: 'status', operator: 'eq', value: 'paid' }] })).toEqual({ collection: 'orders', fields: ['id'], predicates: [{ field: 'status', operator: 'eq', value: 'paid' }], limit: 50 })
  })

  it('rejects arbitrary operations and oversized requests', () => {
    expect(() => queryRequest({ collection: 'orders', predicates: [{ field: 'status', operator: 'contains', value: 'paid' }] })).toThrow('Unsupported predicate')
    expect(() => queryRequest({ collection: 'orders', limit: 101 })).toThrow('row limit')
    expect(() => queryRequest({ collection: '../orders' })).toThrow('collection')
  })

  it('normalizes advertised aggregate-shaped input', () => {
    expect(aggregateRequest({ collection: 'orders', metrics: [{ name: 'total', function: 'sum', field: 'total_minor' }], groupBy: ['status'] })).toEqual({ collection: 'orders', metrics: [{ name: 'total', function: 'sum', field: 'total_minor' }], groupBy: ['status'], limitGroups: 100 })
    expect(() => aggregateRequest({ collection: 'orders', metrics: [{ name: 'p50', function: 'median', field: 'total_minor' }] })).toThrow('Unsupported metric')
  })

  it('persists presentation state but bounds cursor history', () => {
    expect(explorerState({ collection: 'orders', cursorHistory: ['opaque'], selectedRecordId: 'ord_1' })).toEqual({ collection: 'orders', cursorHistory: ['opaque'], selectedRecordId: 'ord_1' })
    expect(() => explorerState({ cursorHistory: Array(101).fill('x') })).toThrow('at most 100')
  })
})
