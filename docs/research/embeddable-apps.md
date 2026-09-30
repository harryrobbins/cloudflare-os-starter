# Embeddable apps: one app inside another, with agents on both sides

**Date:** 2026-09-30. **Question:** can the Whiteboard (or a Vega chart maker) become a component that another app, first of all Docs, embeds as a drawing tool, in the way MCP Apps return an iframe for a chat host to show? And if it is embedded, can the host's agent still change what is inside it?

**Baseline:** root `main` at `2c6f0eb`, `cloudflare-os` submodule at `0bef2869`. External facts were checked on 2026-09-30 against the sources linked in each section. Anything not checked is marked as recalled.

The recommendation that follows from this research is in [Drawings in Docs](../plans/docs-drawing-embeds.md).

## Summary

1. **An MCP App does not let the host agent into the iframe either.** The model never reads or changes the view. The agent and the view both act on state held by the server, through tools. The agent calls model-visible tools. The view calls app-visible tools through the host. The view pushes a summary of its state back with `ui/update-model-context`. So the problem "the doc agent can't add things to the whiteboard iframe" is solved by where the state lives, not by talking to the iframe.
2. **On this platform, nothing can embed a gadget in a gadget.** The gadget page has CSP `frame-src 'none'` and `connect-src 'none'`. The Overseer throws "Gadget-to-gadget bindings are not supported yet." Hosting an MCP-Apps-style frame inside a gadget would need changes to the forked Workshop.
3. **The agent is already shared.** A workspace has one Workshop agent per chat, not an agent per gadget. It gets an RPC stub for every gadget in the workspace. If the drawing's state is reachable through RPC, the "doc agent" and the "whiteboard agent" are the same agent with two skills. A second agent adds nothing unless the specialist has to work on its own for a long time.
4. **The repository has already embedded one app in another without an iframe.** Tessera is bundled into a gadget's `client.js` as a library (`mountTessera`), because iframes are blocked. The Whiteboard is built for this too. Its rules run over a storage-agnostic `Repository`, and its UI talks only to a store interface, never to `gadget` directly.
5. **The best-proven model for "diagram inside a document" is host-owned data.** In draw.io embed mode, Confluence, OLE and Google Docs drawings, the document stores the drawing's source together with a rendered preview. The editor is a component that loads and saves that source. Copying, exporting, sharing and deleting the document then carry the drawing with it.

## 1. What MCP Apps specify

MCP Apps (SEP-1865, extension `io.modelcontextprotocol/ui`) became MCP's first official extension on 2026-01-26. The spec is marked stable at that date, and a draft adds more. MCP-UI says it "directly influenced" MCP Apps and now implements the standard. OpenAI's Apps SDK tells developers to use the MCP Apps fields and bridge, and treats its own `window.openai` additions as optional.

- Stable spec: <https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx>
- Draft: <https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/draft/apps.mdx>
- Launch post: <https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/>

### Declaring and rendering a UI

A tool names a template: `_meta.ui.resourceUri = "ui://server/template"`. The resource must have MIME type `text/html;profile=mcp-app`. Templates are declared up front, so a host can prefetch and review them before any tool runs. The resource's `_meta.ui` carries these fields:

| Field | Contents |
| --- | --- |
| `csp` | `connectDomains`, `resourceDomains`, `frameDomains` and `baseUriDomains`. With no declaration, the default blocks all external connections. |
| `permissions` | Camera, microphone, geolocation and clipboard-write, mapped onto the iframe's `allow` attribute. |
| `domain` | A dedicated sandbox origin. |
| `prefersBorder` | Whether the host should draw a border. |

Web hosts must use a double iframe. An outer sandbox proxy runs on a different origin. It receives the HTML and CSP from the host (`ui/notifications/sandbox-resource-ready`), builds the inner iframe, and then relays messages. The host may tighten the declared CSP but never loosen it.

### The bridge: JSON-RPC over `postMessage`

