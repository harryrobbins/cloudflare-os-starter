// Source adapter for the Synthetic Data (procgen) gatekeeper's SyntheticDataSession
// (packages/gatekeeper-procgen/src/types.d.ts).
//
// Every session call is an observation: it writes an activity record and, in a chat preview, a
// chat message. So the adapter keeps calls few: one table() call per load, which also joins the
// facets of referenced records (an order's customer tier and country), and the caller caches
// results. A gatekeeper deployed before table() existed is read in 100-row query() pages.

import { isMissingMethod } from '../errors.js'

/** PROCGEN_POLICY.maxQueryLimit in packages/gatekeeper-procgen/src/policy.ts. */
export const PAGE_SIZE = 100
/** PROCGEN_POLICY.maxTableLimit. */
export const TABLE_LIMIT = 20_000
/**
 * Fixed, so a reload (or another viewer) sees the same rows. A sample's first k rows are its
 * sample of k, so the core's "serve a smaller cap from a larger load" slice stays representative.
 */
export const SAMPLE_SEED = 'tessera'
/** Sessions that answered table() with "no such method"; they are paged instead from then on. */
const legacy = new WeakSet()
const TYPES = new Set(['string', 'number', 'boolean', 'timestamp'])

/** Maps procgen FieldSchema[] to TableColumn[], dropping `json` fields (and any unknown type). */
export function mapColumns(fields, firstRecord) {
  const currency = typeof firstRecord?.currency_code === 'string' && /^[A-Z]{3}$/.test(firstRecord.currency_code) ? firstRecord.currency_code : undefined
  const columns = []
  for (const field of fields ?? []) {
    if (!field || typeof field.name !== 'string' || !TYPES.has(field.type)) continue
    const column = { name: field.name, type: field.type }
    if (typeof field.semanticType === 'string') column.semantic = field.semanticType
    if (currency && (field.semanticType === 'currency_minor' || field.name.endsWith('_minor'))) {
      column.semantic = 'currency_minor'
      column.currency = currency
    }
    // A joined facet ("customer.tier") reads better as "customer tier".
    if (field.name.includes('.')) column.title = field.name.replaceAll('.', ' ').replaceAll('_', ' ')
    columns.push(column)
  }
  return columns
}

/** Row-major rows from table()'s column-major, dictionary-encoded columns, keeping only `columns`. */
function tableRows(result, columns) {
  const byName = new Map((result.columns ?? []).map((column, index) => [column?.name, index]))
  const rowCount = Math.max(0, Math.floor(Number(result.rowCount) || 0))
  const readers = columns.map(column => {
    const index = byName.get(column.name)
    const values = Array.isArray(result.data?.[index]) ? result.data[index] : []
    const dictionary = Array.isArray(result.columns[index]?.dictionary) ? result.columns[index].dictionary : null
    return dictionary ? r => dictionary[values[r]] ?? null : r => values[r] ?? null
  })
  return Array.from({ length: rowCount }, (_, r) => readers.map(read => read(r)))
}

/** The first row as a record, for mapColumns' currency lookup. */
function firstRecord(result) {
  const index = (result.columns ?? []).findIndex(column => column?.name === 'currency_code')
  if (index < 0) return undefined
  const column = result.columns[index], value = result.data?.[index]?.[0]
  return { currency_code: column.dictionary ? column.dictionary[value] : value }
}

async function loadWithTable(stub, name, { maxRows, title, totalRows: expected, onPage }) {
  const limit = Math.min(TABLE_LIMIT, maxRows)
  // A table that fits whole is read in ID order (a time series stays in date order).
  const fits = Number.isSafeInteger(expected) && expected <= limit
  const result = await stub.table({ collection: name, limit, ...(fits ? {} : { sample: { seed: SAMPLE_SEED } }) })
  const columns = mapColumns(result?.columns, firstRecord(result ?? {}))
  const rows = tableRows(result ?? {}, columns).slice(0, maxRows)
  // Page-sized slices, so the core's size guard stops at about the row where the limit was passed.
  for (let start = 0; start < rows.length; start += PAGE_SIZE) onPage?.(rows.slice(start, start + PAGE_SIZE))
  const totalRows = Number(result?.totalRecords)
  const known = Number.isSafeInteger(totalRows) && totalRows >= 0
  return {
    name: title ?? name,
    columns,
    rows,
    truncated: result?.complete !== true || rows.length < (Number(result?.rowCount) || 0),
    ...(known ? { totalRows } : {}),
  }
}

