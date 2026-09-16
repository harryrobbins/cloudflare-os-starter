# Notebook and IDE integration with this checkout

Research date: 2026-09-16. Inspected `cloudflare-os` commit `90f05910`. This is a source review, not a deployed proof of concept. Links below are repository sources; conclusions labelled **Proposed** describe work still required.

## Feasibility boundary

A notebook-shaped application or lightweight code editor fits the existing blueprint model. A full Jupyter server or code-server process does not run inside the blueprint's current runtime. The practical extension is a blueprint UI plus a separately deployed execution service, reached through a capability-scoped Gatekeeper. For the complete upstream JupyterLab or code-server UI, a blueprint can act as a launcher into an authenticated separate application.

This distinction follows from the runtime, not from how the blueprint is packaged.

| Observed source | Consequence |
| --- | --- |
| [`loadGadgetWorker()`](../../cloudflare-os/packages/workshop-backend/src/overseer.ts) takes only `.js` files, loads `server.js`, sets `globalOutbound: null`, and supplies only `allow_irrevocable_stub_storage` as a compatibility flag. | Gadget backends are dynamically loaded Workers, without a general Linux process, shell, Python kernel, or configured `nodejs_compat`. Neither a Dockerfile nor an npm manifest in an archive changes that. |
| [`getEnvForLoader()`](../../cloudflare-os/packages/workshop-backend/src/overseer.ts) supplies the self-loopback and visible named binding loopbacks. | A blueprint cannot acquire a Container/DO namespace, external network access or R2 bucket merely by naming an environment variable. Such infrastructure belongs in a deployment-owned service. |
| [`getGadgetUiBundle()`](../../cloudflare-os/packages/workshop-backend/src/overseer.ts) returns only `client.js`. | Bundle frontend dependencies and CSS into that entry point. There is no arbitrary static asset server for gadget files. |
| [`GadgetUI.tsx`](../../cloudflare-os/packages/workshop-frontend/src/GadgetUI.tsx) renders `srcDoc` with an opaque origin and `sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"`. CSP has `frame-src 'none'`, `connect-src 'none'`, and `script-src data: 'unsafe-inline'`. | No embedded remote IDE, direct HTTP API, browser WebSocket, CDN module loading or ordinary origin-backed browser storage. Form submission is disabled. `unsafe-eval` and `wasm-unsafe-eval` are absent, so dynamic JavaScript/WASM execution is not an available notebook-kernel assumption. A browser kernel needs a separate compatibility spike and likely platform changes. |
| The same component permits user-activated `target="_blank"` anchors, adds `noopener`, and disables `window.open()`. | A real user-clicked launch link is an existing escape route into a separately authorized application. A programmatic popup is not. |

Worker policy deserves a precise qualification: the CSP does not explicitly name `worker-src`; its fallback includes the script policy. Do not claim that every imaginable browser Worker is categorically impossible. Existing worker loaders, blob URLs, network-loaded worker assets and WASM-based kernels still cannot be assumed to work under this policy.

## Existing transport and persistence

The iframe prefix injects module-scoped `gadget` and `RpcTarget` bindings. It opens a `MessageChannel` to the parent, which validates the source window and opaque origin before obtaining `GadgetClient.connectToGadget()`. Calls travel over the Workshop's Cap'n Web connection to the gadget's Durable Object facet. This is a useful transport for notebook edits, execution requests, status and bounded output events. It is not an HTTP/WebSocket reverse proxy. See [`GadgetUI.tsx`](../../cloudflare-os/packages/workshop-frontend/src/GadgetUI.tsx), [`connectToGadget()` and `getGadgetFacetFetcher()`](../../cloudflare-os/packages/workshop-backend/src/overseer.ts).

Gadget state can live in facet Durable Object KV/SQLite storage. Workspace collaborators reach the same facet, but the gadget implements its own document protocol and subscriber fan-out. The platform's Yjs document describes **gadget application source**, not notebook cells or the files edited by an IDE gadget. Model user projects as separate application data unless editing the gadget itself is intentional. See [`api.ts`](../../cloudflare-os/packages/workshop-shared/src/api.ts), [`getGadgetFacetFetcher()`](../../cloudflare-os/packages/workshop-backend/src/overseer.ts), and the existing [runtime research](gadget-collaboration-runtime.md).

**Proposed notebook state:** cells, order, source revisions, language, execution records, kernel generation and bounded outputs in gadget storage; large artifacts and workspace snapshots in a runner-owned object store. Never treat an in-memory kernel as the canonical document. Execution results should carry the source revision, run ID and kernel generation so late output cannot silently attach to a newer cell version.

**Proposed lightweight IDE state:** a virtual project file tree distinct from `client.js`/`server.js`, with revisions and explicit file size limits. The OS's own Monaco code editor is not a ready-made general filesystem or terminal backend. A bundled editor without network-loaded assets is feasible; language workers and language-server integration require explicit design.

