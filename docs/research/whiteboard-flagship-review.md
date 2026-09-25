# Whiteboard flagship review

Reviewed 2026-09-25. This is a source review and opportunity assessment, not a claim of accessibility certification or enterprise feature parity. The implementation workplan and validation record should describe what actually ships separately from this candidate backlog.

## Recommendation

Win everyday diagramming and evidence-led planning first: connections should be obvious, pasted material should become useful objects, and people should discover powerful actions without learning a toolbar. Preserve the existing small, bounded runtime. The longer-term differentiator is a board whose objects refer to authorised organisational records and explain where their information came from.

Enterprise adoption also needs trustworthy identity, revocation, recovery, retention and supported upgrades. These cannot be replaced by adding more canvas widgets. Treat them as platform work with explicit acceptance criteria. Avoid claims that every Miro or Mural customer could switch today; workshop facilitation, governance, assistive technology support and integrations need evaluation with representative teams.

## Reconcile the older plans with the current source

The [improvement options](whiteboard-improvement-options.md) and [delivery plan](../plans/whiteboard-improvements.md) remain useful, but their original gap lists predate delivered work. At review start, `gadget.lock.json` identifies revision 7. A new archive changes new boards; existing boards retain their copied app code.

| Capability | Evidence in source at review start | Decision |
| --- | --- | --- |
| Syntax-highlighted code blocks | `shared/code/`, `ui/code-block.js`, `canvas/code-editing.js`, README code-block section | Already implemented: language selection, themes, line numbers, wrap, filename, copy, bounded lexers, shared SVG export. Improve discovery and paste where needed; do not add a second highlighter. |
| Endpoint reattachment and routed connectors | `canvas/handles.js`, `canvas/route-edit.js`, `shared/connectors.js` | Already implemented. Starting a new connection from a selected shape is a separate missing affordance. |
| Snapping, arrange, clipboard, backup | `model/alignment.js`, `ui/arrange.js`, `ui/clipboard.js`, `ui/backup.js` | Preserve and regression-test. |
| Icons, emoji, templates, presentation | Existing picker, templates and presentation modules | Existing features, not new roadmap promises. |
| Large-board optimisation | Spatial index, culling, virtual list; prior performance baseline | Already implemented. Extend representative benchmarks when adding rich objects. |
| Recovery and saved state | `sync/connection.js`, recovery UI, prior delivery record | Good interim protection; host connection replacement remains a separate integration issue. |
| Help and object navigation | Static shortcut table and searchable virtual Objects panel | Useful foundation; help is not searchable at review start. |
| Trusted roles and durable audit | Previous plan explicitly leaves host identity/roles work open | Do not describe client display names or Activity as verified audit identity. |

## Research signals