| Direction | Methods |
| --- | --- |
| View → host, requests | `ui/initialize` (the reply carries theme, display mode, dimensions, locale and platform), `tools/call`, `resources/read`, `ui/message`, `ui/update-model-context`, `ui/open-link`, `ui/request-display-mode` (`inline`, `fullscreen` or `pip`), `ping` |
| View → host, notifications | `ui/notifications/initialized`, `ui/notifications/size-changed` |
| Host → view | `ui/notifications/tool-input-partial`, `tool-input`, `tool-result`, `tool-cancelled`, `host-context-changed`, and the request `ui/resource-teardown` |
| Draft only | `ui/download-file`, logging, and `sampling/createMessage` from the view |

`ui/message` inserts a user-role message into the conversation. `ui/update-model-context` replaces the view's previous context, and the host may hold it back until the next turn. It is eventually consistent, not a live channel.

Do not build on sampling. The core MCP 2026-07-28 release candidate deprecates Sampling, Roots and Logging, with at least 12 months before removal (<https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/>).

### How the agent relates to what is in the iframe

- Tool `visibility` is `["model","app"]` by default. A host must hide from the model any tool without `"model"`. It must reject a view's call to any tool without `"app"`. This gives three kinds of tool: agent-only, view-only (for example `apply_patch` or `refresh`), and shared.
- The spec never gives the model the view's DOM or a screenshot. The agent reads and changes the app by calling the server's tools. The view shows the result when it gets `tool-result` or refreshes.
- Unspecified or deferred:
  - whether one view instance is reused across later tool calls;
  - communication between views, and several UI resources in one response (so a standard for **nesting one app inside another app's view does not exist**);
  - persistence of view state ("State persistence and restoration" is listed as a future extension).
- OpenAI's `widgetState` now "belongs to one rendered UI instance" and must not be used for business data. The docs name three kinds of state: business data on the server, UI state in the instance, and cross-session state in your own backend (<https://developers.openai.com/apps-sdk/build/state-management>).

### Security model

The iframe exists because the server's HTML is untrusted. The origin is isolated and CSP limits network access. The host sees every bridge message but nothing inside the iframe that the view does not send. It may ask the user before a `ui/message`, an external connection or a tool call, but per-call consent is not mandatory.

**What to take from this:** an MCP App is an **untrusted-code** isolation boundary plus a **server-authoritative state** pattern. Only the second part is needed to answer the agent question. The first part matters only if the embedded code is not trusted.

## 2. Other prior art

**draw.io embed mode** (<https://www.drawio.com/doc/faq/embed-mode>) is the closest analogue. The host owns storage and the editor iframe is stateless.

- The host opens `embed.diagrams.net/?embed=1&proto=json`, with options such as `spin`, `modified`, `saveAndExit`, `noExitBtn` and `configure`.
- The editor sends `init`. The host replies `{action:"load", xml}`.
- The editor sends `save`, `autosave`, `exit` (with a `modified` flag) and `export` (a data URI).
- The host can also send `merge`, `patch`/`getDiff` (incremental sync with checksums), `export`, `layout`, `snapshot`, `status` and `spinner`.
- The host is responsible for checking origins.

**draw.io for Confluence:** saving writes page attachments, a rendered image plus the diagram XML. draw.io PNG and SVG files can carry their XML inside, so the preview stays editable. Community threads report the macro and its attachments going out of step (<https://community.atlassian.com/forums/Confluence-questions/Draw-io-not-showing-latest-diagram-version-in-Confluence-page/qaq-p/654771>). That is a warning about keeping preview and source in separate records.

**Microsoft Loop / Fluid Framework** takes the other approach: a shared data model with many views. Components are distributed data structures (SharedTree, SharedMap) in one container, and any host that loads the container can render them (<https://fluidframework.com/docs>).

**Recalled, not checked this session:**

- Notion embeds of Excalidraw, Whimsical or Figma are plain iframes with no state protocol between host and embed. The drawing lives with the provider.
- Google Docs drawings are stored in the document and edited in a modal.
- OLE and OpenDoc compound documents stored the embedded object's native data in the container, and activated the object's editor in place.

## 3. Agent-to-agent options

| Mechanism | Fit for "doc agent asks whiteboard agent" |
| --- | --- |
| **One agent, two skills** (this platform today) | Best. The Workshop agent can already call every gadget in the workspace (`agent.ts:790`, `getEnvForAgent` `overseer.ts:2189-2210`). Adding a whiteboard skill gives it the drawing vocabulary. |
| `AGENT_SPAWNER.spawnCallable(title, prompt)` | Available now. A gadget starts a Workshop agent and gets a callable stub back (`workshop-backend/src/agent-spawner-binding.txt:32`). Useful for a background specialist, for example "lay out this architecture as a diagram". |
| A2A (Agent Cards; Task, Message and Artifact; JSON-RPC, gRPC or REST) | For delegating between separately hosted autonomous agents. It says nothing about embedding UI. Over-engineered inside one workspace. |
| MCP sampling or elicitation from the view | Sampling is deprecated in the 2026-07-28 release candidate. Elicitation is for asking the user, not an agent. |

The question "can the doc agent talk to the whiteboard agent?" goes away when the drawing is data that the doc agent can reach. The thing that needs to be shared is **the model and its operations**, not a chat channel. Two agents that can only exchange prose about a drawing would be slower and less reliable than one agent calling `addStickies` or `connectObjects`.

## 4. This platform's constraints

Line numbers refer to the `cloudflare-os` submodule at `0bef2869` unless the path is in the root repository.

| Fact | Evidence |
| --- | --- |
| Gadget iframe: `sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"`, which gives an opaque origin | `workshop-frontend/src/GadgetUI.tsx:537` |
| Gadget CSP: `default-src 'none'; frame-src 'none'; script-src data: 'unsafe-inline'; img-src data:; connect-src 'none'` | `GadgetUI.tsx:112` |
| The only channel from the client is the `gadget` stub: a `MessagePort`, then Cap'n Web over the Workshop WebSocket, then the facet | `GadgetUI.tsx:26-32`, `:345`; `overseer.ts:9569`, `:9830` |
| Gadget-to-gadget bindings throw | `workshop-backend/src/overseer.ts:1864`; future work in `cloudflare-os/plans/multi-gadget.md:27` |
| Connector UI frames exist (`GatekeeperUiFrame {iframeHtml, ui}`), but only the Workshop hosts them | `workshop-shared/src/gatekeeper.ts:433-435`, `SandboxedGatekeeperApp.tsx:363-366` |
| One Workshop agent per chat, with a stub for every gadget; no agent per gadget | `workshop-backend/src/agent.ts:475-503`, `:790` |
| Formats with an `output` are edited through RPC, not code edits | `agent.ts:2346-2356` |
| Precedent for bundling a library instead of an iframe | Tessera: `docs/plans/tessera-blueprint.md` (decisions table) |

### Readiness of the Whiteboard (root repository, `packages/blueprint-whiteboard/src`)

- `core/whiteboard.js` holds all rules: validation, caps, per-object versions, history, undo, idempotency and agent convenience methods. It is "storage-agnostic: everything goes through a Repository". It already runs over Durable Object storage, in memory, and in the browser harness.
- `core/repository.js` is a five-method interface: `getMeta`, `getObjects`, `getHistory`, `getRequests` and `commit`. A second board in the same Durable Object only needs a key-prefixed repository.
- `client/store-contract.js`: "The UI never calls `gadget` directly; the store never touches the DOM." The UI can be mounted against any store that satisfies the contract.
- `shared/render.js` `boardToSvg` renders a board, or one frame, as a standalone SVG. It is pure and already used by `exportSvg`.
- There is no SKILL.md. The agent learns the API from `src/README.md` "Programmatic use".

### Readiness of Docs

- Docs is the upstream bundled format `workspace-docs` (Apache-2.0). Its decoded source is in `docs/research/bundled-blueprints/`.
- Storage is a `document:v2` snapshot of HTML blocks with per-block versions. Concurrency is optimistic per block. `setDocument` and `applyOperation` are the agent write paths. Images are downscaled `data:` URLs in block HTML.
- We do not own this format. Adding embeds means shipping our own fork of it as a format, the same way the other `packages/blueprint-*` formats ship.

### Vega-Lite

There is no chart-maker format. Vega and Vega-Lite 6 with `vega-interpreter`, which works without `unsafe-eval`, are already bundled in `blueprint-procgen-explorer` and `blueprint-work-board`. Work Board stores agent-written Vega-Lite specs with inline data only (`packages/blueprint-work-board/src/SKILL.md:80-132`). A chart is therefore an even simpler embed than a drawing: a JSON spec plus a renderer.

## 5. Candidate architectures

| | A. Static snapshot | B. Nested live iframe (MCP-Apps-like) | C. Connector-hosted editor | D. Embedded library, host-owned data |
| --- | --- | --- | --- | --- |
| Shape | Agent exports SVG from a Whiteboard gadget and inserts an `<img>` into the doc | Doc page frames the Whiteboard gadget's UI | Whiteboard becomes a Gatekeeper that stores boards, renders SVG and supplies a `GatekeeperUiFrame` editor; the doc stores a reference and a preview | Doc bundles the whiteboard core and UI; each drawing's objects live in the doc's Durable Object |
| Platform changes | None | Fork: relax `frame-src`, host nested gadget frames, gadget-to-gadget binding, cross-gadget auth | Fork: let a gadget ask the Workshop to open a connector UI (modal or `fullscreen`) | None |
| Can the doc agent edit the drawing? | Yes, via the Whiteboard gadget, but the doc goes stale until it is re-exported | Only through a second binding to the Whiteboard gadget; the iframe itself is opaque | Yes, via connector RPC (`env.WHITEBOARD.*`) | Yes: doc RPC `drawings.*` calls the same whiteboard core |
| Live co-editing in the doc | No | Yes | In the modal only | Yes, with the doc's subscription |
| Lifecycle (copy, export, share, delete) | Snapshot follows the doc; source is orphaned | Two gadgets to share and keep in step | Drawing lives outside the doc (the Confluence drift risk) | Follows the doc |
| Isolation | n/a | Strong: separate origin per app | Strong | None needed: first-party code, the same trust as the doc's own code |
| Generalises to third-party or untrusted apps | No | Yes | Yes | No |
| Cost to prove | Hours | Weeks, plus upstream divergence | Days to weeks, plus a fork patch | Days |

**Assessment:**

- **A** is a useful stopgap and needs no code: the agent can do it today.
- **B** reproduces MCP Apps but pays for isolation we do not need between first-party formats. It also still leaves the agent editing a *different* gadget.
- **C** is the right shape for untrusted or remote apps, the true MCP-Apps equivalent. The Workshop already hosts connector frames, so it is the path if we later want an "embeddable app" marketplace.
- **D** gives the doc agent direct, first-class editing, live co-editing in place, and correct lifecycle, with no platform change. It also reuses a seam the Whiteboard already has, and it follows a pattern already shipped once (Tessera).

## Sources

- MCP Apps stable spec, draft and launch post: linked in section 1.
- MCP 2026-07-28 release candidate: <https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/>
- OpenAI Apps SDK state management and reference: <https://developers.openai.com/apps-sdk/build/state-management>, <https://developers.openai.com/apps-sdk/reference>
- MCP-UI: <https://mcpui.dev/guide/introduction>
- draw.io embed mode: <https://www.drawio.com/doc/faq/embed-mode>
- Fluid Framework: <https://fluidframework.com/docs>
- A2A, from secondary sources: <https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year>
