import { View, parse } from 'vega'
import { expressionInterpreter } from 'vega-interpreter'
import { compile } from 'vega-lite'
import { LIMITS } from '../shared/validation.js'

const MARKS = new Set(['bar', 'line', 'point'])
const SCALAR_TYPES = new Set(['string', 'number', 'boolean', 'timestamp'])

export function buildPageChartSpec(schema, records, options) {
  const mark = MARKS.has(options?.mark) ? options.mark : 'bar'
  const fields = new Map((schema?.fields ?? []).filter(field => SCALAR_TYPES.has(field.type)).map(field => [field.name, field]))
  const x = fields.get(options?.x), y = fields.get(options?.y)
  if (!x || !y) throw new Error('Choose two declared scalar fields.')
  if (!Array.isArray(records) || records.length > LIMITS.queryRows) throw new Error(`Charts are limited to the current ${LIMITS.queryRows}-row page.`)
  const color = options?.color ? fields.get(options.color) : undefined
  if (options?.color && !color) throw new Error('Choose a declared scalar color field.')
  const values = records.map(record => Object.fromEntries([x, y, color].filter(Boolean).map(field => [field.name, chartValue(record?.[field.name], field.type)])))
  return { $schema: 'https://vega.github.io/schema/vega-lite/v6.json', data: { values }, mark: { type: mark, tooltip: true }, encoding: { x: channel(x), y: channel(y), ...(color ? { color: channel(color) } : {}) }, width: 'container', height: 330, autosize: { type: 'fit', contains: 'padding' }, config: { background: '#f8f8f3', view: { stroke: '#c9cec5' }, axis: { labelFont: 'monospace', titleFont: 'monospace' } } }
}

/** CSP-safe renderer for locally constructed, inline-only Vega-Lite specs. Returns cleanup. */
export async function renderVegaLite(container, spec) {
  if (!(container instanceof Element)) throw new Error('A chart container is required.')
  assertInlineData(spec)
  const runtime = parse(compile(spec).spec, null, { ast: true })
  const view = new View(runtime, { expr: expressionInterpreter, renderer: 'svg' }).initialize(container).hover()
  await view.runAsync()
  return () => view.finalize()
}

function channel(field) { return { field: field.name, type: field.type === 'number' ? 'quantitative' : field.type === 'timestamp' ? 'temporal' : 'nominal', title: field.name } }
function chartValue(value, type) { if (value == null) return null; if (type === 'number') return typeof value === 'number' && Number.isFinite(value) ? value : null; if (type === 'boolean') return typeof value === 'boolean' ? value : null; return String(value).slice(0, 500) }
function assertInlineData(spec) { if (!spec || typeof spec !== 'object' || !Array.isArray(spec.data?.values) || spec.data.values.length > LIMITS.queryRows) throw new Error('Charts require bounded inline data.'); const stack = [spec]; while (stack.length) { const value = stack.pop(); if (!value || typeof value !== 'object') continue; for (const [key, child] of Object.entries(value)) { if (key === 'url') throw new Error('Chart network data is disabled.'); if (child && typeof child === 'object') stack.push(child) } } }
