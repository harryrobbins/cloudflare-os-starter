// Tessera Mosaic client. Runs as one data: module script in the gadget's sandboxed, opaque-origin
// iframe: no storage, no fetch (connect-src 'none'), no blob:, no form submission, no dialogs.
// The platform prepends a prefix that declares `gadget` (a capnweb stub to src/server/index.js)
// and `gadgetViewer` as module-scope bindings, not globals, so they are read behind `typeof`.
//
// Flow: getState() → (a connector table is fetched before mounting, so a vanished connector falls
// back to the demo instead of failing Tessera's boot) → mountTessera → Data popover for connector
// tables → every view change is debounced (800 ms) into setState().

import { datasetFromTable, mountTessera } from 'tessera'
import TESSERA_CSS from 'tessera/style.css'
import TITANIC_CSV from 'tessera/data/titanic.csv'
import {
  CONNECT_HINT, DEFAULT_MAX_ROWS, MAX_ROWS_OPTIONS, SAVE_DEBOUNCE_MS,
  connectorKey, debounce, errorText, formatCount, isBrokenStubError, nearestMaxRows, reloadMarker, sameState, stateFor,
} from './helpers.js'

/* global gadget, WORKER_DATA_URL */
const rpc = typeof gadget !== 'undefined' ? gadget : null

/** The five procedural families plus Titanic; birds and pixels need megabytes of images. */
const FAMILIES = ['tax-cases', 'tax-returns', 'payments', 'invoices', 'products', 'titanic']

const GADGET_CSS = `
#tg-root { height: 100%; }
.tg-popover { width: 300px; max-height: min(70vh, 520px); overflow-y: auto; }
.tg-popover:focus { outline: none; }
.tg-popover h2 { margin: 0; font-size: 13px; font-weight: 650; }
.tg-popover h3 { margin: 0; font-size: 12px; font-weight: 650; color: var(--ink); }
.tg-popover p { margin: 0; color: var(--ink-2); font-size: 12px; }
.tg-section { display: grid; gap: 6px; padding-top: 8px; border-top: 1px solid var(--line); }
.tg-muted { color: var(--ink-3) !important; }
.tg-tables { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.tg-tables button { width: 100%; display: flex; justify-content: space-between; gap: 8px; text-align: left; }
.tg-tables button[aria-current="true"] { border-color: var(--accent); }
.tg-tables button[aria-disabled="true"] { opacity: .5; cursor: progress; }
.tg-tables .tg-rows { color: var(--ink-3); font-variant-numeric: tabular-nums; }
.tg-cap { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.tg-cap[hidden] { display: none; }
.tg-cap label { color: var(--ink-3); font-size: 12px; }
#tg-status[data-kind="error"], .tg-error { color: #f08c7e !important; }
#tg-status[data-kind="ok"] { color: #8fd19e !important; }
.tg-toast { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); z-index: 60; max-width: min(560px, calc(100vw - 32px));
  padding: 8px 14px; border-radius: 10px; background: var(--surface-2); border: 1px solid var(--line); color: var(--ink-2);
  box-shadow: 0 8px 24px rgba(0,0,0,.4); font: 13px/1.45 ui-sans-serif, system-ui, sans-serif; }
.tg-toast:empty { padding: 0; border: 0; box-shadow: none; background: none; }
`

// ------------------------------------------------------------------ document

function injectStyle(css) {
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
}

function el(tag, attrs = {}, text) {
  const node = document.createElement(tag)
  for (const [name, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue
    if (value === true) node.setAttribute(name, '')
    else node.setAttribute(name, String(value))
  }
  if (text != null) node.textContent = text
  return node
}

if (!document.documentElement.lang) document.documentElement.lang = 'en'
if (!document.head.querySelector('meta[name=viewport]')) document.head.appendChild(el('meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' }))
document.title = 'Tessera Mosaic'
injectStyle(TESSERA_CSS)
injectStyle(GADGET_CSS)

const root = el('div', { id: 'tg-root' })
// Live regions stay rendered (an empty toast has no box): one that is hidden or display:none when
// its text arrives is often not announced.
const toastEl = el('div', { id: 'tg-toast', class: 'tg-toast', role: 'status', 'aria-live': 'polite' })
document.body.replaceChildren(root, toastEl)

let toastTimer = 0
function toast(message, ms = 8000) {
  toastEl.textContent = message
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toastEl.textContent = '' }, ms)
}

