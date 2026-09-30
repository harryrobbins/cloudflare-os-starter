# Mobile Chat and app installation

Researched 1 October 2026 against starter `9a0605a` and pinned Cloudflare OS `0bef2869`.

## Recommendation

Install the existing authenticated Chat application at
`https://cfos.surprisingly.ltd/gatekeeper/chat/`. Keep the Router, Access, Gatekeeper,
Durable Object, R2 and Workshop agent bridge. This is an app-specific launch surface
already supported by the architecture; no separate domain, account system or chat backend
is needed. It can become useful daily messaging for a small team. It is not yet a
qualified Slack replacement, chiefly because closed-app delivery is absent.

## What a share link actually opens

The source distinguishes three things often called an app:

| Surface | Current mechanism | Mobile consequence |
| --- | --- | --- |
| Workspace containing gadgets | `ShareModal.tsx` calls `createShareLink` and builds `/workspace/<id>#share=<key>` | Opens the workspace and shares workspace authority; it does not mint a standalone gadget URL |
| Fullscreen gadget in workspace | `GadgetEditor.tsx` uses `#fullscreen` | Removes editor chrome, but remains a workspace route. It cannot simultaneously encode `#share=` this way |
| Gatekeeper application | Chat serves `/gatekeeper/chat/`; shell `/chat` and ChatDock embed it | Direct URL opens the real Chat SPA without the desktop Workshop shell |

Inspection: `cloudflare-os/packages/workshop-frontend/src/ShareModal.tsx`,
`GadgetEditor.tsx`, `useWorkspaceOpen.ts`, and `packages/gatekeeper-chat/src/serve.ts`.
`GadgetUI.tsx` renders the gadget as sandboxed `srcDoc`, not a persistent standalone
HTTP app URL. A bookmark can open a workspace, but a home-screen shortcut does not change the shared
capability or turn an arbitrary sandbox iframe into an independently installed app.
Future generic gadget installation should have an explicit presentation route using
existing capability checks, rather than treating share secrets as manifest identifiers.
Do not put a share key into an installation manifest or issue wider workspace authority
just to make something installable.

## Installation mechanics

A manifest supplies a stable app identity, name, launch URL, scope, standalone display
and icons. A URL alone can be bookmarked; browser installation UI and requirements vary.
Use the Chat path as `id`, `scope` and `start_url`, rather than `/`, so opening the icon
lands in messaging and installation does not claim the entire OS. Routes for channels,
threads and message links stay within that scope. Chrome supports an optional
`beforeinstallprompt`; Safari uses its own Add to Home Screen UI.
Sources: [web.dev installation](https://web.dev/learn/pwa/installation),
[manifest guide](https://web.dev/learn/pwa/web-app-manifest),
[MDN installability](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable).

Safari 26 changes a common older assumption: sites added to the iPhone/iPad home screen
open as web apps by default, with an Open as Web App toggle. A manifest still controls
identity and presentation, and explicit standalone metadata supports older devices.
Source: [WebKit Safari 26](https://webkit.org/blog/16993/news-from-wwdc25-web-technology-coming-this-fall-in-safari-26-beta/).

The app stays behind Access. Manifest fetches use credentials; the service worker script
is authenticated too. A home-screen app may need its own sign-in/session renewal; do not
assume Safari and standalone cookie behavior is identical on all supported devices.
Session expiry and out-of-scope identity-provider redirects must be tested on physical
phones. Installing does not grant membership or bypass Access.
Source: [Cloudflare authorization cookies](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/).

## Mobile behavior that matters

A phone needs one pane at a time, visible ways to reach conversations, touch-accessible
reply/reaction/edit actions, preserved drafts, and readable composer text. Browser bars,
notches and the keyboard change usable height. Dynamic viewport units help, but the
visual viewport can shrink independently when a keyboard appears. Adapt to that viewport
at normal scale, preserving pinch zoom, and keep iframe sizing under the host's control.
Source: [MDN VisualViewport](https://developer.mozilla.org/en-US/docs/Web/API/VisualViewport).

The current app already has narrow/compact layouts, routed thread/permalink views,
unread/mention state, optimistic sends, error/retry actions, upload progress,
local drafts and server catch-up on a fresh socket hello. Reuse these. Mobile suspension
can leave a socket apparently OPEN but unusable: replace it after a longer hidden period
or network recovery, then let the existing catch-up reconcile history. Never blindly
replay message writes just because connectivity returns.

## Installation is not background delivery

Current notifications are page notifications while a tab is alive. A sleeping or closed
phone app cannot depend on that WebSocket. iOS/iPadOS has supported Web Push for installed
home-screen web apps since 16.4, with permission requested from user interaction.
Badging is a separate supported enhancement. Modern WebKit also offers Declarative Web
Push, but this is not a cross-browser replacement for a properly designed delivery
service. Sources: [WebKit Web Push](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/),
[badging](https://webkit.org/blog/14112/badging-for-home-screen-web-apps/),
[Declarative Web Push](https://webkit.org/blog/16535/meet-declarative-web-push/).

A production push system needs per-user/device subscriptions, VAPID credentials,
revocation, membership checks at delivery, mute/thread/mention preferences, an outbox,
retry limits, expired-subscription cleanup, rate limits and deep-link handling.
Default payloads should reveal little on a locked screen. Access protects the app's
HTTP requests; a push provider endpoint is a distinct delivery boundary. These require
reviewed storage and secrets. The present mobile release makes no closed-app
notification claim and introduces no push subscription store.

The service worker in this release supplies only an offline navigation explanation.
It does not cache application HTML, messages, API responses, attachments or Access
redirects. Offline cold launch has no message history. Existing browser-local drafts
are retained by the existing app, but a cross-account local-draft audit is needed before
adding any broader offline storage. An offline outbox would need stable send IDs,
explicit pending/sent/failed states and account-bound reconciliation; it is not implied
by PWA installation.

## Could this replace Slack?

| Requirement | Present position | Qualification before replacement |
| --- | --- | --- |
| Channels, DMs, threads, mentions, reactions, search, uploads | Implemented in Chat | Team trial, volume and permission tests |
| Mobile reading/writing and home-screen launch | Improved by this release | Physical iOS/Android keyboard, installation and renewal checks |
| Closed-app notifications | Absent | Authenticated device subscription and durable push delivery |
| Network loss and suspension | Draft/retry/catch-up, improved resume | Repeated poor-network and no-duplicate trials |
| Governance and operational confidence | Access, private Workers, observation/action boundaries | Backup/restore drills, retention/export, deletion and audit expectations |
| Large-team scalability | One named SQLite ChatWorkspace DO, R2 files, search integration | Measure message rates, reconnect fanout, history paging and search at target load |
| Integrations and agent use | Workshop agent bridge and Gatekeeper capabilities | Decide which team workflows need integrations; keep writes approved |
| Voice/video, external collaboration, rich Slack ecosystem | No demonstrated parity | Explicit product decision or separate integrations |

Slack supplies mobile notification preferences, mentions/DM badges, schedules and mobile
notification timing; matching a chat layout alone does not replace these expectations.
Sources: [Slack notification guide](https://slack.com/help/articles/360025446073-Guide-to-Slack-notifications),
[notification configuration](https://slack.com/help/articles/201355156-Configure-your-Slack-notifications).

Recommended sequence: ship the mobile surface now; run a small team trial alongside
Slack; add reliable push and operational qualification as separately reviewed work;
only then decide to retire Slack. Keep chat within Cloudflare OS patterns. A native
wrapper would not by itself solve notification delivery, permissions or reliability.