export const procgen = Object.freeze({
  kind: 'procgen',

  /** A procgen session answers describeDataset() with a `scenario`; anything else is not one. */
  async probe(stub) {
    const dataset = await stub.describeDataset()
    if (!dataset || typeof dataset.scenario !== 'string') return null
    const details = [dataset.scenario, dataset.version, dataset.sizeProfile && `${dataset.sizeProfile} profile`, dataset.seedLabel && `seed ${dataset.seedLabel}`].filter(part => typeof part === 'string' && part)
    return { title: 'Synthetic Data', description: details.join(', ') }
  },

  async listTables(stub) {
    const collections = await stub.listCollections()
    if (!Array.isArray(collections)) throw new Error('Synthetic Data returned no collection list.')
    return collections.map(c => ({ name: String(c.name), title: String(c.title ?? c.name), ...(typeof c.description === 'string' ? { description: c.description } : {}), exactRecords: Number(c.exactRecords) }))
  },

  /**
   * One table() call: the whole table in ID order when `totalRows` (listTables' exactRecords) fits
   * maxRows, otherwise a spread-out sample of maxRows rows,
   * with facet fields joined from referenced records. Falls back to paging query() for a
   * gatekeeper without table(). `onPage(newRows)` sees the rows in 100-row slices and may throw to
   * abort (the core's size guard).
   */
  async loadTable(stub, name, options = {}) {
    const maxRows = Math.max(1, Math.floor(options.maxRows))
    if (!legacy.has(stub)) {
      try { return await loadWithTable(stub, name, { ...options, maxRows }) }
      catch (error) {
        if (!isMissingMethod(error)) throw error
        legacy.add(stub)
      }
    }
    return procgen.pageTable(stub, name, { ...options, maxRows })
  },

  /**
   * Pages query({collection, limit, cursor}) until maxRows or the last page. The gatekeeper binds a
   * cursor to the exact query including `limit`, so the limit stays fixed across pages and the last
   * page is sliced instead of shortened. A page that adds no rows or repeats the cursor ends the
   * read, so a misbehaving source cannot loop. `onPage(newRows)` sees each page's rows and may
   * throw to abort (the core's size guard).
   */
  async pageTable(stub, name, { maxRows, title, onPage } = {}) {
    const cap = Math.max(1, Math.floor(maxRows))
    const limit = Math.min(PAGE_SIZE, cap)
    let schema = null, columns = null, cursor, rows = []
    while (true) {
      const page = await stub.query({ collection: name, limit, ...(cursor ? { cursor } : {}) })
      const records = Array.isArray(page?.records) ? page.records : []
      if (!schema) {
        schema = page?.schema ?? {}
        columns = mapColumns(schema.fields, records.find(record => record && typeof record === 'object'))
      }
      const added = []
      for (const record of records) {
        if (rows.length + added.length >= cap) break
        if (!record || typeof record !== 'object') continue
        added.push(columns.map(column => record[column.name] ?? null))
      }
      for (const row of added) rows.push(row)
      const next = typeof page?.nextCursor === 'string' && page.nextCursor ? page.nextCursor : undefined
      const stalled = next !== undefined && (next === cursor || added.length === 0)
      cursor = next
      onPage?.(added)
      if (!cursor || stalled || rows.length >= cap) break
    }
    const totalRows = Number(schema?.exactRecords)
    const known = Number.isSafeInteger(totalRows) && totalRows >= 0
    return {
      name: title ?? schema?.title ?? name,
      columns,
      rows,
      truncated: known ? rows.length < totalRows : Boolean(cursor),
      ...(known ? { totalRows } : {}),
    }
  },
})
