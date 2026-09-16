# Notebook blueprint runtime options

Research date: 2026-09-16. This is a source review and implementation proposal, not a tested integration. Upstream documentation linked below is current at research time; pin versions before implementation.

## Feasibility

A Jupyter-style notebook is feasible as a blueprint. A document containing ordered Markdown/code cells, saved outputs, import/export, and an agent-facing API fits the existing gadget model. Executing Python is a separate runtime decision: the current gadget is neither a Python process nor an unrestricted browser application.

The recommended path is a native notebook gadget backed by a narrowly scoped execution gatekeeper. That can initially connect to an existing isolated Jupyter service or a separately provisioned container runtime. A Pyodide alternative is possible, but requires host changes and browser compatibility work; installing JupyterLite into `client.js` does not bypass those requirements.

## Repository evidence

| Evidence | Implication |
| --- | --- |
| [`cloudflare-os/docs/blueprints.md`](../../cloudflare-os/docs/blueprints.md), “What a Blueprint Captures” | Blueprint exports capture source and binding requirements, not SQLite data, credentials, or a live kernel. A notebook template and a saved user notebook are different artifacts. |
| [`GadgetUI.tsx`](../../cloudflare-os/packages/workshop-frontend/src/GadgetUI.tsx), `createSandboxedHtml` | The iframe policy has `connect-src 'none'`, `frame-src 'none'`, `script-src data: 'unsafe-inline'`, and `default-src 'none'`. It has no WASM execution allowance or explicit `worker-src`; worker loading falls back to the script policy, so data-URL workers need browser testing rather than a blanket claim that all workers are forbidden. Stock external runtime assets, embedded JupyterLite, and its normal worker URLs are not supported as-is. |
| Same file, rendered `sandbox` attribute | The frame permits scripts/popups, but not `allow-same-origin`. It has an opaque origin; ordinary JupyterLite origin storage and service-worker assumptions cannot be adopted unchanged. |
| [`overseer.ts`](../../cloudflare-os/packages/workshop-backend/src/overseer.ts), `loadGadgetWorker` | The backend loads `.js` source modules through Worker Loader with `server.js` as the entry point and `globalOutbound: null`. This is a restricted Worker runtime, not a Linux process that can start CPython or Jupyter Server. |
| [`blueprint-kanban/scripts/build.mjs`](../../packages/blueprint-kanban/scripts/build.mjs) | There is already a package-to-blueprint build pattern: bundled `client.js`, `server.js`, and agent README. Its client deliberately has no sibling imports. |
| [`blueprint-kanban/src/server/index.js`](../../packages/blueprint-kanban/src/server/index.js) and [`do-repository.js`](../../packages/blueprint-kanban/src/server/do-repository.js) | Existing gadgets provide authoritative persisted state, explicit mutation APIs, and live subscriptions. Notebook state and operation history can follow this pattern. |

The existing agent `executeCode` facility is not evidence of a persistent Python notebook kernel. Any reuse must first establish its language, state, authority, cancellation, and lifecycle semantics.

## Runtime choices

| Approach | What it provides | Work beyond an ordinary blueprint | Assessment |
| --- | --- | --- | --- |
| Notebook document/editor | Cells, Markdown, stored outputs, `.ipynb` exchange | None for a bounded editor built from bundled code | High feasibility; useful first milestone, but not an executable notebook |
| Native UI plus remote Python kernel | Real Python, compatible packages, persistent variables while kernel lives | Execution gatekeeper, runtime hosting, streaming/lifecycle and authorization | Recommended executable MVP |
| Native UI plus Pyodide | Python/WASM in the user's browser | Safe asset delivery, module workers, WASM policy, persistence bridge, optional isolation headers | Feasible with platform work; worthwhile for browser-only teaching/data exploration |
| Full JupyterLite UI | Existing Jupyter notebook/Lab experience and browser kernels | Dedicated hosted surface or substantial adaptation of assets, frame policy, storage, workers, messaging | Not a drop-in blueprint |
| Full JupyterLab/Jupyter Server | Mature notebook service, terminals/extensions and filesystem | Isolated server/container hosting and authenticated HTTP/WebSocket access | Feasible as a managed external application surfaced by a blueprint |

### Browser Python and JupyterLite

JupyterLite implements notebook interfaces and kernels in the browser. Its normal persistence is IndexedDB tied to the browser/site, not the Workshop's server-side gadget storage. Therefore a reload on another device does not automatically recover the same notebook, and browser storage is not a shared authoritative document store. [JupyterLite usage](https://jupyterlite.readthedocs.io/en/stable/quickstart/using.html)

