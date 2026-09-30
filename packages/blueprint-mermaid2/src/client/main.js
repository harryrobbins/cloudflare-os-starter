import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { history, historyKeymap, defaultKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, indentOnInput } from '@codemirror/language';
import DOMPurify from 'dompurify';
import { renderDiagram } from './engine.js';
import { examples, exampleOptions } from './examples.js';
import { exportDiagram } from './export.js';
import { loadDraft, saveDraft } from './persistence.js';
const style = document.createElement('style'); style.textContent = MERMAID2_CSS; document.head.append(style);
const mount = document.createElement('div'); mount.id = 'app'; document.body.append(mount);

const icons = {
  play: '<path d="m9 5 11 7-11 7z"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M5 17v4h14v-4"/>',
  expand: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  minus: '<path d="M5 12h14"/>',
  plus: '<path d="M5 12h14m-7-7v14"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>',
  code: '<path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4m0 3h.01"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;

document.querySelector('#app').innerHTML = `
  <header class="masthead">
    <a class="brand" href="#" aria-label="MermaiD2 home">
      <svg class="brand-mark" viewBox="0 0 34 34" fill="none" aria-hidden="true"><rect x="1" y="1" width="32" height="32" rx="8" fill="currentColor"/><g stroke="#e4edce" stroke-width="1.5"><rect x="7" y="7" width="7" height="7" rx="1"/><rect x="20" y="20" width="7" height="7" rx="1"/><path d="M14 10h10v10M10 14v10h10"/></g></svg>
      <span>Mermai<span class="brand-d2">D2</span><span class="brand-divider">/</span><span class="brand-subtitle">diagram playground</span></span>
    </a>
    <div class="header-actions"><span class="local-note"><span class="dot"></span>Private diagram renderer</span><button id="help" class="icon-button" aria-label="About this playground">${icon('help')}</button></div>
  </header>
  <main>
    <div class="intro"><div><p class="eyebrow">A LITTLE STRUCTURE GOES A LONG WAY</p><h1>Your ideas. Beautifully connected.</h1></div><p class="intro-note">Two languages. Three layout engines.<br>Explore the connections. Find your favourite view.</p></div>
    <div class="workspace-toolbar">
      <div class="language-switch" role="group" aria-label="Input language"><button data-language="mermaid" aria-pressed="true">Mermaid</button><button data-language="d2" aria-pressed="false">D2</button></div>
      <div class="toolbar-right"><label class="example-label" for="example">Try an example</label><select id="example" aria-label="Load an example"><option value="">Choose a diagram…</option></select><button id="render" class="primary-button">${icon('play')}<span>Render diagram</span><kbd>⌘ ↵</kbd></button></div>
    </div>
    <div class="workspace">
      <section class="source-panel" aria-labelledby="source-heading">
        <div class="panel-heading"><h2 id="source-heading"><span class="panel-index">01</span> Source</h2><div class="panel-actions"><label class="live-label"><input id="live" type="checkbox" checked /><span class="switch" aria-hidden="true"></span>Live preview</label><button id="copy-source" class="icon-button" aria-label="Copy source">${icon('copy')}</button></div></div>
        <div id="editor"></div>
        <div class="source-footer"><span id="source-info">Mermaid · 1 line</span><span id="save-status">Saved in this gadget</span></div>
      </section>
      <section class="preview-panel" aria-labelledby="preview-heading">
        <div class="panel-heading"><h2 id="preview-heading"><span class="panel-index">02</span> Canvas <span id="engine-tag" class="engine-tag">TALA</span></h2><div class="panel-actions"><button id="show-d2" class="text-button" disabled>${icon('code')}<span>View D2</span></button><select id="export-format" aria-label="Export format"><optgroup label="Images"><option value="svg">SVG</option><option value="png">PNG</option><option value="jpeg">JPEG</option><option value="webp">WebP</option></optgroup><optgroup label="Documents"><option value="pdf">PDF</option><option value="ascii">ASCII text</option></optgroup><optgroup label="Source &amp; data"><option value="source">Input source</option><option value="d2">D2 source</option><option value="json">Diagram JSON</option></optgroup></select><select id="export-scale" aria-label="Export resolution" hidden><option value="1">1×</option><option value="2" selected>2×</option><option value="3">3×</option></select><button id="download" class="text-button" disabled>${icon('download')}<span>Export</span></button></div></div>
        <div id="canvas" tabindex="0" role="region" aria-label="Diagram preview. Drag to pan, use the zoom buttons or mouse wheel to zoom.">
          <div class="canvas-coordinate coordinate-top">LAYOUT / AUTO</div><div class="canvas-coordinate coordinate-bottom">DRAG TO PAN · SCROLL TO ZOOM</div>
          <div id="diagram-stage"></div>
          <div id="empty-state"><div class="empty-symbol">↗</div><p>Your diagram takes shape here.</p><span>Write a little. Connect a lot.</span></div>
          <div id="busy-overlay" hidden><span class="spinner"></span><span>Finding the connections…</span></div>
          <div class="zoom-controls"><button id="zoom-out" class="icon-button" aria-label="Zoom out">${icon('minus')}</button><output id="zoom-value" aria-label="Zoom level">100%</output><button id="zoom-in" class="icon-button" aria-label="Zoom in">${icon('plus')}</button><span class="control-divider"></span><button id="fit" class="icon-button" aria-label="Fit diagram to canvas">${icon('expand')}</button></div>
        </div>
        <div id="error" class="error-panel" role="alert" hidden><strong id="error-title">Could not render this diagram</strong><pre id="error-message"></pre></div>
        <div class="preview-footer"><span id="status" role="status" aria-live="polite"><span class="dot"></span>Preparing the canvas</span><span id="metrics">TALA layout</span></div>
      </section>
    </div>
    <footer class="page-footer"><span>Built for the way you think.</span><span>Mermaid → D2 → <span id="footer-engine">TALA</span> <span class="footer-separator">/</span> <a href="https://d2lang.com" target="_blank" rel="noreferrer">Powered by D2 ↗</a></span></footer>
  </main>
  <dialog id="d2-dialog" aria-labelledby="d2-dialog-title"><div class="dialog-heading"><div><p class="eyebrow">UNDER THE SURFACE</p><h2 id="d2-dialog-title">D2 used for this diagram</h2></div><button class="icon-button close-dialog" aria-label="Close D2 source">${icon('close')}</button></div><pre id="converted-source"></pre><div class="dialog-footer"><span id="conversion-note"></span><button id="copy-d2" class="primary-button">${icon('copy')}Copy D2</button></div></dialog>
  <dialog id="help-dialog" aria-labelledby="help-title"><div class="dialog-heading"><div><p class="eyebrow">A PLACE FOR YOUR IDEAS</p><h2 id="help-title">Meet the playground.</h2></div><button class="icon-button close-dialog" aria-label="Close help">${icon('close')}</button></div><div class="help-content"><p>Write <strong>Mermaid or D2</strong> on the left. Both are rendered by D2. Choose TALA for architecture diagrams, or compare it with the layered Dagre and ELK engines. Switch languages to return to each language’s own saved draft.</p><p><strong>Mermaid support:</strong> flowcharts, sequence, state, class, entity relationship, mindmap, and C4 diagrams. Conversion uses <a href="https://github.com/noamsto/mermaid2d2" target="_blank" rel="noreferrer">mermaid2d2</a>. Some language-specific styling and features do not carry over. Mermaid frontmatter and initialization settings are ignored; choose the output palette here. Pie, Gantt, journey, XY, and git graphs have no conversion.</p><p><strong>D2 support:</strong> paste a self-contained diagram. Local file imports and multiple-board navigation are not available here. Sequence diagrams use D2’s specialized sequence layout with any selected layout engine.</p><p>Rendering runs in an isolated Cloudflare browser. Drafts are saved with this gadget. External images and imports are blocked.</p><p><strong>Export:</strong> SVG stays vector. PNG, JPEG, WebP, and PDF use the selected resolution; PDF contains a raster image on a page sized to your diagram. ASCII exports D2’s text representation. Source and JSON exports are also available. Images must be embedded.</p><p><strong>Shortcuts:</strong> Ctrl/⌘ + Enter to render. Drag the canvas to pan, scroll to zoom, and use the fit button to reset the view.</p></div></dialog>
  <div id="toast" role="status" aria-live="polite" hidden></div>
`;

const $ = (id) => document.getElementById(id);

const drafts = { mermaid: examples.architecture.mermaid, d2: examples.architecture.d2 };
let language = 'mermaid';
let initialTheme = '104';
let initialSketch = false;
let initialLive = true;
let initialLayout = 'tala';
try {
  const saved = await loadDraft();
  if (saved) {
    for (const key of ['mermaid', 'd2']) if (typeof saved.drafts?.[key] === 'string') drafts[key] = saved.drafts[key];
    if (saved.language === 'd2') language = 'd2';
    if (['0', '1', '103', '104', '200'].includes(saved.theme)) initialTheme = saved.theme;
    if (['tala', 'dagre', 'elk'].includes(saved.layout)) initialLayout = saved.layout;
    initialSketch = saved.sketch === true;
    initialLive = saved.live !== false;
  }
} catch { /* Storage can be disabled, or an old draft can be malformed. */ }

// Options live with the source, leaving the canvas controls focused on navigation.
const options = document.createElement('div');
options.className = 'render-options';
options.innerHTML = `<label for="layout">Layout</label><select id="layout"><option value="tala">TALA</option><option value="dagre">Dagre</option><option value="elk">ELK</option></select><label for="theme">Palette</label><select id="theme"><option value="0">Neutral</option><option value="1">Graphite</option><option value="103">Earth tones</option><option value="104">Everglade</option><option value="200">Dark mauve</option></select><label class="sketch-label"><input id="sketch" type="checkbox" />Sketch</label>`;
$('editor').before(options);
$('theme').value = initialTheme;
$('layout').value = initialLayout;
const exampleDescription = document.createElement('p');
exampleDescription.id = 'example-description';
exampleDescription.className = 'example-description';
exampleDescription.textContent = 'Choose an example to explore architectures, flowcharts, state, class, ER, sequence, and mindmap diagrams.';
options.after(exampleDescription);
$('sketch').checked = initialSketch;
$('live').checked = initialLive;
if (!navigator.platform.toLowerCase().includes('mac')) $('render').querySelector('kbd').textContent = 'Ctrl ↵';

let revision = 0;
let renderedRevision = -1;
let rendering = false;
let queued = false;
let debounce;
let result;
let toastTimer;
const editorStates = new Map();

const editorTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px', color: '#35372f' },
  '.cm-scroller': { fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace', lineHeight: '1.85' },
  '.cm-content': { padding: '22px 0 48px', caretColor: '#52633c' },
  '.cm-line': { padding: '0 24px 0 12px' },
  '.cm-gutters': { background: 'transparent', color: '#aaa99c', border: 'none', minWidth: '45px' },
  '.cm-activeLine, .cm-activeLineGutter': { background: '#eaece244' },
  '&.cm-focused': { outline: 'none' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { background: '#dbe3c7' },
});
const editorExtensions = [lineNumbers(), history(), drawSelection(), highlightActiveLine(), highlightActiveLineGutter(), bracketMatching(), indentOnInput(), editorTheme,
      EditorView.contentAttributes.of({ 'aria-label': 'Diagram source', spellcheck: 'false' }),
      keymap.of([{ key: 'Mod-Enter', run: () => { requestRender(); return true; } }, indentWithTab, ...defaultKeymap, ...historyKeymap]),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        drafts[language] = update.state.doc.toString();
        updateSourceInfo();
        save();
        changed();
      }),
    ];
