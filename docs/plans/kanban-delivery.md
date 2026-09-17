# Delivery plan: Kanban board, from empty repo to cfos.surprisingly.ltd

## Delivery record (2026-09-16)

`format.board` revision 2 was deployed to cfos.surprisingly.ltd on 2026-09-16 via the durable path (Phase 6). The upload fast path (Phase 5) was skipped because production testing needs a second Access identity. Commits: `6f8407e`, `f0d1e67`, `b58527e`.

What differs from the plan below, and why:

- **Storage layout.** Cards are stored one key each (`card:<id>`), and so are comments. There is no `cards:<columnId>` key. A full column would exceed the per-value limit.
- **Size caps.**
  - The caps are lower than the kanban plan's: 2,000 cards, a 10,000-character description, 50 checklist items, 200 comments per card.
  - There is also an 8 MiB budget for the whole board. A review showed one collaborator could otherwise make the board too large to load.
- **`onRpcBroken`** is not implemented by the Workers runtime. Dead subscribers are dropped when a delivery to them fails, and clients also expire stale peers after 12 s.
- **Protocol additions:**
  - Session tokens on `subscribe` and presence, so no one can take over another person's subscription.
  - A `requestId` on writes, so a request replayed after a restart is never applied twice.
  - A heartbeat that returns `{known, revision}`, so clients notice a server restart.
- **Found only on the real platform (local run):**
  - `gadget` and `RpcTarget` are module-level variables, not globals.
  - The iframe sandbox blocks form submission.
  - After a code edit, a `use`-role iframe's connection fails for good, so the board reloads its own frame and keeps the viewer's name in `window.name`.

  The harness now mirrors all three.
- **Parallelism.** It came from background agents rather than a Workflow:
  - four spikes and three build streams sharing one checkout, with no overlapping files;
  - three read-only reviewers;
  - fix agents;
  - two rounds of local platform e2e.

- **Harness.** It is a static Node server (`harness/serve.mjs`), not a Vite dev server, so nothing watches files. It has "Restart server", "Restart + dispose" and "Restart (stale stub)" controls. It has no forced-conflict control; conflicts are tested with latency races.
- **Worktrees, verifiers, extra reviews.** None were used. Instead, file ownership was kept disjoint, the orchestrator ran integration tests itself, and the local platform suite acted as the verifier. `/code-review` and `/security-review` were not run on top of the three reviewers.
- **Files not in the planned layout.** `gadget.lock.json` records the content hash each revision was packed from. `e2e/start-local-platform.sh` and `stop-local-platform.sh` run a local Cloudflare OS on WSL.

The phases below are the plan as written before the build. They are kept for reference; read them together with the list above.

Test status at deploy:

| Suite | Tests passing |
| --- | --- |
| Node unit | 166 |
| workerd | 15 |
| Harness e2e | 19 |
| Local platform e2e | 11 |
| Deploy scripts | 31 |

**Later the same day:** the whiteboard build found three bugs in the board. Its hub never disposed subscriber stubs, which caused the production "RPC stub was not disposed properly" warning. Its request ids were guessable. Its conflict retries could rebase on a stale card. Revisions 3 to 5 fix them, and revision 5 was deployed with the whiteboard. See [whiteboard-blueprint.md](whiteboard-blueprint.md).

**Still to do, by Harry:**

1. Add a second identity to the Access policy.
2. Run kanban test 7 (the agent edits the board from chat) and the two-browser checks on production.
3. Optionally publish a blueprint with a screenshot for `/admin` featuring.

Written 2026-09-16. This is the *how and in what order* for [kanban-blueprint.md](kanban-blueprint.md), which remains the source for scope, data model, RPC surface and the test list. Where this page disagrees with the [master plan](collaborative-blueprints.md)'s seven-step path, this page wins for the kanban board, for the reasons in "Decisions" below.

Storage for v1 is the gadget's own Durable Object facet storage (`ctx.storage`), which the platform calls private gadget storage. Other backends (Jira, Grist, Git, a standalone DB) are designed for but not built; see [Future backends](#future-backends).

## Decisions

### 1. Author in this repo, not in the Workshop editor

