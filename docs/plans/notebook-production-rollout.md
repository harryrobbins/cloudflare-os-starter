# Notebook production rollout

Target: `https://cfos.surprisingly.ltd`, account `e1376e48400a20e631b61bbf16f555f1`.
Operation: continuation of the existing production deployment, authorized by the user's request to commit and deploy the Notebook feature.

Feature commits: `9aa4759`, `35db38f`; upstream fork commit `835b1738`. Deployment enables `runtime.enabled` and retains its five-container limit. Notebook archive revision 10.

## Changes and boundaries

Update `cfos-error-reporter`, `cfos-context`, `cfos-scheduler`, `cfos-custom-gatekeeper`, `cfos-workshop`, and `cfos-router`. Create `cfos-notebook-python`, its Python container application, and four new SQLite Durable Object classes (`PythonSandbox`, `RuntimeSession`, `RuntimeAccountState`, `RuntimeGatekeeper`, migration `v1`). No existing Worker is renamed, no existing Durable Object class is migrated, and no existing KV/R2 resource is replaced.

Python is available as an optional account/resource connection, accessible only through Workshop's `GATEKEEPER_RUNTIME` service binding. An authenticated workspace owner must request execution and approve it in Activity. Shared viewers can observe saved results but cannot authorize execution; an imported copy gets a fresh connection/kernel. Sandbox internet access is disabled. Container execution incurs Cloudflare usage charges; maximum five basic instances, five-minute idle timeout, and bounded execution/output. This limit is not a monetary spending cap.

Access issuer, audience and administrator remain the values in `deployment.jsonc`; AI remains the `cfos-gateway` OpenRouter configuration. Reporter stays private; invocation logging and traces stay disabled under the deployment policy. Existing connector policies are preserved.

## Existing storage

- Context KV: `6e388b00c1c247ecb2a2cb84ea03948c`.
- Blueprints KV: `195bd91c4e3d4e698e51c8f5fa409468`.
- Avatars KV: `f4bf93d1d5de462ab8b8ed7583a7c050`.
- Blueprint R2: `cfos-workshop-blueprint-content`.

The configured hostname is currently attached to `cfos-router`; all six existing Workers have workers.dev and preview URLs disabled. `cfos-notebook-python` did not exist before this operation.

## Previous deployment versions

| Worker | Deployment | Version |
| --- | --- | --- |
| `cfos-error-reporter` | `7060e1b1-c15a-40fa-a655-64c96b358cc3` | `98faeb12-2b27-476c-b359-07d3535cc276` |
| `cfos-context` | `fb4d0329-c9f1-46fe-86da-5985f0c55616` | `c1e1a624-4b6b-418d-8554-9ebff871383c` |
| `cfos-scheduler` | `1dc8b631-83c8-4fbc-a169-d6848ed9026d` | `253acba6-e31c-4b9a-bfb9-d2e58ec2ad1e` |
| `cfos-custom-gatekeeper` | `8127a9c1-ed04-4b5e-b351-0d669757409b` | `52be934f-21c5-4a51-84bd-903354b30f68` |
| `cfos-workshop` | `35601743-dfaf-4b62-9be0-1e7412be06f3` | `2eb98281-8181-44c3-a03e-5e3c40e04c20` |
| `cfos-router` | `563e2ca6-1197-4493-aa1b-f730be0fe276` | `69969eff-75a7-4f23-b7b9-db88ac8cf468` |

## Validation and rollout

- Fresh-account browser setup passes through the actual Connections UI, account provisioning, configurator handshake, and enabled Run/Stop controls.
- Frontend type-check and 173 frontend tests pass after the setup fixes.
- Earlier full Notebook browser test covered execution/approval, viewer denial and independent clone execution; Docker tests covered isolation, cancellation, errors and output caps.
- Full `pnpm check` with runtime enabled: in progress.
- Deployment: pending.

Production unauthenticated HTTPS redirects to Access. Account-level Access inventory returned no applications and zone-level inventory returned HTTP 403 with the current Wrangler credential; the existing Access policy is preserved, not reconfigured. Positive login, authenticated non-admin denial, existing private data, and production cell execution require a signed-in browser and are not yet verified.

## Recovery

Deployment is sequential: Reporter → Context → Scheduler → custom Gatekeeper → Python runtime → Workshop → Router. New RPC methods are additive and Python is deployed before its first caller. On failure, inventory completed stages before resuming; do not assume an atomic rollout.

Restore the prior compatible Workshop/Router versions together if necessary; preserve storage and the new runtime Worker. Disabling the runtime binding prevents new connections but does not delete existing resources or stop every existing kernel immediately. Do not delete the new Durable Object classes, containers or user data as rollback. Worker rollback does not undo notebook documents, connection records, KV/R2 writes or installed blueprint revisions; bundled blueprint updates affect new instances and require deliberate handling on recovery. Prefer forward repair for runtime failures.
