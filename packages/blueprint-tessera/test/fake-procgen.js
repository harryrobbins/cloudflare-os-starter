// A fake SyntheticDataSession (packages/gatekeeper-procgen/src/types.d.ts) built on the real
// generator, so schemas, record shapes and counts match the deployed gatekeeper. Like the real
// one, a cursor is bound to the exact query (collection and limit) and a limit over 100 is refused.
// Every call is recorded in `calls`, standing in for the gatekeeper's observation records.

import { COLLECTION_NAMES, countFor, generateRecord, isCollection, schemaFor } from '../../gatekeeper-procgen/src/generator.ts'

const encode = body => Buffer.from(JSON.stringify(body)).toString('base64url')

export function fakeProcgen({ seed = 'demo', profile = 'small', describe } = {}) {
  const resource = { url: `procgen://commerce/v1/${seed}/${profile}`, scenario: 'commerce', version: 'v1', seed, profile }
  const calls = []
  return {
    calls,
    async describeDataset() {
      calls.push(['describeDataset'])
      if (describe) return describe()
      return { resourceUrl: resource.url, scenario: resource.scenario, version: resource.version, seedLabel: seed, sizeProfile: profile }
    },
    async listCollections() {
      calls.push(['listCollections'])
      return COLLECTION_NAMES.map(name => schemaFor(resource, name)).map(({ fields: _f, indexes: _i, aggregates: _a, ...summary }) => summary)
    },
    async describeCollection(name) {
      calls.push(['describeCollection', name])
      if (!isCollection(name)) throw new Error(`Unknown collection ${name}.`)
      return schemaFor(resource, name)
    },
    async query(request) {
      calls.push(['query', request])
      if (!request || !isCollection(request.collection)) throw new Error('Query collection is invalid.')
      const limit = request.limit ?? 50
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Query limit must be 1-100.')
      let offset = 0
      if (request.cursor) {
        const body = JSON.parse(Buffer.from(request.cursor, 'base64url').toString())
        if (body.collection !== request.collection || body.limit !== limit) throw new Error('Cursor is expired or does not belong to this query.')
        offset = body.offset
      }
      const total = countFor(resource, request.collection)
      const end = Math.min(total, offset + limit)
      const records = []
      for (let id = offset + 1; id <= end; id++) records.push(generateRecord(resource, request.collection, id))
      return { schema: schemaFor(resource, request.collection), records, ...(end < total ? { nextCursor: encode({ collection: request.collection, limit, offset: end }) } : {}) }
    },
  }
}

/** An in-memory stand-in for ctx.storage (get/put with structured-clone semantics). */
export function memoryStorage() {
  const map = new Map()
  return { map, async get(key) { return map.has(key) ? structuredClone(map.get(key)) : undefined }, async put(key, value) { map.set(key, structuredClone(value)) } }
}
