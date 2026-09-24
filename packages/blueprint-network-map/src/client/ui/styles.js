// @ts-check
// CSS for the whole app, injected as one <style> element (the iframe has no stylesheet files).
// Tokens and the button/modal/menu/toast rules follow the whiteboard's shell (same look across
// bundled formats); the layout is the map's own: top bar, left rail, canvas, right panel and the
// quick-add bar. Light and dark follow prefers-color-scheme; the canvas background does too.

export const CSS = String.raw`
:root {
  color-scheme: light dark;
  --surface: #ffffff;
  --surface-2: #f5f6f8;
  --canvas: #fbfbfa;
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
  --ok: #237032;
  --warn: #b45309;
  --shadow-1: 0 1px 2px rgba(16, 24, 40, .08), 0 2px 6px rgba(16, 24, 40, .08);
  --shadow-2: 0 8px 24px rgba(16, 24, 40, .18);
  --shadow-3: 0 16px 48px rgba(16, 24, 40, .28);
  --radius: 10px;
  --radius-sm: 6px;
  --font: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --rail: 240px;
  --panel: 340px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --surface: #242832;
    --surface-2: #1c2028;
    --canvas: #171a21;
    --border: #3a404c;
    --border-strong: #4f5666;
    --text: #e8ebf1;
    --text-2: #b3bac7;
    --text-3: #9aa2b1;
    --accent: #6d9eff;
    --accent-hover: #8fb4ff;
    --accent-soft: #233657;
    --on-accent: #0b1220;
    --danger: #ff7b7b;
    --ok: #58c878;
    --warn: #f0b35a;
    --shadow-1: 0 1px 2px rgba(0, 0, 0, .4), 0 2px 6px rgba(0, 0, 0, .3);
    --shadow-2: 0 8px 24px rgba(0, 0, 0, .5);
    --shadow-3: 0 16px 48px rgba(0, 0, 0, .6);
  }
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { height: 100%; margin: 0; }
body {
  font-family: var(--font); font-size: 14px; line-height: 1.4; color: var(--text);
  background: var(--canvas); overflow: hidden; -webkit-font-smoothing: antialiased; overscroll-behavior: none;
}
button, input, textarea, select { font: inherit; color: inherit; }
button { cursor: pointer; }
:focus:not(:focus-visible) { outline: none; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.icon { flex: none; display: block; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
h2, h3, h4 { margin: 0; }

/* Buttons and inputs */
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  border: 1px solid transparent; background: transparent;
  padding: 6px 10px; border-radius: var(--radius-sm); min-height: 32px;
  color: var(--text-2); font-weight: 500; white-space: nowrap;
}
.btn:hover:not(:disabled):not([aria-disabled="true"]) { background: rgba(127, 127, 127, .16); color: var(--text); }
.btn:disabled, .btn[aria-disabled="true"] { opacity: .4; cursor: default; }
.btn.primary { background: var(--accent); color: var(--on-accent); }
.btn.primary:hover:not(:disabled) { background: var(--accent-hover); color: var(--on-accent); }
.btn.outline { border-color: var(--border); background: var(--surface); }
.btn.icon-only { padding: 6px; min-width: 32px; }
.btn[aria-pressed="true"], .btn[aria-checked="true"], .btn[aria-selected="true"] { background: var(--accent-soft); color: var(--accent-hover); }
.btn.small { padding: 3px 8px; font-size: 13px; min-height: 28px; }
.btn.danger-text { color: var(--danger); }
input[type="text"], input[type="number"], input[type="date"], input[type="url"], input[type="search"], input:not([type]), select, textarea {
  border: 1px solid var(--border); background: var(--surface); border-radius: var(--radius-sm);
  padding: 6px 8px; min-width: 0;
}
textarea { resize: vertical; width: 100%; }
input:focus, select:focus, textarea:focus { border-color: var(--accent); }
label { color: var(--text-2); font-size: 13px; }
.field-row { display: flex; flex-direction: column; gap: 4px; }
.field-row > input, .field-row > select, .field-row > textarea { width: 100%; }
.inline { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.muted { color: var(--text-3); font-size: 13px; }
.warn-text { color: var(--warn); }
.error-text { color: var(--danger); }
.chip {
  display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px; border-radius: 999px;
  background: var(--surface-2); border: 1px solid var(--border); font-size: 12px; color: var(--text-2);
}
.swatch-dot { width: 12px; height: 12px; border-radius: 50%; flex: none; border: 1px solid rgba(127,127,127,.5); }

/* Shell */
.nm-app { position: fixed; inset: 0; display: grid; grid-template-rows: auto 1fr auto; grid-template-columns: var(--rail) 1fr var(--panel); }
.nm-app.rail-closed { grid-template-columns: 0 1fr var(--panel); }
.nm-app.panel-closed { grid-template-columns: var(--rail) 1fr 0; }
.nm-app.rail-closed.panel-closed { grid-template-columns: 0 1fr 0; }
.nm-topbar {
  grid-column: 1 / -1; grid-row: 1; display: flex; align-items: center; gap: 6px; padding: 6px 8px;
  background: var(--surface); border-bottom: 1px solid var(--border); min-width: 0; overflow-x: auto;
}
.nm-topbar .sep { width: 1px; align-self: stretch; background: var(--border); margin: 2px 4px; flex: none; }
.nm-title { min-width: 0; display: inline-flex; }
.nm-title .inline-edit-display {
  font-size: 15px; font-weight: 650; border: 0; background: transparent; padding: 4px 8px; color: var(--text);
  border-radius: var(--radius-sm); max-width: 30ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left;
}
.nm-title .inline-edit-display:hover { background: rgba(127, 127, 127, .14); }
.nm-title .inline-edit-input { font-size: 15px; font-weight: 650; width: min(320px, 50vw); }
.inline-edit { min-width: 0; display: inline-flex; }
.spacer { flex: 1; }
.conn { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-3); white-space: nowrap; }
.conn-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-3); flex: none; }
.conn[data-state="live"] .conn-dot, .conn[data-state="saving"] .conn-dot { background: var(--ok); }
.conn[data-state="reconnecting"] .conn-dot, .conn[data-state="connecting"] .conn-dot { background: #e8871e; animation: nm-pulse 1s infinite alternate; }
.conn[data-state="recovery-required"] .conn-dot { background: var(--danger); }
.conn.conn-warn { color: var(--warn); font-weight: 600; }
@keyframes nm-pulse { to { opacity: .3; } }
.peers { display: inline-flex; gap: 2px; }
.avatar {
  width: 26px; height: 26px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 700; border: 2px solid var(--surface); flex: none;
}

.nm-rail, .nm-panel { background: var(--surface); overflow: hidden; display: flex; flex-direction: column; min-width: 0; grid-row: 2; }
.nm-rail { grid-column: 1; }
.nm-panel { grid-column: 3; }
.nm-stage { grid-column: 2; grid-row: 2; }
.nm-topbar .inline { flex-wrap: nowrap; }
.stage-status { white-space: nowrap; }
.nm-rail { border-right: 1px solid var(--border); }
.nm-panel { border-left: 1px solid var(--border); }
.rail-closed .nm-rail, .panel-closed .nm-panel { visibility: hidden; }
.nm-section { padding: 10px 12px; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 6px; }
.nm-section > h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--text-3); display: flex; align-items: center; gap: 6px; }
.nm-scroll { overflow-y: auto; flex: 1; min-height: 0; }
.view-list { display: flex; flex-direction: column; gap: 2px; }
.view-list .btn { justify-content: flex-start; width: 100%; }
.legend { display: flex; flex-direction: column; gap: 2px; }
.legend .btn { justify-content: flex-start; width: 100%; font-weight: 400; }
.legend-shape { width: 12px; height: 12px; flex: none; }
.search-results { display: flex; flex-direction: column; gap: 2px; max-height: 240px; overflow-y: auto; }
.search-results .btn { justify-content: flex-start; width: 100%; font-weight: 400; overflow: hidden; text-overflow: ellipsis; }

.nm-stage { position: relative; min-width: 0; min-height: 0; background: var(--canvas); }
.nm-canvas { position: absolute; inset: 0; }
.nm-list-host { position: absolute; inset: 0; background: var(--surface); overflow: hidden; }
.nm-overlay { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
.peer-cursor { position: absolute; transform: translate(-2px, -2px); display: flex; align-items: flex-start; gap: 2px; transition: left .08s linear, top .08s linear; }
.peer-cursor svg { flex: none; }
.peer-cursor .name { font-size: 11px; font-weight: 600; color: #fff; padding: 1px 6px; border-radius: 6px; margin-top: 12px; white-space: nowrap; }
.stage-float {
  position: absolute; z-index: 5; background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); box-shadow: var(--shadow-1); display: flex; gap: 2px; padding: 3px; align-items: center;
}
.stage-zoom { right: 10px; bottom: 10px; flex-direction: column; }
.stage-status { left: 10px; bottom: 10px; padding: 4px 10px; font-size: 12px; color: var(--text-2); gap: 10px; }
.layout-progress { left: 50%; top: 10px; transform: translateX(-50%); padding: 6px 10px; gap: 10px; font-size: 13px; }
.demo-banner {
  left: 50%; top: 10px; transform: translateX(-50%); padding: 6px 8px 6px 14px; gap: 10px; font-size: 13px;
  max-width: calc(100% - 20px); flex-wrap: wrap; justify-content: center;
}
.empty-hint { left: 50%; top: 45%; transform: translate(-50%, -50%); padding: 16px 20px; flex-direction: column; gap: 8px; max-width: 360px; text-align: center; }

.nm-tabs { display: flex; gap: 2px; padding: 6px 6px 0; border-bottom: 1px solid var(--border); flex: none; overflow-x: auto; }
.nm-tabs .btn { border-radius: var(--radius-sm) var(--radius-sm) 0 0; }
.nm-tab-body { flex: 1; min-height: 0; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 12px; }

.nm-quickadd { grid-column: 1 / -1; grid-row: 3; display: flex; gap: 6px; align-items: center; padding: 6px 8px; background: var(--surface); border-top: 1px solid var(--border); }
.nm-quickadd input { flex: 1; }
.nm-quickadd .hint { font-size: 12px; color: var(--text-3); white-space: nowrap; }

/* Dialogs, menus, toasts (as the whiteboard's) */
.modal-scrim { position: fixed; inset: 0; background: rgba(10, 14, 22, .45); z-index: 50; display: flex; align-items: center; justify-content: center; padding: 16px; }
.modal { background: var(--surface); color: var(--text); border-radius: 12px; box-shadow: var(--shadow-3); width: min(460px, 100%); max-height: calc(100vh - 32px); overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 14px; }
.modal.wide { width: min(880px, 100%); }
.modal h2 { margin: 0; font-size: 17px; }
.modal p { margin: 0; color: var(--text-2); }
.modal input[type="text"], .modal input:not([type]) { width: 100%; padding: 8px 10px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
.menu {
  position: fixed; z-index: 40; background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 8px;
  box-shadow: var(--shadow-2); padding: 4px; min-width: 180px; display: flex; flex-direction: column;
}
.menu .btn { justify-content: flex-start; width: 100%; }
.toasts { position: fixed; top: 56px; left: 50%; transform: translateX(-50%); z-index: 60; display: flex; flex-direction: column; gap: 8px; width: min(460px, calc(100vw - 32px)); pointer-events: none; }
.toast { pointer-events: auto; background: #2b1d1d; color: #fff; border-radius: 8px; padding: 8px 8px 8px 14px; box-shadow: var(--shadow-2); display: flex; gap: 8px; align-items: center; }
.toast .msg { flex: 1; overflow-wrap: anywhere; }
.toast .btn { color: #fff; }
.toast .btn:hover { background: rgba(255,255,255,.15); color: #fff; }
.swatches { display: flex; gap: 3px; flex-wrap: wrap; align-items: center; }
.swatch { width: 24px; height: 24px; border-radius: 50%; border: 2px solid var(--border-strong); padding: 0; min-height: 0; }
.swatch[aria-checked="true"], .swatch[aria-pressed="true"] { border-color: var(--text); box-shadow: inset 0 0 0 2px var(--surface); border-width: 3px; }
.recovery-data { width: 100%; font-family: ui-monospace, monospace; font-size: 12px; }

/* Tables (list mode, import review) */
.grid-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.grid-table th, .grid-table td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--border); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 280px; }
.grid-table th { position: sticky; top: 0; background: var(--surface-2); font-weight: 600; color: var(--text-2); z-index: 1; }
.grid-table tr[aria-selected="true"] td { background: var(--accent-soft); }
.grid-table tr:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }

/* Phones: the rail and the panel become sheets over the canvas. */
@media (max-width: 760px) {
  .nm-app, .nm-app.rail-closed, .nm-app.panel-closed, .nm-app.rail-closed.panel-closed { grid-template-columns: 0 1fr 0; }
  .nm-rail, .nm-panel { position: fixed; top: 48px; bottom: 48px; z-index: 30; width: min(90vw, 360px); box-shadow: var(--shadow-3); }
  .nm-rail { left: 0; }
  .nm-panel { right: 0; }
  .nm-quickadd .hint { display: none; }
  .nm-topbar .btn .label, .stage-status .detail { display: none; }
  .demo-banner { top: auto; bottom: 56px; }
  .btn, .btn.small { min-height: 44px; }
  .btn.icon-only { min-width: 44px; }
  .conn .conn-text { display: none; }
  .nm-title .inline-edit-display { max-width: 14ch; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
}
`;

export function injectStyles() {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
}
