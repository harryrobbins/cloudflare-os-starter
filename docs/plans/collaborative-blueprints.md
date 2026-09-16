# Master plan: three real-time collaborative blueprints

Written 2026-09-16. Goal: give the team Miro-, Trello- and Wave-style tools inside our Cloudflare OS deployment, each as a blueprint that anyone can stamp out and then share with colleagues for live, same-state collaboration.

Background research is in [`../research/`](../research/README.md). Read [gadget-collaboration-runtime.md](../research/gadget-collaboration-runtime.md) once before starting any of these; the rest of this page assumes it.

## The three blueprints

| Plan | Product analogue | Hard part | Status |
| --- | --- | --- | --- |
| [Kanban board](kanban-blueprint.md) | Trello, Jira board | Nothing new; the Sheets pattern applied to cards and columns | **Deployed 2026-09-16** as `format.board` from [`packages/blueprint-kanban`](../../packages/blueprint-kanban/README.md), about 2,500 lines of shared, core and server code and 5,400 of client |
| [Whiteboard](whiteboard-blueprint.md) | Miro | High-frequency ephemeral state (drags, cursors) kept off storage; many small versioned objects | **Deployed 2026-09-16** as `format.whiteboard` (revision 4) from [`packages/blueprint-whiteboard`](../../packages/blueprint-whiteboard/README.md), about 4,000 lines of shared, core and server code and 8,500 of client |
| [Wave](wave-blueprint.md) | Google Wave | Character-level co-editing inside many threaded messages, which needs a CRDT inlined into the gadget | Not started |

