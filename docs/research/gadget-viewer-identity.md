# Viewer identity for gadgets: platform binding or connector?

Written 2026-09-17 against the pinned submodule at `cloudflare-os` commit `a1909a38` (branch `starter-openrouter` of the private `surprisingly-os` fork), which adds `gadgetViewer`. Line references are to that commit unless stated.

## Headline

The Board and Whiteboard now attribute every change to the signed-in account. They learn who that is from `gadgetViewer`, a module-scope binding the platform injects into every gadget iframe beside `gadget`. It carries `{id, displayName, role}`.

The obvious alternative is a connector (a Gatekeeper) named something like "Your profile", which a format would request and the user would approve. It was considered and rejected for the "who is looking at this right now" question:

- **A connector answers a different question.** A Gatekeeper binding is created from one person's connected account and attached once to a gadget. Every viewer then shares it. It can say whose account was connected, not who is viewing.
- **The gadget's server cannot tell callers apart.** All viewers talk to one shared server facet, and the platform does not say which user made a call. A connector sits behind that facet, so it cannot recover the caller either.
- **A consent prompt protects nothing here.** Upstream already shows every collaborator the same three fields in the workspace's presence roster.

A connector does fit richer profile data and a directory of the workspace's people. Section 5 sketches that as a complement, not a replacement.

## 1. The problem

