# External datastores: plans

Plans for data that lives outside any single gadget: organisation datastores that many gadgets,
people and external systems share, and APIs that let the outside world read and write data held on
the platform. The evidence behind these plans is in
[`../../research/external_datastores/`](../../research/external_datastores/README.md).

## Overview

A gadget's own storage is a private SQLite database inside its Durable Object facet. That works well
for a single board or whiteboard, but it cannot be shared across gadgets, reached from outside, queried
with SQL, or kept when the gadget is deleted. These plans answer "where should business data live, and
how does everything else get at it?"

The direction, agreed 2026-09-24:

- **Postgres is the source of truth** for organisational business data.
- **An API is the only way in.** It exposes domain commands, and modules can add compatibility surfaces,
  such as a Jira-compatible subset for Projects.
- **Change history is immutable:** a journal written in the same transaction as each change, ordered
  by a per-datastore clock.
- **UIs are optimistic and rebase** onto whatever the server decides.
- **The service is portable.** It accepts cloudflare-os identities (delegated tokens, Cloudflare
  Access) and enforces them with row-level security, without depending on Cloudflare to run.

Gadget-local data stays in Durable Objects. A gadget-specific HTTP API remains a separate, smaller
feature for automating one gadget.

## Documents

| Plan | Status | What it is |
| --- | --- | --- |
| [canonical-postgres-datastore.md](canonical-postgres-datastore.md) | **Target design**, proposal | The canonical shape: journal and clock, command bus, RLS by principal, delegated tokens, optimistic sync, native and Jira-compatible APIs, portability. Builds on Records |
| [organisation-datastores.md](organisation-datastores.md) | **Implemented and deployed** (2026-09-24), signed-in checks pending | Records: the Postgres-backed service on Neon, with registry, memberships, approvals, viewer assertions, outbox delivery, the Data management page and the project board and report blueprints. Includes the deployment record |
| [gadget-http-api.md](gadget-http-api.md) | Planned, not built | Give one gadget a REST endpoint through a gatekeeper and hook. For gadget automation, not organisational records |
| [immutable-datastores.md](immutable-datastores.md) | **Not pursued** | Event-sourced Durable Object shards exporting to an R2 lakehouse. Rejected because the source of truth must be strongly consistent; its ordering and journal ideas moved into the canonical plan |
| [external-records-service.md](external-records-service.md) | **Superseded** | An earlier Postgres records-service sketch using PostgREST and the Neon Data API |

## Reading order

1. The canonical plan, for where things are heading.
2. The organisation datastores plan, for what exists and is deployed, and the decisions it carries.
3. The research index, for evidence and rejected options.

## Conventions shared by these plans

- The public entrypoint is the Router. APIs live under `/gatekeeper/<name>/…` behind a path-specific
  Access application.
- Mutations take an `Idempotency-Key`. Edits take `If-Match` revisions. Errors are problem+json
  (`revision_conflict` 412, `revision_required` 428, other conflicts 409).
- Credentials are shown once and stored as SHA-256 digests (`rk1_…` for Records).
- No payloads or secrets in logs or observations.
- Publishing a blueprint never provisions data. Creating a datastore is an explicit administrative
  action.
