// @ts-check
// All CSS, injected once. Light and dark follow the viewer's system setting.

const CSS = `
:root {
  --bg: #f4f5f7; --surface: #fff; --surface-2: #f8f9fb; --border: #d8dce3; --border-strong: #b6bdc9;
  --text: #1a1f2b; --text-2: #4b5363; --text-3: #6b7280;
  --accent: #2554c7; --accent-hover: #1d44a6; --accent-soft: #e0e8fb; --on-accent: #fff;
  --ok: #1f7a3a; --ok-soft: #e1f3e6; --warn: #8a5a00; --warn-soft: #fff3d4; --danger: #b42318; --danger-soft: #fde8e6;
  --win: #b7791f; --win-soft: #fdf3dc;
  --shadow: 0 1px 2px rgba(16,24,40,.06), 0 1px 3px rgba(16,24,40,.1); --shadow-lift: 0 10px 28px rgba(16,24,40,.22);
  --radius: 10px; --focus: 0 0 0 3px rgba(37,84,199,.45);
  --font: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #121418; --surface: #1b1e24; --surface-2: #22262e; --border: #343a45; --border-strong: #4a5261;
    --text: #e8ebf1; --text-2: #b4bbc8; --text-3: #8b93a3;
    --accent: #7ea2ff; --accent-hover: #9bb7ff; --accent-soft: #24304d; --on-accent: #0d1220;
    --ok: #6fd08c; --ok-soft: #173222; --warn: #f0c060; --warn-soft: #3a2d10; --danger: #ff8a80; --danger-soft: #3b1a18;
    --win: #f0c060; --win-soft: #3a2d10;
    --shadow: 0 1px 2px rgba(0,0,0,.4); --shadow-lift: 0 12px 30px rgba(0,0,0,.55);
    --focus: 0 0 0 3px rgba(126,162,255,.5);
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 var(--font); }
button, input, textarea, select { font: inherit; color: inherit; }
button { cursor: pointer; }
:focus-visible { outline: none; box-shadow: var(--focus); }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.app { max-width: 1180px; margin: 0 auto; padding: 16px; }
header.top { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
header.top h1 { margin: 0; font-size: 22px; line-height: 1.25; flex: 1 1 320px; min-width: 0; }
.question-btn { all: unset; cursor: text; border-radius: 6px; padding: 2px 4px; margin: -2px -4px; overflow-wrap: anywhere; }
.question-btn:hover { background: var(--surface-2); }
.question-btn:focus-visible { box-shadow: var(--focus); }
.question-input { width: 100%; font-size: 20px; font-weight: 600; padding: 4px 8px; border: 1px solid var(--accent); border-radius: 6px; background: var(--surface); }
.chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px; font-size: 12.5px; font-weight: 600; background: var(--surface-2); border: 1px solid var(--border); color: var(--text-2); white-space: nowrap; }
.chip.ok { background: var(--ok-soft); color: var(--ok); border-color: transparent; }
.chip.warn { background: var(--warn-soft); color: var(--warn); border-color: transparent; }
.chip.win { background: var(--win-soft); color: var(--win); border-color: transparent; }
.grid { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 16px; align-items: start; }
@media (max-width: 820px) { .grid { grid-template-columns: minmax(0, 1fr); } }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); padding: 14px; margin-bottom: 14px; }
.card h2 { font-size: 15px; margin: 0 0 8px; }
.muted { color: var(--text-3); }
.small { font-size: 12.5px; }
.btn { border: 1px solid var(--border-strong); background: var(--surface); border-radius: 8px; padding: 6px 12px; font-weight: 600; }
.btn:hover:not(:disabled) { background: var(--surface-2); }
.btn:disabled { opacity: .55; cursor: not-allowed; }
.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
.btn.primary:hover:not(:disabled) { background: var(--accent-hover); }
.btn.big { width: 100%; padding: 10px 14px; font-size: 15px; }
.btn.danger { color: var(--danger); }
.btn.link { border: 0; background: none; padding: 2px 4px; color: var(--accent); font-weight: 500; }
.btn.link.danger { color: var(--danger); }
.btn.icon { padding: 3px 7px; min-width: 30px; }
input.text, textarea.text, select.text { width: 100%; border: 1px solid var(--border-strong); background: var(--surface); border-radius: 8px; padding: 7px 10px; }
textarea.text { resize: vertical; min-height: 64px; }
.row { display: flex; gap: 8px; align-items: center; }
.row > .grow { flex: 1; min-width: 0; }
.banner { border-radius: var(--radius); padding: 10px 14px; margin-bottom: 14px; border: 1px solid transparent; }
.banner.warn { background: var(--warn-soft); color: var(--warn); }
.banner.error { background: var(--danger-soft); color: var(--danger); display: flex; gap: 10px; align-items: center; }
.banner.error .grow { flex: 1; }
.toast-area { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 50; display: grid; gap: 6px; width: min(520px, calc(100% - 32px)); pointer-events: none; }
.toast { pointer-events: auto; background: var(--danger-soft); color: var(--danger); border: 1px solid var(--danger); border-radius: 8px; padding: 8px 12px; box-shadow: var(--shadow-lift); }

.ranking { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.opt { position: relative; display: grid; grid-template-columns: auto auto minmax(0, 1fr) auto; gap: 10px; align-items: start; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 10px 10px 6px; box-shadow: var(--shadow); }
.opt.is-new { border-color: var(--warn); box-shadow: 0 0 0 1px var(--warn); }
.opt.dragging { z-index: 5; box-shadow: var(--shadow-lift); border-color: var(--accent); transition: none; }
.opt.settle { transition: transform .12s ease; }
.handle { border: 0; background: none; padding: 6px 4px; border-radius: 6px; color: var(--text-3); cursor: grab; touch-action: none; line-height: 0; }
.handle:hover { background: var(--surface-2); color: var(--text); }
.handle:disabled { cursor: default; opacity: .35; }
.opt.dragging .handle { cursor: grabbing; }
.rank { font-weight: 700; font-size: 16px; min-width: 26px; text-align: right; padding-top: 4px; color: var(--text-2); font-variant-numeric: tabular-nums; }
.opt-body { min-width: 0; }
.opt-line { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; }
.opt-title { all: unset; cursor: pointer; font-weight: 700; font-size: 16px; overflow-wrap: anywhere; border-radius: 4px; }
.opt-title:focus-visible { box-shadow: var(--focus); }
.opt-title:hover { text-decoration: underline; }
.badge { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; border-radius: 4px; padding: 1px 6px; background: var(--warn-soft); color: var(--warn); }
.by { font-size: 12.5px; color: var(--text-3); }
.own-actions { display: inline-flex; gap: 2px; margin-left: auto; }
.summary { margin-top: 4px; display: grid; gap: 2px; font-size: 13px; color: var(--text-2); }
.summary .desc { white-space: pre-line; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.facts { display: flex; flex-wrap: wrap; gap: 4px 12px; }
.fact b { font-weight: 600; color: var(--text-3); font-size: 12px; }
.fact span { overflow-wrap: anywhere; }
.moves { display: flex; flex-direction: column; gap: 2px; }
.moves .btn { padding: 0 6px; line-height: 20px; font-size: 12px; }
.details { margin-top: 10px; display: grid; gap: 10px; border-top: 1px dashed var(--border); padding-top: 10px; }
.details label { display: grid; gap: 4px; font-size: 12.5px; font-weight: 600; color: var(--text-2); }
.details .saved { font-size: 12px; color: var(--ok); font-weight: 500; }
.details .actions { display: flex; flex-wrap: wrap; gap: 8px; }
.locked .opt { box-shadow: none; }
.add-option { display: grid; gap: 8px; }
.new-fields { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; }
.new-fields label { display: grid; gap: 4px; font-size: 12.5px; font-weight: 600; color: var(--text-2); }
.new-fields label.wide { grid-column: 1 / -1; }
.list-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap; margin: 4px 0 8px; }
.list-head h2 { margin: 0; font-size: 16px; }

.voters { list-style: none; padding: 0; margin: 8px 0 0; display: grid; gap: 4px; }
.voters li { display: flex; align-items: center; gap: 8px; }
.voters .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dot { width: 9px; height: 9px; border-radius: 50%; background: var(--border-strong); flex: none; }
.dot.ready { background: var(--ok); }
.fields-list { list-style: none; padding: 0; margin: 0 0 10px; display: grid; gap: 4px; }
.fields-list li { display: flex; align-items: center; gap: 8px; }
.fields-list .kind { font-size: 11.5px; color: var(--text-3); }
.activity { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; font-size: 12.5px; color: var(--text-2); max-height: 280px; overflow: auto; }
.activity time { color: var(--text-3); margin-right: 4px; }

.results { border: 2px solid var(--win); }
.winner { display: flex; align-items: center; gap: 12px; margin: 4px 0 12px; }
.winner .trophy { font-size: 30px; }
.winner .name { font-size: 26px; font-weight: 800; line-height: 1.15; overflow-wrap: anywhere; }
.table-wrap { overflow-x: auto; }
table.rounds { border-collapse: collapse; width: 100%; font-size: 13px; font-variant-numeric: tabular-nums; }
table.rounds th, table.rounds td { padding: 5px 8px; border-bottom: 1px solid var(--border); text-align: left; white-space: nowrap; }
table.rounds th:first-child, table.rounds td:first-child { position: sticky; left: 0; background: var(--surface); white-space: normal; min-width: 140px; }
table.rounds td.n { position: relative; min-width: 64px; }
table.rounds td.n .bar { position: absolute; left: 0; top: 4px; bottom: 4px; background: var(--accent-soft); border-radius: 3px; z-index: 0; }
table.rounds td.n span { position: relative; z-index: 1; }
table.rounds td.out { color: var(--danger); font-weight: 600; }
table.rounds td.gone { color: var(--text-3); }
table.rounds tr.won td:first-child { font-weight: 800; color: var(--win); }
.narrative { margin: 10px 0 0; padding-left: 18px; font-size: 13px; color: var(--text-2); display: grid; gap: 3px; }
details.past { margin-top: 10px; }
details.past summary { cursor: pointer; font-weight: 600; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 12px; }
`;

/** Adds the built-in CSS, then `extra` (client.js adapt.styles) so it wins. @param {string} [extra] */
export function injectStyles(extra = "") {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
  if (typeof extra === "string" && extra.trim()) {
    const custom = document.createElement("style");
    custom.dataset.adapt = "";
    custom.textContent = extra;
    document.head.appendChild(custom);
  }
}
