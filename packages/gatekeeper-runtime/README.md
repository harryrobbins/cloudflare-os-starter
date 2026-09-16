# Notebook Python runtime

Private Gatekeeper Worker, Durable Object coordinator and Python Sandbox container. The exact preview SDK and matching image are pinned together. It exposes no public execution, terminal, file or preview endpoint.

Every connection owns a fresh random runtime identity. Execute and stop requests need an owner-session permit scoped to the exact intent, gadget and connection, which authorizes that operation directly; Workshop Activity retains the audit record. Callers cannot supply a runtime ID. The trusted connector declares `workspaceReadable: true`, so authorized workspace collaborators can read status/results without their own Python account; this grant persists for the lifetime of the connection. Saved outputs are shareable; Python variables and temporary files are ephemeral. Internet access is disabled. Each operation has a 60-second watchdog including startup; a persisted 90-second alarm recovers interrupted coordinators. Retries of an exact request never replay source. Rejection is recorded at the coordinator before acknowledgement.

Limits: one active execution per connection, 16,000 source characters, 12,000 text-output characters, 24,000 base64 PNG characters, 1 MB stream consumption and 64 ledger entries. Unsupported active MIME types are dropped. Idle kernels sleep after five minutes. Account revocation blocks new operations/reads; an already running operation remains bounded by its watchdog.

Deployment is wired through `deployment.jsonc.runtime` and disabled by default. Enabling adds the runtime before Workshop, binds `GATEKEEPER_RUNTIME` only to Workshop, and provisions Container/Durable Object resources. It needs Cloudflare Containers availability/billing, not a separately managed Python server or a Python API secret. Review the [rollout plan](../../docs/plans/notebook-ide-blueprints.md) before deployment. Users opt into the connector according to `/admin` policy and connect a fresh resource.

```sh
pnpm --filter gatekeeper-runtime generate
pnpm --filter gatekeeper-runtime types:check
pnpm --filter gatekeeper-runtime test:run
pnpm --filter gatekeeper-runtime exec wrangler deploy --dry-run
```

For Docker lifecycle checks, in one terminal:

```sh
cd packages/gatekeeper-runtime
pnpm exec wrangler dev --config __tests__/runtime.wrangler.jsonc --port 8794 --ip 127.0.0.1
```

In another, run `node packages/gatekeeper-runtime/scripts/smoke.mjs`. The HTTP test ingress is local-only and absent from the production Worker. Compatibility date `2026-08-08` matches the pinned Workers test toolchain; do not advance it independently of tooling validation.
