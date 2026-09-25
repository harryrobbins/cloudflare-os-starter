// Bounds for everything the explorer's server forwards or stores. Pure; runs under Node tests.
export const LIMITS = Object.freeze({ pageRows: 50, maxRows: 500, stateBytes: 8_000, columns: 12, activity: 200, jsonChars: 20_000 })
export const TABS = Object.freeze(['records', 'model', 'activity', 'connection'])
const ENTITY = /^[a-z][a-z0-9_]{0,62}$/
const FIELD = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)

export const isUuid = value => typeof value === 'string' && UUID.test(value)
export function entityName(value) { if (typeof value !== 'string' || !ENTITY.test(value)) throw new Error('Invalid entity name.'); return value }

/** A `records()` query: entity, exact id, `after` cursor (UUIDs) and a 1-500 limit. Nothing else. */
export function recordsQuery(input) {
  if (input === undefined || input === null) return {}
  if (!plain(input)) throw new Error('Query must be an object.')
  const out = {}
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === '') continue
    if (key === 'entity') out.entity = entityName(value)
    else if (key === 'id' || key === 'after') { if (!isUuid(value)) throw new Error(`${key} must be a record UUID.`); out[key] = value.toLowerCase() }
    else if (key === 'limit') { if (!Number.isInteger(value) || value < 1 || value > LIMITS.maxRows) throw new Error(`limit must be 1-${LIMITS.maxRows}.`); out.limit = value }
    else throw new Error(`Unsupported query field ${key}; use entity, id, after and limit.`)
  }
  return out
}

/** A `changes()` cursor or permission epoch: absent or a non-negative safe integer. */
export function cursor(value, label = 'cursor') {
  if (value === undefined || value === null) return undefined
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${label}.`)
  return value
}

/** Presentation state only: selected entity, visible columns per entity, active tab. Never record data. */
export function explorerState(input) {
  if (!plain(input)) throw new Error('State must be an object.')
  const state = {}
  if (input.entity !== undefined) state.entity = entityName(input.entity)
  if (input.tab !== undefined) { if (!TABS.includes(input.tab)) throw new Error('Invalid tab.'); state.tab = input.tab }
  if (input.columns !== undefined) {
    if (!plain(input.columns) || Object.keys(input.columns).length > 20) throw new Error('Invalid column preferences.')
    state.columns = {}
    for (const [entity, fields] of Object.entries(input.columns)) {
      entityName(entity)
      if (!Array.isArray(fields) || fields.length > LIMITS.columns || fields.some(field => typeof field !== 'string' || !FIELD.test(field))) throw new Error('Invalid column list.')
      state.columns[entity] = [...new Set(fields)]
    }
  }
  if (JSON.stringify(state).length > LIMITS.stateBytes) throw new Error('Explorer state is too large.')
  return state
}

/** A readable name for a Records actor: Cloudflare OS viewers by their account, others by kind. */
export function actorLabel(actor) {
  if (typeof actor !== 'string' || !actor) return 'unknown'
  if (actor.startsWith('cloudflare-os:')) return actor.slice('cloudflare-os:'.length)
  if (actor.startsWith('records:principal:')) return 'a service credential'
  if (actor.startsWith('records:operator:')) return 'an operator'
  return actor
}
