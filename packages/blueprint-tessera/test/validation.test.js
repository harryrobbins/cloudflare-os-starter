import { describe, expect, it } from 'vitest'
import { gadgetState, loadOptions, maxRows, sourceId, tableName, viewState } from '../src/shared/validation.js'

describe('validation', () => {
  it('accepts binding-style source ids and procgen table names only', () => {
    expect(sourceId('PROCGEN_2')).toBe('PROCGEN_2')
    for (const bad of ['demo', '', '2X', 'a-b', 'x'.repeat(65), 7]) expect(() => sourceId(bad)).toThrow('Invalid source id')
    expect(tableName('order_items')).toBe('order_items')
    for (const bad of ['Orders', 'a b', '', 'x'.repeat(65), null]) expect(() => tableName(bad)).toThrow('Invalid table name')
  })

  it('clamps maxRows to 1-10,000 with a 2,000 default', () => {
    expect([maxRows(undefined), maxRows('500'), maxRows(NaN), maxRows(0), maxRows(-5), maxRows(12.7), maxRows(20_000)]).toEqual([2_000, 2_000, 2_000, 1, 1, 12, 10_000])
    expect(loadOptions(null)).toEqual({ maxRows: 2_000 })
  })

  it("keeps Tessera's ViewState, drops unknown keys and bounds filters", () => {
    expect(viewState({ layout: 'xy', x: 'Age', y: 'Fare', sort: '', camera: { z: 1 }, color: null })).toEqual({ layout: 'xy', x: 'Age', y: 'Fare', sort: '' })
    expect(() => viewState({ layout: 'Grid!' })).toThrow('layout')
    expect(() => viewState({ color: '' })).toThrow('view color')
    expect(() => viewState({ x: 'x'.repeat(201) })).toThrow('view x')
    expect(() => viewState({ filters: Array.from({ length: 33 }, () => ({ field: 'a', labels: ['b'] })) })).toThrow('at most 32')
    expect(() => viewState({ filters: [{ field: 'a', labels: Array(201).fill('b') }] })).toThrow('at most 200')
    expect(() => viewState({ filters: [{ field: 'a', labels: [3] }] })).toThrow('filter label')
    expect(() => viewState({ filters: ['a:b'] })).toThrow('object')
    expect(() => viewState([])).toThrow('View must be an object')
  })

  it('validates the state shape and caps it at 16 KB', () => {
    expect(gadgetState({ source: { kind: 'demo', key: 'titanic' } }, 3)).toEqual({ source: { kind: 'demo', key: 'titanic' }, rev: 3 })
    expect(() => gadgetState({ source: { kind: 'demo', key: 'src:PROCGEN:orders' } })).toThrow('demo collection key')
    expect(() => gadgetState({ source: { kind: 'url', href: 'https://x' } })).toThrow("'demo' or 'connector'")
    expect(() => gadgetState({ source: { kind: 'demo' }, extra: 1 })).toThrow('Unknown state key')
    expect(() => gadgetState({ source: { kind: 'demo' }, rev: -1 })).toThrow('rev')
    expect(() => gadgetState(null)).toThrow('State must be an object')
    const filters = Array.from({ length: 32 }, (_, i) => ({ field: `f${i}`, labels: Array(10).fill('x'.repeat(100)) }))
    expect(() => gadgetState({ source: { kind: 'demo' }, view: { filters } })).toThrow('16 KB')
  })
})
