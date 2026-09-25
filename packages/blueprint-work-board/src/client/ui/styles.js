// Work board styles (adapted from blueprint-project-board). Colours are tokens with a dark-mode set; status meaning is always carried by text
// and an icon-like prefix as well as colour.
export const CSS = `
:root {
  --bg: #f5f6f8; --surface: #ffffff; --surface-2: #eef0f4; --ink: #1c2230; --ink-2: #4a5263;
  --muted: #6b7385; --line: #d9dde5; --accent: #2f5bd3; --accent-ink: #ffffff; --focus: #2f5bd3;
  --ok: #1d7a46; --ok-bg: #e5f4ea; --warn: #8a5a00; --warn-bg: #fff4d6; --bad: #b3261e; --bad-bg: #fde8e6;
  --info-bg: #e8eefc; --shadow: 0 1px 2px rgba(20, 25, 40, .08), 0 2px 8px rgba(20, 25, 40, .06);
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14171d; --surface: #1d2129; --surface-2: #262b35; --ink: #e8ebf1; --ink-2: #c0c6d2;
    --muted: #9aa2b2; --line: #343a46; --accent: #7b9cff; --accent-ink: #0d1220; --focus: #9db5ff;
    --ok: #6fd39a; --ok-bg: #173325; --warn: #f0c060; --warn-bg: #3a2f14; --bad: #ff8a80; --bad-bg: #3d1d1b;
    --info-bg: #1e2a47; --shadow: 0 1px 2px rgba(0, 0, 0, .4);
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body { background: var(--bg); color: var(--ink); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
button, input, select, textarea { font: inherit; color: inherit; }
button { cursor: pointer; border: 1px solid var(--line); background: var(--surface); border-radius: 6px; padding: 5px 10px; }
button:hover:not(:disabled) { border-color: var(--accent); }
button:disabled { opacity: .55; cursor: not-allowed; }
button.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
button.link { border: 0; background: none; color: var(--accent); padding: 0 2px; text-decoration: underline; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
input, select, textarea { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; padding: 5px 8px; }
textarea { resize: vertical; min-height: 70px; width: 100%; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

.wb-app { display: flex; flex-direction: column; height: 100%; }
.wb-header { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; padding: 10px 16px; border-bottom: 1px solid var(--line); background: var(--surface); }
.wb-header h1 { font-size: 16px; margin: 0; }
.wb-header .datastore { color: var(--muted); font-size: 13px; }
.wb-header .spacer { flex: 1; }
.wb-toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 8px 16px; }
.wb-toolbar input[type=search] { min-width: 180px; }
.live { font-size: 12px; color: var(--muted); display: inline-flex; gap: 6px; align-items: center; }
.live .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
.live[data-live=active] .dot { background: var(--ok); }
.live[data-live=requested] .dot { background: var(--warn); }

.banner { margin: 8px 16px 0; padding: 8px 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--info-bg); }
.banner.warn { background: var(--warn-bg); color: var(--warn); border-color: transparent; }
.banner.bad { background: var(--bad-bg); color: var(--bad); border-color: transparent; }
.state-panel { max-width: 560px; margin: 48px auto; padding: 24px; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow); }
.state-panel h2 { margin-top: 0; font-size: 18px; }
.state-panel ol { padding-left: 20px; }

.wb-main { flex: 1; display: flex; min-height: 0; }
.wb-board { flex: 1; display: flex; gap: 12px; padding: 12px 16px 16px; overflow-x: auto; align-items: flex-start; }
.wb-column { flex: 1 0 260px; max-width: 360px; background: var(--surface-2); border-radius: 10px; padding: 8px; display: flex; flex-direction: column; max-height: 100%; border: 2px solid transparent; }
.wb-column.drop-over { border-color: var(--accent); border-style: dashed; background: var(--info-bg); }
.wb-column h2 { font-size: 13px; margin: 2px 4px 8px; display: flex; justify-content: space-between; color: var(--ink-2); }
.wb-column ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; overflow-y: auto; min-height: 40px; }
.wb-column .empty { color: var(--muted); font-size: 12px; padding: 4px; }
.wb-card { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; box-shadow: var(--shadow); }
.wb-card[aria-current=true] { border-color: var(--accent); }
.wb-card button.open { all: unset; cursor: pointer; display: block; width: 100%; }
.wb-card button.open:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.wb-card .title { font-weight: 550; overflow-wrap: anywhere; }
.wb-card .snippet { font-size: 12px; color: var(--ink-2); margin-top: 2px; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.wb-card .foot { display: flex; gap: 8px; align-items: center; justify-content: space-between; margin-top: 6px; flex-wrap: wrap; }
.wb-card select { font-size: 12px; padding: 2px 4px; }
.chip { font-size: 11px; padding: 1px 7px; border-radius: 10px; display: inline-block; }
.chip.saving { background: var(--surface-2); }
.chip.pending { background: var(--warn-bg); color: var(--warn); }
.chip.applied { background: var(--ok-bg); color: var(--ok); }
.chip.conflict, .chip.rejected { background: var(--bad-bg); color: var(--bad); }

.wb-detail { flex: 0 0 380px; max-width: 100%; border-left: 1px solid var(--line); background: var(--surface); overflow-y: auto; padding: 14px 16px 24px; }
.wb-detail h2 { font-size: 15px; margin: 0 0 4px; overflow-wrap: anywhere; }
.wb-detail h2:focus { outline: none; }
.wb-detail .sub { color: var(--muted); font-size: 12px; margin-bottom: 12px; overflow-wrap: anywhere; }
.wb-detail label, .dialog label { display: block; font-size: 12px; color: var(--ink-2); margin: 10px 0 3px; }
.wb-detail input[type=text], .wb-detail select, .dialog input[type=text] { width: 100%; }
.wb-detail .readonly { white-space: pre-wrap; overflow-wrap: anywhere; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 12px; }
.dialog .row { justify-content: flex-end; }
.notice { margin-top: 10px; padding: 8px 10px; border-radius: 8px; background: var(--warn-bg); color: var(--warn); font-size: 13px; }

.wb-writes { position: fixed; left: 12px; bottom: 12px; display: flex; flex-direction: column; gap: 6px; max-width: min(420px, calc(100vw - 24px)); z-index: 20; }
.wb-writes .write { background: var(--surface); border: 1px solid var(--line); border-left-width: 4px; border-radius: 8px; padding: 8px 10px; box-shadow: var(--shadow); display: flex; flex-direction: column; gap: 4px; }
.wb-writes .write[data-status=applied] { border-left-color: var(--ok); }
.wb-writes .write[data-status=pending] { border-left-color: var(--warn); }
.wb-writes .write[data-status=conflict], .wb-writes .write[data-status=rejected] { border-left-color: var(--bad); }
.wb-writes .write .what { font-weight: 550; overflow-wrap: anywhere; }
.wb-writes .write .actions { display: flex; gap: 8px; }

.dialog-backdrop { position: fixed; inset: 0; background: rgba(10, 14, 22, .45); display: flex; align-items: flex-start; justify-content: center; padding: 40px 16px; z-index: 30; overflow-y: auto; }
.dialog { background: var(--surface); border-radius: 12px; padding: 16px 18px; width: min(480px, 100%); box-shadow: var(--shadow); }
.dialog h2 { margin: 0 0 8px; font-size: 16px; }
.field-error { color: var(--bad); font-size: 12px; min-height: 1em; }

@media (max-width: 760px) {
  .wb-main { flex-direction: column; }
  .wb-board { flex-direction: column; align-items: stretch; overflow-x: visible; }
  .wb-column { flex: none; max-width: none; max-height: none; }
  .wb-detail { position: fixed; inset: 0; z-index: 25; border-left: 0; }
  .wb-writes { right: 12px; z-index: 27; }
}
@media (prefers-reduced-motion: no-preference) { .wb-card { transition: border-color .15s; } }
`;
