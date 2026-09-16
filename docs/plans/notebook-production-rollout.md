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
- Full `pnpm check` with runtime enabled: passed (exit 0), including all seven Worker dry runs and the Python Docker build.
- Deployment: `pnpm deploy` completed successfully (exit 0) from root `a231fe1` and submodule `835b1738`.

Production unauthenticated HTTPS redirects to Access. Account-level Access inventory returned no applications and zone-level inventory returned HTTP 403 with the current Wrangler credential; the existing Access policy is preserved, not reconfigured. Positive login, authenticated non-admin denial, existing private data, and production cell execution require a signed-in browser and are not yet verified.

## Recovery

Deployment is sequential: Reporter → Context → Scheduler → custom Gatekeeper → Python runtime → Workshop → Router. New RPC methods are additive and Python is deployed before its first caller. On failure, inventory completed stages before resuming; do not assume an atomic rollout.

Restore the prior compatible Workshop/Router versions together if necessary; preserve storage and the new runtime Worker. Disabling the runtime binding prevents new connections but does not delete existing resources or stop every existing kernel immediately. Do not delete the new Durable Object classes, containers or user data as rollback. Worker rollback does not undo notebook documents, connection records, KV/R2 writes or installed blueprint revisions; bundled blueprint updates affect new instances and require deliberate handling on recovery. Prefer forward repair for runtime failures.

## Deployed versions

| Worker | Deployment | Version |
| --- | --- | --- |
| `cfos-error-reporter` | `cf186560-fa7f-46c7-8f1a-1f964305bd93` | `f66d835a-6d41-4ac9-bbf0-f60d96d00fbf` |
| `cfos-context` | `3012c8b2-680e-4c5f-aeb4-106d47ba30f6` | `343f4a2d-1b1c-42f4-b95a-399606256f53` |
| `cfos-scheduler` | `072fa2ea-fbd4-4d78-ba9f-cecfa8918141` | `cac17184-daf7-4f20-a770-4ba9f2ac7013` |
| `cfos-custom-gatekeeper` | `44a930ef-5d24-4e7d-80d5-2c9f0c71c1ac` | `035d74b6-c6da-4492-a001-ffda962b39e0` |
| `cfos-notebook-python` | `ef8e051e-1351-43fd-98a0-c860c49de3eb` | `0c765d6c-f8b4-4270-8b28-182f302ebd36` |
| `cfos-workshop` | `17abc82f-ffb0-4728-8992-1d9e21962203` | `6c8013e8-4a60-4fb4-bb29-2ed6500b92e6` |
| `cfos-router` | `b1232f43-43e4-4f8f-ae89-3670545f37e9` | `e98c3ecf-78f8-47e1-9ff2-7d22efba334a` |

Post-deploy API inventory confirms the original Context/Workshop KV and R2 identities are unchanged. Workshop now binds `GATEKEEPER_RUNTIME` to `cfos-notebook-python` / `GatekeeperVendor`. All seven Workers have workers.dev and preview URLs disabled. The Router remains on the configured custom domain. Unauthenticated curl requests to `/` and `/api` return HTTP 302 to Access; Python's default HTTP client receives HTTP 403 instead. Neither test is an authenticated application check.

Container application: `a03b0724-75f7-4818-9fb6-b62e30f1f2e4`, `cfos-notebook-python-pythonsandbox`. Readiness verified with `wrangler containers info`: five healthy slots, zero failed/scheduling/starting, zero active or assigned. Maximum instances is five; image digest is `sha256:4115101e594260467ee1a5b3ecc29ad8908a789698ff31016961206f059159c8`. Signed-in production cell execution remains unverified.