const editor = new EditorView({
  state: EditorState.create({ doc: drafts[language], extensions: editorExtensions }),
  parent: $('editor'),
});

function save() {
  saveDraft({ drafts: { ...drafts }, language, theme: $('theme').value, sketch: $('sketch').checked, live: $('live').checked, layout: $('layout').value }, $('save-status'));
}

function updateSourceInfo() {
  const lines = editor.state.doc.lines;
  $('source-info').textContent = `${language === 'd2' ? 'D2' : 'Mermaid'} · ${lines} ${lines === 1 ? 'line' : 'lines'}`;
}

function setStatus(message, type = 'ready') {
  $('status').replaceChildren();
  const dot = document.createElement('span');
  dot.className = `dot ${type}`;
  $('status').append(dot, document.createTextNode(message));
}

function changed() {
  revision++;
  queued = false;
  clearTimeout(debounce);
  $('download').disabled = true;
  $('show-d2').disabled = true;
  $('error').hidden = true;
  setStatus('Edited · preview out of date', 'edited');
  if ($('live').checked) debounce = setTimeout(requestRender, 550);
}

function requestRender() {
  clearTimeout(debounce);
  queued = true;
  flushRender();
}

async function flushRender() {
  if (rendering || !queued) return;
  queued = false;
  const snapshot = { language, source: editor.state.doc.toString(), theme: $('theme').value, sketch: $('sketch').checked, layout: $('layout').value };
  const engineName = layoutName(snapshot.layout);
  const currentRevision = revision;
  if (!snapshot.source.trim()) {
    result = undefined;
    $('diagram-stage').replaceChildren();
    $('empty-state').hidden = false;
    $('download').disabled = true;
    $('show-d2').disabled = true;
    $('metrics').textContent = `${engineName} layout`;
    setStatus('Add a diagram to get started', 'edited');
    return;
  }
  rendering = true;
  $('render').disabled = true;
  $('render').querySelector('span').textContent = 'Rendering…';
  $('busy-overlay').hidden = false;
  $('canvas').setAttribute('aria-busy', 'true');
  $('error').hidden = true;
  setStatus(`Laying out with ${engineName}`, 'busy');
  const started = performance.now();
  try {
    const output = await renderDiagram(snapshot);
    if (currentRevision !== revision) return;
    const safeSVG = DOMPurify.sanitize(output.svg, { USE_PROFILES: { svg: true, svgFilters: true }, ADD_TAGS: ['style'] });
    const fragment = document.createElement('template');
    fragment.innerHTML = safeSVG;
    const svg = fragment.content.querySelector('svg');
    if (!svg) throw new Error('The renderer returned an empty diagram.');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `Diagram laid out with ${engineName}`);
    // SVG's aspect ratio and viewBox determine its fitted size; transforms handle navigation.
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    const preview = document.createElement('img');
    const bytes = new TextEncoder().encode(safeSVG); let encoded = '';
    for (let at = 0; at < bytes.length; at += 8192) encoded += String.fromCharCode(...bytes.subarray(at, at + 8192));
    preview.src = 'data:image/svg+xml;base64,' + btoa(encoded);
    preview.alt = `Diagram laid out with ${engineName}`;
    $('diagram-stage').replaceChildren(preview);
    result = { ...output, svg: safeSVG, language: snapshot.language, source: snapshot.source, theme: snapshot.theme, sketch: snapshot.sketch };
    renderedRevision = currentRevision;
    $('empty-state').hidden = true;
    $('download').disabled = false;
    $('show-d2').disabled = false;
    $('metrics').textContent = `${output.nodes} nodes · ${output.edges} edges · ${Math.round(performance.now() - started)} ms`;
    setStatus(`Rendered with ${engineName}`);
    $('engine-tag').textContent = engineName;
    $('footer-engine').textContent = engineName;
    resetView();
  } catch (error) {
    if (currentRevision !== revision) return;
    $('error-title').textContent = snapshot.language === 'mermaid' ? 'Could not convert or render this Mermaid diagram' : 'Could not render this D2 diagram';
    $('error-message').textContent = error.message;
    $('error').hidden = false;
    $('download').disabled = true;
    $('show-d2').disabled = true;
    setStatus(result ? 'Error · showing previous preview' : 'Check your diagram source', 'error');
  } finally {
    rendering = false;
    $('render').disabled = false;
    $('render').querySelector('span').textContent = 'Render diagram';
    $('busy-overlay').hidden = true;
    $('canvas').setAttribute('aria-busy', 'false');
    if (currentRevision !== revision) setStatus('Edited · preview out of date', 'edited');
    if (queued) flushRender();
  }
}

