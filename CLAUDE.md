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
