// Pure helpers for the Tessera gadget client, kept free of the DOM and of Tessera so vitest can
// run them in Node (test/client-helpers.test.js).

export const MAX_ROWS_OPTIONS = Object.freeze([500, 2_000, 10_000])
export const DEFAULT_MAX_ROWS = 2_000
export const SAVE_DEBOUNCE_MS = 800
/** A second broken-stub reload within this window is refused, so a dead facet cannot loop. */
export const RELOAD_WINDOW_MS = 60_000
const RELOAD_FLAG = 'tessera-gadget:reloaded:'
const KEY_PREFIX = 'src:'

export const formatCount = n => Number(n).toLocaleString('en-GB')

/** Tessera registry key for a connector table: `src:<sourceId>:<table>`. */
export const connectorKey = (sourceId, table) => `${KEY_PREFIX}${sourceId}:${table}`

/** `{sourceId, table}` for a key made by connectorKey, else null. */
export function parseConnectorKey(key) {
  if (typeof key !== 'string' || !key.startsWith(KEY_PREFIX)) return null
  const rest = key.slice(KEY_PREFIX.length)
  const colon = rest.lastIndexOf(':')
  if (colon <= 0 || colon === rest.length - 1) return null
  return { sourceId: rest.slice(0, colon), table: rest.slice(colon + 1) }
}

/** The one of MAX_ROWS_OPTIONS closest to a saved cap (the server clamps, the menu offers three). */
export function nearestMaxRows(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAX_ROWS
  return MAX_ROWS_OPTIONS.reduce((best, option) => (Math.abs(option - value) < Math.abs(best - value) ? option : best))
}

/**
 * The gadget state for what Tessera reports: a connector key maps back to its source and the
 * cap it was loaded with; anything else is a demo key. `rev` is assigned by the server.
 */
export function stateFor(datasetKey, view, maxRowsFor = () => DEFAULT_MAX_ROWS) {
  const connector = parseConnectorKey(datasetKey)
  const source = connector
    ? { kind: 'connector', sourceId: connector.sourceId, table: connector.table, maxRows: maxRowsFor(datasetKey) }
    : datasetKey ? { kind: 'demo', key: datasetKey } : { kind: 'demo' }
  const state = { source }
  if (view && Object.keys(view).length) state.view = view
  return state
}

/** Equality of two states ignoring `rev`, so an unchanged view is not saved twice. */
export const sameState = (a, b) => !!a && !!b && JSON.stringify({ ...a, rev: 0 }) === JSON.stringify({ ...b, rev: 0 })

/** Trailing-edge debounce with `flush()` and `cancel()`. */
export function debounce(fn, ms, timers = globalThis) {
  let timer = null
  let args = null
  const run = () => {
    timer = null
    const pending = args
    args = null
    if (pending) fn(...pending)
  }
  const debounced = (...next) => {
    args = next
    if (timer !== null) timers.clearTimeout(timer)
    timer = timers.setTimeout(run, ms)
  }
  debounced.flush = () => {
    if (timer !== null) timers.clearTimeout(timer)
    run()
  }
  debounced.cancel = () => {
    if (timer !== null) timers.clearTimeout(timer)
    timer = null
    args = null
  }
  return debounced
}

/**
 * Whether an RPC rejection means the frame's `gadget` stub is dead (the facet restarted after a
 * code edit and the platform never replaces the stub), as opposed to an application error the
 * server threw on purpose. Only the former justifies a reload.
 */
export function isBrokenStubError(error) {
  const message = String(error?.message ?? error ?? '')
  // The server prefixes every adapter and gatekeeper error with "Data source <id> is unavailable:"
  // (core.js), so a gatekeeper-side "disconnected" never reloads this frame.
  if (/^(Invalid|Unknown table|No connected data source|Data source \S+ is unavailable|Too large:|View must|State )/.test(message)) return false
  return /disconnect|connection (was |is )?(lost|closed|reset)|shut ?down|broken|session (was |is |has been )?(closed|ended|aborted|terminated)|durable object (was )?reset|code (has been|was) updated|stub.*(disposed|released)|network connection lost/i.test(message)
}

/**
 * Whether a broken-stub reload may happen now, given `window.name`: once per RELOAD_WINDOW_MS.
 * Returns the `window.name` to write before reloading, or null when a reload already happened
 * recently (the caller then tells the user to reload).
 */
export function reloadMarker(windowName, now) {
  const text = typeof windowName === 'string' ? windowName : ''
  if (text.startsWith(RELOAD_FLAG)) {
    const at = Number(text.slice(RELOAD_FLAG.length))
    if (Number.isFinite(at) && now - at >= 0 && now - at < RELOAD_WINDOW_MS) return null
  }
  return `${RELOAD_FLAG}${now}`
}

export const CONNECT_HINT = "Connect a data source: open this gadget's Connections tab and add Synthetic Data (if a chat is open, accept its changes). The mosaic reloads with it automatically."

/** A readable one-line error from an RPC rejection or a connector `error` string. */
export function errorText(error) {
  const text = String(error?.message ?? error ?? 'Unknown error').replace(/\s+/g, ' ').trim()
  return text.length > 300 ? `${text.slice(0, 297)}…` : text
}
