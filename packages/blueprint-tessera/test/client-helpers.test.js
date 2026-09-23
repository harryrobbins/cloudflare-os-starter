import { describe, expect, it, vi } from 'vitest'
import {
  RELOAD_WINDOW_MS, connectorKey, debounce, isBrokenStubError, nearestMaxRows, parseConnectorKey, reloadMarker, sameState, stateFor,
} from '../src/client/helpers.js'
import { gadgetState } from '../src/shared/validation.js'

describe('client helpers', () => {
  it('round-trips connector keys and leaves demo keys alone', () => {
    expect(connectorKey('PROCGEN_2', 'daily_metrics')).toBe('src:PROCGEN_2:daily_metrics')
    expect(parseConnectorKey('src:PROCGEN_2:daily_metrics')).toEqual({ sourceId: 'PROCGEN_2', table: 'daily_metrics' })
    expect(parseConnectorKey('tax-cases:3000')).toBeNull()
    expect(parseConnectorKey('src::x')).toBeNull()
    expect(parseConnectorKey('src:PROCGEN:')).toBeNull()
  })

  it('builds states the server accepts', () => {
    const connector = stateFor('src:PROCGEN:orders', { layout: 'bars' }, () => 500)
    expect(connector).toEqual({ source: { kind: 'connector', sourceId: 'PROCGEN', table: 'orders', maxRows: 500 }, view: { layout: 'bars' } })
    expect(gadgetState(connector, 1).source).toEqual(connector.source)
    expect(stateFor('titanic', {})).toEqual({ source: { kind: 'demo', key: 'titanic' } })
    expect(gadgetState(stateFor('titanic', {}), 1).source).toEqual({ kind: 'demo', key: 'titanic' })
    expect(sameState({ ...connector, rev: 4 }, connector)).toBe(true)
    expect(sameState(connector, stateFor('titanic', {}))).toBe(false)
  })

  it('maps a saved cap to the nearest menu option', () => {
    expect(nearestMaxRows(2000)).toBe(2000)
    expect(nearestMaxRows(20_000)).toBe(10_000)
    expect(nearestMaxRows(700)).toBe(500)
    expect(nearestMaxRows(undefined)).toBe(2000)
  })

  it('debounces to the last call, with flush and cancel', () => {
    vi.useFakeTimers()
    try {
      const fn = vi.fn()
      const d = debounce(fn, 800)
      d(1); d(2)
      vi.advanceTimersByTime(799)
      expect(fn).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(fn).toHaveBeenCalledExactlyOnceWith(2)
      d(3); d.flush()
      expect(fn).toHaveBeenLastCalledWith(3)
      d(4); d.cancel(); vi.advanceTimersByTime(1000)
      expect(fn).toHaveBeenCalledTimes(2)
    } finally { vi.useRealTimers() }
  })

  it('tells a dead stub from an application error', () => {
    expect(isBrokenStubError(new Error('RPC session was shut down by disposing the main stub'))).toBe(true)
    expect(isBrokenStubError(new Error('Network connection lost.'))).toBe(true)
    expect(isBrokenStubError(new Error('Durable Object reset because its code was updated.'))).toBe(true)
    expect(isBrokenStubError(new Error('Invalid table name: use 1-64 lowercase letters, digits or underscores.'))).toBe(false)
    expect(isBrokenStubError(new Error('Data source PROCGEN is unavailable: connection lost'))).toBe(false)
    expect(isBrokenStubError(new Error('No connected data source "PROCGEN".'))).toBe(false)
    expect(isBrokenStubError(new Error('Data source PROCGEN is unavailable: RPC session was disconnected'))).toBe(false)
    expect(isBrokenStubError(new Error('Data source list is unavailable: connection reset'))).toBe(false)
    expect(isBrokenStubError(new Error('Too large: Broken orders passed the 8 MB limit at 9,000 rows (8.1 MB); load fewer rows.'))).toBe(false)
  })

  it('allows one broken-stub reload per window', () => {
    const now = 1_000_000
    const marker = reloadMarker('', now)
    expect(marker).toMatch(/^tessera-gadget:reloaded:/)
    expect(reloadMarker(marker, now + 5_000)).toBeNull()
    expect(reloadMarker(marker, now + RELOAD_WINDOW_MS)).not.toBeNull()
    expect(reloadMarker('something else', now)).not.toBeNull()
  })
})
