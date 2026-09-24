// @ts-check
// CSS for the app shell (floating chrome around the canvas), injected as one <style> element
// together with the canvas's own CSS (the iframe has no stylesheet files). The chrome follows
// prefers-color-scheme; the canvas itself stays light so boards look the same for everyone.

export const SHELL_CSS = String.raw`
:root {
  color-scheme: light dark;
  --surface: #ffffff;
  --surface-2: #f5f6f8;
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
}
@media (prefers-color-scheme: dark) {
  :root {
    --surface: #242832;
    --surface-2: #1c2028;
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
  background: #f7f7f5; overflow: hidden; -webkit-font-smoothing: antialiased;
  overscroll-behavior: none;
}
button, input, textarea, select { font: inherit; color: inherit; }
button { cursor: pointer; }
:focus:not(:focus-visible) { outline: none; }
/* One focus ring everywhere: an outline (never a box-shadow, which other rules also use and would
   override), in the accent colour, which has at least 3:1 contrast on the surfaces in both schemes. */
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.icon { flex: none; display: block; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

/* Buttons */
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  border: 1px solid transparent; background: transparent;
  padding: 6px 10px; border-radius: var(--radius-sm); min-height: 32px;
  color: var(--text-2); font-weight: 500; white-space: nowrap;
}
.btn:hover:not(:disabled):not([aria-disabled="true"]) { background: rgba(127, 127, 127, .16); color: var(--text); }
.btn:disabled, .btn[aria-disabled="true"] { opacity: .4; cursor: default; }
.btn.primary { background: var(--accent); color: var(--on-accent); }
.btn.primary:hover { background: var(--accent-hover); color: var(--on-accent); }
.btn.outline { border-color: var(--border); background: var(--surface); }
.btn.icon-only { padding: 6px; min-width: 32px; }
.btn[aria-pressed="true"], .btn[aria-checked="true"] { background: var(--accent-soft); color: var(--accent-hover); }
.btn.small { padding: 3px 8px; font-size: 13px; min-height: 28px; }
.btn.danger-text { color: var(--danger); }
input[type="text"], input:not([type]) {
  border: 1px solid var(--border); background: var(--surface); border-radius: var(--radius-sm);
  padding: 6px 8px; min-width: 0;
}
input:focus { border-color: var(--accent); }

/* Layout: the canvas fills the frame; everything else floats above it. */
.wb-app { position: fixed; inset: 0; overflow: hidden; }
.wb-canvas-host { position: absolute; inset: 0; }
.wb-canvas-host > * { width: 100%; height: 100%; }
.wb-float {
  position: absolute; z-index: 10; background: var(--surface); color: var(--text);
  border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow-1);
}
.wb-sep { width: 1px; align-self: stretch; background: var(--border); margin: 2px 2px; flex: none; }
.wb-toolbar .wb-sep { width: auto; height: 1px; margin: 2px 4px; }

.wb-topbar {
  top: 10px; left: 10px; display: flex; align-items: center; gap: 6px; padding: 4px 8px 4px 4px;
  max-width: calc(100vw - 20px - 260px);
}
.board-title { min-width: 0; display: inline-flex; }
.board-title .inline-edit-display {
  font-size: 15px; font-weight: 650; border: 0; background: transparent; padding: 4px 8px; color: var(--text);
  border-radius: var(--radius-sm); max-width: 32ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left;
}
.board-title .inline-edit-display:hover { background: rgba(127, 127, 127, .14); }
.board-title .inline-edit-input { font-size: 15px; font-weight: 650; width: min(320px, 50vw); }
.inline-edit { min-width: 0; display: inline-flex; }
.conn { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-3); white-space: nowrap; }
.conn-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-3); flex: none; }
.conn[data-state="live"] .conn-dot, .conn[data-state="saving"] .conn-dot { background: var(--ok); }
.conn-text { overflow: hidden; text-overflow: ellipsis; }
.conn[data-state="reconnecting"] .conn-dot, .conn[data-state="connecting"] .conn-dot { background: #e8871e; animation: wb-pulse 1s infinite alternate; }
.conn[data-state="recovery-required"] .conn-dot { background: var(--danger); }
.conn.conn-warn { color: var(--warn); font-weight: 600; }
@keyframes wb-pulse { to { opacity: .3; } }

.wb-topright { top: 10px; right: 10px; display: flex; align-items: center; gap: 6px; padding: 4px; }
.people { display: flex; align-items: center; padding: 0 2px; }
/* Avatars overlap a little but stay at least 24px apart centre to centre (target spacing). */
.people .peer {
  margin-left: -2px; border: 0; padding: 0; background: transparent; border-radius: 50%;
}
.people .peer:first-child { margin-left: 0; }
.people .peer .avatar { box-shadow: 0 0 0 2px var(--surface); }
.people .peer[aria-pressed="true"] .avatar { box-shadow: 0 0 0 2px var(--surface), 0 0 0 4px var(--accent); }
.people .more-people .avatar { background: var(--surface-2); color: var(--text); box-shadow: 0 0 0 1px var(--text-3); }
.avatar {
  display: inline-flex; align-items: center; justify-content: center; flex: none;
  width: 28px; height: 28px; border-radius: 50%; font-size: 11px; font-weight: 700; letter-spacing: .02em;
  user-select: none;
}
.me-btn { padding: 2px 8px 2px 2px; border-radius: 999px; }
.me-btn .me-name { max-width: 12ch; overflow: hidden; text-overflow: ellipsis; }
.follow-chip {
  top: 58px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 8px;
  padding: 4px 4px 4px 12px; border-width: 2px; font-size: 13px; white-space: nowrap;
}

/* Tools */
.wb-toolbar {
  left: 10px; top: 50%; transform: translateY(-50%); display: flex; flex-direction: column; gap: 2px; padding: 4px;
  max-height: calc(100vh - 140px); overflow-y: auto; scrollbar-width: thin; overscroll-behavior: contain;
  /* Scroll shadows: a visible edge where more buttons are scrolled out of view (and none otherwise). */
  background:
    linear-gradient(var(--surface) 30%, transparent) top / 100% 24px no-repeat local,
    linear-gradient(transparent, var(--surface) 70%) bottom / 100% 24px no-repeat local,
    radial-gradient(farthest-side at 50% 0, rgba(127, 127, 127, .55), transparent) top / 100% 12px no-repeat scroll,
    radial-gradient(farthest-side at 50% 100%, rgba(127, 127, 127, .55), transparent) bottom / 100% 12px no-repeat scroll,
    var(--surface);
}
.wb-toolbar .btn { min-width: 36px; min-height: 36px; padding: 6px; }
.tool-btn[aria-pressed="true"][data-locked="true"] { box-shadow: inset 0 0 0 2px var(--accent); }

/* Style bar (selection) */
.wb-stylebar {
  top: 58px; left: 50%; transform: translateX(-50%); display: flex; flex-wrap: wrap; align-items: center; gap: 4px;
  padding: 4px 6px; max-width: calc(100vw - 120px);
}
@media (min-width: 601px) {
  .wb-app.following .wb-stylebar { top: 100px; }
}
.style-group { display: flex; align-items: center; gap: 2px; }
.style-group-label { font-size: 11px; color: var(--text-3); padding: 0 4px 0 2px; text-transform: uppercase; letter-spacing: .04em; }
.swatches { display: flex; gap: 3px; flex-wrap: wrap; align-items: center; }
/* The border has at least 3:1 contrast in both schemes, so white and near-black swatches show too. */
.swatch {
  width: 24px; height: 24px; border-radius: 50%; border: 2px solid var(--text-3); padding: 0; flex: none;
}
.swatch[aria-checked="true"], .swatch[aria-pressed="true"] { border-color: var(--text); box-shadow: inset 0 0 0 2px var(--surface); border-width: 3px; }
.swatch.none { background: linear-gradient(135deg, transparent 45%, var(--danger) 45%, var(--danger) 55%, transparent 55%), var(--surface); }
.swatch-chip { width: 18px; height: 18px; min-height: 0; border-width: 1px; border-color: var(--text-3); }
.wb-stylebar .btn { min-height: 30px; }
.wb-stylebar .btn.small { min-width: 30px; }
.move-group .btn, .size-group .btn { padding: 4px; min-width: 30px; }
.size-field { display: inline-flex; align-items: center; gap: 3px; font-size: 11px; color: var(--text-3); margin-left: 4px; }
.size-field input { width: 6ch; padding: 3px 5px; font-size: 13px; color: var(--text); font-variant-numeric: tabular-nums; }
.size-field input::placeholder { color: var(--text-3); }

/* Bottom right: zoom and minimap */
.wb-zoom { right: 10px; bottom: 10px; display: flex; align-items: center; gap: 2px; padding: 3px; }
.zoom-level { min-width: 56px; font-variant-numeric: tabular-nums; }
.wb-minimap {
  right: 10px; bottom: 56px; width: 200px; height: 140px; padding: 0; overflow: hidden; cursor: pointer;
  touch-action: none; background: #fbfbfa;
}
.wb-minimap canvas { display: block; width: 100%; height: 100%; }
.wb-minimap:focus-visible { border-radius: var(--radius); }
.minimap-toggle { right: 10px; bottom: 56px; }

/* Undo/redo */
.wb-history { left: 10px; bottom: 10px; display: flex; gap: 2px; padding: 3px; }

/* Panels */
.wb-panel {
  position: fixed; top: 0; right: 0; bottom: 0; width: min(380px, 100vw); z-index: 30;
  background: var(--surface); color: var(--text); box-shadow: var(--shadow-3); display: flex; flex-direction: column;
  animation: wb-slide-in .16s ease-out;
}
@keyframes wb-slide-in { from { transform: translateX(24px); opacity: .6; } }
.panel-head { display: flex; align-items: center; gap: 8px; padding: 12px 12px 10px 16px; border-bottom: 1px solid var(--border); }
.panel-head h2 { margin: 0; font-size: 16px; flex: 1; }
.panel-list { flex: 1; overflow-y: auto; padding: 6px 10px 16px; margin: 0; list-style: none; display: flex; flex-direction: column; }
.panel-list > li { display: flex; gap: 8px; padding: 8px 4px; border-bottom: 1px solid var(--border); align-items: center; }
.panel-list .summary { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.panel-list .when { font-size: 12px; color: var(--text-3); }
.panel-filter { margin: 10px 12px 0; }
.panel-filter input { width: 100%; }
.outline-item .kind { font-size: 11px; font-weight: 600; text-transform: uppercase; color: var(--text-3); letter-spacing: .04em; display: block; }
.outline-item .excerpt { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.outline-item[aria-current="true"] { background: var(--accent-soft); border-radius: var(--radius-sm); }
.muted { color: var(--text-3); font-size: 13px; }

/* Dialogs, menus, toasts */
.modal-scrim { position: fixed; inset: 0; background: rgba(10, 14, 22, .45); z-index: 50; display: flex; align-items: center; justify-content: center; padding: 16px; }
.modal { background: var(--surface); color: var(--text); border-radius: 12px; box-shadow: var(--shadow-3); width: min(420px, 100%); padding: 20px; display: flex; flex-direction: column; gap: 14px; }
.modal h2 { margin: 0; font-size: 17px; }
.modal p { margin: 0; color: var(--text-2); }
.modal input[type="text"], .modal input:not([type]) { width: 100%; padding: 8px 10px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
.menu {
  position: fixed; z-index: 40; background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 8px;
  box-shadow: var(--shadow-2); padding: 4px; min-width: 180px; display: flex; flex-direction: column;
}
.menu .btn { justify-content: flex-start; width: 100%; }
.toasts { position: fixed; top: 60px; left: 50%; transform: translateX(-50%); z-index: 60; display: flex; flex-direction: column; gap: 8px; width: min(440px, calc(100vw - 32px)); pointer-events: none; }
.toast { pointer-events: auto; background: #2b1d1d; color: #fff; border-radius: 8px; padding: 8px 8px 8px 14px; box-shadow: var(--shadow-2); display: flex; gap: 8px; align-items: center; }
.toast .msg { flex: 1; overflow-wrap: anywhere; }
.toast .btn { color: #fff; }
.toast .btn:hover { background: rgba(255,255,255,.15); color: #fff; }

/* Phones: tools become a bottom bar, the style bar a bottom sheet, the minimap goes. */
@media (max-width: 600px) {
  .wb-topbar { top: 6px; left: 6px; max-width: calc(100vw - 12px - 150px); }
  .board-title .inline-edit-display { max-width: 16ch; font-size: 14px; }
  .conn:not(.conn-warn) .conn-text { display: none; }
  .conn { min-width: 0; }
  .wb-topright { top: 6px; right: 6px; }
  .me-btn .me-name { display: none; }
  .me-btn { padding: 2px; }
  .wb-toolbar {
    top: auto; left: 0; right: 0; bottom: 0; transform: none; flex-direction: row; max-height: none;
    border-radius: 0; border-width: 1px 0 0; overflow-x: auto; overflow-y: hidden;
    padding: 4px 6px calc(4px + env(safe-area-inset-bottom, 0px)); justify-content: flex-start;
    background:
      linear-gradient(to right, var(--surface) 30%, transparent) left / 24px 100% no-repeat local,
      linear-gradient(to right, transparent, var(--surface) 70%) right / 24px 100% no-repeat local,
      radial-gradient(farthest-side at 0 50%, rgba(127, 127, 127, .6), transparent) left / 14px 100% no-repeat scroll,
      radial-gradient(farthest-side at 100% 50%, rgba(127, 127, 127, .6), transparent) right / 14px 100% no-repeat scroll,
      var(--surface);
  }
  .wb-toolbar .wb-sep { width: 1px; height: auto; margin: 4px 2px; }
  .wb-toolbar .btn { min-width: 44px; min-height: 44px; }
  .wb-history { left: 6px; bottom: 64px; }
  .wb-zoom { right: 6px; bottom: 64px; }
  .zoom-level { min-width: 48px; }
  .wb-minimap, .minimap-toggle { display: none !important; }
  .wb-stylebar {
    top: auto; left: 0; right: 0; bottom: 56px; transform: none; max-width: none; border-radius: 14px 14px 0 0;
    border-width: 1px 0 0; padding: 8px 8px 10px; max-height: 45vh; overflow-y: auto; box-shadow: var(--shadow-2);
    justify-content: flex-start; row-gap: 8px;
  }
  .wb-stylebar ~ .wb-history, .wb-app.has-selection .wb-history, .wb-app.has-selection .wb-zoom { display: none; }
  .wb-stylebar .style-group { flex-wrap: wrap; row-gap: 4px; }
  /* Touch targets of at least 44px. */
  .wb-stylebar .btn, .wb-stylebar .btn.small { min-height: 44px; min-width: 44px; }
  .size-field input { min-height: 44px; }
  .menu .btn { min-height: 44px; }
  .swatch-pop .swatch { width: 44px; height: 44px; }
  .modal .swatch { width: 44px; height: 44px; }
  .modal-actions .btn { min-height: 44px; }
  .follow-chip { top: 50px; }
  .wb-panel { width: 100vw; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
}
`;