The master plan's step 1 has the Workshop agent draft the gadget in the browser. We invert that: the source of truth is a package in this repo, built by Claude Code agents, tested locally, packed into a `.gadget` archive and uploaded. Verified in the pinned submodule:

- Home → Blueprints has an **Upload .gadget** picker that calls `AuthenticatedApi.importBlueprint` (`workshop-frontend/src/components/BlueprintList.tsx:187-205`, `workshop-backend/src/server.ts:394-425`). The upload gets a new blueprint id, and `/blueprint/<id>` instantiates it.
- The archive format is small and already decoded by our `docs/research/bundled-blueprints/extract-gadget.mjs`: a 24-byte header, metadata JSON, then a gzip of a Yjs V2 update whose unnamed root map holds `filename -> Y.Text`. Upstream's `workshop-backend/scripts/import-format-blueprint.mjs:31-75` has a Node `serializeArchive` we can copy.
- `FORMAT_BLUEPRINTS_DIR` is honoured by `workshop-backend/scripts/build-format-blueprints.mjs:22`, so shipping as a bundled format needs no submodule change.

Why: parallel agents, real unit tests, code review and git history all need the code on disk. The Workshop agent is still used, as a comparison track (Stream E) and for the "agent edits the board from chat" test.

Consequence: edits made in the Workshop code editor are throwaway unless pulled back with `extract-gadget.mjs`. Say so in the gadget README.

### 2. Plain JavaScript with JSDoc, bundled to one readable `server.js` and one `client.js`

- `client.js` must be a single file: only it is sent to the iframe, and the CSP forbids imports (`overseer.ts:2549`, `GadgetUI.tsx:108`).
- `server.js` *could* import `lib/*.js`, but slash-named modules are untested (`overseer.ts:2394-2398` only filters on `.js`). Bundling removes that risk.
- Bundle with esbuild: ESM, **not minified**, section banners kept. The in-Workshop agent reads `server.js` and `README.md` to learn the RPC surface (`agent.ts:2285-2296`), so the output must stay legible.
- JS plus `// @ts-check` JSDoc rather than TypeScript, so that what we write and what lands in the Workshop editor stay close.

### 3. A storage-agnostic core

All board rules (validation, caps, version checks, move semantics, history and inverses) live in `src/core/`, which takes a small repository interface and knows nothing about Durable Objects. `src/server/` is only a thin adapter: the `Gadget` class, subscriber registry, broadcast, presence, `ExportHandler`, and a `DoStorageRepository`.

This pays for itself three ways:

- the core unit-tests in plain Node in milliseconds;
- the local harness (below) runs the *real* core in the browser, so multi-user behaviour can be tested without the platform;
- it is the seam for future backends.

### 4. A browser harness before the platform

`harness/` is a Vite page that loads the built `client.js` into two or three side-by-side iframes. Each iframe gets a `gadget` global backed by an in-page fake server that uses the real `src/core` with an in-memory repository. The harness has controls to:

- add latency;
- drop every subscription, to simulate a facet restart and exercise re-subscribe;
- reject the next write with a conflict.

Most two-browser tests from the kanban plan run here under Playwright in seconds. The platform is only needed for what is platform-specific: RPC stub lifetimes, sharing, roles, the agent, export.

### 5. Ship twice: upload first, bundle second

1. **Fast path (no deploy):** upload `board.gadget` to production, test, publish as blueprint, promote in `/admin` → Formats. This proves the board on the real instance within a day of the code being ready.
2. **Durable path (deploy):** `formats/board.gadget` plus `formats/board.json` (`blueprintId: "format.board"`), wired through a new `formatBlueprintsDir` key in `deployment.jsonc`, then `pnpm deploy`. Remove the fast-path format from `/admin` afterwards so **New** does not show two boards.

## Target layout