Existing local findings matter for execution streaming: kept callback stubs need explicit disposal; a server code change can leave a `use`-role iframe needing a reload; and the whiteboard spike measured roughly 45–50 inbound calls/second in its environment. That last figure is a local observation, **not a Cloudflare platform limit**. Batch terminal/output fragments, bound queues, and replay by cursor after reconnect instead of issuing one RPC per byte or keystroke. See the [collaborative plan's verified gaps](../plans/collaborative-blueprints.md#what-the-platform-does-not-give-us) and [`Hub`](../../packages/blueprint-whiteboard/src/core/hub.js).

## Identity and authority are separate integration work

Workspace sharing already distinguishes `build` and `use`, but `use` permits interacting with deployed gadget RPC. It does not mean read-only data or forbidden code execution. The current gadget API does not hand a trusted viewer identity to the gadget's methods. A user-supplied display name, run ID, workspace ID or session ID is not proof of authority. See [sharing documentation](../../cloudflare-os/docs/sharing.md), [`UseGadgetInterface`](../../cloudflare-os/packages/workshop-backend/src/overseer.ts), and the [existing viewer-identity analysis](../plans/collaborative-blueprints.md#phase-0-optional-but-recommended-viewer-identity).

**Proposed:** bind a runner capability to an explicitly provisioned resource, using broker-generated identifiers. Decide whether that resource belongs to one owner, one gadget, or a shared workspace. Avoid inferring that a gatekeeper automatically receives arbitrary trustworthy caller identifiers: define and test how provisioning establishes that mapping. Until viewer authorization is available, either deliberately grant all gadget collaborators the same execution authority or restrict runnable workspaces to the owner. Merely hiding a Run button is insufficient.

The Gatekeeper contract explicitly mediates observations and actions, including collaborator verification through `addObserver()`. Reuse this rather than giving gadget code raw cloud credentials. Arbitrary execution is a side effect: define the action/approval behavior for launching, executing, interrupting, stopping and exposing services, including whether direct interactive user actions have an explicit session grant. Existing generic approvals may be too cumbersome for each notebook cell; that needs an intentional bounded policy, not an accidental bypass. See [`Gatekeeper.startSession()`, `addObserver()` and `ObservationDescription`](../../cloudflare-os/packages/workshop-shared/src/gatekeeper.ts).

The [example Custom Gatekeeper](../../packages/custom-gatekeeper/src/custom.ts) is intentionally a low-stakes read-only example with permissive observer verification. Copying its trust policy into an arbitrary-code runner would be incorrect. It can demonstrate package shape, not runner authorization.

## Extension points in the deployment starter

[`deployment.jsonc`](../../deployment.jsonc) already sets `formatBlueprintsDir` to `formats`. [`scripts/deploy.ts`](../../scripts/deploy.ts) provides the build environment override and generates bindings. Its package/deploy list is fixed to the currently supported Workers. A new runner is not automatically deployed because a blueprint references it.

**Proposed minimal integration:** add a separate runner Gatekeeper package, its resource bindings/configuration, and tests to the wrapper. Extend [`deployment-config.ts`](../../scripts/deployment-config.ts) and [`deploy.ts`](../../scripts/deploy.ts) together. Deploy the service before the Workshop and Router that bind it. Keep the runner package distinct from the example Custom Gatekeeper if both remain useful. No change to gadget network policy is necessary when all control passes through a named Gatekeeper binding.

The upstream [`Router`](../../cloudflare-os/packages/router/src/index.ts) discovers `GATEKEEPER_*` service bindings and forwards `/gatekeeper/<suffix>` HTTP requests with their original paths. Thus a new matching Router binding can expose a broker route without changing the routing algorithm. Workshop bindings use the `GatekeeperVendor` entrypoint; Router bindings target the HTTP worker with no entrypoint. The generator currently replaces these binding lists, so hand-editing an upstream Wrangler file alone is not a durable integration.

Crucially, that Router is a dispatcher, not a workspace authorization service. It does not verify Access JWTs or resolve workspace membership before forwarding a Gatekeeper request. **Proposed broker HTTP routes must authenticate and authorize independently** and preserve that authorization across WebSocket upgrades. Protection of the Workshop hostname by Access is not equivalent to per-workspace access. A same-origin service under `/gatekeeper/...` is also not the preferred place for arbitrary project-generated HTML; use a separate application/preview origin with appropriately scoped credentials and policies.

## Packaging a notebook or IDE blueprint

The existing [whiteboard build](../../packages/blueprint-whiteboard/scripts/build.mjs) shows the right mechanical pattern: bundle a browser entry into `client.js`, a neutral Worker entry into `server.js`, and include an agent-facing `README.md`. The [kanban packer](../../packages/blueprint-kanban/scripts/pack-gadget.mjs) writes an archive plus a versioned sidecar/lock. These can guide a `packages/blueprint-notebook` package.

Ship a stable format ID and maintain archive revision updates. [Blueprint semantics](../../cloudflare-os/docs/blueprints.md) are important: an archive contains source, metadata and binding requirements, **not** live filesystem contents, notebook document storage, credentials or a running kernel. A sample notebook must be explicit seed data in source or an import fixture. A user project needs its own export/import workflow. Instantiating a blueprint creates a new gadget; shared execution resources must be provisioned or selected deliberately, not accidentally inherited from a sample resource suggestion.

Changing the bundled archive changes what future instances receive. Do not assume an installed notebook gadget, its schema or an already-running execution service is automatically upgraded by changing a format.

## Concrete spikes before implementation

1. Bundle a small cell editor into one `client.js`; prove save/reload, two-viewer editing, source revision checks and `.ipynb` round-trip without executing code.
2. Bind a minimal runner resource; prove the mapping from one gadget to one execution environment cannot be selected or changed by guessing another resource ID.
3. Execute a cell, stream bounded output, interrupt it, restart the kernel and reconnect the iframe. Confirm output association and durable document recovery after each transition.
4. For an external IDE launcher, test a user-clicked link, authenticated broker exchange, denied unrelated user, revoked collaborator, assets, WebSockets and reload. Do not regard loading the HTML shell as success.
5. Prove project files survive runtime shutdown/recreation. Distinguish file persistence from restoration of the live Python namespace or running shell process.

No application code, deployment configuration, remote resources or pinned submodule files were changed for this research.
