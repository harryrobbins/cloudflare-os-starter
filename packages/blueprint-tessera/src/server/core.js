// The Tessera gadget's server logic, free of `cloudflare:workers` so unit tests and the browser
// harness run it as-is. src/server/index.js wraps it in the Durable Object the platform loads.
//
// Connector reads are observations (an activity record each, and a chat message in a chat
// preview), so detection and loaded tables are cached for the facet's lifetime. Binding changes
// restart the facet, so neither cache can go stale. Tables are never written to durable storage.

import { DEFAULT_STATE, gadgetState, loadOptions, sourceId as validSourceId, tableName } from '../shared/validation.js'
import { isMissingMethod } from './errors.js'
import { procgen } from './sources/procgen.js'

export { isMissingMethod }

export const STATE_KEY = 'state'
export const PROBE_TIMEOUT_MS = 3_000
/** How long a binding whose probe failed transiently (rejected, timed out) waits before a retry. */
export const PROBE_RETRY_MS = 30_000
/** JSON size above which a loaded table is refused rather than sent to the frame. */
export const MAX_RESULT_BYTES = 8 * 1024 * 1024
/** How long a load refused for size is remembered, so a retry does not repeat every read. */
export const SIZE_FAILURE_MS = 60_000
const TABLE_CACHE_ENTRIES = 4
const CONNECT_HINT = "Open this gadget's Connections tab and add Synthetic Data (if a chat is open, accept its changes)."

