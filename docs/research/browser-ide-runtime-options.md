# Browser IDE runtime options

Research date: 2026-09-16. This is a source-based feasibility assessment, not a deployed proof of concept.

## Implementation update

The isolated `feat/notebook` worktree now contains a notebook-specific [Python runtime Gatekeeper](../../packages/gatekeeper-runtime/src/gatekeeper.ts), optional wrapper deployment wiring and the matching Sandbox SDK/image pair `0.13.0-next.751.1`. This establishes a starting point for execution integration, not an implemented code-server service. There is still no IDE image, terminal, durable project filesystem, authenticated launch endpoint or HTTP/WebSocket IDE proxy.

Notebook owner-action permits authorize queued notebook execution; they are not browser IDE login sessions. A future IDE still needs its own origin and resource authorization. The implemented copy flow is `.ipynb` export/import plus a fresh connection, not cloning a Linux environment. Docker lifecycle checks are ongoing and no deployed runtime or IDE verification is claimed. Follow the [updated recommendation](../plans/notebook-ide-blueprints.md).


## Conclusion

A code-server-style IDE is feasible as a blueprint backed by a separately deployed runtime service. A lightweight editor is feasible inside an ordinary gadget. Full code-server is not a self-contained blueprint that runs inside the existing gadget Worker and iframe: it needs a Linux process, project filesystem, terminal, extension host, HTTP assets and WebSockets.

The recommended full-IDE shape is a small native blueprint that manages a workspace and launches a protected code-server page on a separate origin. Reuse the same runtime Gatekeeper for notebook execution. Treat embedding the full IDE inside Workshop as a later platform feature.

## What this checkout already provides

- [Blueprints](../../cloudflare-os/docs/blueprints.md) capture source and binding requirements, but exclude live credentials, gadget SQLite state and chat history. A blueprint can require a runtime Gatekeeper; exporting it will not export a running Linux environment or its files.
- [GadgetUI.tsx](../../cloudflare-os/packages/workshop-frontend/src/GadgetUI.tsx) renders a `srcDoc` iframe with `connect-src 'none'`, `frame-src 'none'`, and no `allow-same-origin`. A normal code-server iframe, direct browser API requests, and direct WebSockets therefore cannot work inside it. The allowed popup permissions make a user-initiated external launch a practical first integration.
- [overseer.ts](../../cloudflare-os/packages/workshop-backend/src/overseer.ts) constructs dynamic gadget Workers with `globalOutbound: null`. A runtime service must be provided through a capability binding; arbitrary outbound connectivity is not available to gadget code.
- [The router](../../cloudflare-os/packages/router/src/index.ts) already forwards `/gatekeeper/<name>` through matching `GATEKEEPER_*` service bindings. That is useful for runtime control endpoints, but does not itself provide workspace authorization or origin isolation for IDE content.
- [The deploy script](../../scripts/deploy.ts) and [deployment schema](../../scripts/deployment-config.ts) now include an optional notebook Sandbox/container deployment path in this implementation worktree. IDE images, durable project storage and authenticated routing remain additional infrastructure work.

## Product and runtime choices

| Option | Fit | Additional work |
| --- | --- | --- |
| Native editor gadget | File tree, editing, diff, run button and output panel | Bundle browser editor assets; expose files and jobs through a narrow runtime capability; no automatic VS Code extension compatibility |
| code-server on Sandbox | Preferred full IDE experiment; mature browser editor with terminal and remote extension host | Custom image, service readiness, authenticated HTTP/WebSocket proxy, lifecycle recovery and persistent workspace strategy |
| OpenVSCode Server on Sandbox | Credible alternative when proximity to upstream VS Code is preferred | Similar runtime work; explicit authentication configuration is essential |
| IDE on an external VM/container service | Good when an existing development host provides durable disks and operational ownership | Gatekeeper integration, identity/session bridge and host management; measure this against Sandbox rather than assuming Cloudflare hosting is mandatory |
| Bare Cloudflare Containers | Viable lower-level hosting option | Own more process, file, terminal and recovery orchestration than with Sandbox |