// ---------------------------------------------------------------------- RPC

let reloading = false
/**
 * Last resort only: GadgetUI reconnects and reloads the frame on code and binding changes, but a
 * facet restart can still leave this frame's stub dead for good. Reload once per minute at most
 * (window.name survives the reload; nothing else does in this sandbox).
 */
function reloadOnce() {
  if (reloading) return
  reloading = true
  let marker = null
  try { marker = reloadMarker(window.name, Date.now()) } catch {}
  if (!marker) {
    toast('Lost the connection to this gadget. Reload the page to reconnect.', 60_000)
    return
  }
  try { window.name = marker } catch {}
  toast('Reconnecting…', 5000)
  setTimeout(() => location.reload(), 300)
}

async function call(method, ...args) {
  if (!rpc) throw new Error('This gadget has no server connection.')
  try {
    return await rpc[method](...args)
  } catch (error) {
    if (isBrokenStubError(error)) reloadOnce()
    throw error
  }
}

// ------------------------------------------------------------------ restore

const DEMO_STATE = { source: { kind: 'demo' }, rev: 0 }
let lastSavedState = DEMO_STATE
try {
  if (rpc) lastSavedState = (await call('getState')) ?? DEMO_STATE
} catch (error) {
  console.warn('[tessera-gadget] getState failed', error)
}

/** Cap each connector key was loaded with, so the saved state reloads the same rows. */
const maxRowsByKey = new Map()
const maxRowsFor = key => maxRowsByKey.get(key) ?? DEFAULT_MAX_ROWS
const tableLabel = data => `${data.name} (${formatCount(data.rows.length)} rows)`

function loadedText(data) {
  const shown = formatCount(data.rows.length)
  const of = data.truncated && data.totalRows ? ` of ${formatCount(data.totalRows)}` : ''
  return `Loaded ${shown} rows${of} from ${data.name}.${data.truncated ? ' Raise the row cap to load more.' : ''}`
}

const saved = lastSavedState.source ?? DEMO_STATE.source
let initialDataset = saved.kind === 'demo' ? saved.key : undefined
let initialView = lastSavedState.view
/** The connector table fetched before mounting, when the saved state names one. */
let restored = null
let restoreNotice = ''
if (saved.kind === 'connector') {
  root.appendChild(el('p', { style: 'margin: 24px; font: 14px system-ui, sans-serif; color: #888' }, `Loading up to ${formatCount(saved.maxRows)} rows from ${saved.table}…`))
  try {
    const data = await call('loadTable', saved.sourceId, saved.table, { maxRows: saved.maxRows })
    restored = { key: connectorKey(saved.sourceId, saved.table), data, dataset: datasetFromTable(data) }
    initialDataset = restored.key
    maxRowsByKey.set(restored.key, saved.maxRows)
  } catch (error) {
    // The connector is gone (or failing): open the demo, keep the saved choice until the user
    // changes something, so a transient failure does not lose it.
    initialDataset = undefined
    initialView = undefined
    restoreNotice = `The connected table "${saved.table}" could not be loaded, so the demo collections are showing instead. ${errorText(error)}`
  }
}

// -------------------------------------------------------------------- persist

let saving = Promise.resolve()
function save(state) {
  saving = saving.then(async () => {
    if (sameState(state, lastSavedState)) return
    try {
      lastSavedState = rpc ? await call('setState', state) : { ...state, rev: (lastSavedState?.rev ?? 0) + 1 }
    } catch (error) {
      console.warn('[tessera-gadget] setState failed', error)
    }
  })
  return saving
}
const saveSoon = debounce(state => { void save(state) }, SAVE_DEBOUNCE_MS)
// A pane closed or a tab switched within the debounce window would otherwise lose the last change.
addEventListener('pagehide', () => saveSoon.flush())
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveSoon.flush() })

// ---------------------------------------------------------------------- mount