```
packages/blueprint-kanban/
  package.json            name @starter/blueprint-kanban; scripts: build, test, pack, harness
  README.md               becomes the gadget's README.md: user guide + "Programmatic use" RPC docs
  src/
    shared/protocol.js    op/event/presence shapes, limits, id regexes, sanitisers  (the contract)
    shared/order.js       fractional ordering keys
    core/                 board rules; depends only on shared/ and the Repository interface
    server/               Gadget DO, DoStorageRepository, subscribers, presence, ExportHandler
    client/model/         in-memory board state, optimistic apply, reducers
    client/sync/          subscribe/resubscribe, op queue + replay, conflict handling, presence heartbeat
    client/ui/            renderers, pointer drag and drop, card panel, filters, mobile, export view
    client/main.js        wiring; top-level await gadget.subscribe(...)
  test/
    core/                 node --test or vitest (plain)
    server/               vitest-pool-workers, compat 2026-02-01, allow_irrevocable_stub_storage
    client/               model and sync against a fake gadget
  harness/                Vite multi-iframe harness + fake gadget over real core
  e2e/                    Playwright: harness specs, local-platform specs
  scripts/
    build.mjs             esbuild -> dist/server.js, dist/client.js, copies README.md
    pack-gadget.mjs       dist/ -> ../../formats/board.gadget (deterministic: fixed Y clientID, dates from board.json)
formats/
  board.gadget, board.json
  workspace-docs|sheets|slides.gadget + .json    copied from the submodule (the dir REPLACES defaults)
```

`packages/*` is already in `pnpm-workspace.yaml`, so the package's `test` script joins the root `pnpm test`, and therefore `pnpm check` before every deploy.

## Phases

The gate at the end of each phase must pass before the next phase starts. Times are wall-clock with agents doing the work, and assume Harry is available for the manual steps.

### Phase 0: Prerequisites and spikes (half a day)

**Harry, manual, start immediately because it has lead time:**

- [ ] Add a **second identity** to the Access application's policy for `cfos.surprisingly.ltd`, such as a second Google account or a colleague. Every "B" step in the two-browser tests needs one, and today only `harryrobbins@gmail.com` is allowed. Keep it out of `access.admins`.
- [ ] Confirm the second identity can sign in, and that `/admin` refuses it.

**Four spike agents in parallel.** Each is time-boxed to about an hour and each returns a yes/no plus evidence. They de-risk every later phase.

| Spike | Question | Done when |
| --- | --- | --- |
| S1 pack round-trip | Does a hand-packed `.gadget` (hello-world `Gadget` with one RPC and a `client.js` that shows its result) upload and instantiate? | `pack-gadget.mjs` v0 exists; decoding its output with `extract-gadget.mjs` reproduces the input files byte for byte. Upload itself is verified in S2 locally and by Harry in prod. |
| S2 local platform | Does `pnpm run-local` in the submodule execute gadgets on this WSL box (Worker Loader and facets under workerd), with password auth? | Hello-world gadget from S1 uploaded via UI at `localhost:8787`, instantiated, RPC result rendered. Process group killed afterwards. |
| S3 DO test rig | Can vitest-pool-workers host a `Gadget` DO with the loader's compat settings, and can a test pass an `RpcTarget` callback to `subscribe`, `.dup()` it, receive broadcasts, and observe `onRpcBroken` when disposed? | One passing test for each of the three behaviours, or a written note of which can't be simulated. |
| S4 export | Does an `ExportHandler extends WorkerEntrypoint` with `mode: "server"` CSV and browser-mode `html`/`pdf` entries show all three in the export menu? | Verified on the S2 local instance. |

Gate: S1–S3 green. If S2 fails (no local gadget execution), P3's platform testing moves to production with a throwaway workspace, which is slower but not blocking. If S3 can't simulate `onRpcBroken`, that behaviour is covered only by the harness and platform tests.

### Phase 1: The contract (2–3 hours, one agent, sequential)

This is the only thing that has to be serial. Everything parallel later depends on it being precise.

Deliverables:

- `src/shared/protocol.js`:
  - JSDoc typedefs for `Card`, `Column`, `Label`, `Comment`, `HistoryEntry`, `BoardSnapshot`, `CardOp`, `ColumnOp`, `LabelOp`, `OperationRequest`, `OperationResult`, `BroadcastEvent`, `PresenceEvent`;
  - `LIMITS` (the caps from the hardening checklist);
  - id regexes and prefixes;
  - pure `sanitize*` functions.

  All of these are taken from kanban-blueprint.md.
