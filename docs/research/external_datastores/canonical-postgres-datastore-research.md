# Canonical Postgres datastore: research

> **Records direction superseded — 2026-09-25.** The current recommendation and delivery plan is [Records: shared application data](../../plans/external_datastores/records-direction.md). This document is retained as historical research, implementation evidence or a separate gadget-HTTP proposal; it is not the specification for the new Records service. Existing deployment records remain historical facts, not instructions to deploy the new design.

> **Framing superseded (2026-09-25)** by [App datastore service: reframing](../../plans/external_datastores/app-datastore-service.md). Records is a
> generic, schema-driven datastore for apps built on cloudflare-os. It was never meant to be a
> Jira-like product or a Projects service: project management with a Jira mapping is one example
> module. The evidence stays valid. Its focus on the Jira Cloud surface reflects the superseded framing: Jira compatibility is an optional adapter for one example module.

Written 2026-09-24 against starter `main` `5f8c12c`. Evidence for the
[canonical Postgres datastore plan](../../plans/external_datastores/canonical-postgres-datastore.md).
Confidence: **V** = checked in primary documentation, **S** = secondary source, **I** = inference or
background knowledge not re-checked. Nothing here has been built or measured.

## 1. Immutable history in an OLTP Postgres

- **PostgreSQL 18** (released 2025-09-25, **V**,
  [release notes](https://www.postgresql.org/about/news/postgresql-18-released-3142/)) adds temporal
  keys (`PRIMARY KEY (id, valid WITHOUT OVERLAPS)`, `FOREIGN KEY (…, PERIOD valid)`), `uuidv7()`,
  `OLD`/`NEW` in `RETURNING`, and virtual generated columns. Temporal keys use GiST and need
  `btree_gist` for scalar columns (**S**). There is no `FOR PORTION OF` or system versioning yet (**I**),
  so closing a version row stays in application code.
- **Neon** supports Postgres 14–18, and 18 is the default for new projects (**S**,
  [version support](https://neon.com/docs/postgresql/postgres-version-support)). Our `cfos-records`
  project runs 17 ([deployment record](../../plans/external_datastores/organisation-datastores.md#12-deployment-record-2026-09-24)).
- **The pattern that fits** (**I**): one transaction inserts an immutable journal row and updates a
  narrow current-state row. Reads stay cheap; the journal is history, audit and the sync feed.
  Append-only is enforced by grants (no `UPDATE`/`DELETE` for application roles) and a rejecting
  trigger. Full version tables (SCD2 with `tstzrange` and `WITHOUT OVERLAPS`) are an option for
  entities that need as-of queries in SQL, at the cost of an `UPDATE` to close each version and an
  as-of predicate in every query.
- **Scale** (**I**): range-partition the journal by month, B-tree on `(datastore_id, seq)`, BRIN on
  time. Dropping a partition is the only cheap bulk delete.
- **Erasure** (**I**): immutability conflicts with erasure. Keep personal data (names, emails) out of
  the journal by referencing principals by ID; free text needs an audited redaction procedure or
  crypto-shredding.

## 2. Commit-ordered cursors

Sequences allocate before commit, so a reader can see 12 before 11 commits and skip 11 for ever
(**S**, [Sequin](https://blog.sequinstream.com/postgres-sequences-can-commit-out-of-order/),
[event-driven.io](https://event-driven.io/en/ordering_in_postgres_outbox/)). The deployed Records
outbox already avoids cursors for this reason
([decisions §7](organisation-datastores-decisions.md#7-outbox-correction-allocation-order-is-not-commit-order)).

| Approach | Ordering | Cost |
| --- | --- | --- |
| Per-datastore counter row, `UPDATE … SET seq = seq + 1 RETURNING seq` inside the write transaction | Gapless, commit order per datastore, because the row lock serialises that datastore's commits | Writes to one datastore are serial. Fine for organisational workloads; take the lock last to keep it short |
| `pg_current_xact_id()` on each row; read only below `pg_snapshot_xmin(pg_current_snapshot())` | Lock-free | One long transaction stalls every reader |
| Logical replication (LSN) | Exact | Needs a long-lived replication consumer (Electric, Zero, Debezium, Sequin) |

Hyperdrive does **not** support advisory locks, `LISTEN`/`NOTIFY` or SQL-level `PREPARE` (**V**,
[Hyperdrive features](https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/)),
so the counter row is the portable choice. Linear's sync engine uses one global, monotonically
increasing `lastSyncId` (**S**, [reverse-engineering](https://github.com/wzhudev/reverse-linear-sync-engine)).

## 3. Client sync protocols

- **Replicache protocol** (**V**, [push](https://doc.replicache.dev/reference/server-push),
  [pull](https://doc.replicache.dev/reference/server-pull)): clients push mutations with a per-client
  monotonically increasing ID; the server applies each mutation and bumps that client's
  `lastMutationID` in the same transaction; a mutation that fails permanently must still be marked
  processed or the client stalls. Pull takes an orderable cookie and returns a patch plus
  `lastMutationIDChanges`. The client rebases: it resets to server state and replays mutations the
  server has not yet processed. The server sends a content-free *poke* and the client pulls.
- **Replicache** is in maintenance mode, free and open source; Rocicorp points new work to Zero (**S**).
  The protocol is backend-agnostic, so implementing its semantics ourselves is low-risk.
- **Zero** is Apache-2.0 and reached 1.0 around June 2026 (**V**/**S**). It needs Postgres with
  `wal_level=logical` and a long-lived `zero-cache` process (**S**). That conflicts with the aims of no
  replication consumer and no hard platform dependency.
- **Electric, PowerSync** (from earlier research): also need a long-lived server and logical
  replication. See [gadget-postgres-mirror.md](gadget-postgres-mirror.md).

## 4. Realtime without replication

`LISTEN`/`NOTIFY` does not work through Neon's transaction-mode pooler (**V**,
[pooling](https://neon.com/docs/connect/connection-pooling)) or through Hyperdrive (**V**). The portable
approach (**I**): after commit, the API tells a per-datastore hub the new head `seq`; the hub pokes
connected clients; clients pull from their cursor. A lost poke only delays an update because clients
also pull on reconnect, on focus and on a timer. On Cloudflare the hub is a Durable Object with
hibernating WebSockets; elsewhere it can be SSE plus Redis pub/sub.

## 5. Jira Cloud REST as a compatibility target

- **Endpoints** (**I**, stable for years): `POST/GET/PUT /rest/api/3/issue[/{idOrKey}]`,
  `GET/POST /issue/{key}/transitions` (transition IDs are per workflow and differ from status IDs),
  `/issue/{key}/comment`, `/project/search`, `/project/{key}`, `/myself`, `/user/search`, `/field`,
  `/priority`, `/status`, `/serverInfo`. `priority` and `status` are objects referenced by `id` or
  `name`; custom fields are `customfield_NNNNN`.
- **Search** (**S**, [issue search](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/)):
  `GET/POST /rest/api/3/search/jql` with `nextPageToken`; fields are not returned unless requested. The
  old `/rest/api/{2,3}/search` was deprecated 2024-10-31 and has returned 410 since 2025-08-01 (**S**).
- **Rich text** (**I**): v3 requires Atlassian Document Format (ADF) JSON for `description`,
  `comment.body` and `environment`; v2 accepts plain or wiki-markup strings.
- **Auth** (**S**, [basic auth](https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/)):
  Basic `email:api_token`; OAuth 2.0 (3LO) via `api.atlassian.com/ex/jira/{cloudId}`; scoped tokens via
  that same gateway path.
- **Webhooks** (**V**, [webhooks](https://developer.atlassian.com/cloud/jira/platform/webhooks/)):
  `{timestamp, webhookEvent: "jira:issue_created" | "jira:issue_updated" | "jira:issue_deleted" |
  "comment_created", issue, user, changelog}`; optional secret gives an `X-Hub-Signature` HMAC; an
  `X-Atlassian-Webhook-Identifier` header; up to 5 retries.
- **Clients with a configurable base URL** (**I**): jira.js (`host`), Python `jira` (`server=`),
  go-jira (`baseURL`), ankitpokhrel/jira-cli (`server`; its local mode uses v2 and a bearer token), n8n
  (Server/Data Center credential). Clients commonly call `/serverInfo`, `/myself`, `/field` and
  `/project/search` at start-up.
- **No maintained open-source Jira-compatible server was found** (**S**/unverified). Plane, Huly,
  OpenProject and YouTrack provide importers, not API emulation. Compatibility has to be proven with
  the clients themselves.
- **JQL parsers** (**S**): `@atlaskit/jql-parser` (Atlassian's ANTLR grammar) and
  `@atlassianlabs/jql-ast`.

## 6. Identity into Postgres RLS without platform coupling

- **PostgREST/Supabase convention** (**V**): per transaction `SET LOCAL ROLE authenticated` and
  `set_config('request.jwt.claims', …, true)`; policies read the subject through a function.
  Performance guidance (**V**, [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)):
  wrap the function as `(select fn())` so it runs once per statement, index policy columns, use
  `SECURITY DEFINER` helpers for membership lookups, and scope policies `TO role`.
- Transaction-local settings work through transaction pooling and Hyperdrive (**I**). The deployed
  Records service already relies on this and tests it on direct connections and local Hyperdrive.
- **Neon** offers `pg_session_jwt` and a Data API that validates JWTs against a JWKS (**V**,
  [pg_session_jwt](https://neon.com/docs/extensions/pg_session_jwt)). The standalone "Neon RLS" product
  appears to be retired (**S**, unconfirmed). Verifying tokens in our own service and setting claims
  ourselves keeps the design provider-neutral.
- **Cloudflare Access** (**V**,
  [validating JWTs](https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/)):
  any service can validate `Cf-Access-Jwt-Assertion` against
  `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, checking `aud` and `iss`; keys rotate
  every 6 weeks, so match `kid`. **Access for SaaS** can act as a generic OIDC provider (discovery,
  token, JWKS, userinfo, PKCE, refresh tokens, custom claims; **V**,
  [generic OIDC](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/saas-apps/generic-oidc-saas/)),
  so a datastore service or UI hosted anywhere can sign users in with the platform's identity.
- **Delegation** (**I**): RFC 8693 token exchange defines `subject_token`, `actor_token` and the `act`
  claim. A platform gateway that has verified a user can obtain or mint a short-lived token with
  `sub` = user and `act` = gateway; RLS uses `sub` and the journal records both.

## 7. Portable runtime

- **Hono** runs on Workers, Node, Bun and Deno (**I**). `@hono/zod-openapi` 1.6.3 requires `zod ^4`
  and `hono >= 4.10` (**V**). The repository's contracts use Zod; check its major version before adopting.
- **Workers placement** (**V**, [placement](https://developers.cloudflare.com/workers/configuration/placement/)):
  Smart Placement, or explicit `region = "aws:eu-west-2"`-style hints. Placement applies to `fetch`
  handlers, not RPC entrypoints, so a placed data Worker should be called over HTTP (or a service
  binding `fetch`). Co-located queries are cited at 1–3 ms versus 20–30 ms without placement (**S**).
  Not measured for our Neon London project.

## 8. Unresolved

- Hyperdrive latency from a placed Worker to Neon `eu-west-2`: not measured.
- RLS policy cost with principal-level membership checks at realistic sizes: not measured.
- Behaviour of real Jira clients against a partial implementation: not tested.
- Replicache licence text and the Neon RLS retirement date: not seen in primary sources.
