---
name: mobile-apps
description: Improve an existing Cloudflare OS app for phone and tablet use, including standalone launch, PWA installation, software keyboards, touch actions, safe areas and suspension recovery. Use for mobile app implementation or qualification; generic desktop design and unrelated infrastructure work are outside this skill.
---

# Mobile applications in Cloudflare OS

Deliver a usable mobile surface through the app's existing authority and host patterns.
A small local workflow is reusable across messaging, boards and other daily-use apps.

| Request | Workflow |
| --- | --- |
| Make an app usable on mobile | Inspect host and app, improve interaction, verify narrow and embedded modes |
| Install one app on a phone | Establish its standalone route; add scoped metadata and installation guidance |
| Qualify a mobile release | Test real workflows in emulation and list remaining physical-device gates |

## Inspect before editing

Distinguish workspace share links, fullscreen workspace gadgets and Gatekeeper app URLs.
In this checkout Chat has `/gatekeeper/chat/`; workspace shares are
`/workspace/<id>#share=<key>`. Installing a URL does not change its permissions.
Read the app's entry, routes, host bridge, asset forwarding, CSP and authentication path.
Preserve Access, viewer attribution, capability bindings and approved-action patterns.

## Implementation decisions

- Prefer the existing responsive route tree, one pane at a time on phones. Keep thread,
  message and conversation deep links meaningful and Back predictable.
- Make core navigation reachable by thumb. Use real focus-trapped dialogs with a visible
  dismiss control; all important message/file actions must work without hover.
- Target 44px touch controls on coarse pointers; don't enlarge every desktop/dock control.
  Use readable input text (16px avoids common iOS focus zoom), keeping user zoom enabled.
- Use dynamic/visual viewport height for the keyboard, browser bars and orientation.
  Respect safe areas and pinch zoom. Top-level viewport handling must not fight host iframes.
  Avoid body scrolling plus nested competing scroll regions.
- Phone Enter should normally insert a newline with an explicit Send action. Preserve
  hardware keyboard shortcuts and IME composition; never send composition-confirming Enter.
- Preserve drafts on navigation/reload; show pending, failed and retry states honestly.
  Resume through existing catch-up. Ignore events from replaced sockets, remove lifecycle
  listeners on shutdown, and never blindly replay writes after reconnect.
- A PWA manifest needs stable app-scoped identity/start URL/scope, standalone display,
  suitable icons and authenticated same-origin fetches where required. Explain Safari's
  home-screen menu and Android browser installation; feature-detect browser prompts.
- Installation, offline storage and closed-app push are separate capabilities. Never claim
  page WebSocket notifications survive suspension. Caching private data or adding device
  subscriptions requires explicit account isolation, revocation and delivery decisions.

Local reversible app work follows the user's task authorization. Infrastructure, storage
migrations, secrets or policy changes follow the operator workflow and its boundaries.
Do not widen sharing/access to solve installation. Consult current primary browser docs
for behaviors that vary by release.

## Verification and reporting

Exercise 320/390/430px portrait, landscape, desktop and compact embedded layouts.
Test send/newline/IME, reaction/thread/edit, file upload/remove, dialogs, deep links,
Back, draft reload, network loss and background/foreground recovery. Check overflow,
actual hit areas and composer visibility, not just screenshots. Verify manifest/assets
through the real Worker and preserve negative authentication checks.

Keep real-device iOS/Android installation, software keyboard, session expiry and network
transition tests distinct from emulation. Report what passed and what remains unverified.
For a messaging example see `docs/research/mobile-chat-and-pwa.md` and
`docs/plans/mobile-chat.md` from the repository root.

Smoke prompt: “Make this Cloudflare OS board acceptable on a phone without breaking its
workspace embed.” It should inspect both surfaces, improve touch/keyboard behavior and
verify them; it should not introduce a new authentication system or promise offline sync.
