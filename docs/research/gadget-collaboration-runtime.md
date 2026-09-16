# Gadgets and blueprints at runtime, with a focus on concurrent multi-user editing

Code trace of the pinned submodule (`cloudflare-os` at `90f0591`). Paths are relative to `cloudflare-os/`. Line numbers were correct at that commit and will drift.

## Headline

The platform is genuinely multi-user and live, in two independent layers, both pushing over one WebSocket rather than polling:

1. **The Workshop layer (platform-owned).** Gadget *code* is a Yjs CRDT document; chat, actions, presence and metadata are RPC subscriptions. Every collaborator of a workspace hits the same Overseer Durable Object.
2. **The Gadget layer (user- or agent-authored).** A gadget's own server is a Durable Object *facet* inside that same Overseer DO, so every collaborator's browser talks to one shared instance with one shared storage. Live push is **not automatic** at this layer: the gadget's `server.js` must implement subscriber broadcast. The agent's system prompt instructs it to do so, and all three bundled format blueprints do.

**Blueprints are the opposite.** A blueprint is a code template. Instantiating one produces a new gadget with its own empty storage (`docs/blueprints.md:3`).

## 1. Gadget, blueprint, workspace, chat

### Workspace

One `OverseerDurableObject`, addressed by the workspace's public id.

- `packages/workshop-backend/src/overseer.ts:6532` — `export class OverseerDurableObject extends DurableObject<Cloudflare.Env>`
- `packages/workshop-backend/src/server.ts:223-227` — `overseerId = this.overseers.idFromString(id); let overseer = this.overseers.get(overseerId);` Every user opening gadget `id` resolves the same DO.
- `packages/workshop-shared/src/api.ts:1599` — `export interface Overseer extends RpcTarget`, the workspace-level capability (code sync, chats, sharing, workpieces).
- `api.ts:1233-1284` — `GadgetMetadata` is really the workspace's metadata (`id`, `title`, `owner?`, `role?`, `sharingProhibited?`, `defaultGadgetId?`).

### Gadget (a "workpiece")

`api.ts:3300` (`WorkpieceClient`) and `api.ts:3353` (`GadgetClient extends WorkpieceClient`). `WorkpieceId = number` (`api.ts:167`), sharing an id namespace with gatekeepers.

The agent system prompt (`packages/workshop-backend/src/agent.ts:477-487`) is the clearest statement of what a gadget is:

> `server.js` defines the Gadget's server-side logic, in the form of a Cloudflare Durable Object class. The class must be exported under the name `Gadget`. … The Gadget has access to private storage via the regular Durable Objects KV and SQLite storage APIs.

Runtime mechanism, Dynamic Worker Loader plus Durable Object facet:

- `overseer.ts:2374-2422` — `loadGadgetWorker()` calls `this.env.LOADER.get(\`${this.ctx.id}.${codeVersion}.${gadgetId}\`, ...)` with `{mainModule: "server.js", modules, env, globalOutbound: null, tails: [...]}`. Only `.js` files from the Yjs doc become modules (`:2394-2398`).
- `overseer.ts:2469-2476` — the facet:
  ```ts
  return this.ctx.facets.get<DurableObject>(facetName, () => {
    let stub = this.loadGadgetWorker(gadgetId, chatId);
    return { class: stub.getDurableObjectClass<any>("Gadget"), id: facetName };
  });
  ```
- `overseer.ts:1607` — `gadgetFacetName(id)`; the legacy single gadget keeps the name `"gadget"` (`:792`).
- `packages/workshop-backend/wrangler.jsonc:80-84` — `"worker_loaders": [{ "binding": "LOADER" }]`.
- `README.md:116` — "Every workspace is its own Durable Object, every Gadget runs in a Dynamic Worker Facet, and Gatekeepers also install facets into each workspace."

### Blueprint

A shareable code snapshot. `docs/blueprints.md:3`: "A blueprint captures the code but not the chat history, SQLite storage, or credentials. Each gadget created from a blueprint gets its own bindings, storage, and chat history."

- Types: `api.ts:3198` (`BlueprintMetadata`), `:3224` (`BlueprintPublicInfo`), `:3125` (`BlueprintBinding`), `:3322` (`BlueprintOutput`).
- Archive codec: `packages/workshop-backend/src/blueprint-archive.ts:1-21` (magic `0xec2e2d3a2300e317`, version 1, 24-byte prefix, JSON metadata, gzip Yjs snapshot).
- Storage: `docs/blueprints.md:51-63`, Gadget DO to User DO to KV (`BLUEPRINTS`); code content in R2 at `BLUEPRINT_CONTENT/<blueprintId>/<version>`.
- `GadgetClient.createBlueprint()` at `api.ts:3451`.

