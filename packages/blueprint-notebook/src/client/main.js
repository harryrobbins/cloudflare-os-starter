import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { python } from '@codemirror/lang-python';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { intentHash } from '../../../gatekeeper-runtime/src/protocol.ts';
import css from './style.css';

const style = document.createElement('style'); style.textContent = css; document.head.append(style);
document.body.innerHTML = `<main class="notebook"><header><div class="brand">N<span>·</span></div><div class="heading"><div class="eyebrow">PYTHON NOTEBOOK</div><input class="title" aria-label="Notebook title" maxlength="120"><div class="save-status" role="status">Opening notebook…</div></div><div class="file-actions"><button id="import">Import .ipynb</button><button id="export">Copy notebook…</button></div></header><section class="kernelbar"><div><span class="dot"></span><strong id="kernel">Python</strong><span id="kernel-info">Checking connection</span></div><button id="stop">Stop / reset kernel</button></section><div id="notice" role="status" hidden></div><section id="cells" aria-label="Notebook cells"></section><footer><button id="add-code">＋ Code cell</button><button id="add-markdown">＋ Markdown</button><span>Shift + Enter to save and run</span></footer><input id="file" type="file" accept=".ipynb,application/json" hidden><aside id="copy-help">Copies include cells and saved outputs. Import into a new Notebook and connect your own Python kernel to run it.</aside></main>`;
const $ = selector => document.querySelector(selector);
const rows = new Map();
let doc, owner = false, runtime = { connected: false }, polling = false, latest = null, connectionFailures = 0;
let saving = Promise.resolve();
const notice = message => { $('#notice').textContent = message; $('#notice').hidden = !message; };
const status = message => { $('.save-status').textContent = message; };
const error = e => { notice(e?.message || String(e)); status('Needs attention'); };
const safe = handler => (...args) => Promise.resolve().then(() => handler(...args)).catch(error);

