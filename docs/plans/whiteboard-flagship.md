# Whiteboard flagship workplan

Date: 2026-09-25

## Direction

Make common work obvious and expert work fast while keeping the existing authoritative operation model, bounded renderer, deterministic exports and sandbox. This iteration improves the packaged application; publishing it and upgrading existing board instances are separate operations.

The earlier [improvement plan](whiteboard-improvements.md) and [research](../research/whiteboard-improvement-options.md) remain the architectural baseline. The new [flagship review](../research/whiteboard-flagship-review.md) records competitive research, priorities and enterprise dependencies. Existing highlighted code blocks, templates, presentation, recovery, backups, routing and virtualisation should be surfaced and extended rather than replaced.

## Implementation sequence

1. **Direct connections.** Show distinct connection controls on selected shapes, with drag creation and a click/keyboard searchable destination picker. Keep resize targets separate, pin the chosen source side, and preserve one-operation undo. Test rotated shapes, zoom, cancellation and deletion races.
2. **Useful paste.** Recognise plain HTTP(S) URLs, including YouTube links, and create readable, editable cards using existing objects. Provide an explicit open action and an honest explanation when playback is unavailable. Preserve safe schemes, escaping, clipboard fallback, undo and portable exports. No metadata proxy, automatic external requests, iframe permissions or new storage schema.
3. **Accessible board navigation.** Add object-type filtering and additive selection to the virtual Objects panel so users can build a selection without dragging or remembering modifiers. Preserve focused rows, selection order and a bounded DOM; announce results and selection changes. Filtering is local and generates no writes.
4. **Discovery and documentation.** Add searchable help and a session-only single-character shortcut preference. Preserve modifier shortcuts and editor/navigation keys. Surface existing code-block and rich-paste workflows. Record completed work, evidence and deliberately deferred enterprise requirements.
5. **Verification and packaging.** Run targeted regressions, complete whiteboard unit/workerd suites, browser harness and performance budgets. Rebuild the deterministic archive with the same blueprint ID and update revision documentation. Record limitations rather than implying enterprise certification or zero runtime cost.

## Cost and performance constraints

- No new service, dependency, periodic refresh, AI call or remote database on editing paths.
- Selection controls add bounded DOM for the current selection only; reuse connector routing and existing operation validation.
- Link cards are ordinary data-only objects, with no preview fetches and no new asset retention liability.
- Search and selection reuse the virtual list; only render its visible window. Avoid full-board scans during pointer motion.
- Reuse the existing linear-work syntax highlighter; no heavyweight editor or executable pasted content.
- Measure bundle/archive growth and preserve 500/2,000/5,000-object proxy budgets. Extra client code has a nonzero transfer/parse cost; quantify it instead of promising literally no overhead.

## Future work, not implied by this delivery

Host-authenticated role/session enforcement and verified audit actors precede view-only sharing and compliance claims. Permission-filtered record cards require a connector contract, explicit refresh policy and stale/permission-revoked states. Comments, workshop voting/timers, image assets, enterprise retention, organisation search and upgrades of existing board code need their own scoped acceptance criteria. These candidates belong in the ranked review, not in an unbounded promise to implement every idea in one release.

## Delivery record

The implemented slice covers direct connection creation, inert website/YouTube cards, object-type filtering and additive selection, plus searchable help and a session-only character-shortcut preference. Highlighted code already existed and is now described alongside rich paste in Help. The archive is packaged as revision 8; stored schema 1 and `format.whiteboard` remain unchanged.

Research is linked from the package README. The candidate backlog is deliberately larger than the implementation slice: verified roles, compliance audit, permission-aware live records and retention are not delivered by these UI changes. No claim of complete Miro/Mural parity or accessibility certification is made.

### Performance evidence

The Node benchmark ran on 2026-09-25 using the existing deterministic fixtures. At 5,000 objects, the 100% viewport rendered 96 object groups and 734 SVG elements; a remote single-object update caused one object render. The connector fixture (2,000 shapes, 1,000 elbow connectors) reported zero route-budget fallbacks, with 7.22 routes recomputed per move on average. These are algorithmic/proxy measurements, not a production concurrency or browser frame-rate guarantee. The existing test budgets were not raised.

Connection controls add four ephemeral handles for one selected object. Filtering, help and preference changes create no board mutations. URL cards use the same single create operation and storage representation as rectangles; there are no preview requests, remote thumbnails, AI calls, new dependencies, background polling or storage migrations. Additional UI code still adds a small bundle cost, reported below after packaging.

### Final verification

- `pnpm --filter blueprint-whiteboard test:run`: **672 unit tests and 18 workerd server tests passed**. Includes existing performance budgets and new URL, connection, object-panel and shortcut regressions.
- `node --test e2e/harness.test.mjs e2e/connection-handles.test.mjs e2e/media.test.mjs`: **43 browser scenarios passed**. The 500-object Chromium pan measured p95 16.8 ms; a remote update caused one object render and no full render.
- `node --test e2e/help.test.mjs`: **1 browser scenario passed**, including search, disabling character shortcuts, another viewer remaining unaffected, reopening Help by its visible menu, and reenabling shortcuts.
- New media browser coverage verifies no provider request on paste/inspection, peer visibility, safe outbound anchor attributes and one-step undo. Connection coverage verifies drag, pinned side, click picker, keyboard picker, cancellation and peer visibility.
- Connection and media screenshots were visually inspected. These local tests do not substitute for screen-reader evaluation or testing in the authenticated production host.
- Deterministic build, pack and archive freshness check passed. Revision **8**, archive **341,417 bytes**, versus **337,792 bytes** before: **3,625 bytes (+1.07%)**. Blueprint ID and stored schema unchanged. No new runtime dependency or service.
- `git diff --check` passed. Unrelated pre-existing worktree changes were left alone.

No production deploy or existing-board code upgrade was performed. The release archive affects newly created boards once installed; existing board instances retain their copied code. Full deployment checks, real-host sandbox navigation, representative assistive technology testing and a supported existing-instance upgrade remain release/enterprise validation steps.
