# Notebook and IDE blueprints: feasibility and implementation

Status: implemented and locally validated, 2026-09-16. Work is isolated in `/tmp/cloudflare-os-notebook`, branch `feat/notebook`, including changes to the pinned Cloudflare OS fork. This is not a deployed or production-verified integration. Docker lifecycle checks and the owner/shared-user browser flow have passed; see the validation record below.

**A native notebook blueprint with a separate Python runtime is now implemented.** Full code-server remains feasible as a separate authenticated application launched by a blueprint; it is not implemented here. Neither a Python process nor a complete IDE can run inside an ordinary gadget Worker and its current network-blocked iframe.

## Recommendation

Evaluate the locally validated notebook on an isolated deployment. Keep production runtime deployment disabled until account, resource and rollout review is complete. Retain the current gadget sandbox. Defer a full IDE until the notebook's execution service has demonstrated reliable cancellation, recovery and resource limits.

The selected first version deliberately allows collaborators to read shared results while only the workspace owner can request Python execution or stop/reset. Collaborators who want an independent executable copy download `.ipynb`, create a new Notebook, import it and connect a fresh Python resource under their own workspace. This copies document data and outputs, not credentials, live variables or runtime identity.

## Implemented in this worktree

| Area | Current source behavior |
| --- | --- |
| Notebook blueprint | [`packages/blueprint-notebook`](../../packages/blueprint-notebook/src/README.md), bundled as `formats/notebook.gadget` with stable `format.notebook` metadata. Code/Markdown/raw cells, revision checks, bounded saved outputs, import/export and document methods for agents. |
| Python runtime | [`packages/gatekeeper-runtime`](../../packages/gatekeeper-runtime/src/gatekeeper.ts), an explicit `PYTHON` resource binding. A random facet-owned runtime ID selects a private coordinator and Python sandbox; callers cannot choose another runtime ID. |
| Owner authority | Authenticated [`GadgetClient`](../../cloudflare-os/packages/workshop-backend/src/overseer.ts) mints an expiring one-use permit for the exact intent; the iframe host forwards only the reserved permit operation. Gatekeeper consumption checks resource/gadget scope and digest before queueing a mutation. This requires the accompanying fork patch, not merely installing the archive. |
| Approval | Execute and stop/reset are immutable queued actions reviewed in Workshop Activity. The connector declares no autoapprovable action kinds. Agents may edit notebook documents but cannot mint execution permits in this version. |
| Shared results | The trusted connector declares `workspaceReadable: true`; Workshop persists this grant when creating the connection, allowing workspace collaborators to read without their own Python account. Reads still pass through observation authorization. Notebook results saved in gadget storage remain accessible to workspace collaborators independently of the live kernel. |
| Runtime isolation | Sandbox internet access is disabled in code; HTTP execution/preview/filesystem routes are not exposed. Platform enforcement still needs integration verification. |
| Lifecycle | Recorded run IDs, sequence/generation checks, bounded ledgers, stream/output caps, a 60-second execution watchdog and a 90-second recovery alarm. Stop/reset and kernel loss discard variables and temporary files. |
| Deployment | Optional runtime configuration, Worker build, service binding, Container and Durable Object resources are wired through the wrapper. `runtime.enabled` is currently false. No live deployment was performed for this update. |

The exact preview dependency is `@cloudflare/sandbox@0.13.0-next.751.1`; the [Dockerfile](../../packages/gatekeeper-runtime/Dockerfile) pins the matching `0.13.0-next.751.1-python` image by digest. Keep that SDK/image pair together. Updating either is a compatibility change requiring lifecycle validation.

## Authority and sharing limits

Use the Workshop **use** role for people consuming notebook outputs. **Build** collaborators can change gadget application source and must be trusted accordingly: malicious application code opened in the owner's session could request owner permits. The permit proves an owner-authenticated session, not a physical button click; normal action approval remains a separate boundary.

The `workspaceReadable` grant covers runtime status/live output as well as saved results. It is not public access: ordinary workspace sharing authorization still applies. Other private services in the same workspace keep their account/verifier requirements. The grant is immutable for an existing connection; removing the flag from future connector code does not revoke old grants. The connector cannot use per-observer exclusions for such a resource. Existing connections created before this fork change must be recreated to get the grant, which starts a fresh kernel while saved notebook data remains.

