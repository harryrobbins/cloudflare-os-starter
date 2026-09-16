# Master plan: three real-time collaborative blueprints

Written 2026-09-16. Goal: give the team Miro-, Trello- and Wave-style tools inside our Cloudflare OS deployment, each as a blueprint that anyone can stamp out and then share with colleagues for live, same-state collaboration.

Background research is in [`../research/`](../research/README.md). Read [gadget-collaboration-runtime.md](../research/gadget-collaboration-runtime.md) once before starting any of these; the rest of this page assumes it.

## The three blueprints

| Plan | Product analogue | Hard part | Est. server size |
| --- | --- | --- | --- |
| [Kanban board](kanban-blueprint.md) | Trello, Jira board | Nothing new; the Sheets pattern applied to cards and columns | ~400 lines |
| [Whiteboard](whiteboard-blueprint.md) | Miro | High-frequency ephemeral state (drags, cursors) kept off storage; many small versioned objects | ~600 lines |
| [Wave](wave-blueprint.md) | Google Wave | Character-level co-editing inside many threaded messages, which needs a CRDT inlined into the gadget | ~500 lines plus an inlined Yjs build |

Build them in that order. Each plan reuses the previous one's server skeleton and presence code, and the kanban board is the one that proves the deployment, sharing and promotion pipeline end to end at the lowest cost.

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
| Facet restarts on code deploy, chat-branch switch and revocation drop every subscription | Clients go stale silently | Every plan implements `[Symbol.dispose]` re-subscribe plus a heartbeat, which the bundled gadgets skip. |
| No CRDT library, no `typed-storage`, no npm at runtime; `client.js` is served as one file and cannot import siblings | Text co-editing needs a library inlined: a module file for the server, concatenated into `client.js` for the browser | Only Wave needs this; see its plan for the Yjs build step. |
| Sharing is workspace-wide, not per gadget | A workspace with a board and a whiteboard shares both or neither | Keep one tool per workspace for now. Upstream `plans/multi-gadget.md` defers per-gadget sharing. |
| Open RPC channel keeps the DO billable (upstream issue #338) | A tab left open all day costs DO wall-clock time | Acceptable at team scale. Revisit if the deployment grows. |
| Alarms availability in gadget code is undocumented | No server-side timers for e.g. Wave digests | Treat as unavailable. Use `gatekeeper-scheduler` if a schedule is ever needed. |
| Output is one shared state, no history | No undo across users, no audit | Each plan keeps a bounded server-side `history` list of applied operations for undo and a basic activity feed. |

## Common build and ship path

Each plan follows the same seven steps. The plan pages only describe what differs.

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

Once stable, export the `.gadget` from `/blueprint/<id>` and check it into this repo so a fresh deployment gets it on first request. Upstream's mechanism is the `FORMAT_BLUEPRINTS_DIR` variable read by `workshop-backend`'s build, and the submodule's `format-blueprints/README.md` says a fork should point it at its own directory rather than editing the submodule. This needs one small starter change, tracked below.

### 7. Sync upstream

Upstream `main` has moved the bundled gadgets to `packages/bundled-blueprints/` with a shared `libraries/sync` (mutation queue, versioned apply, presence roster) and TypeScript sources. When the weekly upstream-sync workflow next lands that, rebase the three gadgets onto that library instead of the hand-copied skeleton.

## Cross-cutting work items

### Phase 0, optional but recommended: viewer identity

A kernel change in our fork (`surprisingly-os`, branch `starter-openrouter`). `GadgetClient.connectToGadget` in `overseer.ts` already runs inside a session that knows the caller's profile and role. Pass a `{id, displayName, role}` object into the facet on connect (for example as `ctx.props`, or as a second argument the platform injects into `subscribe`), and expose it to `client.js` as a `gadgetViewer` global next to `gadget`. This mirrors the shape proposed in upstream Discussion #455, so if upstream lands it our change becomes a no-op rebase.

Cost: a day. Benefit: every plan drops its name prompt, presence shows real names, kanban assignees and Wave authors become real identities, and `use`-role viewers can be made read-only inside the gadget. Without it the three tools work but attribution is on the honour system.

If you do this, keep the diff in `workshop-backend` and `workshop-shared` small and separate, per upstream's AGENTS.md rule for kernel changes.

### Starter change: own formats directory

Add `formatBlueprintsDir` to `deployment.jsonc` (default `null`). In `scripts/deploy.ts`, when set, pass `FORMAT_BLUEPRINTS_DIR=<absolute path>` in the env of the `@gadgets/workshop-backend` build command. The build already runs with `--no-cache`, which restores the full environment, so no `env:` declaration on the task is needed. Add a `formats/` directory at the repo root holding `<name>.gadget` plus `<name>.json` pairs, starting with copies of the three upstream ones so nothing disappears. Cover it in `scripts/deploy.test.ts` and document it in `docs/customization.md`.

### Shared presence and sync module

After the kanban board is done, lift its `subscribe`/`broadcast`/presence code into a snippet kept at `docs/plans/snippets/` (or, better, wait for upstream's `libraries/sync` to arrive via step 7) so the whiteboard and Wave plans start from tested code rather than an agent draft.

## Sequencing

1. Kanban board: draft, two-browser test, harden, publish, promote. One to two days.
2. Starter change for the formats directory, and ship the board as a bundled format. Half a day.
3. Phase 0 viewer identity, if wanted. One day. Re-test the board with real names.
4. Whiteboard. Two to three days, most of it in the client.
5. Wave. Two to three days, the first of which is getting a Yjs build that loads under the gadget module rules.
6. Upstream sync and rebase onto `libraries/sync` when it arrives.

## Success criteria

- Three blueprints promoted as formats in `/admin`, each instantiable from **New** in under ten seconds.
- Two colleagues editing the same instance see each other's changes within a second and each other's cursor or selection.
- A killed tab disappears from presence within fifteen seconds.
- No edit is lost when two people change the same item; the loser sees a conflict and the authoritative value.
- The AI agent can read and modify each tool's content from chat through the documented RPC surface.
- A server-side restart (code edit, revocation) recovers without a page reload.