function layoutName(layout) { return { tala: 'TALA', dagre: 'Dagre', elk: 'ELK' }[layout]; }

function updateLanguageButtons() {
  document.querySelectorAll('[data-language]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.language === language)));
}
document.querySelectorAll('[data-language]').forEach((button) => button.addEventListener('click', () => {
  if (button.dataset.language === language) return;
  editorStates.set(language, editor.state);
  language = button.dataset.language;
  editor.setState(editorStates.get(language) ?? EditorState.create({ doc: drafts[language], extensions: editorExtensions }));
  $('example').innerHTML = exampleOptions(language);
  exampleDescription.textContent = 'Choose an example for this input language. Native D2 topologies have no fixed flow direction.';
  updateLanguageButtons();
  updateSourceInfo();
  save();
  changed();
  requestRender();
}));

$('example').addEventListener('change', () => {
  const example = examples[$('example').value];
  if (!example || !example[language]) return;
  exampleDescription.textContent = `${example.type} · ${example.complexity} — ${example.description}`;
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: example[language] } });
  requestRender();
});
$('render').addEventListener('click', requestRender);
for (const id of ['theme', 'sketch', 'layout']) $(id).addEventListener('change', () => { save(); changed(); requestRender(); });
$('live').addEventListener('change', () => {
  save();
  if ($('live').checked) requestRender();
  else { clearTimeout(debounce); queued = false; }
});

