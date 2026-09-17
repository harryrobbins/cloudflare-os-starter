// @ts-check
// The whole stylesheet, injected as one <style> element (the iframe has no stylesheet files).
// Light theme, system font, visible outline focus rings, a single column with the panel as a
// bottom sheet and 44 px targets on phones, reduced-motion and print rules. Class names outside
// the shell (cards, editors, carets) follow ui-contract.js and stream C1's conversation.

import { el } from "./dom.js";

export const SHELL_CSS = String.raw`
:root {
  color-scheme: light;
  --surface: #ffffff;
  --surface-2: #f5f6f8;
  --surface-3: #eceef2;
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
  --danger-soft: #fde8e8;
  --ok: #237032;
  --ok-soft: #e3f4e6;
  --warn: #b45309;
  --warn-soft: #fdf1dc;
  --agent: #f3efff;
  --agent-border: #c9b8f5;
  --proposal: #eefaf4;
  --proposal-border: #9fd9b8;
  --decision-border: #1a1f2b;
  --highlight: #fff3bf;
  --shadow-1: 0 1px 2px rgba(16, 24, 40, .08), 0 2px 6px rgba(16, 24, 40, .08);
  --shadow-2: 0 8px 24px rgba(16, 24, 40, .18);
  --shadow-3: 0 16px 48px rgba(16, 24, 40, .28);
  --radius: 10px;
  --radius-sm: 6px;
  --font: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --header-h: 52px;
  --panel-w: 340px;
  --target: 32px;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { height: 100%; margin: 0; }
body {
  font-family: var(--font); font-size: 14px; line-height: 1.5; color: var(--text);
  background: var(--surface-2); overflow: hidden; -webkit-font-smoothing: antialiased; overscroll-behavior: none;
}
button, input, textarea, select { font: inherit; color: inherit; }
button { cursor: pointer; }
:focus:not(:focus-visible) { outline: none; }
/* One focus ring everywhere: an outline (never a box-shadow) in the accent colour, 3:1 on every surface. */
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.icon { flex: none; display: block; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.muted { color: var(--text-3); font-size: 13px; }
code, pre { font-family: var(--mono); font-size: 13px; }
pre { background: var(--surface-3); padding: 8px 10px; border-radius: var(--radius-sm); overflow-x: auto; }
:not(pre) > code { background: var(--surface-3); padding: 1px 4px; border-radius: 4px; }
a { color: var(--accent); }
q { quotes: "“" "”"; }

/* Buttons and fields */
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  border: 1px solid transparent; background: transparent;
  padding: 6px 10px; border-radius: var(--radius-sm); min-height: var(--target);
  color: var(--text-2); font-weight: 500; white-space: nowrap;
}
.btn:hover:not(:disabled):not([aria-disabled="true"]) { background: rgba(127, 127, 127, .16); color: var(--text); }
.btn:disabled, .btn[aria-disabled="true"] { opacity: .45; cursor: default; }
.btn.primary { background: var(--accent); color: var(--on-accent); }
.btn.primary:hover:not(:disabled) { background: var(--accent-hover); color: var(--on-accent); }
.btn.primary.danger { background: var(--danger); }
.btn.outline { border-color: var(--border); background: var(--surface); }
.btn.icon-only { padding: 6px; min-width: var(--target); }
.btn[aria-pressed="true"], .btn[aria-checked="true"], .btn[aria-selected="true"] { background: var(--accent-soft); color: var(--accent-hover); }
.btn.small { padding: 3px 8px; font-size: 13px; min-height: 28px; }
.btn.danger-text { color: var(--danger); }
.btn.link-btn { padding: 0 2px; min-height: 0; color: var(--accent); font-weight: 500; text-decoration: underline; white-space: normal; text-align: left; }
.btn.link-btn:hover { background: transparent; color: var(--accent-hover); }
input[type="text"], input:not([type]), textarea, select {
  border: 1px solid var(--border); background: var(--surface); border-radius: var(--radius-sm);
  padding: 6px 8px; min-width: 0; color: var(--text);
}
input:focus, textarea:focus, select:focus { border-color: var(--accent); }
textarea { resize: vertical; width: 100%; line-height: 1.5; }

/* Layout: header on top, conversation in the centre, panel on the right. The DOM order is
   conversation, header, panel so Tab visits them in that order (plan 3.6). */
.wave-app {
  position: fixed; inset: 0; display: grid;
  grid-template-columns: minmax(0, 1fr) var(--panel-w);
  grid-template-rows: var(--header-h) minmax(0, 1fr);
  grid-template-areas: "header header" "centre panel";
  background: var(--surface-2);
}
.wave-header { grid-area: header; }
.wave-centre { grid-area: centre; min-height: 0; display: flex; flex-direction: column; overflow: hidden; position: relative; }
.wave-panel { grid-area: panel; min-height: 0; }
.wave-centre > .wave-conversation, .wave-centre > [data-conversation], .wave-centre > .conversation {
  flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
}
.wave-centre > :last-child { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }

/* Header */
.wave-header {
  display: flex; align-items: center; gap: 8px; padding: 0 12px; background: var(--surface);
  border-bottom: 1px solid var(--border); min-width: 0;
}
.header-title { flex: 1 1 auto; min-width: 0; display: flex; }
.wave-title {
  width: 100%; max-width: 48ch; font-size: 16px; font-weight: 650; border-color: transparent; background: transparent;
  padding: 6px 8px; text-overflow: ellipsis;
}
.wave-title:hover { background: var(--surface-2); }
.wave-title:focus { background: var(--surface); border-color: var(--accent); }
.header-status { display: flex; align-items: center; gap: 6px; flex: none; }
.header-actions { display: flex; align-items: center; gap: 2px; flex: none; }
.people-btn { padding: 2px 8px 2px 2px; border-radius: 999px; gap: 6px; }
.people-btn .avatars { display: inline-flex; }
.people-btn .avatar { width: 26px; height: 26px; font-size: 10px; box-shadow: 0 0 0 2px var(--surface); margin-left: -6px; }
.people-btn .avatar:first-child { margin-left: 0; }
.people-btn .avatar.more { background: var(--surface-3); color: var(--text); }
.here-count { font-size: 13px; color: var(--text-2); }
.me-btn { padding: 2px; border-radius: 50%; }
.avatar {
  display: inline-flex; align-items: center; justify-content: center; flex: none;
  width: 28px; height: 28px; border-radius: 50%; font-size: 11px; font-weight: 700; letter-spacing: .02em; user-select: none;
}
.conn { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-3); white-space: nowrap; }
.conn-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-3); flex: none; }
.conn[data-state="live"] .conn-dot { background: var(--ok); }
.conn[data-state="live"] .conn-text { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.conn[data-state="reconnecting"] .conn-dot, .conn[data-state="connecting"] .conn-dot { background: #e8871e; animation: wave-pulse 1s infinite alternate; }
@keyframes wave-pulse { to { opacity: .3; } }
.saving-chip { font-size: 12px; color: var(--text-3); white-space: nowrap; padding: 2px 8px; border-radius: 999px; background: var(--surface-2); }
.saving-chip[data-state="saving"] { color: var(--warn); background: var(--warn-soft); }
.saving-chip[data-state="failed"] { color: var(--danger); background: var(--danger-soft); }
.ask-agent-btn.no-model { color: var(--text-3); }
.conn-banner {
  padding: 6px 16px; background: var(--warn-soft); color: var(--warn); font-size: 13px; border-bottom: 1px solid #f0d9a8;
}
.conn-banner .muted { color: var(--text-2); }

/* Panel */
.wave-panel { display: flex; flex-direction: column; background: var(--surface); border-left: 1px solid var(--border); min-width: 0; }
.panel-tabs { display: flex; border-bottom: 1px solid var(--border); flex: none; }
.panel-tab {
  flex: 1; border: 0; border-bottom: 2px solid transparent; background: transparent; padding: 10px 6px; min-height: 44px;
  color: var(--text-2); font-weight: 500; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
}
.panel-tab:hover { background: var(--surface-2); }
.panel-tab[aria-selected="true"] { color: var(--accent-hover); border-bottom-color: var(--accent); }
.tab-count { font-size: 11px; background: var(--accent-soft); color: var(--accent-hover); border-radius: 999px; padding: 0 6px; min-width: 18px; text-align: center; }
.panel-sheet { display: flex; flex-direction: column; min-height: 0; flex: 1; }
.panel-close { display: none; align-self: flex-end; margin: 4px 8px 0; }
.panel-body { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 14px 20px; overscroll-behavior: contain; }
.panel-body h2 { margin: 0; font-size: 15px; }
.panel-body h3 { margin: 14px 0 6px; font-size: 13px; color: var(--text-2); text-transform: uppercase; letter-spacing: .04em; }
.tab-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }

/* Decisions tab */
.decision-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.decision-item { border: 1px solid var(--border); border-left: 3px solid var(--decision-border); border-radius: var(--radius-sm); padding: 8px 10px; }
.decision-item.superseded { border-left-color: var(--border-strong); opacity: .85; }
.decision-link { display: flex; align-items: flex-start; gap: 6px; padding: 0; min-height: 0; white-space: normal; text-align: left; color: var(--text); font-weight: 500; width: 100%; }
.decision-link:hover { background: transparent; text-decoration: underline; }
.decision-n { flex: none; color: var(--text-3); font-weight: 600; }
.decision-meta, .decision-chain { margin-top: 4px; font-size: 12px; }

/* Agent tab: run cards */
.run-list { display: flex; flex-direction: column; gap: 10px; }
.run-card { border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px 12px; background: var(--surface); display: flex; flex-direction: column; gap: 4px; }
.run-card[data-state="running"] { border-color: var(--accent); }
.run-card[data-state="failed"], .run-card[data-state="unknown"] { border-color: #e8a5a5; }
.run-head { display: flex; align-items: center; gap: 8px; }
.run-op { font-weight: 600; flex: 1; }
.run-state { font-size: 12px; padding: 1px 8px; border-radius: 999px; background: var(--surface-3); color: var(--text-2); }
.run-state[data-state="running"] { background: var(--accent-soft); color: var(--accent-hover); }
.run-state[data-state="done"] { background: var(--ok-soft); color: var(--ok); }
.run-state[data-state="failed"], .run-state[data-state="unknown"] { background: var(--danger-soft); color: var(--danger); }
.run-meta, .run-scope, .run-timing { font-size: 12px; }
.run-omitted { display: flex; gap: 6px; align-items: center; font-size: 12px; color: var(--warn); }
.run-error { font-size: 13px; color: var(--danger); overflow-wrap: anywhere; }
.run-instructions { font-size: 13px; color: var(--text-2); }
.run-result { border-top: 1px solid var(--border); margin-top: 6px; padding-top: 8px; }
.run-result .md > :first-child { margin-top: 0; }
.run-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
.no-model-note { padding: 8px 10px; background: var(--warn-soft); color: var(--warn); border-radius: var(--radius-sm); }

/* People tab */
.people { display: flex; flex-direction: column; gap: 8px; }
.peer-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.peer { display: flex; align-items: center; gap: 8px; min-height: 36px; flex-wrap: wrap; }
.peer-name { font-weight: 500; }
.peer-activity { flex: 1 1 auto; overflow-wrap: anywhere; }
.peer.me { padding-bottom: 8px; border-bottom: 1px solid var(--border); }

/* History tab and banner */
.history-tab p { margin: 0 0 10px; }
.history-scrub-row { display: flex; align-items: center; gap: 10px; }
.history-scrubber { flex: 1; min-width: 0; accent-color: var(--accent); min-height: 32px; }
.history-pos { font-variant-numeric: tabular-nums; font-size: 13px; color: var(--text-2); white-space: nowrap; }
.history-actions { display: flex; gap: 6px; flex-wrap: wrap; margin: 6px 0 10px; }
.history-changed { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.history-item { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px; }
.history-item-btn { padding: 2px 6px; white-space: normal; text-align: left; }
.history-banner {
  display: flex; align-items: center; gap: 6px; padding: 8px 16px; background: var(--highlight); color: var(--text);
  border-bottom: 1px solid #efd77a; flex: none; flex-wrap: wrap;
}
.history-banner .btn { margin-left: auto; }
.wave-app.history-mode .wave-centre { background: repeating-linear-gradient(135deg, transparent 0 24px, rgba(0, 0, 0, .02) 24px 48px); }

/* Templates (first open) */
.templates { padding: 24px 16px; max-width: 760px; margin: 0 auto; flex: none; }
.templates h2 { margin: 0 0 4px; font-size: 20px; }
.templates > p { margin: 0 0 16px; color: var(--text-2); }
.template-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; }
.template-btn {
  display: flex; flex-direction: column; align-items: flex-start; gap: 6px; text-align: left; padding: 12px 14px; min-height: 96px;
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow-1); white-space: normal;
}
.template-btn:hover:not(:disabled) { border-color: var(--accent); background: var(--surface); }
.template-title { display: inline-flex; align-items: center; gap: 8px; font-weight: 650; font-size: 15px; color: var(--text); }
.template-desc { color: var(--text-2); font-size: 13px; font-weight: 400; line-height: 1.4; }
.templates-note { margin-top: 12px; }

/* Conversation: cards (classes per ui-contract.js and stream C1) */
.wave-conversation, .conversation { padding: 16px 16px 120px; }
.wave-blip {
  position: relative; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 12px 14px; margin: 0 0 10px; box-shadow: var(--shadow-1); scroll-margin: 16px;
}
.wave-blip:focus-visible { outline-offset: 0; }
.wave-blip[data-changed="1"]::before {
  content: ""; position: absolute; left: -1px; top: 14px; width: 6px; height: 6px; border-radius: 50%; background: var(--accent); transform: translateX(-9px);
}
.wave-blip.highlight, .wave-blip[data-highlight="1"] { animation: wave-flash 1.6s ease-out; }
@keyframes wave-flash { from { background: var(--highlight); } to { background: var(--surface); } }
.wave-blip[data-kind="brief"] { border-left: 4px solid var(--accent); }
.wave-blip[data-kind="agent"], .agent-card { background: var(--agent); border-color: var(--agent-border); }
.wave-blip[data-kind="proposal"], .proposal-card { background: var(--proposal); border-color: var(--proposal-border); }
.wave-blip[data-kind="decision"], .decision-card { border: 2px solid var(--decision-border); }
.wave-blip[data-deleted="1"], .wave-blip.deleted { opacity: .6; border-style: dashed; }
.blip-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; font-size: 13px; color: var(--text-2); }
.blip-head .avatar { width: 22px; height: 22px; font-size: 9px; }
.blip-author { font-weight: 600; color: var(--text); }
.blip-time { color: var(--text-3); }
.blip-kind, .kind-badge { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; padding: 1px 6px; border-radius: 4px; background: var(--surface-3); color: var(--text-2); display: inline-flex; align-items: center; gap: 4px; }
.wave-blip[data-kind="agent"] .blip-kind { background: #e4dbfb; color: #4c2ea8; }
.wave-blip[data-kind="proposal"] .blip-kind { background: #cdeedb; color: #1b5e3a; }
.wave-blip[data-kind="decision"] .blip-kind { background: var(--text); color: var(--surface); }
.blip-body { overflow-wrap: anywhere; }
.blip-body .md > :first-child, .md > :first-child { margin-top: 0; }
.blip-body .md > :last-child, .md > :last-child { margin-bottom: 0; }
.md h1 { font-size: 20px; margin: 12px 0 6px; } .md h2 { font-size: 17px; margin: 12px 0 6px; } .md h3 { font-size: 15px; margin: 10px 0 4px; }
.md p, .md ul, .md ol, .md blockquote, .md pre { margin: 6px 0; }
.md blockquote { border-left: 3px solid var(--border-strong); margin-left: 0; padding-left: 10px; color: var(--text-2); }
.md a[rel~="noopener"] { overflow-wrap: anywhere; }
.bliplink, .md .bliplink { font-family: var(--mono); font-size: 12px; color: var(--accent); text-decoration: underline; background: transparent; border: 0; padding: 0; cursor: pointer; }
/* The editor keeps the read view's width and font, so nothing jumps. */
.blip-editor {
  width: 100%; min-height: 3.6em; font: inherit; line-height: 1.5; padding: 0; border: 0; border-radius: 0; background: transparent;
  resize: none; overflow: hidden; color: var(--text); white-space: pre-wrap; overflow-wrap: anywhere;
}
.blip-editor:focus { outline: none; }
.blip-edit-wrap, .editor-wrap { position: relative; outline: 2px solid var(--accent-soft); outline-offset: 6px; border-radius: 2px; }
.blip-editor-host, .editor-host { position: relative; }
.mirror {
  position: absolute; inset: 0; visibility: hidden; pointer-events: none; white-space: pre-wrap; overflow-wrap: anywhere;
  font: inherit; line-height: 1.5; padding: 0; border: 0; margin: 0;
}
.remote-caret { position: absolute; width: 2px; height: 1.4em; background: var(--peer-color, var(--accent)); pointer-events: none; }
.remote-caret .caret-tag, .caret-tag {
  position: absolute; top: -1.3em; left: -1px; padding: 0 5px; border-radius: 3px 3px 3px 0; font-size: 10px; line-height: 1.5;
  background: var(--peer-color, var(--accent)); color: #fff; white-space: nowrap; font-weight: 600;
}
.remote-selection { position: absolute; background: var(--peer-color, var(--accent)); opacity: .18; pointer-events: none; }
.blip-actions { display: flex; align-items: center; gap: 2px; flex-wrap: wrap; margin-top: 8px; }
.blip-actions .btn { min-height: 28px; padding: 3px 8px; font-size: 13px; }
.blip-count, .char-count { margin-left: auto; font-size: 12px; color: var(--text-3); font-variant-numeric: tabular-nums; }
.editing-chip { font-size: 12px; color: var(--peer-color, var(--accent)); display: inline-flex; align-items: center; gap: 4px; }
.editing-chip::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.blip-replies { margin: 8px 0 0 18px; padding-left: 12px; border-left: 2px solid var(--border); }
.blip-replies > .wave-blip:last-child { margin-bottom: 0; }
.blip-collapsed, .more-replies { margin: 6px 0 6px 18px; }
.blip-collapsed .btn, .more-replies .btn, .blip-more .btn { font-size: 13px; }
.blip-actions .more-btn { min-width: 32px; padding: 3px 6px; }
/* One .blip-para per rendered block (blip.js); its gutter button sits at the paragraph's top right,
   inside the card (a button left of the card would fall outside the conversation's padding). */
.blip-para { position: relative; }
.para-reply-btn {
  position: absolute; right: 0; top: 0; z-index: 1; opacity: 0; min-height: 24px; padding: 2px 6px; font: inherit; font-size: 12px;
  color: var(--text-2); background: var(--surface); border: 1px solid var(--border); border-radius: 6px; cursor: pointer;
}
.para-reply-btn:hover { color: var(--text); border-color: var(--accent); }
/* Shown while the paragraph's own block (or the button) is hovered or focused: not .blip-para:hover,
   which also matches while a reply nested in the paragraph's .para-replies slot is hovered. The
   block is the first child and the button follows it (blip.js). */
.blip-para > :first-child:hover + .para-reply-btn, .blip-para > :first-child:focus-within + .para-reply-btn,
.para-reply-btn:hover, .para-reply-btn:focus-visible { opacity: 1; }
.para-replies { margin: 6px 0 6px 12px; padding-left: 10px; border-left: 2px dashed var(--border); }
.anchor-note, .removed-anchor { font-size: 12px; color: var(--warn); }
.agent-card .sections h4, .agent-sections h4, .blip-body h4 { margin: 10px 0 2px; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--text-2); }
.sources { font-size: 12px; color: var(--text-3); margin-top: 6px; display: flex; flex-wrap: wrap; gap: 2px 4px; align-items: baseline; }
.proposal-target { font-size: 13px; color: var(--text-2); margin-bottom: 6px; }
.diff { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 8px 0; }
.diff-quote, .diff-replacement { padding: 8px 10px; border-radius: var(--radius-sm); font-size: 13px; white-space: pre-wrap; overflow-wrap: anywhere; }
.diff-quote { background: var(--danger-soft); text-decoration: line-through; text-decoration-color: rgba(198, 40, 40, .5); }
.diff-quote:empty::before, .diff-quote.whole::before { content: "(the whole text)"; text-decoration: none; color: var(--text-3); }
.diff-replacement { background: var(--ok-soft); }
.version-chips { display: flex; gap: 6px; flex-wrap: wrap; font-size: 12px; color: var(--text-3); }
.stale-chip, .version-chip { font-size: 12px; padding: 1px 8px; border-radius: 999px; background: var(--surface-3); color: var(--text-2); }
.stale-chip { background: var(--warn-soft); color: var(--warn); }
.proposal-state { font-size: 12px; font-weight: 600; }
.decision-fields { margin-top: 8px; display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; font-size: 13px; }
.decision-fields dt { color: var(--text-3); font-weight: 500; }
.decision-fields dd { margin: 0; overflow-wrap: anywhere; }
.supersedes, .superseded-by { font-size: 12px; color: var(--text-2); }
.unverified { font-size: 11px; color: var(--text-3); }
.thread-focus .back-link, .back-link { display: inline-flex; align-items: center; gap: 6px; margin-bottom: 12px; }
.thread-focus > .wave-blip { margin-left: 0; }
.conversation-empty, .empty-note { color: var(--text-3); padding: 24px 0; text-align: center; }

/* Dialogs, menus, toasts */
.modal-scrim { position: fixed; inset: 0; background: rgba(10, 14, 22, .45); z-index: 50; display: flex; align-items: center; justify-content: center; padding: 16px; }
.modal {
  background: var(--surface); color: var(--text); border-radius: 12px; box-shadow: var(--shadow-3); width: min(440px, 100%);
  max-height: calc(100vh - 32px); overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 14px;
}
.modal.decision-dialog, .modal.text-dialog, .modal.run-dialog { width: min(640px, 100%); }
.modal h2 { margin: 0; font-size: 17px; }
.modal p { margin: 0; color: var(--text-2); }
.modal input[type="text"], .modal input:not([type]) { width: 100%; padding: 8px 10px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
.name-row { display: flex; gap: 10px; align-items: center; }
.swatches { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.swatch { width: 28px; height: 28px; border-radius: 50%; border: 2px solid var(--text-3); padding: 0; flex: none; }
.swatch[aria-checked="true"] { border-color: var(--text); box-shadow: inset 0 0 0 2px var(--surface); border-width: 3px; }
.field-row { display: flex; flex-direction: column; gap: 4px; }
.field-row label { font-weight: 600; font-size: 13px; }
.field-row .hint { font-size: 12px; color: var(--text-3); }
.field-error { color: var(--danger); font-size: 13px; }
.decision-dialog .context { background: var(--surface-2); border-radius: var(--radius-sm); padding: 8px 10px; font-size: 13px; color: var(--text-2); display: flex; flex-direction: column; gap: 4px; }
.decision-dialog .context strong { color: var(--text); }
.text-dialog-text { font-family: var(--mono); font-size: 12px; min-height: 240px; white-space: pre; overflow: auto; }
.menu {
  position: fixed; z-index: 40; background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 8px;
  box-shadow: var(--shadow-2); padding: 4px; min-width: 200px; max-width: min(360px, calc(100vw - 16px)); display: flex; flex-direction: column;
  max-height: calc(100vh - 16px); overflow-y: auto;
}
.menu .btn { justify-content: flex-start; width: 100%; white-space: normal; text-align: left; }
.menu .menu-item { flex-direction: column; align-items: flex-start; gap: 0; }
.menu-desc { font-size: 12px; color: var(--text-3); font-weight: 400; }
.menu-head { padding: 6px 8px 8px; border-bottom: 1px solid var(--border); margin-bottom: 4px; display: flex; flex-direction: column; gap: 6px; }
.menu-title { font-weight: 650; }
.scope-row { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; font-size: 13px; color: var(--text-2); }
.menu-head input { width: 100%; }
.menu-note { padding: 8px 8px 4px; font-size: 12px; color: var(--text-3); border-top: 1px solid var(--border); margin-top: 4px; }
.toasts { position: fixed; top: 60px; left: 50%; transform: translateX(-50%); z-index: 60; display: flex; flex-direction: column; gap: 8px; width: min(460px, calc(100vw - 32px)); pointer-events: none; }
.toast { pointer-events: auto; background: #2b2d33; color: #fff; border-radius: 8px; padding: 8px 8px 8px 14px; box-shadow: var(--shadow-2); display: flex; gap: 8px; align-items: center; }
.toast .msg { flex: 1; overflow-wrap: anywhere; }
.toast .btn { color: #fff; }
.toast .btn.toast-action { border: 1px solid rgba(255, 255, 255, .5); }
.toast .btn:hover { background: rgba(255, 255, 255, .15); color: #fff; }
.overlay-message { background: var(--surface); color: var(--text); padding: 16px 22px; border-radius: 10px; box-shadow: var(--shadow-3); }

/* Phones: single column, the panel a bottom sheet opened from its tab bar, 44 px targets. */
@media (max-width: 720px) {
  :root { --target: 44px; --header-h: 48px; }
  .wave-app { grid-template-columns: minmax(0, 1fr); grid-template-areas: "header" "centre"; grid-template-rows: var(--header-h) minmax(0, 1fr); }
  .wave-centre { padding-bottom: 52px; }
  .wave-header { padding: 0 8px; gap: 4px; }
  .wave-title { font-size: 15px; }
  .btn-label { display: none; }
  .header-actions .btn { min-width: 44px; }
  .here-count, .conn { display: none; }
  .saving-chip { display: none; }
  .saving-chip[data-state="saving"], .saving-chip[data-state="failed"] { display: inline; }
  .wave-panel {
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 30; border-left: 0; border-top: 1px solid var(--border);
    flex-direction: column-reverse; max-height: 72vh; box-shadow: var(--shadow-2);
  }
  .wave-panel[data-open="false"] { box-shadow: none; }
  .wave-panel[data-open="false"] .panel-sheet { display: none; }
  .panel-tabs { border-bottom: 0; border-top: 1px solid var(--border); padding-bottom: env(safe-area-inset-bottom, 0px); }
  .panel-tab { min-height: 48px; border-bottom: 0; border-top: 2px solid transparent; }
  .panel-tab[aria-selected="true"] { border-top-color: var(--accent); }
  .panel-sheet { border-radius: 14px 14px 0 0; background: var(--surface); }
  .panel-close { display: inline-flex; }
  .panel-body { max-height: calc(72vh - 96px); }
  .wave-conversation, .conversation { padding: 12px 12px 140px; }
  /* Touch targets of at least 44 px (as the whiteboard): card actions, the paragraph reply button,
     the editor's Done, "N more replies", menus, dialogs and the toast's action. */
  .blip-actions .btn, .btn.small, .menu .btn, .modal-actions .btn, .history-item-btn, .editor-bar .btn, .blip-more .btn,
  .back-btn, .toast .btn { min-height: 44px; }
  .blip-actions .more-btn { min-width: 44px; }
  .para-reply-btn { position: static; opacity: 1; margin: 4px 0 0; min-height: 44px; padding: 4px 12px; }
  .diff { grid-template-columns: 1fr; }
  .modal .swatch { width: 44px; height: 44px; }
  .toasts { top: auto; bottom: 60px; }
  .template-grid { grid-template-columns: 1fr; }
  .template-btn { min-height: 44px; }
  .history-scrubber { min-height: 44px; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
  .wave-blip.highlight, .wave-blip[data-highlight="1"] { background: var(--highlight); }
}

@media print {
  body { overflow: visible; background: #fff; }
  .wave-app { position: static; display: block; }
  .wave-header, .wave-panel, .toasts, .conn-banner, .history-banner, .templates, .blip-actions, .para-reply-btn,
  .editing-chip, .remote-caret, .menu, .modal-scrim { display: none !important; }
  .wave-centre { overflow: visible; }
  .wave-centre > :last-child { overflow: visible; }
  .wave-blip { box-shadow: none; break-inside: avoid; }
  .blip-collapsed, .more-replies { display: none; }
}
`;

export function injectStyles() {
  if (document.getElementById("wave-styles")) return;
  document.head.appendChild(el("style", { id: "wave-styles" }, SHELL_CSS));
}
