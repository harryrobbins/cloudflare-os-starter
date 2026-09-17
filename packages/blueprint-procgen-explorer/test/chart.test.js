import { describe, expect, it } from 'vitest'
import { buildPageChartSpec } from '../src/client/chart.js'

const schema = { fields: [{ name: 'status', type: 'string' }, { name: 'total_minor', type: 'number' }, { name: 'created_at', type: 'timestamp' }, { name: 'properties', type: 'json' }] }
describe('current-page chart specs', () => {
  it('uses bounded inline values and declared fields', () => { const spec = buildPageChartSpec(schema, [{ status: 'paid', total_minor: 4200 }], { mark: 'bar', x: 'status', y: 'total_minor' }); expect(spec.data).toEqual({ values: [{ status: 'paid', total_minor: 4200 }] }); expect(spec.encoding.y.type).toBe('quantitative') })
  it('whitelists marks and scalar fields', () => { expect(buildPageChartSpec(schema, [], { mark: 'arc', x: 'status', y: 'total_minor' }).mark.type).toBe('bar'); expect(() => buildPageChartSpec(schema, [], { x: 'properties', y: 'total_minor' })).toThrow('scalar fields') })
  it('rejects more than one query page', () => { expect(() => buildPageChartSpec(schema, Array(101).fill({ status: 'paid', total_minor: 1 }), { x: 'status', y: 'total_minor' })).toThrow('100-row page') })
})