function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2500);
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied to clipboard'); }
  catch { toast('Clipboard unavailable. Select the text and copy it manually.'); }
}
$('copy-source').addEventListener('click', () => copy(editor.state.doc.toString()));
$('copy-d2').addEventListener('click', () => { if (result) copy(result.d2Source); });
$('show-d2').addEventListener('click', () => {
  if (!result || renderedRevision !== revision) return;
  $('converted-source').textContent = result.d2Source;
  $('conversion-note').textContent = `${result.language === 'mermaid' ? 'Converted from Mermaid.' : 'Your D2 source.'} Rendered with ${layoutName(result.layout)}.`;
  $('d2-dialog').showModal();
});
$('help').addEventListener('click', () => $('help-dialog').showModal());
document.querySelectorAll('.close-dialog').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));
document.querySelectorAll('dialog').forEach((dialog) => dialog.addEventListener('click', (event) => {
  if (event.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
}));
$('export-format').addEventListener('change', () => {
  $('export-scale').hidden = !['png', 'jpeg', 'webp', 'pdf'].includes($('export-format').value);
});
$('download').addEventListener('click', async () => {
  if (!result || renderedRevision !== revision) return;
  const exporting = result;
  $('download').disabled = true;
  $('download').querySelector('span').textContent = 'Exporting…';
  try { await exportDiagram(exporting, $('export-format').value, Number($('export-scale').value)); }
  catch (error) { toast(error.message); }
  finally {
    $('download').querySelector('span').textContent = 'Export';
    $('download').disabled = renderedRevision !== revision || result !== exporting;
  }
});

let zoom = 1;
let pan = { x: 0, y: 0 };
let drag;
function applyView() {
  $('diagram-stage').style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;
  $('zoom-value').textContent = `${Math.round(zoom * 100)}%`;
}
function resetView() { zoom = 1; pan = { x: 0, y: 0 }; applyView(); }
function changeZoom(factor, point = { x: 0, y: 0 }) {
  const next = Math.max(0.2, Math.min(5, zoom * factor));
  const ratio = next / zoom;
  pan.x = point.x - (point.x - pan.x) * ratio;
  pan.y = point.y - (point.y - pan.y) * ratio;
  zoom = next;
  applyView();
}
$('zoom-in').addEventListener('click', () => changeZoom(1.2));
$('zoom-out').addEventListener('click', () => changeZoom(1 / 1.2));
$('fit').addEventListener('click', resetView);
$('canvas').addEventListener('wheel', (event) => {
  if (!result || event.target.closest('.zoom-controls')) return;
  event.preventDefault();
  const stage = $('diagram-stage');
  const canvasRect = $('canvas').getBoundingClientRect();
  const center = { x: canvasRect.left + stage.offsetLeft + stage.offsetWidth / 2, y: canvasRect.top + stage.offsetTop + stage.offsetHeight / 2 };
  changeZoom(Math.exp(-event.deltaY * 0.0015), { x: event.clientX - center.x, y: event.clientY - center.y });
}, { passive: false });
$('canvas').addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || !result || event.target.closest('button, a')) return;
  drag = { id: event.pointerId, x: event.clientX - pan.x, y: event.clientY - pan.y };
  $('canvas').setPointerCapture(event.pointerId);
  $('canvas').classList.add('dragging');
});
$('canvas').addEventListener('pointermove', (event) => {
  if (!drag || event.pointerId !== drag.id) return;
  pan = { x: event.clientX - drag.x, y: event.clientY - drag.y };
  applyView();
});
for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) $('canvas').addEventListener(event, () => { drag = undefined; $('canvas').classList.remove('dragging'); });
$('canvas').addEventListener('keydown', (event) => {
  if (event.target !== $('canvas')) return;
  if (event.key === '+' || event.key === '=') changeZoom(1.2);
  else if (event.key === '-') changeZoom(1 / 1.2);
  else if (event.key === '0') resetView();
  else return;
  event.preventDefault();
});
window.addEventListener('keydown', (event) => {
  if (!event.defaultPrevented && (event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); requestRender(); }
});

$('example').innerHTML = exampleOptions(language);
updateLanguageButtons();
updateSourceInfo();
save();
requestRender();