code-server requires a host environment and WebSockets; its published baseline recommendation is at least 1 GB RAM and two CPU cores. Use that as an initial sizing reference, then measure actual language servers, builds and extension workloads. A Worker isolate is not that host. [code-server requirements](https://coder.com/docs/code-server/requirements)

OpenVSCode Server provides a Docker-based remote VS Code implementation. Its documented Docker entrypoint disables the connection token by default; a deployment must deliberately provide authentication through its token options or a fully protected proxy. Its Docker instructions also describe preinstalling extensions. [OpenVSCode Server README](https://github.com/gitpod-io/openvscode-server)

For new Sandbox work, Cloudflare currently recommends `@cloudflare/sandbox@next`, the 1.0 preview. Pin a matching SDK and container-image version. Preview `exec(argv)` returns a process handle at launch; stable `exec(string)` waits for a buffered result. The preview has first-class PTYs and no session-based command state. Do not mix examples from the two lines. A production choice to remain on stable should be explicit and include a migration plan. [Sandbox 1.0 preview](https://developers.cloudflare.com/sandbox/1-0-preview/)

## Proposed integration boundary

These are design recommendations inferred from the repository boundaries and runtime requirements above:

1. Introduce a runtime Gatekeeper account/resource that owns an opaque workspace identity. Scope each binding to a workspace and explicit operations such as inspect files, execute, stop and open IDE. Never accept a browser-supplied sandbox ID as authorization.
2. Provision a separate sandbox for each independent trust boundary. Do not put unrelated users into shells or folders within one shared container. Start with one owner per workspace; collaboration requires an explicit membership and execution policy.
3. Build an immutable image with code-server, selected runtimes and reviewed extensions. Restore project data before starting the IDE; wait for its listening port before offering the launch action. Serialize first-start operations in the workspace coordinator.
4. Return an expiring, single-use launch handoff from an authorized control call. Redeem it on the IDE origin into a secure, host-scoped session cookie, redirect away from the handoff URL, and authorize subsequent HTTP requests and WebSocket upgrades against workspace ownership/membership. Avoid putting durable credentials in blueprint source or URLs.
5. Proxy the IDE only after authorization. Cloudflare documents Worker-to-sandbox WebSocket routing with `wsConnect`; HTTP and WebSocket paths both need the same authorization decision. A public preview URL is not an authorization design. [Sandbox WebSocket guide](https://developers.cloudflare.com/sandbox/guides/websocket-connections/)
6. Use a dedicated IDE origin, ideally isolate independently trusted workspaces by origin as well. Keep Workshop cookies unavailable to IDE/project content. The Access policy on the existing Workshop hostname does not automatically protect a new hostname; deployment must deliberately cover the new ingress.

An external IDE's HTML, extensions and preview applications should not inherit Workshop's origin. A future first-party embedding surface must deliberately specify accepted frame origins, sandbox permissions, navigation, clipboard, downloads, authentication and message capabilities. Relaxing the shared gadget CSP globally is not a reasonable prerequisite.

## WebSockets, previews and terminals

code-server's documentation requires WebSocket support, documents Cloudflare Access as an external-authentication option, and provides built-in port proxies. Subpath hosting is possible but requires careful path/redirect handling; its guide favors subdomains for application previews to avoid base-path issues. Test asset paths, reconnects, host forwarding and cookies against the exact pinned release. [code-server usage](https://coder.com/docs/code-server/guide)

The integrated terminal is arbitrary execution inside the workspace. Give it only workspace-scoped files and credentials; keep infrastructure credentials in the trusted service. A native gadget terminal would require an explicit RPC stream adapter because the iframe cannot open a direct WebSocket. Launching the complete IDE avoids building that adapter for the first version.

Project preview ports also need authorization and origin isolation. A running development server can serve arbitrary HTML; sharing the IDE or Workshop origin with it exposes browser state to that content. Preview traffic, notebook execution and terminal activity also need a deliberate policy for extending idle lifetime. Do not assume an open browser tab or connection alone guarantees continued execution.

## Durable data versus a live workspace

A Sandbox ID identifies its coordinator, not a permanent Linux instance. Idle stop, failure or replacement can destroy local files, processes, terminal IDs and live log buffers. `keepAlive` changes idle behavior but does not guarantee permanence. Store recoverable job definitions and external state, and tell users when a terminal/kernel has been restarted. [Preview lifecycle](https://developers.cloudflare.com/sandbox/1-0-preview/lifecycle/)

For the initial IDE implementation, use local container disk for the working tree and dependency activity, with versioned external checkpoints for project files and selected settings. Define the recovery point explicitly: edits made after the last completed checkpoint may be lost on abrupt termination. A periodic backup is not equivalent to a durable acknowledged save. If every saved edit must survive failure, add an acknowledged write-through/journal design or choose a host with suitable durable filesystem guarantees.

Sandbox supports directory backups to R2 and restore. Persist the backup reference in the workspace coordinator; restore before starting writers. Checkpoint on a schedule and explicit stop, not only on shutdown hooks. Restoring a directory snapshot does not restore process memory or a running terminal. [Backup and restore](https://developers.cloudflare.com/sandbox/guides/backup-restore/)

R2 mounts provide another persisted path, but mounting over `/workspace` overlays image-seeded contents rather than merging them. Cloudflare recommends considering backup/restore for project workspaces. Validate filesystem behavior and performance for Git, package managers, rename-heavy tools and file watchers instead of assuming an object-storage mount is interchangeable with a development disk. [Bucket mounts](https://developers.cloudflare.com/sandbox/guides/mount-buckets/)

Keep runtime checkpoints separate from blueprint archives. Define what cloning means: a clean template, a chosen project snapshot, or a new connection to existing data. None should silently include private workspace data or access to the original owner's runtime.

## Extensions and collaboration

code-server uses Open VSX rather than Microsoft's extension marketplace; Microsoft's proprietary extension availability cannot be assumed. The documented unavailable examples include Live Share and Microsoft remote extensions. VSIX installation exists, but availability, licensing and compatibility need verification per extension. Persist user settings and extension choices deliberately, or bake a reproducible allow-list into the image. [code-server FAQ](https://coder.com/docs/code-server/FAQ)

Workshop's existing source collaboration does not automatically synchronize files edited inside code-server. Initially designate the runtime project filesystem as the project source of truth and the blueprint source as the launcher/control UI. If both interfaces later edit the same files, add revision/conflict handling; a naive bidirectional watcher risks lost edits. Shared editing also requires a decision about whether every collaborator receives shell access.

## Proof-of-concept acceptance checks

- Launch from a blueprint into a workspace-bound IDE session; deny a different user's workspace ID and an expired launch handoff.
- Load the workbench, run a terminal command, install one approved extension and use a language server through the real HTTPS/WebSocket proxy.
- Confirm unauthorized requests and WebSocket upgrades fail, including direct preview URLs and alternate hostnames.
- Edit files, complete a checkpoint, force container replacement, and recover files/settings while clearly indicating terminal loss. Measure recovery time and the acknowledged-save guarantee.
- Open a development preview and verify that its JavaScript cannot access Workshop or IDE session data.
- Measure warm/cold start, active and idle cost, memory pressure, reconnect behavior, and concurrent-workspace limits before choosing production sizing.

The main uncertainty is implementation and operational polish, not theoretical capability. The lowest-risk first slice is an externally launched code-server workspace plus a native blueprint control panel, with durable-file semantics tested before promising a persistent cloud IDE.