References: [Sandbox deployment](https://developers.cloudflare.com/sandbox/guides/deploy/), [Worker rollback limits](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/).

## Owner-click follow-up rollout

Authorized by the user's request to implement, commit and deploy direct owner Run/Stop authorization. The one-use permit now authorizes one action ID on the same approval queue. Actions still pass through the normal audit/apply path, with the owner recorded as resolver and `autoApproved: false`; no automatic approval rule is enabled. Agent/preview callers cannot consume owner permits, and collaborators cannot mint them. Old queue implementations ignore the optional action ID and retain manual approval during deployment.

No Worker, route, Access policy, storage binding, container image, migration or capacity changes. Deploy the seven existing Workers in their established order. New Notebook instances receive revision 12 with updated guidance. Existing Notebook code also executes directly through the updated backend/runtime, but may retain old Activity-approval wording until its gadget code is upgraded.

Validation: six runtime tests, 338 backend tests, two backend integration tests (four pre-existing skips), backend type-check, and the real Workshop/Python browser test passed. The browser test makes no Activity approval call: it checks execution, owner-attributed action records, shared-viewer denial, independent clone execution and kernel resets. Full `pnpm check` passed, including all production builds and seven Worker dry runs. Deployment completed successfully (exit 0) from root `2b115f8` and submodule `d262ffd6`.

### Baseline for the follow-up

| Worker | Version |
| --- | --- |
| `cfos-error-reporter` | `f66d835a-6d41-4ac9-bbf0-f60d96d00fbf` |
| `cfos-context` | `343f4a2d-1b1c-42f4-b95a-399606256f53` |
| `cfos-scheduler` | `cac17184-daf7-4f20-a770-4ba9f2ac7013` |
| `cfos-custom-gatekeeper` | `035d74b6-c6da-4492-a001-ffda962b39e0` |
| `cfos-notebook-python` | `0c765d6c-f8b4-4270-8b28-182f302ebd36` |
| `cfos-workshop` | `6c8013e8-4a60-4fb4-bb29-2ed6500b92e6` |
| `cfos-router` | `e98c3ecf-78f8-47e1-9ff2-7d22efba334a` |

Recovery: the previous Workshop and runtime remain API-compatible; restoring them reintroduces manual approval. Already executed Python is not undone. Existing runtime, notebook data, and Activity records must be preserved.

### Follow-up deployed versions

| Worker | Deployment | Version |
| --- | --- | --- |
| `cfos-error-reporter` | `add779d7-5ac9-45bf-a1e2-842168c5d051` | `621c1b5d-d9bf-47f4-b8fe-b78fb080c8f8` |
| `cfos-context` | `ed08dac6-7bc6-42a7-8ff0-9b108d74db15` | `495d7a68-bfad-4b6a-84c4-e5c658be51f9` |
| `cfos-scheduler` | `7a52aa8c-3107-46e3-8a9d-88ceebb95185` | `b1e5bd7e-900b-4043-9fb6-c648eaa9146b` |
| `cfos-custom-gatekeeper` | `f21d5c99-d6dc-4ac3-93ef-4507638c7beb` | `db3347fb-3dd4-4273-90e2-ea72023e8ce5` |
| `cfos-notebook-python` | `2fed690e-c1b8-435c-9524-18a77ec3e7c7` | `75acd33a-2307-472b-abed-7b51e6469464` |
| `cfos-workshop` | `730ae227-73fd-4aa7-92da-0b6e7b725756` | `bb655312-c851-40b2-836d-340f9c0284b8` |
| `cfos-router` | `33ccab52-1815-4b30-b94d-a72f94f90b9b` | `6d9a2ee7-fde8-4d10-aac9-b2b1c5c5508d` |

Post-rollout verification: all seven Workers have the exact same bindings as before, and workers.dev/preview URLs remain disabled. Container health reports five healthy slots and no failures/errors. Unauthenticated HTTPS `/` and `/api` still redirect to Access (302). The real local browser test covered immediate owner execution and audit attribution; signed-in production execution remains unverified because no authenticated production browser session is available.

## Python connection metadata follow-up

Authorized by the user's request to commit and deploy the corrected blueprint. Bundled revision 13 is displayed as **Python Notebook** and declares one required `PYTHON` Gatekeeper binding for the `runtime` connector's `python://notebook/:name` resource. The blueprint creation page therefore provisions and configures a Notebook Python kernel before creating the Gadget instead of claiming that no connections are required.

This changes bundled blueprint metadata and its archive only. It does not change Worker identities, routes, Access policy, service bindings, storage resources, container images, Durable Object migrations, runtime capacity, AI configuration, or observability. Existing Notebook gadgets and their connections are unchanged; the corrected requirement applies when creating a Gadget from the updated bundled blueprint.

### Custom-scheme normalization hotfix

The first revision 13 deployment exposed a frontend normalization bug: after configuration, `python://notebook/notebook` was displayed and submitted as `https://python://notebook/notebook`, which the runtime correctly rejected. Upstream submodule commit `c99aeb36` preserves any syntactically valid URI scheme while retaining the HTTPS default for schemeless web resources. A focused regression test covers both cases. This changes Workshop frontend behavior only; the blueprint, connector, runtime, infrastructure, and policies remain unchanged.
