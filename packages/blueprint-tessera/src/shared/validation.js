// Validation for everything the client (or an agent) sends the Tessera gadget facet.
//
// The facet is reachable over capnweb from any viewer's frame, so every argument is untrusted:
// shapes are checked, strings and arrays are bounded, and the stored state is capped at 16 KB.

export const LIMITS = Object.freeze({
  stateBytes: 16 * 1024,
  maxRowsMin: 1,
  maxRowsMax: 10_000,
  maxRowsDefault: 2_000,
  filters: 32,
  filterLabels: 200,
  string: 200,
})

/** Binding names as the platform assigns them (`PROCGEN`, `PROCGEN_2`, …), or any env key. */
const SOURCE_ID = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
/** Procgen collection names; also the bound for any future adapter's table names. */
const TABLE = /^[a-z0-9_]{1,64}$/
/** Tessera dataset keys: `prefix` or `prefix:size` (e.g. `tax-cases:3000`, `titanic`). */
const DEMO_KEY = /^[a-z0-9][a-z0-9:._-]{0,63}$/
/** Layout kinds are identifiers; the set (grid, bars, scatter, xy today) belongs to Tessera. */
const LAYOUT = /^[a-z][a-z0-9_-]{0,31}$/
const VIEW_STRINGS = ['color', 'sort', 'bucket', 'x', 'y']

const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null

function boundedString(value, label, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || value.length > LIMITS.string || (!allowEmpty && value.length === 0)) {
    throw new Error(`Invalid ${label}: expected a${allowEmpty ? '' : ' non-empty'} string of at most ${LIMITS.string} characters.`)
  }
  return value
}

export function sourceId(value) {
  if (typeof value !== 'string' || !SOURCE_ID.test(value) || value === 'demo') throw new Error('Invalid source id.')
  return value
}

export function tableName(value) {
  if (typeof value !== 'string' || !TABLE.test(value)) throw new Error('Invalid table name: use 1-64 lowercase letters, digits or underscores.')
  return value
}

export function demoKey(value) {
  if (typeof value !== 'string' || !DEMO_KEY.test(value) || value.startsWith('src:')) throw new Error('Invalid demo collection key.')
  return value
}

/** Clamps rather than rejects: any finite number lands in 1-10,000; anything else is the default. */
export function maxRows(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return LIMITS.maxRowsDefault
  return Math.min(LIMITS.maxRowsMax, Math.max(LIMITS.maxRowsMin, Math.floor(value)))
}

/** `{maxRows}` options bag for loadTable; absent or malformed means the default cap. */
export function loadOptions(value) {
  const options = plainObject(value) ?? {}
  return { maxRows: maxRows(options.maxRows) }
}

/**
 * Tessera's `ViewState` (scratch/tessera/src/ui/deepLink.ts): layout, color, sort, bucket, x, y and
 * nested `filters: {field, labels[]}[]`. Field and label names are only meaningful to the loaded
 * collection, so they are passed through as bounded strings. `sort` may be `''` (the user chose no
 * sort). Keys Tessera may add later are dropped rather than rejected, so a newer engine never
 * breaks persistence; null or undefined values mean "absent".
 */
export function viewState(input) {
  const value = plainObject(input)
  if (!value) throw new Error('View must be an object.')
  const view = {}
  if (value.layout != null) {
    if (typeof value.layout !== 'string' || !LAYOUT.test(value.layout)) throw new Error('Invalid view layout.')
    view.layout = value.layout
  }
  for (const key of VIEW_STRINGS) {
    if (value[key] != null) view[key] = boundedString(value[key], `view ${key}`, { allowEmpty: key === 'sort' })
  }
  if (value.filters != null) {
    if (!Array.isArray(value.filters) || value.filters.length > LIMITS.filters) throw new Error(`View filters must be an array of at most ${LIMITS.filters} entries.`)
    view.filters = value.filters.map(entry => {
      const filter = plainObject(entry)
      if (!filter) throw new Error('Each view filter must be an object.')
      if (!Array.isArray(filter.labels) || filter.labels.length > LIMITS.filterLabels) throw new Error(`Each view filter holds at most ${LIMITS.filterLabels} labels.`)
      return { field: boundedString(filter.field, 'filter field'), labels: filter.labels.map(label => boundedString(label, 'filter label')) }
    })
  }
  return view
}

export function source(input) {
  const value = plainObject(input)
  if (!value) throw new Error('State source must be an object.')
  if (value.kind === 'demo') return value.key == null ? { kind: 'demo' } : { kind: 'demo', key: demoKey(value.key) }
  if (value.kind === 'connector') return { kind: 'connector', sourceId: sourceId(value.sourceId), table: tableName(value.table), maxRows: maxRows(value.maxRows) }
  throw new Error("State source kind must be 'demo' or 'connector'.")
}

/**
 * State = { source: {kind:'demo', key?} | {kind:'connector', sourceId, table, maxRows}, view?, rev }.
 * `rev` is assigned by the server on write; an incoming `rev` is checked for shape and ignored.
 */
export function gadgetState(input, rev = 0) {
  const value = plainObject(input)
  if (!value) throw new Error('State must be an object.')
  if (value.rev !== undefined && (!Number.isSafeInteger(value.rev) || value.rev < 0)) throw new Error('Invalid state rev.')
  for (const key of Object.keys(value)) if (!['source', 'view', 'rev'].includes(key)) throw new Error(`Unknown state key "${key.slice(0, 40)}".`)
  const state = { source: source(value.source), ...(value.view == null ? {} : { view: viewState(value.view) }), rev }
  if (new TextEncoder().encode(JSON.stringify(state)).byteLength > LIMITS.stateBytes) throw new Error('Gadget state is larger than 16 KB.')
  return state
}

export const DEFAULT_STATE = Object.freeze({ source: Object.freeze({ kind: 'demo' }), rev: 0 })
