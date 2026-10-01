# Mobile Chat delivery plan

Research: [Mobile Chat and PWA](../research/mobile-chat-and-pwa.md).

## Goal and boundary

Make the existing Chat SPA an excellent connected mobile client at `/gatekeeper/chat/`,
installable independently of the Workshop editor. Preserve Access identity, Router path,
ChatWorkspace and R2 ownership, the embedded dock contract, routes, optimistic writes,
drafts and existing catch-up. No new native client or generic gadget sharing mechanism.

## Implementation checklist

- [x] Research share links versus standalone Gatekeeper URLs and current browser behavior.
- [x] Add a reusable repository skill for mobile app work.
- [x] Add a scoped manifest, 192/512 icons, Apple icon and standalone metadata.
- [x] Explain browser installation in Settings, with a browser-prompt enhancement.
- [x] Provide a navigation-only offline fallback without caching authenticated content.
- [x] Track the top-level visual viewport at normal scale; retain pinch zoom and iframe sizing.
- [x] Apply safe areas, keyboard-aware navigation and scrollable dialogs.
- [x] Add thumb navigation for Inbox, Conversations, Mentions and Search; retain other rail views.
- [x] Reuse focus trapping and Escape/backdrop dismissal for the mobile conversation drawer.
- [x] Increase coarse-pointer targets, show message actions without hover, prevent iOS input zoom.
- [x] Phone Enter inserts a newline; explicit Send sends; composition never sends prematurely.
- [x] Replace stale sockets on network return or resume after suspension; ignore old socket events.
- [x] Verify targeted unit/type tests and mobile browser flows, plus desktop/compact regressions.
- [x] Merge to main including the previously present repository changes requested for deployment.
- [x] Run canonical release validation, serial production deploy, and record live evidence.

## Acceptance evidence

At 320, 390 and 430px portrait, plus phone landscape: no page-level horizontal overflow;
conversation/thread navigation and Back work; dialogs remain dismissible and scrollable;
reply/reaction/edit/send and file removal work without hover; composer is reachable with
keyboard visible and multiline drafts survive navigation/reload. Test IME input as well.
At desktop width and `?embed=1&compact=1`, preserve the existing layout and host bridge.
Verify manifest/PNG/script content types through the real Worker, scoped service-worker
registration, offline fallback, reconnection and negative unauthenticated access.
Record browser emulation separately from real-device evidence.

Physical-device gate: iPhone Safari + installed app, Android Chrome + installed app;
actual software keyboard, notch/landscape, install prompt/menu, identity-provider round
trip, session expiry, background/foreground and Wi-Fi/cellular transitions. Automated
emulation cannot prove these. This gate controls a claim of full mobile qualification,
not delivery of the tested improvements.

## Later qualification, outside this implementation

Closed-app push needs a separately reviewed server delivery design, credentials and
subscription storage. Account-bound offline history/outbox, cross-device unread consistency
under load, backup/restore, export/retention, integration coverage and scalability trials
remain explicit Slack-replacement gates. Do not report these as delivered by installation.

## Validation record

Chat Worker tests: 281 passing; frontend tests: 281 passing, including socket replacement,
network recovery and draft flushing before the debounce. Production build and both
TypeScript projects pass. The first browser run exposed an immediate-reload draft race;
flushing on pagehide/hidden fixed it. The first Worker test run began before its asset
build completed and failed three shell checks; running after the build passed all 280.

Chromium mobile integration covers narrow portrait/landscape, multiline send, IME
composition, thread route/Back, immediate-reload drafts, touch target sizing, visible
actions, drawer dismissal, Settings, manifest and icon MIME types, offline navigation,
desktop and compact presentation. Keyboard viewport signals are simulated, not physical.
WebKit launch was attempted but this host lacks libevent/libavif/libmanette/libwoff;
set `CHAT_WEBKIT=1` to run it on a provisioned machine. Physical-device qualification
remains open. The new skill passes the skill-creator YAML/name validator; its trigger
matches mobile app work and excludes general desktop/infrastructure work. This release
is its output smoke test; no broader skill benchmark is claimed.

The browser regression also found cached conversation navigation returning a 404 when
the asset binding returned 304 for the HTML fallback. Fallback fetches now omit cache
validators; the new Worker regression and the complete Chromium integration pass.

The first full production release stopped before uploads: Whiteboard's 50-viewer and
adversarial lexer tests exceeded Vitest's default 5s runner timeout. The isolated lexer
finished in 6.3s, within its existing 15s assertion. The full suite exposed CPU contention
in another serialization test. Whiteboard now caps test workers at four and gives the
two large simulations 20s runner headroom; traffic/work/time assertions are unchanged.
All 672 Node and 21 workerd Whiteboard tests pass with these settings. Production release
validation must pass again before uploading.


## Production completion

All 15 configured Workers were deployed from isolated source `30fe643` and each final
live version was verified at 100%. TLS and unauthenticated Access redirects passed.
[Release evidence and rollback versions](../deployments/2026-10-01-mobile-chat.md) records
the test-runner correction, interrupted/shared-checkout attempts, Go worktree build fix,
concurrently merged Whiteboard/Docs changes, final IDs and remaining live-device gates.
The implementation checklist is complete; physical and signed-in production qualification
and the separate Slack-replacement work above are not claimed complete.