const handle = mountTessera(root, {
  storage: null,
  urlSync: false,
  tour: false,
  bench: false,
  families: FAMILIES,
  fetchAsset: path => path === 'data/titanic.csv'
    ? Promise.resolve(new Response(TITANIC_CSV, { headers: { 'content-type': 'text/csv' } }))
    : Promise.reject(new Error(`No bundled asset ${path}.`)),
  layoutWorker: () => new Worker(WORKER_DATA_URL, { type: 'module' }),
  initialDataset,
  initialView,
  onViewChange: (view, datasetKey) => saveSoon(stateFor(datasetKey, view, maxRowsFor)),
})
// Straight after mounting, so Tessera's boot (one microtask later) can open it.
if (restored) handle.registerDataset(restored.key, tableLabel(restored.data), restored.dataset)
/** Counts the user's picks in Tessera's Collection menu (programmatic selection fires no change). */
let collectionPicks = 0
root.addEventListener('change', event => { if (event.target?.id === 'dataset') collectionPicks++ })

// ------------------------------------------------------------------ Data popover

const host = el('div', { class: 'popover-host' })
const button = el('button', {
  id: 'tg-data-btn', type: 'button', class: 'ghost', title: 'Load a table from a connected data source',
  'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-controls': 'tg-data-popover',
}, 'Data')
const popover = el('div', { id: 'tg-data-popover', class: 'popover tg-popover', role: 'dialog', 'aria-labelledby': 'tg-data-title', tabindex: '-1', hidden: true })
const sourcesEl = el('div', { id: 'tg-sources', class: 'tg-section' })
const capRow = el('div', { class: 'tg-cap', hidden: true })
const capSelect = el('select', { id: 'tg-maxrows' })
for (const option of MAX_ROWS_OPTIONS) capSelect.appendChild(el('option', { value: option }, `${formatCount(option)} rows`))
capSelect.value = String(saved.kind === 'connector' ? nearestMaxRows(saved.maxRows) : DEFAULT_MAX_ROWS)
capRow.append(el('label', { for: 'tg-maxrows' }, 'Rows to load'), capSelect)
const statusEl = el('p', { id: 'tg-status', role: 'status', 'aria-live': 'polite' })
const demoSection = el('div', { class: 'tg-section' })
demoSection.append(
  el('h3', {}, 'Demo collections'),
  el('p', { class: 'tg-muted' }, 'Tax cases, tax returns, card payments, invoices, products and Titanic: pick one from the Collection menu.'),
)
popover.append(el('h2', { id: 'tg-data-title' }, 'Data'), demoSection, sourcesEl, capRow, statusEl)
host.append(button, popover)
handle.setMenuExtras(host)

function setStatus(text, kind = '') {
  statusEl.textContent = text
  if (kind) statusEl.dataset.kind = kind
  else delete statusEl.dataset.kind
}

let loadSeq = 0
let loading = false
function markCurrent() {
  const key = handle.currentDatasetKey()
  for (const tableButton of sourcesEl.querySelectorAll('button[data-tg-table]')) {
    const current = connectorKey(tableButton.dataset.tgSource, tableButton.dataset.tgTable) === key
    if (current) tableButton.setAttribute('aria-current', 'true')
    else tableButton.removeAttribute('aria-current')
    // aria-disabled, not disabled: a disabled button drops focus to <body> mid-load.
    if (loading) tableButton.setAttribute('aria-disabled', 'true')
    else tableButton.removeAttribute('aria-disabled')
  }
}

function renderSources(sources) {
  const connectors = sources.filter(source => source.id !== 'demo')
  capRow.hidden = !connectors.some(source => Array.isArray(source.tables) && source.tables.length)
  if (!connectors.length) {
    sourcesEl.replaceChildren(el('h3', {}, 'Connected data'), el('p', { id: 'tg-connect-hint' }, CONNECT_HINT))
    return
  }
  const nodes = []
  for (const source of connectors) {
    nodes.push(el('h3', {}, `${source.title || source.id}`))
    if (source.description) nodes.push(el('p', { class: 'tg-muted' }, source.description))
    if (source.error) {
      nodes.push(el('p', { class: 'tg-error' }, `This connection is unavailable: ${errorText(source.error)}`))
      continue
    }
    const tables = Array.isArray(source.tables) ? source.tables : []
    if (!tables.length) { nodes.push(el('p', { class: 'tg-muted' }, 'No tables.')); continue }
    const list = el('ul', { class: 'tg-tables' })
    for (const table of tables) {
      const tableButton = el('button', { type: 'button', 'data-tg-source': source.id, 'data-tg-table': table.name, title: table.description || null })
      tableButton.append(el('span', {}, table.title || table.name))
      if (table.exactRecords != null) tableButton.append(el('span', { class: 'tg-rows' }, `${formatCount(table.exactRecords)} rows`))
      tableButton.addEventListener('click', () => { void loadConnectorTable(source.id, table.name, table.title || table.name) })
      list.appendChild(el('li')).appendChild(tableButton)
    }
    nodes.push(list)
  }
  sourcesEl.replaceChildren(...nodes)
  markCurrent()
}