Build them in that order. The kanban board proved the deployment, sharing and promotion pipeline end to end, and its package is the base for the other two (see [Reusing the kanban build](#reusing-the-kanban-build)).

## Why this works on the platform

Verified in the pinned release (details and `file:line` in the research):

- Every gadget's `server.js` is a Durable Object facet with private KV/SQLite storage. Sharing a gadget gives every collaborator the *same* facet and the same storage. There is no per-user copy.
- Server-to-client push is Cap'n Web RPC callbacks: the client hands the server an `RpcTarget`, the server keeps a `.dup()` of it and calls it later. The bundled Docs, Sheets and Slides gadgets all do this and are live-collaborative today.
- The AI agent that builds gadgets is prompted with exactly this pattern and told to use it "when implementing multiplayer collaboration", so an agent-built first draft will be close to what we want.
- Sharing, roles (`build`/`use`), share links, transitive revocation and the who-is-here roster are platform features and cost us nothing.

## What the platform does not give us

Each plan has to handle these, and the master plan tracks the cross-cutting fixes:

| Gap | Impact | Handling |
| --- | --- | --- |
| No viewer identity reaches gadget code (upstream Discussion #455) | Collaborators show as "Guest A1B2" unless they type a name; nothing can be attributed to a real user | Phase 0 option below patches the kernel in our fork. Until then every plan has a name prompt on first load. |
| No client-side storage (opaque-origin iframe) | The name prompt repeats on every reload; no local drafts survive a reload | Accept for v1. With the identity patch the prompt disappears. |
| Facet restarts on code deploy, chat-branch switch and revocation drop every subscription | Clients go stale silently | Neither `[Symbol.dispose]` nor `onRpcBroken` fires in practice (the runtime does not implement `onRpcBroken`). The kanban board's heartbeat (`updatePresence` returns `{known, revision}`) detects the restart, and the client re-subscribes. |
| After a code edit, a `use`-role iframe's `gadget` stub fails permanently (verified locally) | Re-subscribing cannot help; the connection itself is dead | The client reloads its own frame after repeated failures, carrying the viewer's name in `window.name`. Unsent local changes are lost. |
| The platform prepends `gadget` and `RpcTarget` as module-level `let` bindings, not globals | Code reading `globalThis.gadget` crashes on start | Read them with `typeof gadget !== "undefined"`. |
| The iframe sandbox has no `allow-forms` | Native form submission is silently blocked before `submit` fires | No `<form>` elements; use button and Enter handlers. |
| No CRDT library, no `typed-storage`, no npm at runtime; `client.js` is served as one file and cannot import siblings | Text co-editing needs a library inlined: a module file for the server, concatenated into `client.js` for the browser | Only Wave needs this; see its plan for the Yjs build step. |
| Sharing is workspace-wide, not per gadget | A workspace with a board and a whiteboard shares both or neither | Keep one tool per workspace for now. Upstream `plans/multi-gadget.md` defers per-gadget sharing. |
| A `dup()`ed callback stub that is garbage-collected undisposed logs "An RPC stub was not disposed properly" (production) and crashes local workerd (found by the whiteboard spike) | The deployed kanban board logged the warning: its hub dropped replaced and dead subscribers without disposing them | Dispose every kept stub exactly once when its entry is replaced, left or dropped; never call `onRpcBroken` (passing it a function leaks a function stub). Disposal never reaches the client's `[Symbol.dispose]`. An instance aborted by a code edit still cannot dispose what it holds. |
| A gadget handles about 45-50 inbound RPC calls a second, one at a time (measured locally) | Clients firing presence at a fixed 30 Hz queued calls for 2-16 s | Keep at most one `updatePresence` in flight per client and send only the latest state; coalesce fan-out on the server (33 ms) |
| A Durable Object stub has a built-in `connect()` (TCP sockets) | An RPC method named `connect` is unreachable: `env.X.connect({...})` fails with a conversion error | Don't name gadget RPC methods `connect` (the whiteboard uses `connectObjects`) |
| V8 serialises numbers in about 12 bytes, versus 3-4 in JSON | A JSON-based size cap let the whiteboard's `history` reach 284 KiB, past the 128 KiB value limit | Measure stored size with a bound on the V8 form (`storedBytes` in `packages/blueprint-whiteboard/src/shared/protocol.js`) |
| Broadcast `clientId`s are public | Request ids built from `clientId:seq` let a peer pre-record another user's ids and make their writes vanish as duplicates (kanban and whiteboard) | Build request ids from a per-page random secret, and match replay records per `senderId` |
| In the sandboxed iframe, Ctrl+Z outside a text field runs the browser's native undo; `navigator.clipboard` is blocked by permissions policy | Native undo moves focus back into the last edited textarea; async clipboard calls reject | Intercept undo/redo keys in a capture-phase listener outside editors; use `copy`/`paste` DOM events if clipboard is ever needed |
| Open RPC channel keeps the DO billable (upstream issue #338) | A tab left open all day costs DO wall-clock time | Acceptable at team scale. Revisit if the deployment grows. |
| Alarms availability in gadget code is undocumented | No server-side timers for e.g. Wave digests | Treat as unavailable. Use `gatekeeper-scheduler` if a schedule is ever needed. |
| Output is one shared state, no history | No undo across users, no audit | Each plan keeps a bounded server-side `history` list of applied operations for undo and a basic activity feed. |

## Common build and ship path

Each plan follows the same seven steps. The plan pages only describe what differs.

**What the kanban board actually did.** It replaced step 1 with building in this repo. Claude Code agents wrote a package with unit tests, a multi-pane browser harness and a local-platform e2e suite, then packed it into a `.gadget` archive. It shipped through step 6 directly. The [delivery plan](kanban-delivery.md) explains why. Use that route for the whiteboard and Wave too: the platform-only bugs above were invisible in the Workshop editor and would have been hard to find without the e2e suite. Steps 1 to 3 below still describe the Workshop-agent route, which is useful as a quick comparison.

### 1. Draft with the agent

Open the deployment, start a new gadget, and give the agent the plan's "agent brief" section verbatim, followed by: *"Follow the collaboration pattern used by the bundled Sheets gadget: a `Gadget` Durable Object with a mutation queue, per-item versions with conflict responses, `subscribe(callback, client)` with `callback.dup()` and `onRpcBroken`, `broadcast` of diffs, and ephemeral presence. Store all state in `ctx.storage`. Write a README.md documenting the RPC surface."* The agent has read the same prompt the bundled gadgets came from and will produce something in the right shape.

### 2. Test with two browsers

Open the gadget in two browser profiles (or one normal and one private window, both signed in as different Access users). Share it from the header with a share link at `use` role, open the link in the second window. Check: edits appear in the other window without reload; presence appears; conflicts are handled; a reload of one window resyncs. Then stop the facet on purpose by editing `server.js` in the code editor while the other window is open, and confirm it re-subscribes rather than going stale.

### 3. Harden by hand

Go through the plan's checklist (sanitisers, size caps, echo suppression, stale-presence expiry, re-subscribe). The agent tends to skip caps and re-subscribe. Do this in the code editor; the Workshop's Yjs code sync means two people can edit the gadget source at once.

### 4. Publish a blueprint

Gadget header, **Blueprint**, create with title, description and a screenshot. Annotate any bindings (none of the three plans need any in v1). This gives a `/blueprint/<hex-id>` link that colleagues can instantiate.

### 5. Promote as a format (no build)

`/admin`, Formats panel, promote the blueprint. It then appears under **New** in the composer and the agent is told to prefer it. This is the lightest path and needs no deploy. Set `output` (noun, plural, icon) here; icon must be one of `OUTPUT_ICONS` in `workshop-shared/src/api.ts`.

### 6. Ship as a bundled format (optional, durable)

Once stable, put the `.gadget` and its `.json` sidecar in [`formats/`](../../formats). A repo-built gadget packs straight there; a Workshop-built one is exported from `/blueprint/<id>` first. `pnpm deploy` then installs it on the deployment's first request. This uses upstream's `FORMAT_BLUEPRINTS_DIR`, wired through `formatBlueprintsDir` in `deployment.jsonc` (done; see [Bundled formats](../customization.md#bundled-formats)). Bump the sidecar's `revision` on every code change, and never change its `blueprintId`.

### 7. Sync upstream

Upstream `main` has moved the bundled gadgets to `packages/bundled-blueprints/` with a shared `libraries/sync` (mutation queue, versioned apply, presence roster) and TypeScript sources. When the weekly upstream-sync workflow next lands that, rebase the three gadgets onto that library instead of the hand-copied skeleton.

## Cross-cutting work items

### Phase 0, optional but recommended: viewer identity

A kernel change in our fork (`surprisingly-os`, branch `starter-openrouter`). `GadgetClient.connectToGadget` in `overseer.ts` already runs inside a session that knows the caller's profile and role. Pass a `{id, displayName, role}` object into the facet on connect (for example as `ctx.props`, or as a second argument the platform injects into `subscribe`), and expose it to `client.js` as a `gadgetViewer` global next to `gadget`. This mirrors the shape proposed in upstream Discussion #455, so if upstream lands it our change becomes a no-op rebase.

Cost: a day. Benefit: every plan drops its name prompt, presence shows real names, kanban assignees and Wave authors become real identities, and `use`-role viewers can be made read-only inside the gadget. Without it the three tools work but attribution is on the honour system.

If you do this, keep the diff in `workshop-backend` and `workshop-shared` small and separate, per upstream's AGENTS.md rule for kernel changes.

### Starter change: own formats directory (done)

`deployment.jsonc` sets `"formatBlueprintsDir": "formats"`. When the key is set, `scripts/deploy.ts` passes an absolute `FORMAT_BLUEPRINTS_DIR` to the `@gadgets/workshop-backend` build. It also refuses a directory that has no archives, or an archive without a sidecar. `formats/` holds the Board plus copies of upstream's Docs, Sheets and Slides, because the directory replaces upstream's set. Covered by `scripts/deploy.test.ts` and documented in [Bundled formats](../customization.md#bundled-formats).

**When the submodule is upgraded**, re-copy upstream's three format pairs into `formats/` if their `revision` changed. Otherwise the deployment keeps shipping the old Docs, Sheets and Slides.

### Reusing the kanban build

Rather than a snippet, [`packages/blueprint-kanban`](../../packages/blueprint-kanban/README.md) is the tested starting point for the next gadgets. Copy it and replace the board-specific parts. The reusable parts:

| Part | What it gives the next gadget |
| --- | --- |
| `src/core/hub.js` | Subscribers, presence and sessions, with backpressure and dead-subscriber detection. Transport-agnostic. **Take the whiteboard's version** (`packages/blueprint-whiteboard/src/core/hub.js`): it disposes stubs, coalesces presence, caps presence bytes and rate, and evicts idle subscribers |
| `src/core/repository.js` | The storage seam |
| `src/shared/order.js` | Fractional ordering keys |
| `src/client/sync/store.js` | Optimistic queue, serial send, idempotent replay, heartbeat restart detection and frame reload; the conflict rules are board-specific. The whiteboard's version adds gated presence, unguessable request ids, a slow-server tolerant `onUnrecoverable`, and peers reconciled on resubscribe |
| `packages/blueprint-whiteboard/src/shared/protocol.js` `storedBytes`, `cleanPresence` | A V8-safe size measure, and a presence sanitiser that merges partial updates onto full state |
| `packages/blueprint-whiteboard/test/client/net.js` + `fuzz.test.js` | A real-core network simulator with latency, reordering and epoch-fenced restarts, and a seeded convergence fuzz |
| `harness/` | Multi-pane simulator mirroring the platform's prefix, sandbox, CSP and stale stubs |
| `scripts/` | esbuild bundling, deterministic `.gadget` packing, the revision lock |
| `e2e/` | Local platform start and stop scripts for WSL (the whiteboard's copy detects an Access-mode frontend build and rebuilds it), plus Playwright helpers for sign-up, upload, share and export, and platform-log scanning for runtime warnings |

If upstream's `libraries/sync` arrives through step 7, compare the two and adopt upstream's only where it removes code without changing the wire protocol.

## Sequencing

1. ~~Kanban board: draft, two-browser test, harden, publish, promote.~~ Done 2026-09-16. It was built in the repo, not drafted, and took one day with parallel agents. Production two-browser checks and the agent-chat test are still Harry's to run.
2. ~~Starter change for the formats directory, and ship the board as a bundled format.~~ Done 2026-09-16 (`format.board` revision 2).
3. Phase 0 viewer identity, if wanted. One day. Re-test the board with real names.
4. ~~Whiteboard.~~ Done 2026-09-16: built in one day with parallel agents (spikes, contract, four build streams, three reviews, three fix streams, local platform e2e) and deployed as `format.whiteboard` revision 4. The same deploy shipped Board revision 5 (stub disposal, request-id and conflict-rebase fixes). Production two-browser checks and the agent-chat tests for both are Harry's to run.
5. **Next: Wave.** Read the "Start here" notes at the top of [wave-blueprint.md](wave-blueprint.md) first, and start from a copy of `packages/blueprint-whiteboard`.
   Budget one to two days. Yjs is a normal esbuild import, so the first spike is binary RPC (`Uint8Array` round-trips) and the RPC rate for text updates.
6. Upstream sync and rebase onto `libraries/sync` when it arrives.

## Success criteria

- Three blueprints promoted as formats in `/admin`, each instantiable from **New** in under ten seconds.
- Two colleagues editing the same instance see each other's changes within a second and each other's cursor or selection.
- A killed tab disappears from presence within fifteen seconds.
- No edit is lost when two people change the same item; the loser sees a conflict and the authoritative value.
- The AI agent can read and modify each tool's content from chat through the documented RPC surface.
- A server-side restart (code edit, revocation) recovers without the user reloading the page. Revised after the kanban build: the platform leaves a `use`-role iframe's connection dead after a code edit, so the gadget reloads its own frame, keeping the viewer's name, and recovers in about 5 s.
