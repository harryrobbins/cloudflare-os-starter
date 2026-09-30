// @ts-check
// The Arcade's CSS, injected as one <style> (the iframe has no stylesheet of its own).

const CSS = `
:root {
  --bg: #0e1118; --panel: #161b26; --panel2: #1d2331; --line: #2b3346; --text: #e9edf5; --muted: #9aa4b8;
  --accent: #ffd166; --accent-ink: #1a1400; --good: #06d6a0; --bad: #ff6b81; --link: #7cc4ff;
  --mono: ui-monospace, "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace;
  color-scheme: dark;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
body > div { height: 100%; display: flex; flex-direction: column; }
button, input, select, textarea { font: inherit; color: inherit; }
button { background: var(--panel2); border: 1px solid var(--line); border-radius: 6px; padding: 5px 11px; cursor: pointer; }
button:hover { border-color: #46506a; }
button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, summary:focus-visible, .piano-keys:focus-visible, canvas:focus-visible {
  outline: 2px solid var(--accent); outline-offset: 2px;
}
button.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); font-weight: 600; }
button.danger, button.armed { border-color: var(--bad); color: var(--bad); }
button.primary.armed { background: var(--bad); color: #fff; }
button.icon { padding: 3px 8px; }
button.link { background: none; border: 0; color: var(--link); padding: 0 6px 0 0; text-decoration: underline; }
button:disabled { opacity: .5; cursor: default; }
input, select, textarea { background: #0b0e14; border: 1px solid var(--line); border-radius: 6px; padding: 5px 8px; }
input[type=checkbox], input[type=radio] { accent-color: var(--accent); }
input[type=range] { padding: 0; accent-color: var(--accent); }
.muted { color: var(--muted); }
.pad { padding: 12px 16px; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 8px 0; }
.inline { display: inline-flex; gap: 6px; align-items: center; white-space: nowrap; }
.stack { display: flex; flex-direction: column; gap: 4px; }
.spacer { flex: 1; }
h2 { font-size: 17px; margin: 0; }
h3 { font-size: 14px; margin: 14px 0 6px; }

header.top { display: flex; align-items: center; gap: 16px; padding: 8px 14px; border-bottom: 1px solid var(--line); background: var(--panel); flex-wrap: wrap; }
.brand { display: flex; align-items: center; gap: 8px; }
.logo { color: var(--accent); font-size: 20px; line-height: 1; }
.arcade-title { background: none; border: 0; font-size: 16px; font-weight: 700; padding: 2px 4px; }
.arcade-title-input { font-size: 16px; font-weight: 700; width: 16em; }
.tabs { display: flex; gap: 4px; }
.tab { background: none; border: 1px solid transparent; }
.tab.on { background: var(--panel2); border-color: var(--line); color: var(--accent); }
.conn { margin-left: auto; font-size: 12px; color: var(--muted); }
.conn.lost { color: var(--bad); }
.banner { background: #3a1620; color: #ffd0d8; padding: 6px 14px; display: flex; gap: 8px; align-items: center; }
.main { flex: 1; min-height: 0; overflow: auto; }

.shelf { padding: 16px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 12px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 6px; }
.card h3 { margin: 0; font-size: 16px; }
.card .desc { margin: 0; color: var(--muted); flex: 1; }
.card .best { margin: 0; font-size: 12px; color: var(--good); }
.card-top { display: flex; justify-content: space-between; align-items: center; }
.badge { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--accent); }
.kind-classroom .badge { color: var(--good); }
.card-actions { display: flex; gap: 6px; margin-top: 4px; }
.card-menu { position: relative; }
.card-menu summary { list-style: none; cursor: pointer; padding: 0 6px; border-radius: 4px; }
.card-menu summary::-webkit-details-marker { display: none; }
.card-menu .menu { position: absolute; right: 0; z-index: 5; background: var(--panel2); border: 1px solid var(--line); border-radius: 8px; padding: 6px; display: flex; flex-direction: column; gap: 4px; min-width: 210px; }
.card-menu .menu button { text-align: left; }
.new-card { border-style: dashed; }

.toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 14px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.play { display: flex; flex-direction: column; height: 100%; }
.play-body { flex: 1; min-height: 0; display: flex; }
.stage { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; background: #05060a; position: relative; }
.side { width: 260px; flex: none; border-left: 1px solid var(--line); padding: 4px 14px 14px; overflow: auto; background: var(--panel); }
.help-list p { margin: 4px 0; }
table.keys { border-collapse: collapse; width: 100%; margin: 6px 0; }
table.keys th, table.keys td { text-align: left; padding: 3px 6px 3px 0; border-bottom: 1px solid var(--line); font-weight: normal; vertical-align: top; }
table.keys th { color: var(--muted); }
table.keys td { font-family: var(--mono); }
ol.scores { margin: 0; padding-left: 22px; }
ol.scores li { padding: 2px 0; }
ol.scores li span { display: inline-block; min-width: 9em; }
ol.scores li.me { color: var(--accent); }
.notice { background: #2a2410; border: 1px solid #5c4d17; border-radius: 8px; padding: 8px; margin-top: 10px; }
.crash { max-width: 560px; padding: 20px; }
.crash pre { white-space: pre-wrap; color: var(--bad); font-family: var(--mono); }

.player { width: 100%; height: 100%; }
.screen-frame { position: relative; box-shadow: 0 0 0 1px #202636, 0 12px 40px #000c; border-radius: 4px; overflow: hidden; }
canvas.screen { display: block; image-rendering: pixelated; image-rendering: crisp-edges; }
.crt { position: absolute; inset: 0; pointer-events: none; background: repeating-linear-gradient(to bottom, #0000 0 2px, #0003 2px 3px); mix-blend-mode: multiply; }
.touch { display: none; width: 100%; justify-content: space-between; padding: 10px 14px; gap: 12px; }
@media (pointer: coarse) { .touch { display: flex; } }
.touch button { touch-action: none; user-select: none; -webkit-user-select: none; min-width: 52px; min-height: 52px; font-size: 18px; border-radius: 50%; }
.touch-pad { display: grid; grid-template-areas: ". up ." "left . right" ". down ."; gap: 4px; }
.touch-up { grid-area: up; } .touch-left { grid-area: left; } .touch-right { grid-area: right; } .touch-down { grid-area: down; }
.touch-buttons { display: flex; gap: 10px; align-items: center; }
.touch-start { border-radius: 10px !important; font-size: 13px !important; }

.code-view { display: flex; flex-direction: column; height: 100%; }
.code-body { flex: 1; min-height: 0; display: flex; }
.editor { flex: 1 1 55%; min-width: 0; display: flex; background: #0b0e14; border-right: 1px solid var(--line); }
.gutter { margin: 0; padding: 10px 8px 10px 10px; color: #55607a; text-align: right; font: 13px/18px var(--mono); overflow: hidden; user-select: none; min-width: 44px; background: #0d1119; }
textarea.code { flex: 1; resize: none; border: 0; border-radius: 0; background: transparent; padding: 10px; font: 13px/18px var(--mono); tab-size: 2; white-space: pre; overflow: auto; }
.preview { flex: 1 1 45%; min-width: 0; display: flex; flex-direction: column; }
.stage.small { flex: 1 1 60%; }
.console { flex: 0 0 34%; overflow: auto; border-top: 1px solid var(--line); padding: 6px 10px; font: 12px/1.5 var(--mono); background: #0b0e14; }
.log.error { color: var(--bad); white-space: pre-wrap; }
.log.ok { color: var(--good); }
.log.info { color: var(--text); }
.reference { flex: 0 0 38%; overflow: auto; border-left: 1px solid var(--line); background: var(--panel); }
.reference pre { margin: 0; padding: 12px; white-space: pre-wrap; font: 12px/1.5 var(--mono); }
.save-state { color: var(--muted); font-size: 12px; }
.save-state.unsaved { color: var(--accent); }

.music { display: flex; height: 100%; }
.tune-list { width: 220px; flex: none; border-right: 1px solid var(--line); padding: 10px; display: flex; flex-direction: column; gap: 6px; overflow: auto; background: var(--panel); }
.tune-item { text-align: left; display: flex; flex-direction: column; background: none; }
.tune-item small { color: var(--muted); }
.tune-item.on { border-color: var(--accent); background: var(--panel2); }
.music-main { flex: 1; min-width: 0; overflow: auto; padding: 12px 16px; }
.composer-bar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }
.tune-title { font-size: 16px; font-weight: 700; width: 14em; }
.tempo { width: 5em; }
canvas.roll { width: 100%; height: 150px; display: block; border: 1px solid var(--line); border-radius: 8px; }
.channels { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 10px; margin-top: 10px; }
.channel { border: 1px solid var(--line); border-left: 4px solid var(--ch); border-radius: 8px; padding: 8px; background: var(--panel); }
.channel.active { box-shadow: 0 0 0 1px var(--ch); }
.channel-head { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-bottom: 6px; }
.channel-head .swatch { width: 10px; height: 10px; border-radius: 2px; background: var(--ch); }
.ch-name { width: 8em; }
textarea.mml { width: 100%; font: 13px/1.5 var(--mono); resize: vertical; }
.mml-errors { margin: 4px 0 0; padding-left: 18px; color: var(--bad); font-size: 12px; }
.mml-errors:empty { display: none; }
.piano { margin-top: 12px; border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; background: var(--panel); }
.piano-keys { display: flex; height: 90px; position: relative; padding: 2px; border-radius: 6px; }
.key { border-radius: 0 0 5px 5px; padding: 0; }
.key.white { flex: 1; background: #f3f1ea; border: 1px solid #999; height: 100%; }
.key.black { width: 0; flex: 0 0 0; position: relative; z-index: 2; margin: 0 -9px; min-width: 18px; height: 58%; background: #1a1a1a; border: 1px solid #000; }
.key.down { background: var(--accent) !important; }
.octave { font-family: var(--mono); }
.tune-actions { margin-top: 12px; }
details.help { margin-top: 12px; }
details.help summary { cursor: pointer; color: var(--link); }
.help-body p { margin: 6px 0; max-width: 80ch; }

.controls { padding: 16px; max-width: 760px; }
.layouts { display: flex; flex-direction: column; gap: 6px; }
.layout { display: grid; grid-template-columns: auto 6em 1fr; gap: 8px; align-items: center; }

.toasts { position: fixed; bottom: 12px; right: 12px; display: flex; flex-direction: column; gap: 6px; z-index: 50; max-width: 360px; }
.toast { background: var(--panel2); border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; box-shadow: 0 6px 20px #0008; }
.toast.error { border-color: var(--bad); color: #ffd0d8; }

@media (max-width: 760px) {
  .play-body, .code-body, .music { flex-direction: column; }
  .side, .tune-list { width: auto; border-left: 0; border-right: 0; border-top: 1px solid var(--line); }
  .tune-list { flex-direction: row; overflow-x: auto; }
  .editor { min-height: 45vh; }
  .stage { min-height: 50vh; }
}
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;

export function injectStyles() {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.append(style);
}