- `src/shared/order.js` with tests: key between two keys, key before first, key after last, and many sequential inserts without unbounded growth.
- `src/core/repository.js`: the Repository interface (`loadMeta`, `loadColumn(colId)`, `loadLabels`, `loadComments(cardId)`, `appendComment`, `loadHistory`, `commit(writes)` where `commit` is atomic) plus an `InMemoryRepository` used by tests and the harness.
- The client-internal interface between sync and UI: `store.getState()`, `store.subscribe(listener)`, `store.dispatch(action)`, `store.presence`, and the action list. This lets Streams B and C build against each other without waiting.
- `README.md` "Programmatic use" section, written from the contract, with an `executeCode` example: `await env.Board.applyOperation({...})`.
- Package scaffold: `package.json`, esbuild build producing empty-but-valid bundles, test runners wired so `pnpm --filter @starter/blueprint-kanban test` passes with placeholder tests.
- `storage schemaVersion: 1` in `meta`, and a `migrate(meta)` hook in core, so future code changes can upgrade existing boards' data.

Gate: Harry reviews `protocol.js` and the README RPC section (30 minutes). Changes to the contract after this point go through the orchestrator (the main session), never through a stream agent.

### Phase 2: Parallel build (half a day to a day)

Five streams, four of them agents in separate git worktrees. File ownership is disjoint, so merges are mechanical.

| Stream | Owns | Builds | Tests it must ship |
| --- | --- | --- | --- |
| **A. Core + server** | `src/core/**`, `src/server/**`, `test/core`, `test/server` | `applyOperation` (upsert/delete/move across columns in one commit, per-card and per-column versions, LWW column order), comments, history with inverses and undo of recent entries, caps and sanitisation, `getBoard`, `subscribe`/`broadcast`/`updatePresence`/`leavePresence` with `dup()` and `onRpcBroken`, `enqueueMutation`, `DoStorageRepository` (keys exactly as in the kanban plan), `ExportHandler` CSV (+ html/pdf browser formats) | Core: every op type, every conflict path, every cap, move atomicity, id validation, unknown-key stripping. Server (pool-workers): storage layout, two subscribers receive diffs, sender echo contains `senderId`, broken stub dropped, presence join/leave, CSV output |
| **B. Client model + sync** | `src/client/model/**`, `src/client/sync/**`, `test/client` | Snapshot apply, optimistic local apply, remote op merge with echo suppression, pending-op queue, conflict handling (auto-rebase and retry once for moves and checklist ticks; surface a `conflict` state with the authoritative card for content edits), `Callbacks extends RpcTarget` with `[Symbol.dispose]` → resubscribe → apply fresh snapshot → replay unsent ops, heartbeat 4 s / stale 12 s, name/colour identity behind a `getViewer()` function (so Phase 0 viewer identity drops in later) | Against a scripted fake gadget: concurrent remote + local edits converge, conflict banner state, resubscribe replays exactly the unacked ops once, stale presence expiry with fake timers |
| **C. Client UI + harness** | `src/client/ui/**`, `src/client/main.js`, `harness/**`, `e2e/harness` | Board and column rendering (per-column re-render), pointer-event DnD for cards and columns with ghost and presence broadcast, card side panel (debounced 400 ms saves, conflict banner, comments, checklist), header with avatars, label/assignee filter and title search, name prompt dialog, mobile one-column tab strip, `gadgetExportFormatId` static export view, activity panel with undo. Harness with latency, drop-subscriptions and force-conflict controls | Playwright on the harness, two iframes: kanban plan tests 1–4 and 6 (as "drop subscriptions"), drag within/between columns, column reorder, filter/search, 400 px viewport. Starts against a thin contract-shaped fake; switches to the real core at integration |
| **D. Tooling + starter change** | `scripts/build.mjs`, `scripts/pack-gadget.mjs`, `formats/**`, root `scripts/deploy.ts`, `scripts/deployment-config.ts`, `scripts/deploy.test.ts`, `deployment.jsonc`, `docs/customization.md` | Finish the packer from S1 (deterministic output; reads `formats/board.json` for metadata, `blueprintId: "format.board"`, `output: {id: "board", noun: "Board", plural: "Boards", icon: "kanban"}`, `revision`). A drift test failing when `formats/board.gadget` ≠ fresh pack of `dist/`, telling you to run `pnpm --filter @starter/blueprint-kanban pack` (which bumps `revision`). `formatBlueprintsDir` key (null default), validation, passing an absolute `FORMAT_BLUEPRINTS_DIR` into the `@gadgets/workshop-backend` build env (`deploy.ts:700`), and the existing single-env assertion at `deploy.test.ts:706-711` updated. Copy the three upstream format pairs into `formats/` | `node --test scripts/**/*.test.ts` covering null key, set key, bad path; pack determinism; archive decodes with `extract-gadget.mjs` |
| **E. Workshop-agent comparison** (Harry, optional) | nothing in the repo | Paste the kanban plan's agent brief into a new gadget on production, exactly as the master plan's step 1 describes. Takes 30–60 minutes of Harry's time in parallel with A–D | Note what the platform's own vibe-coding produced vs. the repo build: correctness, re-subscribe, caps, UX. This is the "test how this works" data point, and it may surface UX ideas worth pulling into Stream C |