JupyterLite exposes file-browser contents to supported kernels using either `SharedArrayBuffer` with appropriate COOP/COEP headers or a service worker. With neither available, those kernel/file-browser views are not synchronized. This is an explicit compatibility blocker for assuming its stock filesystem will work inside the current opaque-origin gadget frame. A purpose-built Pyodide integration could instead copy bounded input/output files through a message bridge and avoid claiming full JupyterLite filesystem support. [JupyterLite filesystem access](https://jupyterlite.readthedocs.io/en/stable/howto/content/python.html)

Pyodide should execute in a module Web Worker so computation does not block the UI; the current documentation says classic workers are unsupported. Its Python environment is not a Linux substitute: browser network restrictions apply, and threading, multiprocessing, and sockets have documented limitations. Compatible package loading exists, but arbitrary native Linux wheels cannot be assumed to work. [Worker integration](https://pyodide.org/en/stable/usage/webworker.html), [Python compatibility](https://pyodide.org/en/stable/usage/wasm-constraints.html), [Package loading](https://pyodide.org/en/stable/usage/loading-packages.html)

Graceful Pyodide interruption uses a shared interrupt buffer and suitable isolation headers. Without that setup, a product can offer hard worker termination/recreation, but this discards Python variables and unsaved runtime files. This distinction needs to be visible in the notebook UI. [Interrupting execution](https://pyodide.org/en/stable/usage/keyboard-interrupts.html)

Do not loosen every gadget's CSP or give notebook code Workshop-origin storage access to make the demo work. Prefer a reviewed runtime surface on an isolated origin, or a host-owned worker bridge whose operations and messages are explicitly constrained. Embedded cross-origin isolation also depends on the surrounding page and browser policies; adding one header is not a complete design. The exact packaging and browser behavior require a spike.

### Real Python through Jupyter

Jupyter Server exposes REST resources for contents, kernels, sessions, and related functions, alongside kernel WebSocket communication. A gateway can adapt those to notebook-oriented RPC operations so the gadget does not need unrestricted browser networking. [Jupyter Server REST API](https://jupyter-server.readthedocs.io/en/latest/developers/rest-api.html)

Suggested capability operations are `startSession`, `execute`, `subscribeEvents`, `interrupt`, `restart`, `readFile`, `writeFile`, and `closeSession`. These are proposed APIs, not existing repository methods. Bind authority to an owner/workspace and concrete runtime; never accept an arbitrary session ID as sufficient authority. Keep service credentials server-side and reject execution from read-only viewers.

Jupyter explicitly treats kernel/terminal execution as arbitrary code execution. Its default authenticated-user authorization is broad, so one shared Jupyter server is not a safe multi-tenant isolation boundary merely because each user gets a different kernel. Use independently isolated runtime environments for distinct trust domains and apply idle limits, CPU/memory quotas, network policy, and cleanup at that boundary. [Jupyter Server security](https://jupyter-server.readthedocs.io/en/latest/operators/security.html)

The runtime can be an external service or a container-backed service; the blueprint itself cannot provision that infrastructure. A remote service is the smaller initial experiment when an isolated service is already available. The gatekeeper's use of its network/service bindings must be checked separately from the gadget's deliberately absent outbound access.

## Document model, persistence, and collaboration

Use the `.ipynb` format as the interchange model: ordered Markdown/code/raw cells, IDs, metadata, source, execution count, and MIME outputs. Preserve unsupported metadata and outputs when possible instead of silently discarding them. Support both string and string-array source encodings on import. The first renderer can restrict itself to plain text, JSON, and bounded PNG images. [Notebook format specification](https://nbformat.readthedocs.io/en/latest/format_description.html)

Persist document edits and completed execution records in gadget storage. Store large files/artifacts in a separate explicitly configured storage capability rather than assuming the blueprint-content bucket is application storage. Browser storage can be a cache, not the sole copy. Templates must initialize starter cells from source/seed data because blueprint publication does not copy the running gadget's database.

Treat these as separate lifecycles:

- **Document:** durable cells, revisions, metadata, and saved outputs.
- **Kernel:** transient variable state, execution queue, and process identity; lost on restart.
- **Filesystem:** explicitly checkpointed runtime files; durability depends on the chosen provider.

For collaboration, serialize execution per kernel and associate results with cell ID, source revision/hash, execution ID, and kernel generation. An output returning after an edit must be marked stale. Reconnecting must not re-execute a submitted cell without checking its execution ID. A shared document does not imply shared kernel state: either define one shared execution session or show each participant's private kernel clearly.

Imported output is untrusted. Never execute notebook HTML/JavaScript output in the gadget's privileged application context. Bound notebook size, output size, images, event backlog, and run duration; filter unsafe links and render Markdown safely. An execution bridge must not expose unrelated gadget capabilities to arbitrary notebook code.

## Smallest credible executable MVP

1. Build `packages/blueprint-notebook` using the local bundled-blueprint conventions, with a cell editor, import/export, durable revisions, and a documented agent RPC surface.
2. Add a separate execution gatekeeper bound to a single isolated Python environment. Implement one kernel per notebook/session, sequential execution, stdout/stderr, results/errors, run status, restart, and interruption.
3. Save completed output with source revision and kernel generation. Add idempotent submission, reconnection/replay, and explicit lost-kernel recovery.
4. Initially exclude terminals, arbitrary frontend extensions, widget JavaScript, automatic execution on import, and unrestricted package/environment management. These need their own product/security decisions.
5. Verify `.ipynb` round trips, long/infinite execution cancellation, reconnect without double execution, stale-output handling, authorized collaboration, artifact durability, and isolation between two owners.

Do not call the MVP complete merely because one cell returns `2`: the lifecycle and persistence cases establish whether it behaves as a notebook users can trust.

## Questions for the implementation spike

- Is the intended workload lightweight browser analytics, or real project environments with native packages and shell access? This determines whether Pyodide's extra host work is worthwhile.
- Can the existing gatekeeper/RPC transport stream notebook output with bounded buffering and recover after disconnection? Measure this with large stdout and cancellation.
- Which container/provider persistence guarantees survive restart, idle shutdown, redeployment, and deletion? Kernel RAM is never the durable notebook store.
- How will package environments be pinned and restored? A saved notebook alone is not reproducible execution.
- Does a managed JupyterLab UI need an isolated new tab first, with embedding postponed until origin/authentication behavior is proven?
- If browser Python is selected, prove pinned Pyodide loading, module-worker creation, WASM compilation, file transfer, restart, and output transport inside the proposed sandbox before building the full editor.
