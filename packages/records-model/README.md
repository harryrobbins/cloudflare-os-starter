# Records model foundation

Complete pinned Schema.org **30.1** catalogue, explicit application profiles and reviewed module
publication artefacts. No runtime dependencies; Node 24.19+. Catalogue coverage is not application
coverage: 3,026 Schema.org terms are available, while executable SQL modules cover work items and
messages. Importing the catalogue does not generate thousands of tables or grant any access.

```sh
node packages/records-model/scripts/catalogue.ts verify
node packages/records-model/scripts/catalogue.ts stats
node packages/records-model/scripts/catalogue.ts validate packages/records-model/profiles/work.json
node --test packages/records-model/test/*.test.ts
```

`catalogue.ts import` redownloads the pinned official release and rejects any checksum mismatch.
Updates require an explicit release/provenance edit and review; `diffCatalogues` reports added,
removed and changed graph nodes. The original graph remains intact, including annotations,
external nodes, multiple inheritance, superseded/retired/pending terms and domain/range conventions.
HTTP and HTTPS Schema.org terms resolve to the same canonical HTTPS identity.

`src/index.ts` exports:

- `buildCatalogue`, `canonicalIri`, `diffCatalogues`: vocabulary access without network I/O.
- `validateProfile`, `validateRecord`, `recordJsonSchema`: explicit application constraints.
- `toJsonLd`, `fromJsonLd`: a deliberately restricted, expanded-IRI JSON-LD representation,
  preserving identifiers and declared custom fields, including JSON extension objects. These are
  not general JSON-LD processors. Remote/compact contexts and unmapped fields fail closed.
- `mapToCanonical`, `mapFromCanonical`: versioned column/identity/enum mappings. SQL NULL becomes
  omitted; unknown enum values, missing identities and ambiguous inverse mappings fail. Two
  different storage layouts converge in the executable test fixture. No SQL is inferred or run.
- `validateModule`, `preparePublication`, `validateUpgrade`: validate command scopes, API/version
  identity and checksummed migration bytes before privileged SQL publication. Migration IDs are
  restricted logical IDs, never paths; a caller resolves them inside its trusted package directory.
  Commands may carry a schema-qualified `(uuid,text,jsonb,bigint,bigint)` handler signature. `preparePublication`
  does not execute SQL; a deployment owner must review it. Upgrade validation preserves prior
  migrations and conservatively rejects changed existing fields within an API major.

`profiles/work.json` and `messaging.json` match the initial SQL shapes (title/status/description/
extensions; channel/body/extensions). `*-example.json` demonstrate a richer project/channel model
that is **not implemented by those SQL modules**. `extended.json` extends that illustrative work
profile; `custom.json` begins with an entirely custom observatory model. The `urn:records:` IDs are
stable package identifiers, not claims of an officially registered universal vocabulary. A publisher
can supply its own owned HTTP namespace. Reusable profile licensing is a production publication
choice; this private implementation does not assert that decision on the owner's behalf.

JSON validation cannot enforce database references, membership or row permissions. The SQL command
boundary remains authoritative. Callers must permission-filter records before export and retain
trusted datastore/module identity independently of semantic IDs. UUID rows map to `urn:uuid:` IDs
at the export boundary. No remote fetches occur when validating records or profiles.

## Upstream attribution

`catalogue/schemaorg-30.1.jsonld` is an **unmodified complete** Schema.org all-https release from
Schema.org sponsors and contributors, including retired terms. Copyright and licence remain with
the upstream authors; vocabulary licensed **CC BY-SA 3.0**. See
[licence](https://creativecommons.org/licenses/by-sa/3.0/),
[Schema.org terms](https://schema.org/docs/terms.html),
[developer download explanation](https://schema.org/docs/developers.html) and
[release archive](https://github.com/schemaorg/schemaorg/tree/main/data/releases/30.1).
`catalogue/provenance.json` records the original source, release date and SHA-256. Derived in-memory
indexes normalize identifiers without modifying the distributed upstream file.