Owner-only **execution** is enforced separately from notebook document editing. The current document RPC methods allow shared gadget callers to edit cells/import data; the use role is not a general read-only document permission. Do not describe this release as enforcing immutable viewer access. Restricting document writes would require an additional trusted authorization path.

Imported notebooks never autoexecute. The UI renders bounded safe output forms and sanitizes Markdown; active HTML/JavaScript is not run. A copied notebook can contain arbitrary Python source, which is why the new owner must deliberately request and approve execution.

## Persistence and compatibility limits

Notebook cells and saved outputs live in gadget Durable Object storage. The Python filesystem and live namespace are ephemeral; there are no project snapshots, persistent datasets, package-install controls, terminal, public previews, active notebook widgets or full JupyterLab compatibility in this version. A stopped/expired kernel needs explicit reset and rerunning cells. Shared results are not a shared execution grant.

The document implementation caps cells, source and storage, and preserves bounded unsupported notebook metadata/MIME data for export without rendering it. Consult the [notebook API and limits](../../packages/blueprint-notebook/src/README.md) before promising lossless import of arbitrary `.ipynb` files. Output records identify source revisions; outputs from older revisions must remain visibly stale.

Blueprint publication exports application source and binding requirements, not the user's notebook document. Updating the bundled format affects new instances; it is not an automatic migration of existing gadgets. Notebook download/import, blueprint publication and runtime backup are distinct operations; runtime backup is not implemented.

## Validation and rollout gates

Local validation on 2026-09-16:

- `pnpm check` passed both with the default disabled runtime and with runtime temporarily enabled, covering wrapper tests, package tests/builds, the Docker image and every generated Worker deployment dry-run. The disabled setting was restored afterward.
- Runtime and notebook tests cover authorization, immutable digests, ambiguous submission recovery, bounded streams/storage, import/export, stale edits, persistence and rejection without a connection. Owner permit tests cover scope, expiry, replay and binding removal. Observer policy tests retain default/private-service verification.
- Docker smoke checks passed: Python startup; variables across cells; duplicate submission; rejected requests; Python errors; internet denial; output caps; stopping active execution; and fresh-generation isolation.
- The actual Workshop browser flow passed: notebook creation/edit/import/export; safe rendering; owner permit → Activity approval → container execution; a second user reading results without a Python account; direct forged-permit denial; and an imported copy running under its new owner in a fresh kernel without access to the original variables. Stop/reset also passed through owner approval.
- Backend: 338 tests passed. Frontend: 173 tests passed. Notebook: 11 tests passed. Runtime: 5 tests passed. Local test ingress and browser RPC helpers are excluded from production bundles.

The checks establish local behavior, not live Cloudflare behavior. Remaining rollout/fault-injection work:

1. Preserve the passing archive/build/type/configuration checks when merging. Publish submodule commit `c84d34df` (`feat/notebook-owner-permits`) to the configured fork before a fresh clone or deployment.
2. Extend fault injection for cleanup failure, coordinator eviction/restart and stale watchdog delivery. The implemented alarm recovery has been reviewed but these failure combinations are not claimed as fully exercised.
3. Exercise deployed reconnect/reload and idle-kernel expiry; local binding-change reconnection and normal Activity approvals have passed.
4. Repeat the two-user permit, sharing, copy and output tests against the intended deployment, including an unshared outsider and deployment-specific connector permissions.
5. Only then prepare an isolated deployment with explicit account/billing/resource limits and enable the runtime for that evaluation. Verify deployed authentication, service bindings, container startup, network denial and durable notebook recovery. Keep production rollout separate from local test success.

Do not record the feature as fully verified until the complete chain—owner UI permit, Activity approval, container execution, saved output and collaborator read—passes on the intended deployment. No IDE authentication/proxy path has been implemented or tested. No Cloudflare resources were deployed.

## Subsequent IDE work

A code-server/OpenVSCode launcher should use a dedicated authenticated origin, per-runtime authorization, HTTP/WebSocket proxying and an explicit durable filesystem strategy. Access login alone is not authorization to another user's runtime. The current notebook-only runtime has no terminal, launch-ticket endpoint or project storage contract; those are additional work, not hidden capabilities of the shipped blueprint.

Research: [blueprint integration](../research/notebook-ide-blueprint-integration.md), [notebook runtime choices](../research/notebook-blueprint-runtime-options.md), and [browser IDE choices](../research/browser-ide-runtime-options.md).