function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not answer within ${ms / 1000} s.`)), ms) })
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer))
}

const message = error => (error instanceof Error ? error.message : String(error)).slice(0, 500)
const isStubLike = value => value !== null && (typeof value === 'object' || typeof value === 'function')
const encoder = new TextEncoder()
/** UTF-8 byte length of a value's JSON (Workers have TextEncoder, not Buffer). */
export const jsonBytes = value => encoder.encode(JSON.stringify(value)).length
const mb = bytes => (bytes / 1048576).toFixed(1)

/** Thrown when a load passes the size guard; `atRows` is how many rows it had read by then. */
class TooLargeError extends Error {
  constructor(text, atRows) { super(text); this.name = 'TooLargeError'; this.atRows = atRows }
}

/** Prefixes an adapter or gatekeeper error so the client never mistakes it for its own dead stub. */
const unavailable = (id, error) => new Error(`Data source ${id} is unavailable: ${message(error)}`, { cause: error })

/**
 * @param {{ env?: Record<string, unknown>, storage: { get(key: string): Promise<unknown>, put(key: string, value: unknown): Promise<void> },
 *           adapters?: object[], probeTimeoutMs?: number, probeRetryMs?: number, maxResultBytes?: number, sizeFailureMs?: number,
 *           now?: () => number }} options
 */
export function createCore({
  env = {}, storage, adapters = [procgen], probeTimeoutMs = PROBE_TIMEOUT_MS, probeRetryMs = PROBE_RETRY_MS,
  maxResultBytes = MAX_RESULT_BYTES, sizeFailureMs = SIZE_FAILURE_MS, now = () => Date.now(),
}) {
  /** binding id -> {promise, retryAt?}: a settled probe outcome, or the one in flight. */
  const probes = new Map()
  /** sourceId -> Promise<table summaries> */
  const tableLists = new Map()
  /** `${sourceId}\0${table}` -> {maxRows, promise}; insertion order doubles as LRU order. */
  const tables = new Map()
  /** `${sourceId}\0${table}` -> {atRows, error, until}: a recent load refused for size. */
  const sizeFailures = new Map()

  /**
   * One binding's probe outcome: `{found: {adapter, info}}`, `{none: true}` (it answered and is
   * not a connector, or has no such method: final, since binding changes restart the facet), or
   * `{error}` (rejected or timed out: retried after probeRetryMs).
   */
  async function probeBinding(id, stub) {
    try {
      for (const adapter of adapters) {
        try {
          const info = await withTimeout(adapter.probe(stub), probeTimeoutMs, `Binding ${id}`)
          if (info) return { found: { adapter, info } }
        } catch (error) {
          if (!isMissingMethod(error)) throw error
        }
      }
      return { none: true }
    } catch (error) {
      return { error: message(error) }
    }
  }

  /** Cached per binding: a success or a definite "not a connector" forever, a failure until its backoff ends. */
  function probeCached(id) {
    const cached = probes.get(id)
    if (cached && !(cached.retryAt !== undefined && now() >= cached.retryAt)) return cached.promise
    const entry = { promise: null, retryAt: undefined }
    entry.promise = probeBinding(id, env[id]).then(outcome => {
      if (outcome.error) entry.retryAt = now() + probeRetryMs
      return outcome
    })
    probes.set(id, entry)
    return entry.promise
  }

  /**
   * env.PROCGEN first: "Connect resource" names the binding PROCGEN (or PROCGEN_2, …). Only when
   * no binding starts with PROCGEN are the other env keys (never GADGET) probed, with a timeout.
   * Each binding's outcome is cached on its own, so one failing binding never re-probes the
   * healthy ones. A PROCGEN* binding that fails is listed with its error; an unrelated binding
   * that fails is simply not listed (and retried after the backoff).
   */
  async function detect() {
    const keys = Object.keys(env).filter(key => key !== 'GADGET' && isStubLike(env[key])).toSorted()
    const named = keys.filter(key => key.startsWith('PROCGEN'))
    const candidates = named.length ? named : keys
    const outcomes = await Promise.all(candidates.map(id => probeCached(id)))
    const sources = []
    candidates.forEach((id, index) => {
      const outcome = outcomes[index]
      if (outcome.found) sources.push({ id, adapter: outcome.found.adapter, stub: env[id], info: outcome.found.info })
      else if (named.length) sources.push({ id, adapter: procgen, stub: env[id], error: outcome.error ?? `Binding ${id} is not a Synthetic Data connection.` })
    })
    return sources
  }

  function listTables(source) {
    let list = tableLists.get(source.id)
    if (!list) {
      list = Promise.resolve().then(() => source.adapter.listTables(source.stub))
      tableLists.set(source.id, list)
      list.catch(() => { if (tableLists.get(source.id) === list) tableLists.delete(source.id) })
    }
    return list
  }

  async function findSource(id) {
    const source = (await detect()).find(candidate => candidate.id === id)
    if (!source) throw new Error(`No connected data source "${id}". ${CONNECT_HINT}`)
    if (source.error) throw new Error(`Data source ${id} is unavailable: ${source.error}`)
    return source
  }

  function remember(key, entry) {
    tables.delete(key)
    tables.set(key, entry)
    while (tables.size > TABLE_CACHE_ENTRIES) tables.delete(tables.keys().next().value)
  }

  /** Reads one table, refusing it as soon as the rows read so far pass the size guard. */
  function startLoad(source, key, table, summary, maxRows) {
    const entry = { maxRows, complete: false, promise: null }
    entry.promise = (async () => {
      let bytes = jsonBytes(summary.title) + 64
      let rowCount = 0
      const tooLarge = () => new TooLargeError(`Too large: ${summary.title} passed the ${(maxResultBytes / 1048576).toFixed(0)} MB limit at ${rowCount.toLocaleString('en-GB')} rows (${mb(bytes)} MB); load fewer rows.`, rowCount)
      const onPage = rows => {
        bytes += jsonBytes(rows)
        rowCount += rows.length
        if (bytes > maxResultBytes) throw tooLarge()
      }
      let result
      try {
        result = await source.adapter.loadTable(source.stub, table, { maxRows, title: summary.title, totalRows: summary.exactRecords, onPage })
      } catch (error) {
        if (error instanceof TooLargeError) throw error
        throw unavailable(source.id, error)
      }
      bytes += jsonBytes(result.columns)
      if (bytes > maxResultBytes) throw tooLarge()
      entry.complete = !result.truncated
      return result
    })()
    remember(key, entry)
    entry.promise.catch(error => {
      if (tables.get(key) === entry) tables.delete(key)
      if (error instanceof TooLargeError) {
        const previous = sizeFailures.get(key)
        if (!previous || now() >= previous.until || error.atRows < previous.atRows) sizeFailures.set(key, { atRows: error.atRows, error, until: now() + sizeFailureMs })
      }
    })
    return entry
  }

  const api = {
    /** The saved source selection and view, or the demo default `{source:{kind:'demo'}, rev:0}`. */
    async getState() {
      return (await storage.get(STATE_KEY)) ?? { ...DEFAULT_STATE, source: { ...DEFAULT_STATE.source } }
    },

    /** Validates and stores the state; the last writer wins. Returns the stored state with its new rev. */
    async setState(state) {
      const previous = await storage.get(STATE_KEY)
      const clean = gadgetState(state, (previous?.rev ?? 0) + 1)
      await storage.put(STATE_KEY, clean)
      return clean
    },

    /** `[{id:'demo', title}, …connectors]`; each connector lists its tables, or carries `error`. */
    async listSources() {
      try {
        const sources = await detect()
        const connectors = await Promise.all(sources.map(async source => {
          const base = { id: source.id, kind: source.adapter.kind, title: source.info?.title ?? source.id, description: source.info?.description ?? '' }
          if (source.error) return { ...base, error: source.error }
          try { return { ...base, tables: await listTables(source) } }
          catch (error) { return { ...base, error: message(error) } }
        }))
        return [{ id: 'demo', kind: 'demo', title: 'Demo collections' }, ...connectors]
      } catch (error) {
        // Matches the client's "Data source … is unavailable" application-error pattern.
        throw new Error(`Data source list is unavailable: ${message(error)}`, { cause: error })
      }
    },

    /** TableData for one connector table, capped at `maxRows` (1-10,000, default 2,000). */
    async loadTable(sourceIdInput, tableInput, options) {
      const id = validSourceId(sourceIdInput)
      const table = tableName(tableInput)
      const { maxRows } = loadOptions(options)
      const source = await findSource(id)
      let known
      try { known = await listTables(source) } catch (error) { throw unavailable(id, error) }
      const summary = known.find(candidate => candidate.name === table)
      if (!summary) throw new Error(`Unknown table "${table}" in ${id}; tables: ${known.map(candidate => candidate.name).join(', ')}.`)

      const key = `${id}\0${table}`
      const failed = sizeFailures.get(key)
      if (failed && now() < failed.until && maxRows >= failed.atRows) throw failed.error

      const cached = tables.get(key)
      if (cached && (cached.maxRows >= maxRows || cached.complete)) {
        remember(key, cached)
        let result
        try { result = await cached.promise }
        catch (error) {
          // A larger load this request joined was refused for size at more rows than it asked
          // for: this request can still succeed on its own.
          if (error instanceof TooLargeError && maxRows < error.atRows) return api.loadTable(id, table, { maxRows })
          throw error
        }
        return result.rows.length <= maxRows ? result : { ...result, rows: result.rows.slice(0, maxRows), truncated: true }
      }
      return startLoad(source, key, table, summary, maxRows).promise
    },
  }
  return api
}