function outputNodes(cell, node) {
  node.replaceChildren();
  for (const output of cell.outputs ?? []) {
    const text = output.text ?? output.data?.['text/plain'] ?? (output.output_type === 'error' ? `${typeof output.ename === 'string' ? output.ename : 'Error'}: ${typeof output.evalue === 'string' ? output.evalue : ''}\n${(Array.isArray(output.traceback) ? output.traceback.filter(line => typeof line === 'string') : []).join('\n')}` : '');
    if (typeof text === 'string' && text || Array.isArray(text) && text.every(line => typeof line === 'string')) {
      const pre = document.createElement('pre');
      pre.textContent = (Array.isArray(text) ? text.join('') : String(text)).replace(/\x1b\[[0-9;]*m/g, '');
      if (output.name === 'stderr' || output.output_type === 'error') pre.className = 'error-output';
      node.append(pre);
    }
    const png = output.data?.['image/png'];
    if (typeof png === 'string' && png.length < 100_000 && /^[A-Za-z0-9+/=\r\n]+$/.test(png)) {
      const img = document.createElement('img'); img.alt = 'Python cell output'; img.src = 'data:image/png;base64,' + png; node.append(img);
    }
    if (output.data && !text && !png) {
      const hint = document.createElement('p'); hint.className = 'muted'; hint.textContent = 'This output format is preserved in downloads but is not displayed here.'; node.append(hint);
    }
  }
}
function render() {
  if (document.activeElement !== $('.title')) $('.title').value = doc.title;
  for (const [id, row] of rows) if (!doc.cells.some(c => c.id === id)) { row.editor.destroy(); row.el.remove(); rows.delete(id); }
  for (const [index, cell] of doc.cells.entries()) {
    let row = rows.get(cell.id);
    if (!row) {
      const el = document.createElement('article'); el.className = 'cell'; el.dataset.id = cell.id;
      el.innerHTML = `<div class="cell-gutter"><span class="cell-index"></span><button class="run" aria-label="Run cell">▶</button></div><div class="cell-body"><div class="cell-top"><select aria-label="Cell type"><option value="code">Python</option><option value="markdown">Markdown</option><option value="raw">Raw text</option></select><span class="run-state"></span><div class="cell-actions"><button class="up" aria-label="Move cell up">↑</button><button class="down" aria-label="Move cell down">↓</button><button class="delete" aria-label="Delete cell">×</button></div></div><div class="editor"></div><div class="markdown"></div><div class="output"></div><div class="conflict" hidden>Your text has a conflict. <button class="keep">Keep my text</button><button class="reload">Use saved text</button></div></div>`;
      row = { el, cell, dirty: false, updating: false, conflict: null, timer: null };
      row.editor = new EditorView({ parent: el.querySelector('.editor'), state: EditorState.create({ doc: cell.source, extensions: [
        lineNumbers(), highlightActiveLine(), history(), keymap.of([{ key: 'Shift-Enter', run: () => { safe(() => runCell(cell.id))(); return true; } }, indentWithTab, ...defaultKeymap, ...historyKeymap]), python(), syntaxHighlighting(defaultHighlightStyle), EditorView.lineWrapping,
        EditorView.updateListener.of(update => {
          if (!update.docChanged || row.updating) return;
          row.dirty = true; clearTimeout(row.timer); status('Unsaved changes');
          row.timer = setTimeout(() => safe(() => save(row))(), 700);
        }),
      ] }) });
      el.querySelector('.run').onclick = safe(() => runCell(cell.id));
      el.querySelector('select').onchange = safe(() => { row.dirty = true; return save(row); });
      el.querySelector('.delete').onclick = safe(() => change({ type: 'delete', id: cell.id }));
      el.querySelector('.up').onclick = safe(() => change({ type: 'move', id: cell.id, index: doc.cells.findIndex(c => c.id === cell.id) - 1 }));
      el.querySelector('.down').onclick = safe(() => change({ type: 'move', id: cell.id, index: doc.cells.findIndex(c => c.id === cell.id) + 1 }));
      el.querySelector('.keep').onclick = safe(async () => { row.cell = row.conflict; row.conflict = null; row.dirty = true; await save(row); });
      el.querySelector('.reload').onclick = () => { row.dirty = false; row.conflict = null; render(); };
      rows.set(cell.id, row);
    }
    if (!row.dirty && !row.conflict) {
      row.cell = cell; row.updating = true;
      if (row.editor.state.doc.toString() !== cell.source) row.editor.dispatch({ changes: { from: 0, to: row.editor.state.doc.length, insert: cell.source } });
      row.updating = false; row.el.querySelector('select').value = cell.type;
    }
    row.el.querySelector('.cell-index').textContent = String(index + 1).padStart(2, '0');
    const runButton = row.el.querySelector('.run'); runButton.hidden = cell.type !== 'code'; runButton.disabled = !owner || !runtime.connected;
    runButton.title = owner ? 'Save and run this cell' : 'Only the owner can run this notebook. Download a copy to run your own.';
    const state = row.el.querySelector('.run-state');
    state.textContent = cell.run ? `${cell.run.status}${cell.run.sourceRevision !== cell.version ? ' · output from an older revision' : ''}${cell.run.truncated ? ' · output capped' : ''}` : cell.executionCount ? `Out [${cell.executionCount}]` : '';
    row.el.querySelector('.conflict').hidden = !row.conflict;
    const markdown = row.el.querySelector('.markdown'); markdown.hidden = cell.type !== 'markdown';
    if (cell.type === 'markdown') markdown.innerHTML = DOMPurify.sanitize(marked.parse(cell.source), { FORBID_TAGS: ['img', 'iframe', 'form', 'input', 'style'], FORBID_ATTR: ['style'] });
    outputNodes(cell, row.el.querySelector('.output'));
    const container = $('#cells');
    if (container.children[index] !== row.el) container.insertBefore(row.el, container.children[index] ?? null);
  }
}
function save(row) {
  const work = async () => {
    if (!row.dirty || row.conflict) return;
    clearTimeout(row.timer);
    const source = row.editor.state.doc.toString(), type = row.el.querySelector('select').value;
    const result = await gadget.saveCell(row.cell.id, row.cell.version, source, type);
    if (result.conflict) { row.conflict = result.cell; row.el.querySelector('.conflict').hidden = false; status('Resolve the cell conflict'); return; }
    row.cell = result.cell;
    row.dirty = row.editor.state.doc.toString() !== source;
    if (!row.dirty) status('All changes saved');
    doc = await gadget.getNotebook(); render();
  };
  saving = saving.then(work, work); return saving;
}
async function flush() {
  for (const row of rows.values()) await save(row);
  if ([...rows.values()].some(r => r.conflict || r.dirty)) throw new Error('Resolve unsaved cell changes first.');
}
async function change(operation) {
  await flush(); doc = await gadget.changeStructure(doc.revision, operation); render(); status('All changes saved');
}
async function submit(intent) {
  const permit = await gadget.$createOwnerActionPermit('PYTHON', await intentHash(intent));
  if (!permit) throw new Error('Only the workspace owner can run or stop this kernel.');
  const result = await gadget.submitRun(intent, permit); latest = result;
  notice(result.status === 'submission-unknown' ? result.text : 'Run requested. Approve it in Workshop Activity.');
  await poll();
}
async function runCell(id) {
  if (!owner) throw new Error('Download a copy and connect your own Python runtime to run this notebook.');
  await flush();
  runtime = await gadget.getRuntimeStatus(true);
  if (!runtime.connected) throw new Error('Add Notebook Python in Connections, using the binding name PYTHON.');
  const cell = doc.cells.find(c => c.id === id);
  if (cell?.type !== 'code') return;
  await submit({ requestId: crypto.randomUUID(), operation: 'execute', sequence: runtime.sequence, generation: runtime.generation,
    cellId: cell.id, sourceRevision: cell.version, source: cell.source });
}
async function poll() {
  if (polling) return; polling = true;
  try {
    latest = await gadget.refreshRun(); runtime = await gadget.getRuntimeStatus();
    doc = await gadget.getNotebook(); render();
    $('#kernel-info').textContent = !runtime.connected ? 'Connect PYTHON to run cells' : runtime.active?.status === 'submission-unknown' ? 'Submission uncertain · check Activity or stop/reset' : runtime.active && ['pending', 'running'].includes(runtime.active.status) ? runtime.active.status === 'pending' ? 'Waiting for approval in Activity' : 'Running…' : `Ready · session ${runtime.generation + 1}`;
    $('#stop').disabled = !owner || !runtime.connected;
    if (!owner) notice('Shared notebook · you can read saved outputs. Download a copy to run it with your own Python connection.');
    else if (latest?.storageFull) notice('Notebook storage is full. The latest output could not be saved. Export a copy and remove unused cells or outputs.');
    else if (latest && ['succeeded', 'failed', 'interrupted', 'rejected'].includes(latest.status)) notice(latest.status === 'succeeded' ? '' : `Last run: ${latest.status}. See the cell output and Workshop Activity.`);
    if (![...rows.values()].some(row => row.dirty || row.conflict)) status('All changes saved');
    connectionFailures = 0;
  } catch (failure) {
    if (++connectionFailures >= 3 && /restart|disconnect|connection|capability|stub/i.test(failure?.message ?? '')) {
      // Bindings/code updates invalidate the gadget capability without changing client source.
      // Refresh the host RPC session; never retry a submitted mutation automatically.
      gadget[Symbol.dispose]?.();
      const { port1, port2 } = new MessageChannel();
      gadget = newMessagePortRpcSession(port1);
      window.parent.postMessage('handshake', '*', [port2]);
      connectionFailures = 0;
      notice('Reconnecting to the notebook. Unsaved text is kept in this window.');
    } else throw failure;
  } finally { polling = false; }
}
$('#add-code').onclick = safe(() => change({ type: 'insert', cellType: 'code' }));
$('#add-markdown').onclick = safe(() => change({ type: 'insert', cellType: 'markdown' }));
$('.title').onchange = safe(() => change({ type: 'title', title: $('.title').value }));
$('#stop').onclick = safe(async () => {
  runtime = await gadget.getRuntimeStatus(true);
  await submit({ requestId: crypto.randomUUID(), sequence: runtime.sequence, generation: runtime.generation, operation: 'stop', cellId: '', sourceRevision: 0, source: '' });
});
$('#import').onclick = () => $('#file').click();
$('#file').onchange = safe(async () => {
  const file = $('#file').files[0]; if (!file) return;
  if (file.size > 2_000_000) throw new Error('Notebook file is too large.');
  await flush();
  if (doc.cells.some(c => c.run)) throw new Error('Import into a new notebook to keep your current results.');
  doc = await gadget.importNotebook(await file.text(), doc.revision); render(); notice('Imported cells and saved outputs. Nothing has been executed.'); $('#file').value = '';
});
$('#export').onclick = () => notice('To copy: open the Workshop gadget menu → Export → Jupyter notebook. Create a new Notebook, import that file, and connect your own PYTHON resource.');
await safe(async () => {
  owner = await gadget.$canAuthorizeOwnerActions();
  doc = await gadget.getNotebook(); render(); status('All changes saved'); await poll();
  setInterval(() => { if (!document.hidden) safe(poll)(); }, 2500);
})();