### Chat

A branch of the workspace's code plus an AI conversation, keyed by `chatId` throughout `Overseer`.

- `api.ts:2096` (`AiChatMetadata`), `:2182` (`AiChatMessage`), `:2889` (`AiChatSubscriber`).
- A chat with proposed changes makes the gadget facet run *that chat's* code: `overseer.ts:2431-2467`; `:2211-2218` (`proposedChangesChanged` aborts the facet).
- Each chat has a named binding env: `overseer.ts:2161-2205` (`getEnvForAgent`).

### `typed-storage`

`packages/typed-storage/src/index.ts` is a typed collection/index/singleton layer over `DurableObjectStorage` (`:600-612` `createTypedStorage`; `:99` `Collection`, `:60` `UniqueIndex`, `:110` `Singleton`, `:93` `Subscriber<T>`, which powers the kernel's server push). It is used by the kernel only (`overseer.ts:9,762,1403`; `user.ts:7,158,298`). **Gadget code does not get `typed-storage`.** It gets the raw DO storage API.

## 2. Where gadget state lives

In the Overseer DO's own storage, under the gadget's facet. One instance per gadget per *workspace*, not per user.

- The facet is created with `id: facetName` (`overseer.ts:2474`) inside `this.ctx.facets` of the Overseer DO. Facets have their own storage but live in the same DO.
- `wrangler.jsonc:45-59` — migrations declare `new_sqlite_classes` for the four kernel DOs. The gadget class is not listed because it is dynamically loaded and reached as a facet, not a namespace.
- `agent.ts:477` promises gadget code "the regular Durable Objects KV and SQLite storage APIs".
- In practice the bundled blueprints use `ctx.storage.get/put`. Sheets: `meta` plus `cells:<sheetId>`. Docs: `document:v2`.

Other kernel DOs, for orientation: `user.ts:282` `UserDurableObject` (one per verified email, `server.ts:684,700` `idFromName(email)`); `admin-settings.ts:57` `AdminSettings`; `auth/login-flow.ts:40` `PendingLogin`; `overseer.ts:9734` `AgentSpawnerGatekeeper`; `ai-models.ts:704` the language-model gatekeeper DO.

There is no per-user gadget instance anywhere in the code.

## 3. Sharing: same state, live push

### Same backing instance: yes

Both the full and the restricted capability return the identical facet:

- `overseer.ts:9338` (build/owner) — `return this.impl.getGadgetFacet(this.id, chatId);`
- `overseer.ts:9587` (use role) — `return this.impl.getGadgetFacet(this.id, undefined);`

Both route through `getGadgetFacetFetcher` to `this.ctx.facets.get(facetName, ...)` (`overseer.ts:2469`) on the one Overseer DO resolved by `idFromString(id)` (`server.ts:223`).

`docs/sharing.md:140`: "Collaborators share the gadget's code, storage, and AI chat history, but certain resources are scoped to individual users." Per-user carve-outs (`docs/sharing.md:141-145`): AI model bindings resolve from the creating user's account; gatekeeper bindings connect through the creating collaborator's third-party accounts.

Roles (`docs/sharing.md:12-17`): `build` (full) > `use` (render and interact with the deployed UI only). Capability-based: `UseOverseerInterface implements Overseer` and default-denies (`docs/sharing.md:28-30`; `overseer.ts:9045` onward, e.g. `:9179` `updateCode` denies).

Permission graph, share links and lazy revocation: `docs/sharing.md:54-136`; implementation `packages/workshop-backend/src/sharing.ts` (`computeEffectiveRoles()` fixed point at `:292`). Live sessions are killed on revocation via `ctx.abort()` (`docs/sharing.md:153-157`; `OverseerImpl.scheduleRevocationRestart`, called at `overseer.ts:7619`).

### Copy semantics: blueprints only

`docs/blueprints.md:3,5`. Share a gadget and you share live state; share a blueprint and each person gets an independent copy.

### Live push, platform layer

All server-to-client, over the one persistent Cap'n Web WebSocket (`AGENTS.md:12`; `server.ts:895-926`, `newWorkersWebSocketRpcResponse`, status 101). No polling anywhere.

- **Code, true CRDT co-editing.** `api.ts:1675-1685`: "Code is represented as a single Yjs doc shared by the whole workspace." `subscribeToCode` (`overseer.ts:7628-7667`) hooks the typed-storage `code` collection subscriber and calls `subscriber.update(record)` on every new version. `updateCode` (`overseer.ts:2099-2130`) writes the version, which fans out to all subscribed clients. The frontend applies with `Y.applyUpdateV2(this.ydoc, up.update, 'server')` (`packages/workshop-frontend/src/GadgetCodeInterface.tsx:32`) into a Monaco binding (`CodeEditor.tsx:42-43`).
- **Presence roster.** `api.ts:1615-1619`, `:3490` (`PresenceParticipant`), `:3501` (`PresenceSubscriber`). Implementation `overseer.ts:1155-1243`: in-memory `#presence` map keyed by `profileId` (multiple sessions per user collapse into one participant), `#broadcastPresenceAdd/Remove` push to every subscriber. `use`-role callers are allowed (`docs/sharing.md:15,30`).
- **Chat drafts.** `overseer.ts:2220-2236` `emitChatDraftUpdate` / `emitChatDraftCleared` loop over `#chatSubscribers`. Concurrent typists at `overseer.ts:7678-7681`: "If two users are typing at the same time we just attribute the edits to both of them."
- **Metadata.** `subscribeToMetadata` (`api.ts:1611`), with a live `prohibitAllSharing` singleton subscriber at `overseer.ts:7481-7497`.
- **Workpieces.** `api.ts:1644`, `:2988`.

**Gap:** there is no Yjs awareness protocol in the code editor. `grep -rn "awareness|y-protocols|y-websocket" packages/workshop-frontend/src packages/workshop-backend/src` returns nothing. Collaborative *text* merges correctly but there are no remote carets in Monaco, only the Overseer-level roster.

### Live push, gadget layer

Not automatic. `agent.ts:504-539`, "Server -> Client callbacks and subscriptions":

> Using functions this way is a great way to implement real-time updates. The client can "subscribe" to updates, passing a callback function to the server. The server can then call the function asynchronously whenever the state changes (perhaps due to activity of a different client). This technique should be used when implementing multiplayer collaboration.

The canonical pattern (`agent.ts:512-537`): `callback.dup()`, `onRpcBroken` for disconnects, and a client-side `RpcTarget` that re-subscribes in `[Symbol.dispose]`. Design tips at `agent.ts:547-549`: "ALWAYS store server state in Durable Object storage, not just in memory" and "If the user asks for a game or any sort of app where multiple users might collaborate, make sure multiple clients can connect at once and broadcast real-time updates to each other."

Transport is Cap'n Web bidirectional RPC over the existing WebSocket, not a gadget-owned WebSocket or SSE. The gadget iframe cannot open any network connection (see section 5).

## 4. The bundled spreadsheet: `format.spreadsheet`

`packages/workshop-backend/format-blueprints/` ships three blueprints as data:

| stem | blueprintId | output |
| --- | --- | --- |
| `workspace-docs` | `format.document` | Doc / Docs, `fileText` |
| `workspace-sheets` | `format.spreadsheet` | Sheet / Sheets, `table` |
| `workspace-slides` | `format.slides` | Slides, `presentation` |

The `.json` sidecar owns curated presentation and overwrites whatever the archive carries (`format-blueprints/README.md:15-24`; `src/format-blueprints.ts:55-60`). `output.icon` must be in `OUTPUT_ICONS` (`api.ts:1299-1300`). `output.id` should be generic so the Outputs page groups correctly. `blueprintId` is the install key and must never change after deploy (`README.md:78-81`; `AGENTS.md:17`).

The `.gadget` archive is a 24-byte prefix, JSON `BlueprintMetadata`, then a gzip Yjs snapshot. For `workspace-sheets.gadget` (40,319 bytes) the snapshot decodes to about 152 KB of source: `client.js`, `server.js`, `README.md`. Full analysis in [bundled-blueprint-sync-patterns.md](bundled-blueprint-sync-patterns.md).

Install path: `src/format-blueprints.ts:1-10`, installed into KV and R2 on the first `/api` request a deployment serves. Reinstall is fingerprint-triggered (`:30-36`). Override the whole set with `FORMAT_BLUEPRINTS_DIR` (`format-blueprints/README.md`, "Shipping your own formats").

## 5. Gadget frontend and the UI-to-backend transport

An opaque-origin, doubly-sandboxed `srcDoc` iframe. No HTML file; `client.js` builds the DOM (`agent.ts:489-496`). Plain DOM, not React.

`packages/workshop-frontend/src/GadgetUI.tsx`:

- `:492-502` — `<iframe srcDoc={sandboxedHtml} sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox">`
- `:105-115` — the CSP: `default-src 'none'; frame-src 'none'; script-src data: 'unsafe-inline'; style-src data: 'unsafe-inline'; img-src data:; media-src data:; object-src 'none'; base-uri 'none'; form-action 'none'; connect-src 'none';` The gadget UI cannot fetch, WebSocket or EventSource anything.
- `:16-26` — Cap'n Web is injected as a nested base64 `data:` module.
- `:28-33` — the handshake that creates the `gadget` global:
  ```js
  let gadget;  // RPC stub to the gadget's server-side Durable Object.
  { let {port1, port2} = new MessageChannel();
    window.parent.postMessage("handshake", "*", [port2]);
    gadget = newMessagePortRpcSession(port1); }
  ```
- `:329-337` — parent validates `event.source === iframeRef.current?.contentWindow && event.origin === "null"`.
- `:350` — `gadgetStub = await gadgetRef.current.connectToGadget(chatId)`.
- `:358-369` — a redirectable `Proxy` forwarding target so the stub survives backend reconnects.
- `:36-49` console monkey-patch to `postMessage({type:'console',...})`, surfaced as `ConsoleLogEvent` (`api.ts:2939`); `:52-60` `window.open` blocked; `:65-69` Escape forwarded; `:87-101` errors forwarded.

Full path: iframe `gadget.foo()` → `MessagePort` → parent → Cap'n Web over the browser's WebSocket → `AuthenticatedApi` → Overseer DO → `GadgetClient.connectToGadget` (`overseer.ts:9331-9339`) → facet stub (wrapped in a `Proxy` at `overseer.ts:2489-2530`, a documented hack since facet stubs cannot yet cross RPC, which also traps exceptions into the console-log subscriber).

The backend can push to the UI only via Cap'n Web callback stubs. `UiBundle` is `{jsCode: string}` today (`api.ts:1423-1443`), and `getGadgetUiBundle` (`overseer.ts:2539-2551`) returns the text of `client.js` alone: **the client cannot import other gadget files**, while the server side receives every `.js` file as a module (`overseer.ts:2393-2398`) and can import `lib/*.js`.

## 6. `plans/multi-gadget.md`

Turns "workspace = gadget = one Overseer DO" into a workspace containing multiple numbered workpieces (gadgets and gatekeepers). Yjs moves to per-workpiece named roots (`:20-25`); binding names move onto per-gadget binding-edge records (`:27-33`); per-gadget facet names (`:52`).

On multi-user it mostly says *not yet*: sharing stays workspace-scoped (`:80-81`); "v1 shares all gadgets" (`:91`); `prohibitAllSharing` is workspace-level, so "one tainted gadget locks down sharing of all gadgets in the workspace" (`:131`); explicitly not implemented: "Sharing individual gadgets without sharing all gadgets in the workspace" (`:169`). Nothing about CRDTs for gadget data, presence, or operational transforms.

## 7. Sandbox policy and limits on gadget backends

The worker definition, `overseer.ts:2406-2420`:

```ts
compatibilityDate: "2026-02-01",
compatibilityFlags: ["allow_irrevocable_stub_storage"],
mainModule: "server.js",
modules,
env: this.getEnvForLoader(gadgetId, {from: "gadget", chatId, gadgetId}, chatId),
globalOutbound: null,
tails: [this.ctx.exports.GadgetTailLoopback({props: tailProps})],
```

| Capability | Gadget code |
| --- | --- |
| External `fetch()` | No. `globalOutbound: null` (`overseer.ts:2416`); `agent.ts:500,706`; `README.md:161`. |
| Outbound WebSocket | No, same flag; client side has `connect-src 'none'`. |
| Durable Objects | It *is* one (a facet). It cannot create others: `env` is `{GADGET: <self loopback>}` plus one loopback per visible gatekeeper binding (`overseer.ts:2147-2155`). No DO namespace, KV, R2 or queue bindings. |
| DO storage | Yes, KV and SQLite (`agent.ts:477`). |
| Alarms | Not found either way. No grant, no block, no documentation. All `alarm` hits in `workshop-backend` are the Overseer's own keep-alive (`overseer.ts:1132-1144, 1292-1355, 6540-6554`). Scheduling is offered via `gatekeeper-scheduler` and the `ctx.restore()` hook mechanism (`agent.ts:607-666`). Treat as unverified. |
| Incoming HTTP | No route (`agent.ts:477`). All traffic arrives as facet RPC. |
| Client popups | `alert()`/`confirm()` blocked (`agent.ts:502`); `window.open` patched off (`GadgetUI.tsx:52-60`). |
| Client storage | None. Opaque origin means `localStorage` is unavailable; `agent.ts:548` says "there is no client-side storage". |
| Exports | `MAX_EXPORT_DURATION_MS = 30_000`, `MAX_EXPORT_BYTES = 100 MiB` (`src/export-limits.ts:1-5`). |
| Blueprint archives | metadata ≤ 64 KiB, content ≤ 32 MiB (`blueprint-archive.ts:20-21`). |
| Logging | Forced through a tail worker (`overseer.ts:2419`). |

The `executeCode` worker (`overseer.ts:5595-5616`) and the restore forger (`overseer.ts:149-163`) add `disallow_importable_env`; the gadget worker does not (`overseer.ts:2409-2412`).

## 8. What this means for a Google-Docs-style app

Already free: one shared DO facet per gadget for all collaborators; live Yjs co-editing of *code*; presence roster; share links with a real permission graph; live session termination on revoke.

To write in `server.js`: the data-layer broadcast (`subscribe(cb)` with `cb.dup()` and `onRpcBroken`, a `broadcast()` fan-out, and a conflict policy). Copy `format.document` (block-level `baseRevision` plus live carets) or `format.spreadsheet` (per-cell versions plus last-writer-wins structure); avoid `format.slides`' full-snapshot rebroadcast at scale.

Real gaps:

- No Yjs awareness, so no remote cursors in the code editor.
- Sheets ships with remote badges and selection overlays disabled in the UI, though the wire protocol carries them.
- No per-gadget sharing; sharing is workspace-wide.
- `prohibitAllSharing` is workspace-wide.
- Gadget code gets no CRDT library and no `typed-storage`.
- Gadget code has no viewer identity (see the public-docs research, Discussion #455).
- Gadget backends cannot use real WebSockets or hibernation. Live subscriptions die whenever the facet is aborted (code version change, chat-branch switch, revocation restart) and clients must re-subscribe, which is why the prompt's pattern re-subscribes in `[Symbol.dispose]`.

> **Update 2026-09-16 (verified by the kanban build on local workerd and a local Cloudflare OS):**
> - `onRpcBroken` is not implemented by workerd's built-in RPC, so a dead subscriber is only noticed when a delivery to it fails.
> - `[Symbol.dispose]` never fired on a facet restart.
> - After a `server.js` edit, a `use`-role iframe's `gadget` stub fails permanently until the frame reloads.
> - `gadget` and `RpcTarget` are module-level bindings in the injected prefix, not globals.
> - The iframe sandbox lacks `allow-forms`.
>
> **Update 2026-09-16, later (verified by the whiteboard build's spike on a local Cloudflare OS):**
> - A `callback.dup()` stub that is garbage-collected without `[Symbol.dispose]()` logs "An RPC stub was not disposed properly" (the deployed kanban board did this) and crashes local workerd. Disposing a kept stub never reaches the client's `RpcTarget` `[Symbol.dispose]`.
> - Calling `stub.onRpcBroken(fn)` does not throw, but `fn` never fires; it also sends `fn` over RPC as a stub.
> - `setTimeout` and `setInterval` work in the facet, accurate to about 1 ms.
> - A gadget handled about 45–50 inbound RPC calls a second, one at a time. Unawaited calls above that queue for seconds.
> - A Durable Object stub has a built-in `connect()`, so a gadget method named `connect` is unreachable through `env.<Gadget>`.
> - In the sandboxed iframe, `navigator.clipboard` rejects (permissions policy), `localStorage` throws, and Ctrl+Z outside a text field runs native undo, which refocuses the last edited field.
>
> The workarounds are in the [master plan's gaps table](../plans/collaborative-blueprints.md#what-the-platform-does-not-give-us).

## Not found

- Any explicit statement about alarms in gadget code.
- Any awareness/cursor protocol for the Monaco code editor.
- Any per-user or per-session gadget instance.
- Any spreadsheet or table gadget outside `format-blueprints/` (the only other "sheets" code is `gatekeeper-google`'s read-only Google Sheets connector).