Miro documents selected-object connection dots with click/drag creation, which supports treating connection starts as a primary affordance. [Miro connection lines](https://help.miro.com/hc/en-us/articles/360017730733-Connection-lines).

Miro documents keyboard board navigation, a command palette and an option to disable single-character shortcuts. This supports prioritising discoverability and alternative input paths alongside pointer polish. [Miro keyboard navigation](https://help.miro.com/hc/en-us/articles/11997028019858-Keyboard-navigation-while-working-on-boards).

Mural's enterprise materials describe identity management, guest controls, retention, audit integration and e-discovery. These are useful buyer-evaluation categories, not proof that this app needs to clone every option. [Mural trust and security](https://www.mural.co/trust-and-security). Its accessibility statement publishes a conformance report; an independently evaluated accessibility story is more credible than self-labelling a board accessible. [Mural accessibility](https://www.mural.co/accessibility).

W3C guidance requires a non-drag single-pointer alternative for dragging actions, subject to the criterion's exceptions. A keyboard equivalent alone does not satisfy that requirement: new connection handles should also work through clicks or a clickable picker. [Dragging movements](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html).

WCAG 2.2 target-size guidance describes a 24 CSS-pixel minimum or qualifying spacing/exceptions. Prefer 44-pixel touch targets where practical and keep hit regions stable as the board zooms. Do not claim 44 pixels is the AA minimum. [Target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html).

Character-only shortcuts need an off/remap mechanism or activation only when the relevant component has focus. The current app-level listener invokes shell actions from outside inputs and modals, making a user-controlled shortcut preference a well-bounded improvement. [Character key shortcuts](https://www.w3.org/WAI/WCAG22/Understanding/character-key-shortcuts.html).

## Prioritised candidate improvements

Effort is relative: small means a contained UI/shared helper change; medium crosses model, renderer and tests; large crosses platform trust, storage or operational boundaries. These are planning estimates, not delivery dates.

| Priority | Improvement and user value | Implementation | Cost and performance guardrail | Effort |
| --- | --- | --- | --- | --- |
| Now | Start connections from selected shapes | Four visually distinct ports; drag to target or tap/click a searchable target picker; reuse normal connector operations and port geometry | Only selected object's handles; screen-space hit regions; one committed operation; no new traffic while idle | Medium |
| Now | Useful pasted links, including YouTube | Parse a whole plain-text HTTP(S) URL into an inert link card with domain/provider and an explicit open action; preserve ordinary text paste | No metadata fetch, iframe, remote thumbnail, autoplay or URL polling; bound URL/text length and reject credentials/unsafe schemes | Medium |
| Now | Discover existing code blocks | Clear Add-menu entry and help search; preserve existing language controls and fenced-code paste; document where to find it | Reuse bounded lexer/cache and existing object; no editor framework or CDN | Small |
| Now | Accessible multi-object navigation | Type filter and additive selection in the Objects panel; retain selection across searches and move directly to editing controls | Reuse virtualised rows; no selection writes to board storage; bounded visible DOM | Small |
| Now | Searchable help and shortcut preference | Filter the shared command table; labelled checkbox for character shortcuts; apply consistently to app/canvas handlers | Local UI state; no board writes; preserve modifier, navigation and editor keys; do not pretend sandbox storage is reliable | Small |
| Next | Action palette for novices and experts | One searchable registry of existing actions, selection requirements and disabled reasons; keyboard and visible entry point | Reuse action handlers rather than synthetic keyboard events; filter a small in-memory registry | Medium |
| Next | Explain the board without seeing it | Object counts/types, frame-oriented reading order, selected object's inbound/outbound relationships, explicit repeat-description action | Compute on demand from existing index/state; coalesce announcements; do not announce every cursor move | Medium |
| Next | Safer bulk changes and object organisation | Explicit grouping, lock/unlock against accidental edits, frame assignment, selection count and clear undo feedback | Bounded atomic existing operations; distinguish accidental-edit locks from permissions | Medium |
| Next | Accessible workshop toolkit | Timer, agenda/frame progression, parking-lot template and facilitator guidance | Local timer first; shared state only at start/pause/end; voting waits for identity and product rules | Medium |
| Next | Structured paste | TSV tables converted to a bounded editable grid or ordinary objects; preview rows/columns before large imports | Strict cell/object/byte limits; one undoable transaction where limits permit; no raw HTML insertion | Medium |
| Platform | Recovery through host restarts | Refresh RPC target without destroying iframe; preserve request IDs and reconcile acknowledgement ambiguity | Bounded queue and retries; no blind replay; retain recovery export fallback | Large |
| Platform | Identity-bound roles and attribution | Host-issued gadget session; server enforces viewer/editor roles and revocation across every mutation route | No client names as authority; test direct RPC bypasses and expired/cross-board sessions | Large |
| Platform | Comments, mentions and durable checkpoints | Separately bounded threads and snapshot/delta retention after identity/retention decisions | Quotas and retention before UI; no notifications without explicit product authorization; restore cannot silently erase concurrent work | Large |
| Platform | Authorised data cards | Typed source reference, concise snapshot, freshness time and source link; explicit refresh through host capability | No tokens or whole datasets on canvas; query-time permission checks; revision-aware writes; batch/cache refresh; no per-viewer polling | Large |
| Platform | Evidence-backed agent actions | Preview sourced proposed objects and changes, apply a bounded batch with undo and provenance | User-triggered runs; cap objects/tokens/runtime; no model calls during pan/type; source text never gains instruction authority | Large |
| Later | Images, previews and published boards | Authenticated asset service and separate snapshot publishing capability | MIME/dimension/byte quotas; external access policy; no base64 board inflation; snapshot contains no private live capability | Large |

## Implementation details for the immediate work

Connection creation should fit existing gestures: port hit testing precedes ordinary resize/move only when a port is visibly offered. Ports should not cover resize handles at small zoom. Store the chosen source side, use existing target picking and route generation, cancel on Escape or invalid drop, and show an understandable completion/cancellation message. Revalidate both endpoints at commit because a collaborator can remove a target during the gesture. Creation, undo, connector cascades and export must use the same object model as other connectors.

Link cards should honestly describe the sandbox. The current host specifies `frame-src 'none'`, `connect-src 'none'` and data-only images/media in `GadgetUI.tsx`; a YouTube player or fetched thumbnail cannot be a blueprint-only feature under that policy. Render a recognisable local provider treatment, title editable by the user, domain and safe open link. Explain that playback opens on the provider. Use exact parsed hostname matching for provider recognition; a host merely containing `youtube.com` is not YouTube. Keep content inert in the DOM and escaped in SVG export. Imported/backed-up URLs must pass the same normaliser as paste.

Code blocks already satisfy the main syntax-highlighting request. Preserve their plain-text semantics and copy fallback. The feature must remain discoverable from ordinary UI, and pasted code must remain editable with a native textarea. Test long code, unknown language, HTML-like source, multiline undo, and export rather than replacing the implementation with a heavier editor.

The smallest high-value accessibility addition is a character-shortcut checkbox in Help, alongside searchable commands. Keep the preference local to the viewer/session unless a reliable host preference seam exists. Disable single-character matches, including shifted punctuation, without suppressing Escape, Enter, arrows, Tab, editor composition or Ctrl/Cmd shortcuts. The help button must remain usable after shortcuts are off. Return focus after closing and expose filter result feedback without noisy per-keystroke announcements.

## The data-connected differentiator

Start with explicit, refreshable snapshots of authorised records. A card should distinguish source facts, user annotations and agent suggestions; show source/freshness; and expose access loss without leaking a previous sensitive snapshot to newly unauthorised viewers. Before implementing, decide whether materialising data onto a shared board grants every board viewer access to the copied content. That is a real permission/product choice, not a UI detail.

Suggested sequence: link to a source, insert a selected and reviewed excerpt, refresh a bounded set on request, preview agent-generated groupings/diagrams, then consider write-back to source systems. Write-back needs its own authority, confirmation semantics, idempotency and conflict policy. No automatic background crawling, model summarisation or replication is necessary for the first useful version.

## Release evidence and enterprise gates

- Compare archive bytes, startup/render timings and operation counts with the existing baseline; record results, not an assertion of zero overhead. Preserve the 5,000-object and bounded-storage limits.
- Test new objects through sanitisation, copy/paste, undo/redo, backup/import, collaboration, culling, object search and SVG export. Test unsafe URLs and markup-looking text.
- Exercise connector creation by mouse, touch, click-only and keyboard; test cancellation, rotated shapes, zoom, remote deletion, and focus restoration.
- Check keyboard-only use, reduced motion, forced colours, 200% UI zoom and representative screen readers in the actual host. Automated role/name checks are useful but cannot certify the experience.
- Keep source, archive, sidecar and documentation aligned. Document the existing-instance upgrade route before claiming a deployed improvement reaches old boards.
- Complete verified roles/revocation, recovery/restart exercises, retention/restore policy, operational ownership and an accessibility evaluation before an enterprise-readiness claim.
- Estimate total operating cost with measured active users, board sizes, storage/retention, presence deliveries, support and any optional AI usage. A low runtime bill alone does not prove a lower total cost than seat licences.

This review recommends implementing the bounded immediate slice now and retaining the platform items as explicit dependency-led work. The platform roadmap is valuable, but it should not be presented as completed by a canvas usability release.
