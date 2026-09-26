// @ts-check
// Work board styles. Calm and dense: system fonts, a 4/8 px grid, tokens with a dark set. Text is
// ≥ 4.5:1 and UI parts ≥ 3:1 in both themes; meaning never rides on colour alone (icons and text
// carry it); every control is ≥ 24 px; motion is off under prefers-reduced-motion.
export const CSS = `
:root {
  --bg: #f6f7f9; --surface: #ffffff; --surface-2: #f0f2f5; --surface-3: #e6e9ee; --raised: #ffffff;
  --ink: #16181d; --ink-2: #3a404c; --muted: #5a6170; --faint: #6b7280;
  --line: #e0e3e8; --line-strong: #c9ced6; --field-line: #858c99; --col-bg: #f1f3f6;
  --accent: #4b56d2; --accent-ink: #ffffff; --accent-soft: #eceefd; --accent-line: #b9befa; --focus: #3d48c8;
  --ok: #17784a; --ok-bg: #e4f5ec; --warn: #845400; --warn-bg: #fff3d1; --bad: #b42318; --bad-bg: #fde9e7; --info-bg: #eceefd;
  --overdue: #b42318; --blocked: #c2410c;
  --p1: #d92d20; --p2: #3a404c; --p3: #3a404c; --p4: #3a404c; --p0: #6b7280;
  --shadow-1: 0 1px 1px rgba(16, 24, 40, .04), 0 1px 2px rgba(16, 24, 40, .06);
  --shadow-2: 0 2px 4px rgba(16, 24, 40, .06), 0 6px 16px rgba(16, 24, 40, .08);
  --shadow-pop: 0 16px 40px rgba(16, 24, 40, .18), 0 2px 8px rgba(16, 24, 40, .08);
  --radius: 8px; --radius-lg: 12px;
  --col-w: clamp(248px, calc((100vw - 104px) / 5), 320px); --col-collapsed: 44px; --head-h: 44px; --lane-h: 40px;
  --font: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0e1014; --surface: #16191f; --surface-2: #1b1f26; --surface-3: #242933; --raised: #1c2028;
    --ink: #eceef2; --ink-2: #c7ccd5; --muted: #a0a7b4; --faint: #8f97a5;
    --line: #2a2f38; --line-strong: #3b414c; --field-line: #6d7482; --col-bg: #13161b;
    --accent: #8f97ff; --accent-ink: #0e1014; --accent-soft: #23264a; --accent-line: #4b52a8; --focus: #a9b0ff;
    --ok: #5fd39a; --ok-bg: #12301f; --warn: #f2c35b; --warn-bg: #33280f; --bad: #ff8b7e; --bad-bg: #3a1714; --info-bg: #1f2340;
    --overdue: #ff8b7e; --blocked: #fb923c;
    --p1: #ff6b5e; --p2: #c7ccd5; --p3: #c7ccd5; --p4: #c7ccd5; --p0: #8f97a5;
    --shadow-1: 0 1px 2px rgba(0, 0, 0, .4); --shadow-2: 0 4px 14px rgba(0, 0, 0, .45); --shadow-pop: 0 18px 48px rgba(0, 0, 0, .6);
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { margin: 0; height: 100%; }
body { background: var(--bg); color: var(--ink); font: 13px/1.45 var(--font); -webkit-font-smoothing: antialiased; }
button, input, select, textarea { font: inherit; color: inherit; }
h1, h2, h3, h4 { margin: 0; }
kbd { font: 11px/1 var(--mono); padding: 3px 5px; border-radius: 4px; border: 1px solid var(--line-strong); border-bottom-width: 2px; background: var(--surface); color: var(--ink-2); }
.sr-only { position: absolute !important; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.grow { flex: 1; }
.muted { color: var(--muted); }
.hint { color: var(--muted); font-size: 12px; margin: 4px 0; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.icon { flex: none; display: block; }
.state-icon { color: var(--c-light, currentColor); }
@media (prefers-color-scheme: dark) { .state-icon { color: var(--c-dark, currentColor); } }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-radius: 4px; }
.skip-link { position: absolute; left: 8px; top: -40px; z-index: 100; background: var(--accent); color: var(--accent-ink); padding: 8px 12px; border-radius: 6px; }
.skip-link:focus { top: 8px; }

/* Buttons */
.btn { display: inline-flex; align-items: center; gap: 6px; min-height: 28px; padding: 4px 10px; border-radius: 6px; border: 1px solid var(--line-strong); background: var(--surface); color: var(--ink); cursor: pointer; white-space: nowrap; }
.btn:hover:not(:disabled) { background: var(--surface-2); }
.btn:disabled { opacity: .55; cursor: not-allowed; }
.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); font-weight: 550; }
.btn.primary:hover:not(:disabled) { filter: brightness(1.06); background: var(--accent); }
.btn.ghost { border-color: transparent; background: transparent; color: var(--ink-2); }
.btn.ghost:hover:not(:disabled) { background: var(--surface-2); }
.btn.sm { min-height: 24px; padding: 2px 8px; font-size: 12px; }
.btn.toggle.on, .btn[aria-pressed="true"] { background: var(--accent-soft); border-color: var(--accent-line); color: var(--ink); }
.btn kbd { margin-left: 4px; }
.icon-btn { display: inline-flex; align-items: center; justify-content: center; min-width: 28px; min-height: 28px; border-radius: 6px; border: 1px solid transparent; background: transparent; color: var(--ink-2); cursor: pointer; padding: 0; }
.icon-btn.sm { min-width: 24px; min-height: 24px; }
.icon-btn:hover:not(:disabled) { background: var(--surface-3); color: var(--ink); }
.icon-btn:disabled { opacity: .45; cursor: not-allowed; }
.x { font-size: 18px; line-height: 1; }
.link { border: 0; background: none; color: var(--accent); padding: 0; cursor: pointer; text-align: left; font: inherit; }
.link:hover { text-decoration: underline; }
input[type=text], input[type=number], input[type=date], select, textarea { background: var(--surface); border: 1px solid var(--field-line); border-radius: 6px; padding: 5px 8px; min-height: 30px; }
input[type=color] { width: 36px; height: 28px; padding: 2px; border: 1px solid var(--field-line); border-radius: 6px; background: var(--surface); }
input[type=checkbox] { width: 16px; height: 16px; accent-color: var(--accent); margin: 0; }
textarea { width: 100%; resize: vertical; line-height: 1.5; }
.check-label { display: inline-flex; align-items: center; gap: 8px; min-height: 28px; cursor: pointer; }
.field { display: flex; flex-direction: column; gap: 4px; margin: 8px 0; }
.field.inline { flex-direction: row; align-items: center; justify-content: space-between; gap: 12px; }
.field label { font-size: 12px; color: var(--ink-2); font-weight: 550; }
.field-error { color: var(--bad); font-size: 12px; margin: 2px 0 0; min-height: 0; }
.field-error:empty { display: none; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 10px; }
.row.end { justify-content: flex-end; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex: none; }
.dot.lg { width: 10px; height: 10px; }

/* Shell */
.wb-app { display: flex; flex-direction: column; height: 100%; min-height: 0; position: relative; }
.topbar { display: flex; align-items: center; gap: 8px; padding: 8px 16px; min-height: 52px; border-bottom: 1px solid var(--line); background: var(--surface); flex-wrap: wrap; }
.brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
.brand-mark { width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center; background: var(--accent); color: var(--accent-ink); flex: none; }
.brand-text { display: flex; flex-direction: column; min-width: 0; }
.brand h1 { font-size: 15px; font-weight: 650; letter-spacing: -.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.brand .sub { font-size: 12px; color: var(--muted); }
.live { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); padding: 0 8px; }
.live .dot { background: var(--ok); box-shadow: 0 0 0 3px var(--ok-bg); }
.live.retrying .dot { background: var(--warn); box-shadow: 0 0 0 3px var(--warn-bg); }
.live.offline .dot { background: var(--bad); box-shadow: 0 0 0 3px var(--bad-bg); }
.palette-btn { color: var(--muted); min-width: 220px; justify-content: flex-start; background: var(--surface-2); border-color: var(--line); }
.palette-btn .palette-label { flex: 1; text-align: left; }
.banners:empty { display: none; }
.banner { display: flex; align-items: center; gap: 10px; margin: 8px 16px 0; padding: 8px 12px; border-radius: var(--radius); font-size: 13px; }
.banner.warn { background: var(--warn-bg); color: var(--warn); }
.banner.info { background: var(--info-bg); color: var(--ink-2); }
.toolbar { display: flex; align-items: flex-start; gap: 8px 12px; padding: 10px 16px 6px; flex-wrap: wrap; }
.view-controls { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.view-switch { font-weight: 550; max-width: 240px; }
.view-name { overflow: hidden; text-overflow: ellipsis; }
.dirty-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); display: inline-block; }
.segmented { display: inline-flex; border: 1px solid var(--line-strong); border-radius: 7px; padding: 2px; background: var(--surface-2); gap: 2px; }
.seg { display: inline-flex; align-items: center; gap: 5px; min-height: 24px; padding: 2px 9px; border: 0; border-radius: 5px; background: transparent; color: var(--ink-2); cursor: pointer; }
.seg[aria-pressed="true"] { background: var(--surface); color: var(--ink); box-shadow: var(--shadow-1); font-weight: 550; }

/* Filter bar */
.filterbar { flex: 1 1 520px; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.filter-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.filter-row.second { min-height: 24px; }
.wql-field { position: relative; flex: 1 1 360px; min-width: 0; display: flex; align-items: center; gap: 4px; border: 1px solid var(--field-line); border-radius: 8px; background: var(--surface); padding: 0 4px 0 8px; min-height: 32px; }
.wql-field:focus-within { border-color: var(--focus); box-shadow: 0 0 0 3px var(--accent-soft); }
.wql-field.invalid { border-color: var(--bad); }
.wql-icon { color: var(--muted); display: grid; place-items: center; }
.wql-wrap { position: relative; flex: 1; min-width: 0; height: 30px; }
.wql-input, .wql-layer { position: absolute; inset: 0; font: 13px/30px var(--mono); padding: 0 4px; margin: 0; border: 0; letter-spacing: 0; white-space: pre; }
.wql-field .wql-input { background: transparent; border: 0; border-radius: 0; color: transparent; caret-color: var(--ink); outline: none; width: 100%; min-height: 0; padding: 0 4px; }
.wql-input::placeholder { color: var(--muted); font-family: var(--font); }
.wql-input::selection { background: var(--accent-soft); color: var(--ink); }
.wql-layer { overflow: hidden; color: var(--ink); pointer-events: none; }
.tk-field { color: #7a3fc4; } .tk-op { color: var(--ink-2); } .tk-value { color: #0d6b6e; } .tk-keyword { color: #a3470a; font-weight: 650; }
.tk-paren { color: var(--muted); } .tk-neg { color: var(--bad); font-weight: 650; } .tk-text { color: var(--ink); } .tk-sort { color: #1f5fa8; } .tk-error { color: var(--bad); text-decoration: wavy underline; }
@media (prefers-color-scheme: dark) { .tk-field { color: #c9a5ff; } .tk-value { color: #6fd7d2; } .tk-keyword { color: #ffae6b; } .tk-sort { color: #8cc4ff; } }
.wql-suggest { position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 40; list-style: none; margin: 0; padding: 4px; background: var(--raised); border: 1px solid var(--line); border-radius: 10px; box-shadow: var(--shadow-pop); max-height: 280px; overflow: auto; }
.wql-opt { display: flex; justify-content: space-between; gap: 12px; padding: 6px 8px; border-radius: 6px; cursor: pointer; font-family: var(--mono); font-size: 12.5px; min-height: 28px; align-items: center; }
.wql-opt[aria-selected="true"], .wql-opt:hover { background: var(--accent-soft); }
.opt-detail { color: var(--muted); font-family: var(--font); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wql-status { font-size: 12px; color: var(--muted); display: flex; gap: 8px; align-items: center; flex-wrap: wrap; flex: 1 1 260px; min-width: 0; }
.wql-desc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wql-desc strong { color: var(--ink); }
.wql-error { color: var(--bad); }
.quick { display: flex; gap: 4px; flex-wrap: wrap; }
.chips { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.filter-chip { display: inline-flex; align-items: stretch; border: 1px solid var(--accent-line); background: var(--accent-soft); border-radius: 6px; overflow: hidden; font-family: var(--mono); font-size: 12px; }
.filter-chip.negated { border-color: var(--bad); background: var(--bad-bg); }
.filter-chip.advanced { padding: 2px 8px; align-items: center; }
.chip-main, .chip-x { border: 0; background: transparent; color: var(--ink); cursor: pointer; min-height: 24px; padding: 0 8px; }
.chip-x { border-left: 1px solid var(--accent-line); padding: 0 6px; font-size: 14px; min-width: 24px; }
.chip-main:hover, .chip-x:hover { background: rgba(127, 127, 127, .15); }

/* Layout */
.body { flex: 1; min-height: 0; display: flex; position: relative; }
.main { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; position: relative; outline: none; }
.layout-host { flex: 1; min-height: 0; display: flex; flex-direction: column; position: relative; }
.state-host { flex: 1; overflow: auto; }
.state-panel { max-width: 560px; margin: 48px auto; padding: 24px 28px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-lg); box-shadow: var(--shadow-2); }
.state-panel h2 { font-size: 18px; margin-bottom: 8px; }
.state-panel ol { padding-left: 20px; }
.empty-overlay { position: absolute; top: 72px; left: 50%; transform: translateX(-50%); background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-lg); box-shadow: var(--shadow-2); padding: 12px 16px; display: flex; gap: 12px; align-items: center; z-index: 5; }
.empty-overlay p { margin: 0; }

/* Skeleton */
.skeleton { display: flex; gap: 12px; padding: 12px 16px; }
.sk-col { width: var(--col-w); flex: none; display: flex; flex-direction: column; gap: 8px; padding: 8px; border-radius: 10px; background: var(--col-bg); }
.sk-head { height: 18px; width: 50%; border-radius: 6px; background: var(--surface-3); margin: 4px 4px 8px; }
.sk-card { height: 84px; border-radius: var(--radius); background: var(--surface); border: 1px solid var(--line); position: relative; overflow: hidden; }
.sk-card::after, .sk-head::after { content: ""; position: absolute; inset: 0; background: linear-gradient(90deg, transparent, rgba(127, 127, 127, .12), transparent); transform: translateX(-100%); }

/* Board */
.board-view { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.board-scroll { flex: 1; min-height: 0; overflow: auto; padding: 0 16px 96px; outline: none; scroll-padding: calc(var(--head-h) + var(--lane-h) + 8px) 24px 96px var(--col-collapsed); }
.board-grid { display: grid; grid-template-columns: var(--cols); column-gap: 10px; width: max-content; min-width: 100%; }
.col-headers, .lanes, .lane, .lane-cells { display: contents; }
.col-head { position: sticky; top: 0; z-index: 4; display: flex; align-items: center; gap: 4px; height: var(--head-h); padding: 0 6px 0 8px; background: var(--bg); border-bottom: 2px solid transparent; }
.col-head.over-wip { border-bottom-color: var(--bad); }
.col-title { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; min-width: 0; }
.col-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.col-icon { display: grid; place-items: center; }
.col-count { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; padding: 1px 6px; border-radius: 10px; }
.col-count.over { color: var(--bad); background: var(--bad-bg); font-weight: 650; }
.col-est { color: var(--muted); font-size: 11.5px; }
.col-head.collapsed { flex-direction: column; justify-content: flex-start; height: auto; padding: 8px 0; gap: 8px; }
.col-head.collapsed .col-title { writing-mode: vertical-rl; }
.col-head.collapsed .col-icon { writing-mode: horizontal-tb; }
.lane-head { grid-column: 1 / -1; position: sticky; top: var(--head-h); z-index: 3; background: var(--bg); height: var(--lane-h); display: flex; align-items: center; border-top: 1px solid var(--line); margin-top: 4px; }
.lane-head-inner { position: sticky; left: 0; display: inline-flex; align-items: center; }
.lane-title { font-size: 13px; font-weight: 600; }
.lane-toggle { display: inline-flex; align-items: center; gap: 8px; min-height: 30px; padding: 2px 8px 2px 4px; border: 0; background: transparent; color: var(--ink); cursor: pointer; border-radius: 6px; font: inherit; font-weight: 600; }
.lane-toggle:hover { background: var(--surface-3); }
.lane-count { color: var(--muted); font-weight: 500; font-size: 12px; font-variant-numeric: tabular-nums; }
.lane-est { color: var(--muted); font-weight: 500; font-size: 11.5px; }
.lane-icon { display: grid; place-items: center; }
.cell { list-style: none; margin: 0 0 8px; padding: 6px; border-radius: 10px; background: var(--col-bg); display: flex; flex-direction: column; gap: var(--card-gap); min-height: 64px; border: 1px dashed transparent; }
.cell.collapsed { padding: 0; background: repeating-linear-gradient(135deg, var(--col-bg) 0 6px, transparent 6px 12px); min-height: 24px; }
.cell.drop-over { border-color: var(--accent); background: var(--accent-soft); }
.cell > li { flex: none; }
.cell .spacer { list-style: none; padding: 0; margin: 0; }
.cell-empty { display: flex; align-items: center; justify-content: center; min-height: 52px; color: var(--muted); font-size: 12px; border-radius: var(--radius); text-align: center; padding: 8px; }
.cell-empty:focus-visible { outline-offset: -2px; }
.cell-empty { position: relative; gap: 6px; }
.cell-add { display: inline-grid; place-items: center; width: 28px; height: 28px; border-radius: 6px; border: 1px dashed var(--line-strong); background: var(--surface); color: var(--ink-2); cursor: pointer; opacity: 0; }
.cell-add:hover { border-color: var(--accent); color: var(--accent); }
.cell-empty:hover .cell-add, .cell-empty:focus .cell-add, .cell-empty:focus-within .cell-add { opacity: 1; }
@media (hover: none) { .cell-add { opacity: 1; } }
/* Lanes size to their content: an empty cell is a slim, quiet drop zone, not a tall box. */
.has-lanes .cell { min-height: 44px; }
.has-lanes .cell:has(> .cell-empty) { align-self: start; min-height: 44px; padding: 4px; background: transparent; border: 1px dashed var(--line); }
.has-lanes .cell-empty { min-height: 34px; padding: 2px 6px; justify-content: space-between; }
.has-lanes .cell-empty .empty-text { opacity: 0; }
.has-lanes .cell-empty:hover .empty-text, .has-lanes .cell-empty:focus .empty-text, .has-lanes .cell-empty:focus-within .empty-text { opacity: 1; }
.cell.drop-over:has(> .cell-empty) { border-color: var(--accent); background: var(--accent-soft); }
.drop-line { height: 2px; background: var(--accent); border-radius: 2px; margin: -1px 4px; }
.drop-target .drop-card { height: calc(var(--card-h) - 8px); border: 2px dashed var(--accent); border-radius: var(--radius); display: grid; place-items: center; color: var(--accent); font-weight: 600; background: var(--accent-soft); }

/* Cards */
.card { position: relative; height: var(--card-h); display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow-1); cursor: pointer; overflow: hidden; outline: none; touch-action: manipulation; user-select: none; }
.card:hover { border-color: var(--line-strong); }
.card:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
.card.selected { border-color: var(--accent); background: var(--accent-soft); }
.card.pending { border-style: dashed; border-color: var(--warn); }
.card.mirror { opacity: .88; }
.card.done .card-title { color: var(--ink-2); }
.card-top { display: flex; align-items: center; gap: 6px; min-height: 20px; }
.card-key { font: 11.5px/1 var(--mono); color: var(--muted); letter-spacing: -.01em; white-space: nowrap; }
.check-hit { display: inline-grid; place-items: center; width: 24px; height: 24px; flex: none; cursor: pointer; border-radius: 5px; }
.check-hit:hover { background: var(--surface-3); }
.card-check { opacity: 0; position: absolute; left: 2px; top: 6px; margin: 0; }
.card:hover .card-check, .card:focus-within .card-check, .card.selected .card-check, .has-bulk .card-check { opacity: 1; position: static; margin: -2px -2px -2px -6px; }
.card-menu { opacity: 0; min-width: 24px; min-height: 24px; border: 0; background: transparent; color: var(--ink-2); border-radius: 5px; display: grid; place-items: center; cursor: pointer; margin-right: -4px; }
.card:hover .card-menu, .card:focus .card-menu, .card:focus-within .card-menu { opacity: 1; }
.card-menu:hover { background: var(--surface-3); }
@media (hover: none) { .card-menu, .card-check { opacity: 1; position: static; } }
.card-title { font-weight: 550; line-height: 1.35; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.card.compact { gap: 2px; padding: 6px 8px; }
.card.compact .card-title { -webkit-line-clamp: 1; }
.card-meta { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; overflow: hidden; margin-top: auto; height: 20px; row-gap: 8px; }
.card-state { display: grid; place-items: center; }
.snippet { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip { display: inline-flex; align-items: center; gap: 4px; min-height: 20px; padding: 1px 6px; border-radius: 5px; border: 1px solid var(--line); background: var(--surface); font-size: 11.5px; color: var(--ink-2); white-space: nowrap; flex: none; }
.chip.prio .chip-text { display: none; }
.chip.prio.p1 { color: var(--p1); border-color: transparent; background: transparent; padding: 0 2px; }
.chip.prio.p2, .chip.prio.p3, .chip.prio.p4 { border-color: transparent; background: transparent; padding: 0 2px; }
.chip.blocked { color: var(--blocked); border-color: currentColor; font-weight: 600; }
.chip.due.overdue { color: var(--overdue); border-color: currentColor; font-weight: 600; }
.chip.progress.complete { color: var(--ok); }
.chip.more { color: var(--muted); }
.priority-icon { color: var(--ink-2); }
.priority-icon.p1 { color: var(--p1); }
.avatar { display: inline-grid; place-items: center; border-radius: 50%; color: #fff; font-weight: 650; letter-spacing: -.02em; flex: none; line-height: 1; }
.avatar.none { background: transparent; border: 1.5px dashed var(--line-strong); color: var(--faint); }
.pending-chip { font-size: 11px; font-weight: 600; padding: 1px 7px; border-radius: 10px; background: var(--warn-bg); color: var(--warn); white-space: nowrap; }
.pending-chip.saving { background: var(--surface-3); color: var(--ink-2); }
.pending-chip.applied { background: var(--ok-bg); color: var(--ok); }
.card.ghost { border: 1.5px dashed var(--accent-line); background: var(--accent-soft); box-shadow: none; cursor: default; opacity: .92; }
.card.ghost::before { content: ""; position: absolute; inset: 0; background: linear-gradient(100deg, transparent 30%, rgba(255, 255, 255, .45) 50%, transparent 70%); background-size: 250% 100%; pointer-events: none; }
@media (prefers-color-scheme: dark) { .card.ghost::before { background-image: linear-gradient(100deg, transparent 30%, rgba(255, 255, 255, .08) 50%, transparent 70%); } }
.card.drag-source { opacity: .35; }
.drag-clone { position: fixed; left: 0; top: 0; z-index: 200; pointer-events: none; box-shadow: var(--shadow-pop); border-color: var(--accent); will-change: transform; }
.card.moving { outline: 2px dashed var(--accent); outline-offset: 2px; opacity: .6; }
.dragging, .dragging * { cursor: grabbing !important; }
.card.just-settled { box-shadow: 0 0 0 2px var(--ok), var(--shadow-2); }
.card.just-done::after { content: "✓"; position: absolute; right: 8px; bottom: 8px; width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center; background: var(--ok); color: #fff; font-size: 12px; font-weight: 700; }

/* List */
.list-view { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.list-scroll { flex: 1; min-height: 0; overflow: auto; padding: 0 16px 96px; scroll-padding: 40px 0 96px; }
.list-grid { width: 100%; min-width: fit-content; }
.lg-head, .lg-row { display: grid; grid-template-columns: var(--lg-cols); align-items: center; }
.lg-headgroup { position: sticky; top: 0; z-index: 3; background: var(--bg); }
.lg-th { padding: 0 8px; height: 36px; display: flex; align-items: center; font-size: 12px; color: var(--muted); font-weight: 600; border-bottom: 1px solid var(--line); }
.th-btn { border: 0; background: transparent; color: inherit; font: inherit; cursor: pointer; display: inline-flex; gap: 4px; align-items: center; min-height: 24px; padding: 0 4px; border-radius: 4px; }
.th-btn:hover { background: var(--surface-3); color: var(--ink); }
.lg-row { height: 40px; border-bottom: 1px solid var(--line); background: var(--surface); cursor: pointer; }
.lg-row:hover { background: var(--surface-2); }
.lg-row.selected { background: var(--accent-soft); }
.lg-td { display: flex; align-items: center; gap: 6px; padding: 0 8px; height: 100%; min-width: 0; white-space: nowrap; overflow: hidden; }
.lg-td.col-labels { flex-wrap: wrap; row-gap: 20px; align-content: center; }
.lg-td:focus-visible { outline-offset: -2px; }
.row-title { font-weight: 550; overflow: hidden; text-overflow: ellipsis; }
.row-check { opacity: .7; margin-left: -4px; }
.lg-group { height: 40px; display: flex; align-items: center; background: var(--bg); border-bottom: 1px solid var(--line); }
.lg-grouphead { display: flex; align-items: center; }
.overdue { color: var(--overdue); font-weight: 600; }

/* Detail */
.detail { width: min(460px, 42vw); flex: none; border-left: 1px solid var(--line); background: var(--surface); display: flex; flex-direction: column; min-height: 0; box-shadow: -8px 0 24px rgba(16, 24, 40, .04); }
.detail[hidden] { display: none; }
.detail-head { display: flex; flex-direction: column; gap: 6px; padding: 8px 12px 12px 16px; border-bottom: 1px solid var(--line); flex: none; }
.detail-bar { display: flex; align-items: center; gap: 8px; min-height: 32px; }
.pills { display: flex; flex-wrap: wrap; gap: 6px; }
.pill { display: inline-flex; align-items: center; gap: 6px; min-height: 28px; padding: 2px 10px 2px 8px; border-radius: 14px; border: 1px solid var(--line-strong); background: var(--surface); color: var(--ink); font: inherit; max-width: 100%; }
button.pill { cursor: pointer; }
button.pill:hover { background: var(--surface-2); border-color: var(--field-line); }
.detail-head .title-edit { font-size: 20px; }
.detail-key { font: 12px var(--mono); color: var(--muted); outline: none; }
.crumb { border: 0; background: var(--surface-2); color: var(--ink-2); border-radius: 5px; padding: 2px 6px; font: 12px var(--mono); cursor: pointer; min-height: 24px; }
.detail-scroll { flex: 1; overflow: auto; padding: 12px 16px 32px; }
.title-edit { font-size: 18px; font-weight: 650; line-height: 1.3; border: 1px solid transparent; background: transparent; padding: 4px 6px; margin: 0 -6px; resize: none; overflow: hidden; width: calc(100% + 12px); min-height: 34px; letter-spacing: -.01em; }
.title-edit:hover { border-color: var(--line); }
.title-edit:focus { border-color: var(--focus); background: var(--surface); outline: none; box-shadow: 0 0 0 3px var(--accent-soft); }
.detail-title { font-size: 18px; font-weight: 650; }
.props { display: grid; grid-template-columns: 96px 1fr; gap: 2px 8px; margin: 12px 0 8px; align-items: center; }
.props dt { color: var(--muted); font-size: 12px; }
.props dd { margin: 0; min-width: 0; }
.prop-value { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-height: 28px; padding: 2px 6px; margin-left: -6px; border: 1px solid transparent; border-radius: 6px; background: transparent; text-align: left; cursor: pointer; max-width: 100%; }
button.prop-value:hover { background: var(--surface-2); border-color: var(--line); }
span.prop-value { cursor: default; }
.detail-section { border-top: 1px solid var(--line); margin-top: 14px; padding-top: 12px; }
.section-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; min-height: 24px; }
.section-head h3 { font-size: 13px; font-weight: 650; }
.progress-bar { width: 80px; height: 6px; border-radius: 3px; background: var(--surface-3); overflow: hidden; display: inline-block; }
.progress-bar span { display: block; height: 100%; background: var(--ok); }
.markdown { line-height: 1.55; overflow-wrap: anywhere; }
.markdown p { margin: 0 0 8px; }
.markdown h3, .markdown h4, .markdown h5, .markdown h6 { margin: 12px 0 6px; font-size: 14px; }
.markdown code { font: 12px var(--mono); background: var(--surface-2); padding: 1px 4px; border-radius: 4px; }
.markdown pre { background: var(--surface-2); padding: 10px 12px; border-radius: 8px; overflow: auto; }
.markdown pre code { background: none; padding: 0; }
.markdown ul, .markdown ol { padding-left: 20px; margin: 0 0 8px; }
.markdown blockquote { margin: 0 0 8px; padding-left: 10px; border-left: 3px solid var(--line-strong); color: var(--ink-2); }
.markdown a { color: var(--accent); }
.md-task.done { color: var(--ok); }
.empty-line { margin: 0; }
.mini-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.mini-list li { display: flex; align-items: center; gap: 4px; }
.mini-item { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; min-height: 30px; padding: 2px 6px; border: 0; background: transparent; border-radius: 6px; cursor: pointer; text-align: left; }
.mini-item:hover { background: var(--surface-2); }
.mini-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.rel-label { font-size: 12px; color: var(--muted); font-weight: 600; margin: 8px 0 2px; }
.is-blocker .blocker-icon { color: var(--blocked); }
.inline-add-row { display: flex; align-items: center; gap: 6px; color: var(--muted); margin-top: 4px; }
.inline-add { flex: 1; border-style: dashed !important; }
.timeline { list-style: none; margin: 0 0 12px; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.event { display: flex; gap: 10px; align-items: baseline; color: var(--ink-2); font-size: 12.5px; }
.event-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--line-strong); flex: none; transform: translateY(-1px); }
.comment { border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; background: var(--surface); }
.comment-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; font-size: 12.5px; }
.composer { margin-top: 8px; }
.attribution { color: var(--muted); font-size: 12px; margin-top: 18px; }
.notices { display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; }
.notice { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 8px; background: var(--warn-bg); color: var(--warn); font-size: 12.5px; }
.notice.conflict, .notice.rejected { background: var(--bad-bg); color: var(--bad); }
.notice.applied { background: var(--ok-bg); color: var(--ok); }
.notice-text { flex: 1; }

/* Bulk bar */
.bulk-bar { position: absolute; left: 16px; bottom: 16px; z-index: 30; display: flex; align-items: center; gap: 6px; padding: 6px 8px 6px 14px; border-radius: 12px; background: var(--raised); border: 1px solid var(--line-strong); box-shadow: var(--shadow-pop); flex-wrap: wrap; max-width: calc(100% - 32px); }
.bulk-count { font-weight: 650; margin-right: 6px; }

/* Status centre and toasts */
.status-centre { position: absolute; right: 16px; bottom: 16px; z-index: 31; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
.status-btn { display: inline-flex; align-items: center; gap: 8px; min-height: 32px; padding: 4px 12px; border-radius: 16px; border: 1px solid var(--line-strong); background: var(--raised); color: var(--ink); box-shadow: var(--shadow-2); cursor: pointer; font-size: 12.5px; font-weight: 550; }
.status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); flex: none; }
.status-dot.pending { background: var(--warn); }
.status-dot.bad { background: var(--bad); }
.status-panel { width: min(420px, calc(100vw - 32px)); max-height: min(60vh, 520px); overflow: auto; background: var(--raised); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow-pop); padding: 10px 12px; }
.status-head { display: flex; align-items: center; gap: 6px; }
.status-head h2 { font-size: 14px; }
.status-list { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.change { display: flex; gap: 10px; align-items: flex-start; padding: 8px; border-radius: 8px; }
.change:hover { background: var(--surface-2); }
.change .status-dot { margin-top: 5px; }
.change-body { flex: 1; min-width: 0; }
.change-label { font-weight: 550; overflow-wrap: anywhere; min-height: 24px; display: inline-flex; align-items: center; }
.change-status { color: var(--muted); font-size: 12px; }
.change-message { color: var(--bad); font-size: 12px; margin-top: 2px; }
.change-actions { display: flex; gap: 4px; align-items: center; }
.failures { margin: 4px 0 0; padding-left: 16px; font-size: 12px; }
/* Toasts stack above the status button (bottom right), never over it. */
.toasts { position: absolute; right: 16px; bottom: 60px; z-index: 50; display: flex; flex-direction: column; gap: 8px; align-items: flex-end; pointer-events: none; }
.has-bulk .toasts { bottom: 112px; }
.toast { pointer-events: auto; display: flex; align-items: center; gap: 10px; min-height: 40px; padding: 6px 6px 6px 14px; border-radius: 10px; background: #1d2029; color: #f1f2f5; box-shadow: var(--shadow-pop); max-width: min(560px, calc(100vw - 32px)); font-size: 13px; }
.toast.bad { background: #5c1a14; }
.toast .btn { background: transparent; color: #fff; border-color: rgba(255, 255, 255, .35); }
.toast .btn:hover:not(:disabled) { background: rgba(255, 255, 255, .12); }
.toast .icon-btn { color: #dfe2e8; }
.toast .icon-btn:hover { background: rgba(255, 255, 255, .12); color: #fff; }
.toast.leaving { opacity: 0; }

/* Overlays */
.layers { position: absolute; inset: 0; pointer-events: none; z-index: 60; }
.layers > * { pointer-events: auto; }
.backdrop { position: absolute; inset: 0; background: rgba(10, 13, 20, .42); display: flex; align-items: flex-start; justify-content: center; padding: min(12vh, 96px) 16px 16px; overflow: auto; }
.dialog { background: var(--raised); color: var(--ink); border-radius: 14px; box-shadow: var(--shadow-pop); width: min(520px, 100%); max-height: calc(100vh - 32px); display: flex; flex-direction: column; border: 1px solid var(--line); }
.dialog.sm { width: min(400px, 100%); }
.dialog.lg { width: min(820px, 100%); }
.dialog-head { display: flex; align-items: center; gap: 8px; padding: 12px 12px 4px 18px; }
.dialog-title { font-size: 15px; font-weight: 650; flex: 1; }
.dialog-desc { margin: 0 18px; color: var(--muted); font-size: 12.5px; }
.dialog-body { padding: 8px 18px 16px; overflow: auto; }
.palette .dialog-head { display: none; }
.palette .dialog-body { padding: 0; }
.palette-input { width: 100%; border: 0 !important; border-bottom: 1px solid var(--line) !important; border-radius: 14px 14px 0 0 !important; padding: 14px 18px !important; font-size: 15px; min-height: 52px; background: transparent !important; outline: none; }
.palette-list { list-style: none; margin: 0; padding: 6px; max-height: min(420px, 60vh); overflow: auto; }
.palette-option .opt-keys { display: inline-flex; gap: 4px; margin-left: auto; }
.popover { position: absolute; background: var(--raised); color: var(--ink); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow-pop); min-width: 260px; max-width: min(380px, calc(100vw - 16px)); z-index: 70; }
.popover.sheet { left: 8px !important; right: 8px; bottom: 8px; top: auto !important; max-width: none; position: absolute; }
.picker-inner { display: flex; flex-direction: column; max-height: min(440px, 70vh); }
.picker-title { font-size: 12px; font-weight: 600; color: var(--muted); padding: 10px 12px 0; }
.picker-input { margin: 8px; border-radius: 7px; }
.picker-list { list-style: none; margin: 0; padding: 0 6px 6px; overflow: auto; }
.picker-section { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); padding: 8px 8px 4px; font-weight: 650; }
.picker-option { display: flex; align-items: center; gap: 8px; min-height: 32px; padding: 4px 8px; border-radius: 7px; cursor: pointer; }
.picker-option.active, .picker-option:hover { background: var(--accent-soft); }
.picker-option[aria-disabled] { opacity: .5; cursor: not-allowed; }
.picker-option .check { width: 14px; color: var(--accent); font-weight: 700; }
.opt-icon { display: grid; place-items: center; min-width: 18px; }
.opt-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.opt-hint { margin-left: auto; }
.picker-empty { color: var(--muted); font-size: 12px; padding: 4px 14px 8px; margin: 0; }
.picker-foot { color: var(--muted); font-size: 11px; padding: 6px 12px 8px; border-top: 1px solid var(--line); margin: 0; }
.display-inner { padding: 12px 14px; display: flex; flex-direction: column; gap: 6px; width: 320px; max-width: 100%; }
.pop-title { font-size: 13px; font-weight: 650; }
.props-fieldset { border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px 8px; margin: 4px 0; }
.props-fieldset legend { font-size: 12px; color: var(--muted); padding: 0 4px; }
.check-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 12px; }
.create-body { display: flex; flex-direction: column; gap: 8px; }
.create-title { font-size: 16px; font-weight: 550; min-height: 40px !important; }
.create-props { display: flex; gap: 6px; flex-wrap: wrap; }
.prop-chip { max-width: 200px; }
.token-preview { display: flex; gap: 6px; flex-wrap: wrap; min-height: 0; }
.token-preview:empty { display: none; }
.chip.token { background: var(--accent-soft); border-color: var(--accent-line); color: var(--ink); }
.tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--line); margin-bottom: 12px; overflow-x: auto; }
.tabs [role=tab] { border: 0; background: transparent; padding: 8px 12px; min-height: 32px; cursor: pointer; color: var(--ink-2); border-bottom: 2px solid transparent; margin-bottom: -1px; font-weight: 550; }
.tabs [role=tab][aria-selected="true"] { color: var(--ink); border-bottom-color: var(--accent); }
.tab-panel { outline: none; }
.tab-panel h3 { font-size: 13px; margin: 12px 0 4px; }
.settings-list { list-style: none; margin: 0 0 12px; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.settings-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 6px 8px; border: 1px solid var(--line); border-radius: 8px; }
.settings-row.archived { opacity: .65; }
.settings-row.current { border-color: var(--accent-line); }
.settings-row input[type=text] { flex: 1 1 140px; min-width: 120px; }
.settings-row .narrow { width: 72px; }
.row-actions { display: inline-flex; gap: 4px; margin-left: auto; }
.person-cell { flex: 1 1 200px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.settings-add { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 8px; border: 1px dashed var(--line-strong); border-radius: 8px; }
.notice { margin: 0; }
.sc-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-top: 12px; }
.sc-grid h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin-bottom: 6px; }
.sc-grid dl { display: grid; grid-template-columns: auto 1fr; gap: 6px 10px; margin: 0; align-items: center; }
.sc-grid dt { display: flex; gap: 3px; flex-wrap: wrap; }
.sc-grid dd { margin: 0; }

.narrow-only { display: none; }
.narrow-bar { display: flex; gap: 4px; overflow-x: auto; padding: 4px 12px 8px; scrollbar-width: none; scroll-snap-type: x proximity; }
.narrow-tab { flex: none; display: inline-flex; align-items: center; gap: 6px; min-height: 32px; padding: 4px 12px; border-radius: 16px; border: 1px solid var(--line-strong); background: var(--surface); color: var(--ink-2); font: inherit; cursor: pointer; scroll-snap-align: center; }
.narrow-tab[aria-pressed="true"] { background: var(--accent-soft); border-color: var(--accent-line); color: var(--ink); font-weight: 600; }
.narrow-count { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.showkey-inner { padding: 12px 14px; width: 320px; max-width: 100%; display: flex; flex-direction: column; gap: 4px; }
.key-field { font-family: var(--mono); width: 100%; }
/* Responsive: phones and 400% zoom reflow to one column; the detail becomes a full sheet. */
@media (max-width: 760px) {
  :root { --col-w: min(84vw, 320px); }
  .topbar { padding: 6px 12px; gap: 6px; }
  .palette-btn { min-width: 0; }
  .palette-btn .palette-label, .palette-btn kbd, .new-btn span { display: none; }
  .toolbar { padding: 8px 12px 4px; }
  .board-scroll, .list-scroll { padding: 0 12px 96px; }
  .detail { position: fixed; inset: 0; width: auto; z-index: 45; border-left: 0; }
  .live { display: none; }
  .quick, .view-controls { width: 100%; flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; padding-bottom: 2px; }
  .quick .btn, .view-controls > * { flex: none; }
  .filter-row { gap: 6px; }
  .toolbar { gap: 6px; }
}
@media (max-width: 639px) {
  :root { --col-w: calc(100vw - 24px); }
  .col-head .icon-btn[aria-expanded] { display: none; }
}
@media (max-width: 480px) {
  .narrow-only { display: inline-flex; }
  .wb-app:not(.filter-open) .filterbar .filter-row:first-child { display: none; }
  .wb-app:not(.filter-open) .filterbar .filter-row.second:not(:has(.filter-chip)) { display: none; }
  .brand .sub { display: none; }
  .view-controls { width: 100%; }
  .wql-status { flex-basis: 100%; }
  .bulk-bar { left: 8px; right: 8px; transform: none; bottom: 64px; }
}

/* Motion (only when welcome) */
@media (prefers-reduced-motion: no-preference) {
  .card { transition: border-color .12s, background-color .12s, box-shadow .2s; }
  .card.ghost::before { animation: wb-shimmer 1.6s linear infinite; }
  .sk-card::after, .sk-head::after { animation: wb-sweep 1.3s ease-in-out infinite; }
  .card.just-settled { animation: wb-settle .7s cubic-bezier(.2, .9, .3, 1.2); }
  .card.just-done::after { animation: wb-pop .45s cubic-bezier(.2, .9, .3, 1.4); }
  .toast { animation: wb-rise .18s ease-out; transition: opacity .15s; }
  .popover, .dialog { animation: wb-in .12s ease-out; }
  .status-dot.pending { animation: wb-pulse 1.8s ease-in-out infinite; }
  .drag-clone { transition: box-shadow .15s; }
}
@keyframes wb-shimmer { from { background-position: 150% 0; } to { background-position: -100% 0; } }
@keyframes wb-sweep { to { transform: translateX(100%); } }
@keyframes wb-settle { 0% { transform: scale(.97); } 60% { transform: scale(1.015); } 100% { transform: none; } }
@keyframes wb-pop { 0% { transform: scale(0); opacity: 0; } 100% { transform: scale(1); opacity: 1; } }
@keyframes wb-rise { from { transform: translateY(8px); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes wb-in { from { transform: translateY(-4px); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes wb-pulse { 50% { opacity: .35; } }
@media (forced-colors: active) { .card, .cell, .btn, .chip { border: 1px solid CanvasText; } .card:focus-visible { outline: 2px solid Highlight; } }

/* Insights */
.insights-scroll { flex: 1; min-height: 0; overflow: auto; padding: 4px 16px 96px; outline: none; }
.insights-head { display: flex; align-items: center; gap: 8px 12px; flex-wrap: wrap; margin: 4px 0 12px; }
.insights-title h2 { font-size: 15px; font-weight: 650; }
.insights-title p { margin: 2px 0 0; font-size: 12px; }
.filter-note { color: var(--ink-2); }
.insights-error { color: var(--bad); display: inline-flex; align-items: center; gap: 4px; font-size: 12.5px; }
.insights-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 460px), 1fr)); gap: 16px; }
.report-card { position: relative; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-lg); padding: 12px 14px 10px; display: flex; flex-direction: column; gap: 6px; min-width: 0; box-shadow: var(--shadow-1); }
.report-card:focus-within { border-color: var(--accent-line); }
.report-head { display: flex; align-items: flex-start; gap: 8px; }
.report-titles { flex: 1; min-width: 0; }
.report-title { font-size: 14px; font-weight: 650; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; outline-offset: 3px; }
.report-desc { margin: 2px 0 0; color: var(--muted); font-size: 12px; }
.report-controls { display: flex; align-items: center; gap: 4px; flex: none; }
.report-select { min-height: 28px; padding: 2px 6px; font-size: 12px; max-width: 170px; }
.tag { display: inline-block; font-size: 11px; font-weight: 550; padding: 1px 6px; border-radius: 10px; background: var(--surface-3); color: var(--ink-2); }
.report-figure { margin: 0; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.report-chart { min-height: 220px; width: 100%; overflow: hidden; }
.report-chart svg { display: block; max-width: 100%; height: auto; }
.report-chart .dep-node { cursor: pointer; }
.report-chart .dep-node:focus { outline: none; }
.report-chart .dep-node:focus-visible { stroke: var(--focus); stroke-width: 4px; }
.report-summary { font-size: 13px; color: var(--ink-2); line-height: 1.45; min-height: 19px; }
.report-empty { min-height: 120px; display: flex; align-items: center; justify-content: center; gap: 8px; color: var(--muted); text-align: center; margin: 0; padding: 16px; border: 1px dashed var(--line-strong); border-radius: var(--radius); }
.report-empty.bad { color: var(--bad); border-color: var(--bad); }
.report-foot { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.report-data:not([hidden]) { border-top: 1px solid var(--line); padding-top: 8px; }
.report-table-wrap { max-height: 280px; overflow: auto; border-radius: 6px; }
.report-table { width: 100%; border-collapse: collapse; font-size: 12px; font-variant-numeric: tabular-nums; }
.report-table th, .report-table td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; }
.report-table thead th { position: sticky; top: 0; background: var(--surface-2); color: var(--ink-2); font-weight: 600; z-index: 1; }
.report-table tbody th { font-weight: 500; }
.report-table .num { text-align: right; }
.sk-chart { height: 220px; border-radius: var(--radius); background: var(--surface-2); position: relative; overflow: hidden; }
.sk-line { display: block; height: 12px; width: 70%; border-radius: 6px; background: var(--surface-3); margin-top: 4px; }
.chart-tip { position: absolute; z-index: 20; pointer-events: none; background: var(--raised); color: var(--ink); border: 1px solid var(--line); border-radius: 8px; box-shadow: var(--shadow-2); padding: 6px 9px; font-size: 12px; max-width: 280px; }
.chart-tip-title { font-weight: 600; margin-bottom: 3px; }
.chart-tip dl { display: grid; grid-template-columns: auto auto; gap: 1px 10px; margin: 0; }
.chart-tip dt { color: var(--muted); }
.chart-tip dd { margin: 0; font-variant-numeric: tabular-nums; }
.report-editor .editor-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 12px; }
.report-editor .editor-grid .span { grid-column: 1 / -1; }
.param-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 0 12px; }
.mono { font-family: var(--mono); font-size: 12.5px; }
.spec-edit { min-height: 220px; }
.report-errors ul { margin: 4px 0; padding-left: 18px; color: var(--bad); }
.ok-text { color: var(--ok); }
.btn.danger { background: var(--bad); border-color: var(--bad); color: #fff; }

/* Proposals */
.proposals-btn .badge { min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: var(--accent); color: var(--accent-ink); font-size: 11px; font-weight: 650; display: inline-grid; place-items: center; }
.proposals-btn:not(.has) { color: var(--ink-2); }
.tray.dialog { width: min(760px, 100%); }
.tray-body { display: flex; flex-direction: column; gap: 14px; }
.tray-empty { text-align: center; color: var(--ink-2); padding: 24px 8px; display: flex; flex-direction: column; align-items: center; gap: 4px; }
.tray-empty p { margin: 0; }
.proposal { border: 1px solid var(--line); border-radius: var(--radius-lg); padding: 12px 14px; background: var(--surface); }
.proposal-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.proposal-head h3 { font-size: 14px; font-weight: 650; }
.proposal-meta { margin: 0; flex-basis: 100%; font-size: 12px; }
.proposal-reason { margin: 6px 0; font-size: 13px; color: var(--ink-2); }
.row.tight { margin-top: 4px; gap: 4px; }
.proposal-changes { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; }
.proposal-change { padding: 6px 0; border-top: 1px solid var(--line); }
.proposal-change:first-child { border-top: 0; }
.change-line { display: flex; align-items: flex-start; gap: 8px 12px; flex-wrap: wrap; justify-content: space-between; }
.change-check { align-items: flex-start; }
.change-check input { margin-top: 2px; }
.change-text { font-weight: 500; }
.change-state { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--muted); }
.change-state.ok { color: var(--ok); } .change-state.warn { color: var(--warn); } .change-state.bad { color: var(--bad); } .change-state.pending { color: var(--ink-2); }
.change-diff { margin: 2px 0 0 26px; padding: 0; list-style: none; font-size: 12px; color: var(--ink-2); }
.change-reason { margin: 2px 0 0 26px; font-size: 12px; }
.proposal-change .link.sm { margin-left: 26px; font-size: 12px; min-height: 24px; }
.proposal-actions { margin-top: 10px; }
.tray-history summary { cursor: pointer; min-height: 28px; display: flex; align-items: center; gap: 6px; color: var(--ink-2); font-weight: 550; list-style: none; }
.tray-history summary::-webkit-details-marker { display: none; }
.tray-history summary::before { content: "›"; display: inline-block; width: 12px; transition: transform .12s; }
.tray-history[open] summary::before { transform: rotate(90deg); }
.tray-sub { font-size: 13px; font-weight: 600; color: var(--ink-2); margin: 4px 0 8px; }
.tray-recent { display: flex; flex-direction: column; gap: 10px; }
.tray-history-list { margin: 4px 0; padding-left: 18px; font-size: 12.5px; }

/* Jev suggestions */
.suggest-status { display: flex; align-items: center; gap: 4px; color: var(--ink-2); margin: 0 0 8px; }
.suggest-item h3 { font-size: 13.5px; font-weight: 600; margin: 8px 0 4px; }
.suggest-item .key { color: var(--muted); font-family: var(--mono); font-size: 12px; }
.suggest-list { list-style: none; margin: 0; padding: 0; }
.suggest-list li { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 2px 0; }
.confidence { font-size: 12px; font-variant-numeric: tabular-nums; color: var(--muted); }
.confidence.high { color: var(--ok); font-weight: 550; }
@media (max-width: 760px) {
  .insights-scroll { padding: 4px 12px 96px; }
  .seg .seg-label { display: none; }
  .proposals-label { display: none; }
  .report-editor .editor-grid { grid-template-columns: 1fr; }
}

.segmented.sm .seg { min-height: 24px; padding: 2px 8px; font-size: 12px; }
.report-chart.graph { min-height: 260px; }
.report-chart.graph svg { width: 100%; }
.graph-legend { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 12px; color: var(--ink-2); }
.graph-legend li { display: inline-flex; align-items: center; gap: 5px; }
.graph-focus { margin: 0; min-height: 18px; font-size: 12.5px; color: var(--ink); }
.suggest .dialog-body { padding-bottom: 0; }
.suggest-foot { position: sticky; bottom: 0; background: var(--raised); border-top: 1px solid var(--line); margin: 8px -18px 0; padding: 10px 18px 14px; z-index: 2; }
.suggest-now { margin: 0 0 4px; font-size: 12px; color: var(--ink-2); }
.peek-dup { flex-basis: 100%; margin: 0 0 4px 24px; font-size: 12px; }
.peek-dup summary { cursor: pointer; color: var(--accent); min-height: 24px; display: inline-flex; align-items: center; }
.peek-dup p { margin: 2px 0; }
.prompt-text { font-size: 13px; background: var(--surface-2); }
@media (max-width: 480px) {
  .report-head { flex-wrap: wrap; }
  .report-titles { flex-basis: 100%; }
  .report-controls { flex-basis: 100%; justify-content: flex-end; }
}
`;
