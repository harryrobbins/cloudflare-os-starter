# Cloudflare OS collaboration: what the public sources say

Web research done 2026-09-16 against `github.com/cloudflare/cloudflare-os` `main`, Cloudflare's blog and docs, and the GitHub issue tracker. Sources inline. Where nothing was found, it says so.

## 1. Official definitions and how sharing is described

**Gadgets.** The upstream README (https://raw.githubusercontent.com/cloudflare/cloudflare-os/main/README.md): "every user runs their own copy of the productivity apps they use". When you create a slide deck "the system creates a *private instance* of the slide deck software *just for you*", called a gadget. "The basic user experience of Cloudflare OS is something like an online office suite, like Google Docs or MS Office. But, imagine that instead of a fixed set of file types … each file -- or 'Gadget' -- is potentially its own custom application, written by AI to serve exactly your needs." Kenton Varda's launch thread: "A 'Gadget' is the same thing as a Sandstorm 'Grain': a fine-grained app instance." (https://x.com/KentonVarda/status/2084990137180590572)

**Blueprints.** `docs/blueprints.md`: "Blueprints let a user share a gadget's source code so that others can create their own gadget instances from it. … A blueprint captures the code but not the chat history, SQLite storage, or credentials." Blog (https://blog.cloudflare.com/cloudflare-os/, 5 Aug 2026): "Sharing a blueprint of your app lets other people create their own copy of your app. … Each new app starts with independent state and resources."

**Sharing a gadget with collaborators.** `docs/sharing.md`: two mechanisms, collaborators ("granting other users direct access to a gadget, so they can work on it alongside the owner") and blueprints. Roles `build` and `use`. Added by username or share link. "Collaborators share the gadget's code, storage, and AI chat history."

**Official statement on real-time collaboration.** Yes, though short:

- README: "You can share your Gadget just like you'd share a document in a typical online office suite. … you'll be able to see your collaborators' actions in real time. … This works because every Gadget is backed by a Durable Object, Cloudflare's stateful serverless primitive which makes real-time multiplayer collaboration easy."
- Blog: "Sharing your app itself lets other people collaborate in real time using the same state."
- Press release (https://www.cloudflare.com/press/press-releases/2026/cloudflare-os-is-the-first-ai-workspace-built-around-how-companies-actually-work/): "Any output can become a working app with its own isolated database, real-time capabilities, and access controls."
- Kenton Varda, same thread: "all Gadgets are inherently real-time collaborative (Durable Objects and Cap'n Web make it so easy)".
- Presence is an OS-level feature of the Workshop header (`subscribeToPresence()`; PR #131 "Fix presence bubble layout", https://github.com/cloudflare/cloudflare-os/pull/131).

**Not stated officially:** any promise of Google-Docs-style character-level co-editing, live cursors, or CRDT/OT merging as a platform feature. The claim is that the DO gives "the same state" and changes are seen "in real time"; how conflicting edits merge is left to each gadget.

## 2. Multiplayer gadget examples

- **Official bundled blueprints**, installed automatically: `workspace-docs`, `workspace-sheets`, `workspace-slides`. On upstream `main` these now live at https://github.com/cloudflare/cloudflare-os/tree/main/packages/bundled-blueprints/blueprints and are built on a shared `sync` library "for collaborative gadgets" (https://github.com/cloudflare/cloudflare-os/tree/main/packages/bundled-blueprints/libraries/sync) with a `PresenceRoster`/`PresenceReporter` that "keep and report who is where, on the shared heartbeat" (`libraries/sync/client.ts`) and a server side with `MutationQueue` ("commits mutations in call order") and `applyVersioned` ("per-item optimistic-concurrency rule: an edit based on a stale version is rejected with the authoritative item") (`libraries/sync/server.ts`). Confirmed on HN by kentonv: "there are three blueprints installed automatically (docs, slides, sheets)" (https://news.ycombinator.com/item?id=49182996).
- **Our pin predates this.** The pinned submodule still carries the three as opaque `.gadget` archives under `packages/workshop-backend/format-blueprints/`, with no shared library. See the master plan for what to do about that.
- **Official suggested prompt.** README "What to try" includes "Make a collaborative whiteboard app." Kenton Varda's thread references an earlier whiteboard demo (reported as https://x.com/KentonVarda/status/2029678769372299508; the mirror returned "Thread Not Found", unverified). Phillip Jones' companion thread: https://x.com/akaphill/status/2084992807912268258.
- **Community examples.** None found with a link, blueprint URL or repo, across the web, the HN launch thread (72 comments), GitHub Discussions, Reddit and YouTube. The closest is Discussion #455 below, where a user reports building a collaborative gadget and hitting the viewer-identity gap.

## 3. Upstream docs on the sandbox and state

- README and blog: "The server runs in a Dynamic Worker which has had its access to the internet disabled." "The client code runs in a sandboxed iframe. This iframe can communicate with its server only via a Cap'n Web RPC session provided over postMessage()." Blog: "The server is loaded on demand as a Dynamic Worker and instantiated as a Durable Object Facet … The facet gives the app its own SQLite database, separate from the Cloudflare OS runtime managing it."
- `packages/bundled-blueprints/README.md` (upstream main): a gadget is `client.ts` + `server.ts` + `lib/**`; "Server code runs as a Durable Object with Workers globals"; "`cloudflare:workers` is the only import left for the runtime to resolve, and only on the server".
- The upstream Docs gadget server: `import { DurableObject, WorkerEntrypoint } from "cloudflare:workers"; export class Gadget extends DurableObject<GadgetEnv, unknown> implements GadgetStub`, using `this.ctx.storage.get/put` and broadcasting via `this.subscribers.broadcast((subscriber) => subscriber.operation(event))` to RPC callback stubs the browsers registered via `subscribe`.
- Facets docs confirm each facet gets "its own isolated SQLite database" and `globalOutbound: null` blocks network (https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/). **Not found:** any official statement on whether gadget facets can use alarms or accept WebSockets/hibernation (also absent from https://blog.cloudflare.com/durable-object-facets-dynamic-workers/).
- State: per-gadget SQLite in the DO facet (blog); blueprints exclude "SQLite storage" (blueprints.md); collaborators share "storage" (sharing.md).

## 4. Known limitations and roadmap

- **No viewer identity inside gadgets.** Discussion #455 "Expose the authenticated viewer identity to collaborative Gadgets" (6 Sep 2026, https://github.com/cloudflare/cloudflare-os/discussions/455): the OS knows the collaborator and role but gadget code does not, so users "must manually enter display names". Proposes `type GadgetViewer = { id: string; displayName: string; role: "build" | "use"; }`. No maintainer reply as of fetch. The bundled gadgets confirm it: RPCs take a caller-supplied `{clientId, name, color}` with no validation.
- **Long-lived RPC keeps DOs billable.** Issue #338 (https://github.com/cloudflare/cloudflare-os/issues/338, 25 Aug 2026): "Cloudflare bills the object for wall-clock duration while an RPC remains active, so an otherwise idle workspace can accrue continuous Durable Object duration"; proposes hibernatable WebSockets or short-lived RPCs. No maintainer reply.
- **`docs/sharing.md` future work:** more roles (chat-only, read-only), resharing of `use`, binding-aware access control, share-link expiry and usage limits, un-revoking links, GC of dead records, in-product notifications.
- **`docs/sharing.md` known limitations:** authorization is only checked at `open()`; revocation works by aborting the Overseer DO, which "forcibly disconnects every client".
- **`docs/observers.md`** deferred gaps: "Concurrent opens by one collaborator can overwrite observer records", agent turns outliving their lease.
- **`plans/multi-gadget.md`:** sharing stays workspace-scoped in v1; per-gadget sharing is future work.
- Issue #326: deleting a private Context collection "permanently locks collaborators out of every workspace that observed it" (https://github.com/cloudflare/cloudflare-os/issues/326).
- Not found: any issue or discussion requesting CRDTs, live cursors, or Yjs inside gadgets.

## 5. Cloudflare's general 2026 guidance for realtime on Workers

Baseline: a Durable Object per room or document with the WebSocket Hibernation API, "recommended" (https://developers.cloudflare.com/durable-objects/best-practices/websockets/; example https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/), SQLite-backed storage GA. Higher level: PartyServer (Cloudflare-maintained successor to PartyKit) wraps DOs with WebSocket lifecycle hooks and broadcast, and y-partyserver hosts Yjs CRDT backends with `onLoad`/`onSave` persistence (https://github.com/cloudflare/partykit). The Agents SDK adds `setState()` where "Changes are broadcast to all connected WebSocket clients instantly", recommended for small shared UI state with SQL for larger data (https://developers.cloudflare.com/agents/api-reference/store-and-sync-state/). Cloudflare Realtime (RealtimeKit, SFU, TURN) targets audio, video and media, not document co-editing (https://developers.cloudflare.com/realtime/). Community Yjs-on-DO providers exist (e.g. https://github.com/napolab/y-durableobjects).

**Cloudflare OS itself uses none of these inside gadgets.** Gadgets use Cap'n Web RPC callbacks over the facet. Issue #338 is a request to move the workspace channel onto hibernatable WebSockets.

## Not found

- Any official promise of CRDT/OT merging, live cursors, or character-level co-editing for gadgets.
- Any official list of runtime APIs (alarms, WebSockets, `ctx.storage.sql`) available to gadget facets.
- Any community-published multiplayer gadget with a link or blueprint URL.
- Any maintainer response on Discussion #455 or Issue #338.
