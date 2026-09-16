// @ts-check
// All CSS for the board, injected as one <style> element (the iframe has no stylesheet files).

export const CSS = String.raw`
:root {
  color-scheme: light dark;
  --bg: #f3f4f6;
  --bg-board: #eef0f4;
  --surface: #ffffff;
  --surface-2: #f8f9fb;
  --column: #e4e7ec;
  --column-head: #e4e7ec;
  --border: #d5d9e0;
  --border-strong: #b8bfca;
  --text: #1a1f2b;
  --text-2: #4b5363;
  --text-3: #6b7280;
  --accent: #2563eb;
  --accent-hover: #1d4ed8;
  --accent-soft: #dbe6fd;
  --on-accent: #ffffff;
  --danger: #c62828;
  --on-danger: #ffffff;
  --danger-soft: #fde8e8;
  --warn-soft: #fff4d6;
  --warn-border: #e8b23a;
  --ok: #237032;
  --shadow-1: 0 1px 1px rgba(16, 24, 40, .06), 0 1px 3px rgba(16, 24, 40, .08);
  --shadow-2: 0 8px 24px rgba(16, 24, 40, .18);
  --shadow-3: 0 16px 48px rgba(16, 24, 40, .28);
  --radius: 10px;
  --radius-sm: 6px;
  --focus: 0 0 0 3px rgba(37, 99, 235, .45);
  --font: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --column-width: 284px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #111318;
    --bg-board: #15181e;
    --surface: #242832;
    --surface-2: #1c2028;
    --column: #1d2129;
    --column-head: #1d2129;
    --border: #353b47;
    --border-strong: #4a5160;
    --text: #e8ebf1;
    --text-2: #b3bac7;
    --text-3: #939bab;
    --accent: #6d9eff;
    --accent-hover: #8fb4ff;
    --accent-soft: #233657;
    --on-accent: #0b1220;
    --danger: #ff7b7b;
    --on-danger: #0b1220;
    --danger-soft: #3d2124;
    --warn-soft: #3a3120;
    --warn-border: #a47e2c;
    --ok: #58c878;
    --shadow-1: 0 1px 2px rgba(0, 0, 0, .4);
    --shadow-2: 0 8px 24px rgba(0, 0, 0, .5);
    --shadow-3: 0 16px 48px rgba(0, 0, 0, .6);
    --focus: 0 0 0 3px rgba(109, 158, 255, .55);
  }
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { height: 100%; margin: 0; }
body {
  font-family: var(--font);
  font-size: 14px;
  line-height: 1.4;
  color: var(--text);
  background: var(--bg-board);
  overflow: hidden;
  -webkit-font-smoothing: antialiased;
}
button, input, textarea, select { font: inherit; color: inherit; }
button { cursor: pointer; }
:focus:not(:focus-visible) { outline: none; }
/* Transparent outline: invisible normally, but drawn in forced-colors mode where shadows are not. */
:focus-visible { outline: 2px solid transparent; outline-offset: 2px; box-shadow: var(--focus); border-radius: var(--radius-sm); }
.icon { flex: none; display: block; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

/* Buttons */
.btn {
  display: inline-flex; align-items: center; gap: 6px;
  border: 1px solid transparent; background: transparent;
  padding: 6px 10px; border-radius: var(--radius-sm);
  color: var(--text-2); font-weight: 500; white-space: nowrap;
}
.btn:hover { background: rgba(127, 127, 127, .14); color: var(--text); }
.btn.primary { background: var(--accent); color: var(--on-accent); }
.btn.primary:hover { background: var(--accent-hover); }
.btn.danger { background: var(--danger); color: var(--on-danger); }
.btn.danger:hover { filter: brightness(1.08); }
.btn.outline { border-color: var(--border); background: var(--surface); }
.btn.outline:hover { border-color: var(--border-strong); }
.btn.icon-only { padding: 6px; }
.btn[aria-pressed="true"] { background: var(--accent-soft); color: var(--accent-hover); }
.btn.small { padding: 3px 8px; font-size: 13px; }

input[type="text"], input[type="search"], input[type="date"], input:not([type]), textarea, select {
  border: 1px solid var(--border); background: var(--surface); border-radius: var(--radius-sm);
  padding: 6px 8px; min-width: 0;
}
input:focus, textarea:focus, select:focus { border-color: var(--accent); box-shadow: var(--focus); }

/* Layout */
.app { display: flex; flex-direction: column; height: 100vh; height: 100dvh; }
.header {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  padding: 8px 14px; background: var(--surface); border-bottom: 1px solid var(--border);
  position: relative; z-index: 5;
}
.header-title { flex: 1 1 200px; min-width: 0; display: flex; align-items: center; gap: 8px; }
.header-title h1 { margin: 0; font: inherit; min-width: 0; display: flex; }
.board-title .inline-edit-display {
  font-size: 18px; font-weight: 650; border: 0; background: transparent; padding: 4px 6px;
  border-radius: var(--radius-sm); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left;
}
.board-title .inline-edit-display:hover { background: rgba(127, 127, 127, .14); }
.board-title .inline-edit-input { font-size: 18px; font-weight: 650; width: min(420px, 100%); }
.inline-edit { min-width: 0; display: inline-flex; }
.header-right { display: flex; align-items: center; gap: 10px; }
.conn { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-3); white-space: nowrap; }
.conn-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-3); }
.conn[data-state="live"] .conn-dot { background: var(--ok); }
.conn[data-state="reconnecting"] .conn-dot, .conn[data-state="connecting"] .conn-dot { background: #e8871e; animation: pulse 1s infinite alternate; }
@keyframes pulse { to { opacity: .3; } }
.avatars { display: flex; align-items: center; }
.avatars .avatar { margin-left: -6px; box-shadow: 0 0 0 2px var(--surface); }
.avatars .avatar:first-child { margin-left: 0; }
.avatar {
  display: inline-flex; align-items: center; justify-content: center; flex: none;
  width: 28px; height: 28px; border-radius: 50%; font-size: 11px; font-weight: 700; letter-spacing: .02em;
  user-select: none;
}
.avatar.small { width: 22px; height: 22px; font-size: 10px; }
.avatar.me { box-shadow: 0 0 0 2px var(--surface), 0 0 0 3px var(--border-strong); }
.me-btn { padding: 2px 8px 2px 2px; border-radius: 999px; }

.toolbar {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 8px 14px; background: var(--surface-2); border-bottom: 1px solid var(--border);
}
.search { position: relative; display: flex; align-items: center; }
.search .icon { position: absolute; left: 8px; color: var(--text-3); pointer-events: none; }
.search input { padding-left: 28px; width: 200px; }
.toolbar select { max-width: 160px; }
.toolbar .spacer { flex: 1; }
.filter-count { font-size: 12px; color: var(--text-3); }

/* Board */
.board-wrap { flex: 1; min-height: 0; display: flex; flex-direction: column; position: relative; }
.tabs { display: none; }
.board {
  flex: 1; min-height: 0; display: flex; align-items: flex-start; gap: 12px;
  padding: 14px; overflow-x: auto; overflow-y: hidden;
}
.column {
  flex: none; width: var(--column-width); max-height: 100%;
  display: flex; flex-direction: column;
  background: var(--column); border-radius: var(--radius);
  border: 2px solid transparent;
}
.column.peer-hover { border-style: dashed; }
.column-head {
  display: flex; align-items: center; gap: 4px; padding: 8px 6px 6px 10px;
  cursor: grab; touch-action: pan-y; user-select: none; border-radius: var(--radius) var(--radius) 0 0;
}
.column-heading { flex: 1; min-width: 0; margin: 0; font: inherit; display: flex; }
.column-name { flex: 1; min-width: 0; }
.column-name .inline-edit-display {
  border: 0; background: transparent; font-weight: 650; padding: 3px 4px; border-radius: var(--radius-sm);
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; color: var(--text);
}
.column-name .inline-edit-display:hover { background: rgba(127, 127, 127, .16); }
.column-name .inline-edit-input { width: 100%; font-weight: 650; padding: 3px 6px; }
.count {
  font-size: 12px; color: var(--text-2); background: rgba(127, 127, 127, .18);
  border-radius: 999px; padding: 0 7px; min-width: 22px; text-align: center; font-variant-numeric: tabular-nums;
}
.column .btn.icon-only { color: var(--text-3); }
.column-head .collapse-btn { opacity: 0; }
.column-head:hover .collapse-btn, .column-head:focus-within .collapse-btn, .column.collapsed .collapse-btn { opacity: 1; }
.cards {
  flex: 1 1 auto; min-height: 8px; overflow-y: auto; padding: 2px 8px 4px;
  display: flex; flex-direction: column; gap: 8px;
}
.column-foot { padding: 4px 8px 8px; }
.no-match { margin: 0; padding: 4px 12px 8px; }
.column.collapsed .no-match { display: none; }
.add-card-btn { width: 100%; justify-content: flex-start; }
.composer { display: flex; flex-direction: column; gap: 6px; }
.composer textarea { resize: none; min-height: 58px; box-shadow: var(--shadow-1); border-color: transparent; }
.composer-actions { display: flex; gap: 6px; align-items: center; }

.column.collapsed { width: 44px; cursor: default; }
.column.collapsed .column-head { flex-direction: column; padding: 8px 4px; gap: 8px; }
.column.collapsed .column-heading { flex: none; }
.column.collapsed .column-name { writing-mode: vertical-rl; }
.column.collapsed .column-name .inline-edit-display { white-space: nowrap; }
.column.collapsed .cards, .column.collapsed .column-foot, .column.collapsed .col-menu-btn { display: none; }

.add-column { flex: none; width: var(--column-width); }
.add-column > .btn { width: 100%; background: rgba(127, 127, 127, .12); padding: 10px 12px; border-radius: var(--radius); justify-content: flex-start; }
.add-column .add-column-form { background: var(--column); padding: 8px; border-radius: var(--radius); display: flex; flex-direction: column; gap: 6px; }

/* Card */
.card {
  position: relative; background: var(--surface); border-radius: 8px; padding: 8px 10px;
  box-shadow: var(--shadow-1); cursor: pointer; touch-action: pan-y; user-select: none;
  border: 1px solid transparent; transition: opacity .15s;
}
.card:hover { border-color: var(--border-strong); }
.card:focus-visible { box-shadow: var(--focus); border-radius: 8px; }
.card-labels { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
.chip {
  display: inline-flex; align-items: center; font-size: 11px; font-weight: 600; line-height: 16px;
  padding: 1px 8px; border-radius: 999px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.card-title { overflow-wrap: anywhere; white-space: pre-wrap; }
.card-meta { display: flex; align-items: center; gap: 8px; margin-top: 6px; font-size: 12px; color: var(--text-3); flex-wrap: wrap; }
.card-meta:empty { display: none; }
.meta-item { display: inline-flex; align-items: center; gap: 3px; border-radius: 4px; padding: 0 3px; }
.meta-item.overdue { background: var(--danger-soft); color: var(--danger); font-weight: 600; }
.meta-item.complete { color: var(--ok); }
.card-meta .avatar { margin-left: auto; }
.card.dim { opacity: .28; }
.card.peer-open { box-shadow: var(--ring), var(--shadow-1); }
.card.peer-open:focus-visible { box-shadow: var(--ring), var(--shadow-1); outline: 3px solid var(--accent); outline-offset: 5px; }
.card.peer-drag { outline: 2px dashed var(--ghost); outline-offset: 2px; }
.peer-badges { position: absolute; top: -8px; right: -6px; display: flex; gap: 2px; }
.peer-badges .avatar { width: 18px; height: 18px; font-size: 9px; box-shadow: 0 0 0 2px var(--surface); }
.card.drag-source { display: none; }
.placeholder {
  flex: none; border-radius: 8px; background: rgba(127, 127, 127, .22);
  border: 2px dashed var(--border-strong);
}
.column-placeholder { flex: none; width: var(--column-width); align-self: stretch; border-radius: var(--radius); background: rgba(127,127,127,.18); border: 2px dashed var(--border-strong); }
.column.col-drag-source { display: none; }
.drag-ghost {
  position: fixed; z-index: 1000; pointer-events: none; margin: 0;
  box-shadow: var(--shadow-3); transform: rotate(2.5deg); opacity: .96;
}
.column.drag-ghost { max-height: 60vh; overflow: hidden; }
body.dragging, body.dragging * { cursor: grabbing !important; }

/* Side panel */
.scrim { position: fixed; inset: 0; background: rgba(10, 14, 22, .35); z-index: 20; }
.panel {
  position: fixed; top: 0; right: 0; bottom: 0; width: min(520px, 100vw); z-index: 21;
  background: var(--surface); box-shadow: var(--shadow-3);
  display: flex; flex-direction: column;
  animation: slide-in .16s ease-out;
}
@keyframes slide-in { from { transform: translateX(24px); opacity: .6; } }
.panel-head { display: flex; align-items: flex-start; gap: 8px; padding: 14px 14px 8px 18px; border-bottom: 1px solid var(--border); }
.panel-head .where { font-size: 12px; color: var(--text-3); }
.panel-head .viewers { display: flex; gap: 2px; align-items: center; }
.panel-body { flex: 1; overflow-y: auto; padding: 14px 18px 24px; display: flex; flex-direction: column; gap: 18px; }
.panel-body > * { flex-shrink: 0; }
.move-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.move-row select { flex: 1 1 160px; }
.panel-title {
  width: 100%; font-size: 18px; font-weight: 650; border: 1px solid transparent; background: transparent;
  resize: none; padding: 4px 6px; margin-left: -6px; border-radius: var(--radius-sm); overflow: hidden;
}
.panel-title:hover { border-color: var(--border); }
.field-label { font-size: 12px; font-weight: 600; color: var(--text-2); text-transform: uppercase; letter-spacing: .04em; margin-bottom: 6px; display: flex; align-items: center; gap: 6px; }
.field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.field-row input { width: 100%; }
.panel textarea.description { width: 100%; min-height: 110px; resize: vertical; line-height: 1.5; }
.label-toggles { display: flex; flex-wrap: wrap; gap: 6px; }
/* Unselected: outlined in the label colour with normal text; selected: filled chip. */
.label-toggle { border: 2px solid var(--chip); background: transparent; color: var(--text); cursor: pointer; font-size: 12px; padding: 2px 9px; gap: 4px; }
.label-toggle:hover { background: rgba(127, 127, 127, .14); }
.label-toggle[aria-pressed="true"] { background: var(--chip); color: var(--chip-text); border-color: var(--text); }
.label-toggle[aria-pressed="true"]::before { content: "✓"; font-weight: 700; }
.new-label { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 8px; }
.new-label input { width: 140px; }
.swatches { display: flex; gap: 4px; flex-wrap: wrap; }
.swatch { width: 22px; height: 22px; border-radius: 50%; border: 2px solid transparent; padding: 0; }
.swatch[aria-checked="true"] { border-color: var(--text); box-shadow: inset 0 0 0 2px var(--surface); }
.checklist { display: flex; flex-direction: column; gap: 2px; }
.check-item { display: flex; align-items: center; gap: 8px; padding: 2px 0; }
.check-item input[type="checkbox"] { width: 16px; height: 16px; accent-color: var(--accent); flex: none; }
.check-item input.check-text { flex: 1; border-color: transparent; background: transparent; padding: 4px 6px; }
.check-item input.check-text:hover { border-color: var(--border); }
.check-item.done input.check-text { text-decoration: line-through; color: var(--text-3); }
.check-item .btn { opacity: .5; }
.check-item:hover .btn, .check-item .btn:focus-visible { opacity: 1; }
.progress { height: 6px; background: rgba(127,127,127,.2); border-radius: 999px; overflow: hidden; flex: 1; }
.progress > div { height: 100%; background: var(--accent); transition: width .2s; }
.progress.complete > div { background: var(--ok); }
.check-add { display: flex; gap: 6px; margin-top: 6px; }
.check-add input { flex: 1; }
.comments { display: flex; flex-direction: column; gap: 10px; }
.comment { display: flex; gap: 8px; }
.comment-body { flex: 1; min-width: 0; }
.comment-head { font-size: 12px; color: var(--text-3); }
.comment-head strong { color: var(--text); font-weight: 600; margin-right: 6px; }
.comment-text { background: var(--surface-2); border: 1px solid var(--border); padding: 6px 10px; border-radius: 8px; margin-top: 2px; white-space: pre-wrap; overflow-wrap: anywhere; }
.comment-form { display: flex; flex-direction: column; gap: 6px; }
.comments + .comment-form { margin-top: 12px; }
.comment-form textarea { width: 100%; min-height: 60px; resize: vertical; }
.panel-foot { display: flex; align-items: center; gap: 8px; justify-content: space-between; font-size: 12px; color: var(--text-3); border-top: 1px solid var(--border); padding-top: 12px; flex-wrap: wrap; }
.muted { color: var(--text-3); font-size: 13px; }

.banner { border: 1px solid var(--warn-border); background: var(--warn-soft); border-radius: var(--radius-sm); padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.banner strong { font-weight: 650; }
.banner dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; font-size: 13px; }
.banner dt { color: var(--text-2); font-weight: 600; }
.banner dd { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; max-height: 6em; overflow: auto; }
.banner .actions { display: flex; gap: 6px; flex-wrap: wrap; }

/* Activity drawer */
.activity {
  position: fixed; top: 0; right: 0; bottom: 0; width: min(380px, 100vw); z-index: 19;
  background: var(--surface); box-shadow: var(--shadow-3); display: flex; flex-direction: column;
  animation: slide-in .16s ease-out;
}
.activity-list { flex: 1; overflow-y: auto; padding: 8px 12px 16px; margin: 0; list-style: none; display: flex; flex-direction: column; }
.activity-item { display: flex; gap: 10px; padding: 8px 4px; border-bottom: 1px solid var(--border); align-items: flex-start; }
.activity-item .summary { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.activity-item .when { font-size: 12px; color: var(--text-3); }

/* Dialogs, menus, toasts */
.modal-scrim { position: fixed; inset: 0; background: rgba(10, 14, 22, .45); z-index: 50; display: flex; align-items: center; justify-content: center; padding: 16px; }
.modal { background: var(--surface); border-radius: 12px; box-shadow: var(--shadow-3); width: min(400px, 100%); padding: 20px; display: flex; flex-direction: column; gap: 14px; }
.modal h2 { margin: 0; font-size: 17px; }
.modal p { margin: 0; color: var(--text-2); }
.modal input[type="text"], .modal input:not([type]) { width: 100%; padding: 8px 10px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
.menu {
  position: fixed; z-index: 40; background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
  box-shadow: var(--shadow-2); padding: 4px; min-width: 170px; display: flex; flex-direction: column;
}
.menu .btn { justify-content: flex-start; width: 100%; }
.menu .btn.danger-text { color: var(--danger); }
.toasts { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); z-index: 60; display: flex; flex-direction: column; gap: 8px; width: min(440px, calc(100vw - 32px)); }
.toast { background: #2b1d1d; color: #fff; border-radius: 8px; padding: 10px 8px 10px 14px; box-shadow: var(--shadow-2); display: flex; gap: 8px; align-items: center; }
.toast .msg { flex: 1; overflow-wrap: anywhere; }
.toast .btn { color: #fff; }
.toast .btn:hover { background: rgba(255,255,255,.15); color: #fff; }

/* Mobile */
@media (max-width: 640px) {
  .header { padding: 6px 10px; gap: 8px; }
  .header-title { flex-basis: 100%; order: 0; }
  .board-title .inline-edit-display { font-size: 16px; }
  .toolbar { padding: 6px 10px; gap: 6px; }
  .search { flex: 1 1 100%; }
  .search input { width: 100%; }
  .toolbar select { flex: 1; max-width: none; }
  .tabs {
    display: flex; gap: 4px; overflow-x: auto; padding: 8px 10px 0; background: var(--bg-board);
    scrollbar-width: none; flex: none;
  }
  /* Fade the trailing edge while more tabs are scrolled out of view. */
  .tabs.overflow-end { -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 32px), transparent); mask-image: linear-gradient(to right, #000 calc(100% - 32px), transparent); }
  .tab {
    flex: none; border: 0; background: transparent; padding: 6px 12px; border-radius: 999px;
    color: var(--text-2); font-weight: 500; white-space: nowrap;
  }
  .tab[aria-selected="true"] { background: var(--surface); color: var(--text); box-shadow: var(--shadow-1); }
  .tab .count { margin-left: 4px; }
  .board { padding: 10px; overflow-x: hidden; }
  .column.mobile-hidden, .column-placeholder, .add-column.mobile-hidden { display: none; }
  .column, .add-column { width: 100%; }
  .column.collapsed { width: 100%; }
  .column.collapsed .cards, .column.collapsed .column-foot { display: flex; }
  .column.collapsed .column-head { flex-direction: row; padding: 8px 6px 6px 10px; }
  .column.collapsed .column-name { writing-mode: horizontal-tb; }
  .column.collapsed .column-heading { flex: 1; }
  .collapse-btn { display: none; }
  .panel, .activity { width: 100vw; }
  .field-row { grid-template-columns: 1fr; }
}

/* Export (static) */
.export { padding: 24px; background: #fff; color: #111; min-height: 100vh; }
body.export-mode { overflow: auto; background: #fff; color-scheme: light; }
.export h1 { margin: 0 0 4px; font-size: 24px; }
.export .export-sub { color: #555; margin-bottom: 20px; font-size: 12px; }
.export-columns { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; }
.export-column { flex: 1 1 260px; max-width: 360px; background: #f1f3f6; border-radius: 10px; padding: 10px; break-inside: avoid-page; }
.export-column h2 { font-size: 15px; margin: 0 0 8px; display: flex; justify-content: space-between; }
.export-card { background: #fff; border: 1px solid #d5d9e0; border-radius: 8px; padding: 8px 10px; margin-bottom: 8px; break-inside: avoid; }
.export-card h3 { font-size: 14px; margin: 0 0 4px; overflow-wrap: anywhere; }
.export-card .desc { white-space: pre-wrap; font-size: 12px; color: #333; margin: 4px 0; overflow-wrap: anywhere; }
.export-card .meta { font-size: 12px; color: #444; display: flex; gap: 10px; flex-wrap: wrap; }
.export-card ul { margin: 4px 0 0; padding-left: 2px; font-size: 12px; list-style: none; }
.export-card li.done { text-decoration: line-through; color: #666; }
.export .chip { border: 1px solid rgba(0,0,0,.1); }
@media print {
  .export { padding: 0; }
  .export-column { background: #f6f7f9; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
`;