Before this change, both formats opened a name dialog on every load ("Who's here?", with "Continue as guest"). The name was whatever the person typed, and every change, comment and cursor carried it. The iframe has no storage (it has an opaque origin), so the prompt came back after every reload. The master plan listed this as a known gap ([collaborative-blueprints.md](../plans/collaborative-blueprints.md#what-the-platform-does-not-give-us)), tracked upstream as Discussion #455.

The requirement: nobody is asked for a name, and every change is attributed to the user's account name.

## 2. Why no change inside a gadget could do it

A gadget has two halves, and neither knows the viewer.

**The client** runs in a sandboxed iframe built by `workshop-frontend/src/GadgetUI.tsx`:

- Its Content Security Policy is `default-src 'none'` with `connect-src 'none'`, so it cannot make network requests.
- It has an opaque origin, so no cookies, `localStorage` or IndexedDB.
- The platform prepends a prefix to `client.js` that declares only `gadget` (a Cap'n Web stub over a `MessageChannel` to the parent) and `RpcTarget`.
- The parent frame knows the user, but nothing about them crosses into the iframe.

**The server** is a Durable Object facet of the workspace's Overseer. `GadgetClient.connectToGadget()` in `workshop-backend/src/overseer.ts` returns `this.impl.getGadgetFacet(this.id, chatId)`:

- There is one facet per gadget, and the same stub serves every connected user.
- It receives no per-call caller identity.
- It sees only the arguments the client chooses to send.

The platform does know the user, in two places:

- **The authenticated session.** `GadgetClientImpl` and `UseGadgetClientInterface` are constructed per session with `clientUserId`, and `#clientUser.whoami()` returns the profile.
- **The Workshop frontend,** which holds that session and builds the iframe.

So the fix had to be in the platform: nothing a gadget can run has the information.

## 3. What was built

### 3.1 Platform (fork commit `a1909a38`)

| File | Change |
| --- | --- |
| `packages/workshop-shared/src/api.ts` | New `GadgetViewer = {id, displayName, role}` type and `GadgetClient.getViewer()` |
| `packages/workshop-backend/src/overseer.ts` | `getViewer()` on `GadgetClientImpl` (role `"build"`, covering the owner) and on `UseGadgetClientInterface` (role `"use"`), both from `#clientUser.whoami()` |
| `packages/workshop-frontend/src/GadgetUI.tsx` | Fetches the viewer in parallel with `getUiBundle()`. `createSandboxedHtml()` inserts `const gadgetViewer = Object.freeze(<json>);` after the platform prefix. A failed lookup logs a warning and injects `null`; the UI still loads. |
| `packages/workshop-frontend/src/GadgetUI.integration.test.tsx` | Tests for the injected value and for the failure path |
| `docs/sharing.md` | `use` collaborators may call `getViewer()` |

`UseGadgetClientInterface` is declared `implements GadgetClient` so that any new method fails to compile until someone decides whether `use` callers get it (default-deny). Here the decision is yes: a `use` viewer is exactly who needs attribution.

The shape `{id, displayName, role}` is the one proposed in upstream Discussion #455. If upstream ships an equivalent, the fork patch should become a rebase or a deletion.

### 3.2 Formats (starter commit `54bd240`)

- `src/client/main.js` in `packages/blueprint-kanban` and `packages/blueprint-whiteboard` reads `gadgetViewer` behind a `typeof` guard, like `gadget`.
  - The name is `displayName`, then `id`, then a name carried in `window.name` across a self-reload, then `"Guest"` (an older platform).
  - The name is set before the store is created, so no operation is ever sent without it.
- The name dialog is gone. The avatar button opens a colour-only dialog; the name is shown, not editable.
- The harnesses inject a per-pane `gadgetViewer` (`?names=Alice,Bob`), so harness tests run the same code path as the platform.
- The harness and local-platform e2e suites assert three things: no name prompt appears, the header shows the account name, and `createdBy`, history `by` and comment authors carry it.

### 3.3 Why the fork, not the starter

The starter's rule ([customization.md](../customization.md)) is to prefer wrapper-owned Workers and service bindings, and to patch upstream only when a Worker boundary cannot express the behaviour. This one cannot: the iframe prefix, the per-session `GadgetClient`, and the facet connection all live inside `workshop-frontend` and `workshop-backend`. The fork already carries one such patch (the OpenRouter provider). This patch is kept small and separate so it rebases cleanly on upstream upgrades.

## 4. Why not a connector

### 4.1 How connectors work

Connectors are Gatekeepers (`packages/workshop-shared/src/gatekeeper.ts`, and the `write-gatekeeper` skill in the submodule). There are three tiers:

- **Vendor** (`GatekeeperVendor`): one per service.
- **User** (`GatekeeperUser`): one person's authenticated connection. `getGatekeeperClassFor(url)` returns a Durable Object class "imbued (via `ctx.props`) with the user's credentials and the resource ID" (`gatekeeper.ts:596`).
- **Instance** (`Gatekeeper<Session>`): "a specific resource binding on a specific Gadget" (`gatekeeper.ts:701`), running as a facet of the Overseer. `startSession(approvalQueue)` returns the `Session` handed to the gadget. Every observation and action goes through the approval queue.

The gadget's server code reaches a binding as `env.<Name>`. Bindings live on the gadget record (`record.bindings[name]` in `overseer.ts`), are created by the person who connects the resource, and are shared by every caller of that gadget.

The platform already acknowledges that connector data belongs to the connecting user. Observer verification (`getVerifier()`, `addObserver()`, `removeObserver()`) exists because a collaborator can "observe" data the gadget read through someone else's credentials. The gatekeeper then has to check that the collaborator could see it themselves.

### 4.2 The mismatch, concretely

Suppose a "Your profile" gatekeeper existed. Alice creates a Board and approves the connector. Bob opens it through a share link and moves a card.

1. Bob's iframe calls `gadget.applyOperation(...)`. The call reaches the one shared facet, with no indication that it came from Bob.
2. The facet calls `env.Profile.whoami()`. The binding was created from Alice's connection and imbued with Alice's `ctx.props`.
3. It returns Alice. The move is attributed to Alice.

To make a connector answer "who is calling", one of these would have to change:

- **Per-viewer sessions.** Each viewer's iframe or facet connection opens its own session with the viewer's credentials. That means reworking how bindings are instantiated (per session, not per gadget) and how the approval queue attributes actions. It is a larger platform change than `gadgetViewer`, and it still has to start from the same authenticated session `getViewer()` reads.
- **Caller identity on facet calls.** The platform passes the caller's identity with every call into the facet. The facet could then tell a connector who is asking, but at that point the facet already knows. The connector adds nothing to the attribution question.

Either way, the essential work is the platform knowing the viewer per session and passing that on, which is what `gadgetViewer` does.

### 4.3 Consent

An "Access to your profile" prompt makes sense when a gadget would learn something new. For these three fields it would not:

- **Collaborators already see them.** `Overseer.subscribeToPresence()` (`api.ts:1619`) delivers `PresenceParticipant = {key, user: AiChatAuthorInfo, role}` (`api.ts:3519`). `AiChatAuthorInfo` is `{type, id, name}`. `use` collaborators may subscribe (`docs/sharing.md`, "presence ... exposes active viewers' names, profile IDs, and roles"). `gadgetViewer` is the same `id`, `name` and `role`, about the viewer only.
- **The client cannot leak them.** With `connect-src 'none'` and no forms, the iframe cannot send data anywhere except its own gadget's server.
- **The server already receives names.** Before this change it got a typed name as an RPC argument; now it gets the account name the same way. Reaching an external service from the server still requires a connector binding, which has its own consent.

A prompt on every collaborative format would add friction without protecting anything. `id` is an email address under Cloudflare Access, but the roster already shows it to every collaborator.

## 5. Where a connector would fit

A consent-gated profile or directory connector does make sense for data the roster does not show, or for people other than the viewer:

- **Richer profile fields:** avatar, email for display, organisation, team, time zone. Avatars are deliberately left out of `AiChatAuthorInfo` and fetched separately (`api.ts:2177-2179`).
- **A people directory:** a kanban assignee picker listing real workspace members instead of free text, or @mentions in Wave. Upstream is building a deployment-wide user directory on branch `mpeterson/user-directory` (commits `06b2264a` and `b273b226`). It adds `AuthenticatedApi.searchUsers(query, excludeIds)` returning `UserDirectoryRecord = {id, name}`, with an admin toggle. It is aimed at the share modal, not gadgets, but it is the natural backend for such a connector.
- **Third-party identity:** a profile from Google or GitHub, which is what existing connectors already do.

The resource is "this workspace's people" (or "my Google profile"), not "the current viewer". That matches how bindings are scoped. A format would declare the binding in its blueprint annotations, so the user approves it when the format is created.

Recommended split:

| Need | Mechanism | Consent |
| --- | --- | --- |
| Who is viewing, for attribution and presence | `gadgetViewer` (platform, ambient) | None; the same as the presence roster |
| Other people, richer profile fields | Directory or profile Gatekeeper, bound per gadget | Yes, at binding time |
| Server-trusted caller identity, for permissions | Platform passes the caller identity into the facet per call | None; the platform enforces it |

## 6. What is still not solved

`gadgetViewer` is supplied to the iframe by the Workshop frontend. The gadget's server still receives the name as an ordinary RPC argument. That ends the prompt and attributes honest clients correctly. But a user who modifies their own browser can send any name, as they could before.

Anything that grants or denies permission needs the server-side half, and neither `gadgetViewer` nor a connector provides it. Examples:

- making `use` viewers read-only inside a gadget;
- recording a Wave decision as approved by a specific person.

The platform would have to give the facet the caller's identity per call. Options, all kernel changes:

- a per-session wrapper around the facet stub that appends a platform-signed caller argument;
- `ctx.props` on a per-session facet entrypoint;
- the approach upstream picks for Discussion #455.

## 7. Maintenance

- **On submodule upgrades:** rebase `starter-openrouter` including this patch. Without it both formats fall back to `"Guest"`. The operator skill (`.agents/skills/cloudflare-os-operator/SKILL.md`, "Pinned Submodule Upgrade") says to check that a format shows the account name with no dialog.
- **If upstream lands viewer identity:** drop the patch and switch the formats' `accountName()` to the upstream binding. Only `main.js` and the harness `pane.html` read `gadgetViewer`.
- **New formats** (Wave next) use `gadgetViewer` from the start. See [Viewer identity and change attribution](../plans/collaborative-blueprints.md#viewer-identity-and-change-attribution).