How to run A–D: the orchestrating session launches the four as a Workflow, one agent per stream in its own worktree (`isolation: "worktree"`), each given the phase 1 contract, its row above, its file-ownership list, and the rule "if the contract is wrong or missing something, stop and report, do not edit `src/shared/**`". Each stream's agent is followed by a verifier agent that runs that stream's tests from a clean checkout and checks the diff against the file-ownership list and the contract. That is eight agents, inside the default workflow size. Rough cost: a medium-sized session's worth of tokens per stream; wall-clock is set by the slowest stream (C).

When not to fan out: if Phase 1's contract review raises more than a couple of open questions, run A alone first, then B and C in parallel against the real core. Parallel streams against a shaky contract cost more in rework than they save.

WSL heat rules for all streams:

- Streams run tests, not watchers.
- Only Stream C runs a Vite dev server, scoped to `packages/blueprint-kanban/harness` and started with `setsid`; its process group is killed when the agent finishes.
- Before starting any server, check that `ps -ef | grep -E 'vite|wrangler|workerd'` shows no other one.

Gate:

- All four branches merged into `feat/kanban-board` by the orchestrator.
- `pnpm test` green at the root.
- Harness Playwright suite green against the **real core** (the fake is deleted).
- `dist/server.js` and `dist/client.js` are readable, with nothing minified.

### Phase 3: Local platform integration (half a day)

One agent, or the orchestrator directly, sequential. Uses S2's local instance.

1. `pnpm --filter @starter/blueprint-kanban build pack`, then upload `formats/board.gadget` at `localhost:8787`.
2. Create two password accounts (A and B). A instantiates the board and shares a `use`-role link, which B opens.
3. Playwright with two browser contexts (see the `playwright-wsl` skill) runs kanban plan tests 1–6 for real. Test 6 is "edit `server.js` in the code editor"; it proves `[Symbol.dispose]` re-subscribe survives a real facet restart, which nothing earlier can prove.
4. Export CSV and HTML (test 8).
5. Test 7 (agent chat) depends on the local AI setup. If `run-local` has no working model, defer it to Phase 5.
6. Kill the local instance's process group.

Gate: Tests 1–6 and 8 pass locally. Any bug found goes back into the owning stream's files with a regression test in core, sync or harness, whichever layer it belongs to. It is not patched in the Workshop editor.

### Phase 4: Hardening review (2–3 hours)

Three reviewers run in parallel on the `feat/kanban-board` diff, each followed by a verifier that tries to reproduce each finding and discards any it can't. That is six agents.

