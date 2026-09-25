import { describe, expect, it } from 'vitest'
import { cursor, explorerState, recordsQuery } from '../src/shared/validation.js'

const ID = '3f0c1a2b-4d5e-4f60-8a9b-0c1d2e3f4a5b'
describe('records query', () => {
  it('passes bounded queries through', () => {
    expect(recordsQuery({ entity: 'work_item', after: ID.toUpperCase(), limit: 50 })).toEqual({ entity: 'work_item', after: ID, limit: 50 })
    expect(recordsQuery(undefined)).toEqual({})
  })
  it('rejects anything else', () => {
    for (const bad of [{ entity: 'Work' }, { id: 'nope' }, { limit: 0 }, { limit: 501 }, { order: 'title' }, []]) expect(() => recordsQuery(bad)).toThrow()
  })
  it('bounds cursors', () => {
    expect(cursor(5)).toBe(5); expect(cursor(undefined)).toBeUndefined()
    expect(() => cursor(-1)).toThrow(); expect(() => cursor(1.5)).toThrow()
  })
})

describe('explorer state', () => {
  it('keeps only presentation preferences', () => {
    expect(explorerState({ entity: 'work_item', tab: 'model', columns: { work_item: ['title', 'title', 'status'] } })).toEqual({ entity: 'work_item', tab: 'model', columns: { work_item: ['title', 'status'] } })
  })
  it('rejects oversized or unknown values', () => {
    expect(() => explorerState({ tab: 'admin' })).toThrow()
    expect(() => explorerState({ columns: { work_item: Array.from({ length: 13 }, (_, i) => `f${i}`) } })).toThrow()
    expect(() => explorerState({ columns: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`e${i}`, []])) })).toThrow()
    expect(() => explorerState('x')).toThrow()
  })
})
