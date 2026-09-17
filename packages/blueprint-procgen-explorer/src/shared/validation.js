export const LIMITS = Object.freeze({ queryRows: 100, selectedFields: 24, predicates: 4, metrics: 6, groups: 100, stateBytes: 24_000, jsonChars: 20_000 })
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const OPS = new Set(['eq', 'gt', 'gte', 'lt', 'lte'])
const FUNCTIONS = new Set(['count', 'sum', 'min', 'max', 'avg'])
const ownObject = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null
export function name(value, label = 'name') { if (typeof value !== 'string' || !NAME.test(value)) throw new Error(`Invalid ${label}.`); return value }
export function scalar(value) { if (value === null || ['string', 'number', 'boolean'].includes(typeof value) && (typeof value !== 'number' || Number.isFinite(value))) return value; throw new Error('Predicate value must be a string, finite number, boolean, or null.') }
export function filterPredicate(field, operator, raw) {
  const definition = ownObject(field)
  if (!definition || !OPS.has(operator) || typeof raw !== 'string') throw new Error('Invalid filter.')
  const trimmed = raw.trim()
  if (!trimmed) throw new Error('Enter a filter value.')
  let value = trimmed
  if (definition.type === 'number') {
    value = Number(trimmed)
    if (!Number.isFinite(value)) throw new Error('Enter a valid number.')
  } else if (definition.type === 'boolean') {
    if (!['true', 'false'].includes(trimmed)) throw new Error('Choose true or false.')
    value = trimmed === 'true'
  } else if (definition.type === 'timestamp') {
    const timestamp = new Date(trimmed)
    if (Number.isNaN(timestamp.valueOf())) throw new Error('Enter a valid date and time.')
    value = timestamp.toISOString()
  }
  return { field: name(definition.name, 'filter field'), operator, value }
}
export function queryRequest(input) {
  const value = ownObject(input); if (!value) throw new Error('Query must be an object.')
  const fields = value.fields === undefined ? undefined : array(value.fields, LIMITS.selectedFields, field => name(field, 'field'))
  const predicates = value.predicates === undefined ? undefined : array(value.predicates, LIMITS.predicates, predicate => { const p = ownObject(predicate); if (!p || !OPS.has(p.operator)) throw new Error('Unsupported predicate.'); return { field: name(p.field, 'predicate field'), operator: p.operator, value: scalar(p.value) } })
  const limit = value.limit === undefined ? 50 : integer(value.limit, 1, LIMITS.queryRows, 'row limit')
  if (value.cursor !== undefined && (typeof value.cursor !== 'string' || value.cursor.length > 4096)) throw new Error('Invalid cursor.')
  return { collection: name(value.collection, 'collection'), ...(predicates?.length ? { predicates } : {}), ...(value.cursor ? { cursor: value.cursor } : {}), limit, ...(fields?.length ? { fields: [...new Set(fields)] } : {}) }
}
export function aggregateRequest(input) {
  const value = ownObject(input); if (!value) throw new Error('Aggregate must be an object.')
  const metrics = array(value.metrics, LIMITS.metrics, metric => { const m = ownObject(metric); if (!m || !FUNCTIONS.has(m.function)) throw new Error('Unsupported metric.'); return { name: name(m.name, 'metric name'), function: m.function, ...(m.field === undefined ? {} : { field: name(m.field, 'metric field') }) } })
  if (!metrics.length) throw new Error('Choose at least one metric.')
  const predicates = value.predicates === undefined ? undefined : queryRequest({ collection: value.collection, predicates: value.predicates, limit: 1 }).predicates
  const groupBy = value.groupBy === undefined ? undefined : array(value.groupBy, 2, field => name(field, 'group field'))
  return { collection: name(value.collection, 'collection'), metrics, ...(predicates?.length ? { predicates } : {}), ...(groupBy?.length ? { groupBy: [...new Set(groupBy)] } : {}), limitGroups: value.limitGroups === undefined ? LIMITS.groups : integer(value.limitGroups, 1, LIMITS.groups, 'group limit') }
}
export function explorerState(input) {
  const value = ownObject(input); if (!value) throw new Error('State must be an object.')
  const state = { ...(value.collection === undefined ? {} : { collection: name(value.collection, 'collection') }), cursorHistory: array(value.cursorHistory ?? [], 100, cursor => { if (typeof cursor !== 'string' || cursor.length > 4096) throw new Error('Invalid cursor history.'); return cursor }) }
  if (value.selectedRecordId !== undefined) { if (typeof value.selectedRecordId !== 'string' || value.selectedRecordId.length > 256) throw new Error('Invalid record id.'); state.selectedRecordId = value.selectedRecordId }
  if (value.query !== undefined) state.query = queryRequest(value.query)
  if (value.aggregate !== undefined) state.aggregate = aggregateRequest(value.aggregate)
  if (JSON.stringify(state).length > LIMITS.stateBytes) throw new Error('Explorer state is too large.')
  return state
}
function array(value, max, map) { if (!Array.isArray(value) || value.length > max) throw new Error(`Expected at most ${max} items.`); return value.map(map) }
function integer(value, min, max, label) { if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${label}; use ${min}–${max}.`); return value }
