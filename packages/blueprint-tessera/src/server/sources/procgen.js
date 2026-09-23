// Source adapter for the Synthetic Data (procgen) gatekeeper's SyntheticDataSession
// (packages/gatekeeper-procgen/src/types.d.ts).
//
// Every session call is an observation: it writes an activity record and, in a chat preview, a
// chat message. So the adapter keeps calls few: no describeCollection (the first query page
// carries the schema), 100-row pages (the gatekeeper's maximum), and the caller caches results.

/** PROCGEN_POLICY.maxQueryLimit in packages/gatekeeper-procgen/src/policy.ts. */
export const PAGE_SIZE = 100
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
    columns.push(column)
  }
  return columns
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
   * Pages query({collection, limit, cursor}) until maxRows or the last page. The gatekeeper binds a
   * cursor to the exact query including `limit`, so the limit stays fixed across pages and the last
   * page is sliced instead of shortened. A page that adds no rows or repeats the cursor ends the
   * read, so a misbehaving source cannot loop. `onPage(newRows)` sees each page's rows and may
   * throw to abort (the core's size guard).
   */
  async loadTable(stub, name, { maxRows, title, onPage } = {}) {
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