let listSeq = 0
async function refreshSources() {
  const seq = ++listSeq
  if (!sourcesEl.childElementCount) sourcesEl.replaceChildren(el('p', { class: 'tg-muted' }, 'Checking connected data sources…'))
  if (!rpc) { renderSources([]); return }
  try {
    const sources = await call('listSources')
    if (seq === listSeq) renderSources(Array.isArray(sources) ? sources : [])
  } catch (error) {
    if (seq !== listSeq) return
    capRow.hidden = true
    sourcesEl.replaceChildren(el('h3', {}, 'Connected data'), el('p', { class: 'tg-error' }, `Could not list data sources: ${errorText(error)}`))
  }
}

async function loadConnectorTable(sourceId, table, title) {
  if (loading) return
  const maxRows = Number(capSelect.value) || DEFAULT_MAX_ROWS
  const seq = ++loadSeq
  const picks = collectionPicks
  loading = true
  markCurrent()
  setStatus(`Loading up to ${formatCount(maxRows)} rows from ${title}…`)
  try {
    const data = await call('loadTable', sourceId, table, { maxRows })
    if (seq !== loadSeq) return
    const dataset = datasetFromTable(data)
    const key = connectorKey(sourceId, table)
    maxRowsByKey.set(key, maxRows)
    handle.registerDataset(key, tableLabel(data), dataset)
    if (picks !== collectionPicks) {
      // The user chose another collection while this one loaded: keep their choice.
      setStatus(`${loadedText(data)} It is in the Collection menu.`, 'ok')
      return
    }
    await handle.load(key)
    if (seq !== loadSeq) return
    setStatus(loadedText(data), 'ok')
    saveSoon.cancel()
    await save(stateFor(key, handle.getView(), maxRowsFor))
  } catch (error) {
    if (seq === loadSeq) setStatus(`Could not load ${title}: ${errorText(error)}`, 'error')
  } finally {
    if (seq === loadSeq) { loading = false; markCurrent() }
  }
}

const isOpen = () => !popover.hidden
function openPopover() {
  const rect = button.getBoundingClientRect()
  popover.hidden = false
  popover.style.left = `${Math.round(Math.max(8, Math.min(rect.left, window.innerWidth - popover.offsetWidth - 8)))}px`
  popover.style.top = `${Math.round(rect.bottom + 6)}px`
  button.setAttribute('aria-expanded', 'true')
  popover.focus({ preventScroll: true })
  void refreshSources()
}
function closePopover(returnFocus) {
  if (!isOpen()) return
  popover.hidden = true
  button.setAttribute('aria-expanded', 'false')
  if (returnFocus) button.focus({ preventScroll: true })
}
button.addEventListener('click', () => (isOpen() ? closePopover(true) : openPopover()))
// On the document, not the host: focus may be on <body> (after a click on the canvas side, say).
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && isOpen() && !event.defaultPrevented) {
    event.preventDefault()
    event.stopPropagation()
    closePopover(true)
  }
})
document.addEventListener('pointerdown', event => {
  if (isOpen() && !host.contains(event.target)) closePopover(false)
}, true)
// Tabbing (or any focus move) out of the Data control closes it. A null relatedTarget is ignored:
// it is also what a re-rendered source list produces when it removes the focused button.
host.addEventListener('focusout', event => {
  if (isOpen() && event.relatedTarget instanceof Node && !host.contains(event.relatedTarget)) closePopover(false)
})

// ---------------------------------------------------------------- test hook

const ready = handle.ready.then(() => {
  if (restored) setStatus(loadedText(restored.data), 'ok')
  if (restoreNotice) toast(restoreNotice, 12_000)
})
ready.catch(error => console.error('[tessera-gadget] Tessera failed to open its first collection', error))

globalThis.tesseraGadget = {
  handle,
  ready,
  engine: () => handle.layoutEngine(),
  state: () => lastSavedState,
  currentKey: () => handle.currentDatasetKey(),
  count: () => handle.app.dataset?.n ?? 0,
}