| Reviewer | Looks for |
| --- | --- |
| Server safety | Every field sanitised and capped, id regexes enforced, unknown keys stripped, a hostile client (a peer's browser runs untrusted code) cannot corrupt storage, exceed 128 KiB per value, grow `history` or comments unbounded, or wedge the mutation queue with a throwing op |
| Sync correctness | Lost-update paths, double-apply on echo, replay-after-resubscribe duplicating ops, presence leaks, broadcast to broken stubs, move atomicity, ordering-key collisions under concurrent inserts |
| UI and accessibility | Uses the `web-design-guidelines` skill: keyboard access to cards and the panel, focus management, contrast, 400 px layout, drag affordances, no `alert`/`confirm` (blocked in the iframe) |

Then `/code-review high` on the whole branch, and `/security-review`. Fix, re-run `pnpm test` and the harness suite, repack.

Gate: no confirmed findings open. Harry reads the final `README.md` because it is what the in-Workshop agent will read.

### Phase 5: Production, fast path (1–2 hours, mostly Harry)

No deploy is needed. The router at `cfos.surprisingly.ltd` is already live.

1. Upload `formats/board.gadget` from Home → Blueprints, then open `/blueprint/<id>` and create a board.
2. Run the full kanban plan test list 1–8 with Harry in one browser profile and the second Access identity from Phase 0 in another. This time test 7 uses the real agent via the OpenRouter models on `cfos-gateway`: *"add three cards to Backlog for onboarding tasks"*. If the Qwen or DeepSeek flash models struggle with `executeCode` against `env.<Board>`, note which model worked; that feeds the agent hint in step 4.
3. In the gadget header, open **Blueprint**, set the title, description and screenshot, and publish.
4. In `/admin` → Formats, promote the published blueprint. Set noun/plural/icon (`Board`/`Boards`/`kanban`) and an agent hint such as *"For task boards, prefer Board and edit it through `applyOperation` as documented in its README."*
5. Check **New** in the composer shows Board, and instantiation takes under 10 seconds.

Gate: The master plan's success criteria hold for the board: sub-second sync, a killed tab gone from presence in 15 s, no lost edits, the agent can edit the board, and restart recovery works without a reload.

### Phase 6: Production, durable bundled format (1–2 hours)

1. Merge `feat/kanban-board` to `main`, which includes Stream D's starter change. Set `"formatBlueprintsDir": "formats"` in `deployment.jsonc`.
2. `eval "$(fnm env)" && fnm use v24.21.0`, then `pnpm check`. This runs the test suite and dry-run deploys, and also runs the pack drift test.
3. `pnpm deploy`.
4. Verify:
   - the first `/api` request installs `format.board`, and Docs/Sheets/Slides are still present, which proves the copied defaults work;
   - **New** shows Board;
   - one board created from `format.board` passes kanban tests 1 and 6 as a smoke test.
5. In `/admin` → Formats, remove the Phase 5 uploaded format so only the bundled one remains. Boards already created from it keep working, because instantiation copies the code.
6. Record `format.board` and the `revision` convention in memory. **`blueprintId` must never change** (upstream `AGENTS.md:17`).

Gate: A fresh deployment gets Board with no manual steps.

### After v1

- **Upgrading existing boards.** A new `revision` changes what *new* boards get. Existing boards keep the code they were created with. Upgrade one by pasting the new `dist/` files into its code editor, or ask its chat agent to do it. The `schemaVersion`/`migrate` hook from Phase 1 is what makes that safe for data.
- **Viewer identity** (master plan Phase 0). Done for attribution: the platform injects `gadgetViewer` and the name prompt is gone. `use`-role read-only still needs the server-side half.
- **Upstream `libraries/sync`.** When the submodule moves past the pin, compare our `src/server` and `src/client/sync` with it. Adopt it only if it removes code without changing the wire protocol.
- **Lift the harness and sync layers** into a shared package for the whiteboard, per the master plan's "shared presence and sync module".

## Agent orchestration summary

| Phase | Shape | Agents | Why this shape |
| --- | --- | --- | --- |
| 0 | Fan-out, independent spikes | 4 (+ Harry: Access identity) | Four unknowns, none depends on another |
| 1 | Single agent, human review | 1 | The contract is the thing parallelism depends on; one author keeps it coherent |
| 2 | Workflow: 4 builders in worktrees → 4 verifiers; Harry on Stream E | 8 | Disjoint file ownership against a fixed contract; verifiers catch "tests pass on my branch only" |
| 3 | Sequential | 1 | One local instance, stateful browser sessions; parallel runs would fight over it |
| 4 | Workflow: 3 reviewers → verifiers, then `/code-review`, `/security-review` | 6 + skills | Different lenses find different bugs; verification discards false positives before anyone fixes them |
| 5–6 | Mostly Harry, orchestrator assists | 0–1 | Production actions, Access-gated browser sessions, `/admin` clicks; confirm each deploy |

Workflows require an explicit go-ahead: when starting Phase 2 or 4, say "use a workflow" and the orchestrator will run it; otherwise it falls back to individual background agents with the same briefs.

Expected elapsed time: **2.5–3.5 days** from Phase 0 to Phase 6. The serial spine is spikes, contract review, integration and production testing; Phase 2 is where the parallelism saves roughly a day and a half against building A–D in sequence.

## Future backends

Gadget servers have **no outbound network** (`globalOutbound: null`, `overseer.ts:2416`). A Jira, Grist, Git or database-backed board therefore cannot call those services from `server.js`. The route is a **Gatekeeper binding**:

- existing ones such as `gatekeeper-github` or `gatekeeper-linear`;
- or our own in `packages/custom-gatekeeper`, for Grist or a DB.

The blueprint declares the binding, and each instantiation connects it.

What v1 does to keep that open, without building it:

- Board rules live in `src/core` behind the Repository interface. An external-backend variant adds, for example, `GatekeeperRepository`, and does not touch the rules, the protocol or the client.
- Versions stay opaque to the client (`baseVersion` is compared for equality, never incremented client-side), so a backend can map them to Jira `updated` timestamps, Grist row versions or Git blob SHAs.

The part that is genuinely new work later, and why it is not a v1 concern: an external store can change without the board knowing. The DO would become a cache plus sync loop (poll via the scheduler, or webhooks through a Gatekeeper), and conflicts arrive after the fact rather than at write time. That is its own plan.

## Risks

| Risk | Likelihood | Mitigation |
| --- | --- | --- |
| Local `run-local` can't execute gadgets on WSL (S2) | Medium | Phase 3 moves to a throwaway workspace on production; the harness still covers most sync behaviour |
| vitest-pool-workers can't simulate RPC stub lifetimes (S3) | Medium | Cover `dup`/`onRpcBroken` in harness and Phase 3 test 6 instead |
| Upload path rejects slash-named or large files | Low | Bundling to two flat files sidesteps it; archive limits are 32 MiB content |
| Cheap OpenRouter flash models fumble `executeCode` in test 7 | Medium | Crisp README examples; try both models; record which works in the admin agent hint |
| `FORMAT_BLUEPRINTS_DIR` replaces the default formats and one is forgotten | Low | Stream D copies all three; Phase 6 verifies all four appear |
| Weekly upstream-sync PR conflicts with `deploy.ts` changes | Low | Keep the Stream D diff small and isolated; mention it in the PR |
| Code edited in the Workshop editor drifts from the repo | Medium | README says the repo is the source of truth; pull edits back with `extract-gadget.mjs` |

## Harry's checklist

Status after the 2026-09-16 delivery. Phases 1, 4 and 6 ran without Harry's review gates; Harry asked for delivery and deployment end to end.

- [ ] Phase 0: second Access identity added and verified. **Still needed** for the production two-browser tests.
- [ ] Phase 1: contract and README RPC section reviewed. Optional now; the contract is in `packages/blueprint-kanban/src/shared/protocol.js` and `src/README.md`.
- [ ] Phase 2: optional Stream E, a Workshop-agent draft on production, notes taken.
- [ ] Phase 4: final README read (`packages/blueprint-kanban/src/README.md`).
- [ ] Phase 5: two-browser production test and agent-chat test 7. Blueprint publishing and promotion are no longer needed, because the format is bundled.
- [x] Phase 6: `pnpm deploy` run 2026-09-16. `format.board` is installed from the bundle, so there is no uploaded duplicate to remove.
