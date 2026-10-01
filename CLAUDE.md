# Deployment workflow

Use `pnpm` and the project-pinned Wrangler. Run only one root deployment command per checkout at a
time; use a separate worktree when another agent or operator is already checking or deploying.

## Choose the right command

- `pnpm check:cached` is the fast, validation-only command for repeated local and CI runs. It allows
  each Vite+ task's declared cache policy and never changes Cloudflare resources.
- `pnpm check` is the canonical cold validation. It runs tests, rebuilds local artifacts, and runs
  generated Worker dry-runs without deploying.
- `pnpm release` is the preferred production path after explicit approval of the production
  mutation summary. It performs a fresh validation and then deploys in the same process, so local
  pre-builds run once instead of once during `check` and again during `deploy`.
- `pnpm deploy` remains a direct, fresh deploy for exceptional workflows where validation evidence
  already exists. Do not use `pnpm check && pnpm deploy` as the normal release path; it repeats the
  repository's pre-build work.

## Safety and performance invariants

- Local build batches and Wrangler dry-runs may run with up to four concurrent processes.
- Live Worker uploads remain serial and in `deployOrder()`. The router must deploy last because it
  binds the backend Workers and owns the public route. Do not parallelize the live phase merely to
  save time.
- `pnpm release` and `pnpm deploy` force Vite+ builds cold. Cache reuse is validation-only.
- Vite Task caches live at `node_modules/.vite/task-cache` and
  `cloudflare-os/node_modules/.vite/task-cache`. Restore them only after dependency installation and
  save them only after a successful `pnpm check:cached`. Never cache credentials or generated
  `wrangler.prod.jsonc` files.
- The deploy script removes generated Wrangler configs in `finally`. If one is left behind, first
  prove no check or deploy is active before removing only that stale generated file.
- On a live failure, stop. Record which Workers succeeded and their version IDs before deciding to
  resume or roll back; the multi-Worker deployment is not atomic.
- Treat the printed stage timings as the performance record. Optimize the measured slow stage, and
  retain the dependency batches, production cache policy, and router-last order.

Before any production mutation, follow `.agents/skills/cloudflare-os-operator/SKILL.md`: verify the
account and route, current root and submodule commits, affected Workers and resources, Access/AI/
observability state, last-known-good versions, rollback limitations, and a passing validation.

# Blueprints the Workshop agent can use and adapt

When creating, converting or substantially changing a blueprint (`packages/blueprint-*`,
`formats/`), follow `.agents/skills/author-adaptable-blueprints/SKILL.md`. Each blueprint ships:

- a readable `client.js` (with an adapt block) and `server.js` (with `describeGadget()`) over
  prebuilt `*.lib.js` bundles;
- package-only evals (`src/evals.mjs`), run with `node scripts/blueprint-evals/run.mjs <format>`.

Whiteboard and Ranked vote are the reference conversions; the other formats are not converted yet.

# Records / external datastores: intent

Records is a generic, schema-driven **app datastore service** for cloudflare-os apps: shared data that
must outlive or reach beyond one gadget, starting with open work and messaging profiles. Jira/Linear and Slack/Matrix compatibility is an
optional per-module adapter, never a core
concern, and Neon is not a production requirement. Read
`docs/plans/external_datastores/records-direction.md` before planning Records work. That is the
current recommendation; earlier plans are historical. The new product site is `sites/records/`;
the new service and website run at https://records.surprisingly.ltd on ms:~/containers/records.
Read `docs/plans/external_datastores/records-status.md` for implemented APIs versus remaining gates.
For storage, sync, history or performance work, also read the proposed
`docs/plans/external_datastores/records-immutable-facts.md` (immutable, content-addressed facts after
Perry). Its measurement protocol is in `docs/research/records-performance-ideas.md`.
Preserve the archived earlier site for comparison.

The product centre is a **standards-based datastore**: a complete pinned Schema.org vocabulary
catalogue, open application profiles, custom extensions or a blank model, and explicit mappings
from physical schemas to semantic models. Apps and independently authored compatibility SDKs are
views/adapters over those models. Schema.org is not a complete universal ontology; catalogue
coverage is not executable-profile coverage, and standards alone do not guarantee security.

Records implementation is now authorised. Use `docs/plans/external_datastores/records-delivery.md`
as the live checklist and `records-direction.md` as the accepted design. New work lives in
`packages/records-model` and `packages/records-service`; do not replace the legacy OS runtime until
qualification and migration gates pass. Use broader vendor examples whenever discussing optional
compatibility (work: Jira/Linear; messaging: Slack/Matrix; knowledge: Notion/Confluence).
