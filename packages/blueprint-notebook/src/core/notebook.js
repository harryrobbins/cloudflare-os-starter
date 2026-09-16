// Document state is independent of the temporary Python runtime.
export const LIMITS = { cells: 100, source: 16_000, cellBytes: 100_000, notebookBytes: 2_000_000, importBytes: 2_000_000 };
const clone = value => structuredClone(value);
const size = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const idPattern = /^[A-Za-z0-9_-]{1,64}$/;
const cellTypes = new Set(['code', 'markdown', 'raw']);

export function validateCell(cell) {
  if (!cell || !idPattern.test(cell.id) || !cellTypes.has(cell.type) || typeof cell.source !== 'string' || cell.source.length > LIMITS.source) throw new Error('Invalid cell or cell source too large.');
  if (!Array.isArray(cell.outputs ?? []) || (cell.outputs?.length ?? 0) > 128 || (cell.outputs ?? []).some(output => !output || typeof output !== 'object' || Array.isArray(output))) throw new Error('Invalid notebook outputs.');
  if (size(cell) > LIMITS.cellBytes) throw new Error('Cell exceeds the saved-output limit.');
}
export function seedNotebook() {
  return { title: 'Untitled notebook', revision: 0, cells: [
    { id: 'welcome', type: 'markdown', source: '# A place to think in Python\n\nWrite an idea, try it in a cell, and keep the result. Share this notebook so others can read the outputs.', version: 1, metadata: {}, outputs: [] },
    { id: 'first-cell', type: 'code', source: 'values = [3, 7, 12, 18]\nprint("Total:", sum(values))\nsum(values) / len(values)', version: 1, metadata: {}, outputs: [] },
  ], metadata: {} };
}

export function importNotebook(text) {
  if (typeof text !== 'string' || text.length * 2 > LIMITS.importBytes) throw new Error('Notebook file is too large (1 million characters maximum).');
  const data = JSON.parse(text);
  if (data.nbformat !== 4 || !Array.isArray(data.cells) || data.cells.length > LIMITS.cells) throw new Error('Use a version 4 notebook with at most 100 cells.');
  const language = data.metadata?.kernelspec?.language ?? data.metadata?.language_info?.name;
  if (language && language.toLowerCase() !== 'python') throw new Error('This notebook supports Python only.');
  const used = new Set();
  const cells = data.cells.map(item => {
    const id = typeof item.id === 'string' && idPattern.test(item.id) && !used.has(item.id) ? item.id : crypto.randomUUID();
    used.add(id);
    const source = Array.isArray(item.source) ? item.source.join('') : item.source ?? '';
    const cell = { id, type: item.cell_type, source, version: 1, metadata: item.metadata ?? {}, outputs: item.outputs ?? [], executionCount: item.execution_count ?? null };
    // Preserve bounded attachments/unknown MIME output for round trips; never execute/render them.
    if (item.attachments) cell.attachments = item.attachments;
    validateCell(cell); return cell;
  });
  const result = { title: 'Imported notebook', revision: 0, cells, metadata: data.metadata ?? {} };
  if (size(result) > LIMITS.notebookBytes) throw new Error('Notebook exceeds the storage limit.');
  return result;
}
export function exportNotebook(notebook) {
  return JSON.stringify({ nbformat: 4, nbformat_minor: 5,
    metadata: { ...notebook.metadata, kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
    cells: notebook.cells.map(cell => ({ id: cell.id, cell_type: cell.type, metadata: cell.metadata ?? {}, source: cell.source,
      ...(cell.attachments ? { attachments: cell.attachments } : {}),
      ...(cell.type === 'code' ? { execution_count: cell.executionCount ?? null, outputs: cell.outputs ?? [] } : {}) })) }, null, 2);
}

export class Notebook {
  constructor(storage) { this.storage = storage; }
  snapshot() {
    const meta = this.storage.kv.get('meta');
    if (!meta) { this.replace(seedNotebook()); return this.snapshot(); }
    return { ...meta, cells: meta.order.map(id => this.storage.kv.get('cell:' + id)) };
  }
  replace(next) {
    if (!Array.isArray(next.cells) || next.cells.length > LIMITS.cells) throw new Error('Too many cells.');
    next.cells.forEach(validateCell);
    if (new Set(next.cells.map(c => c.id)).size !== next.cells.length) throw new Error('Duplicate cell IDs.');
    if (size(next) > LIMITS.notebookBytes) throw new Error('Notebook storage limit reached.');
    if (size(next.metadata ?? {}) > 16_000) throw new Error('Notebook metadata is too large.');
    const old = this.storage.kv.get('meta');
    const { cells, ...meta } = next;
    const order = cells.map(c => c.id);
    this.storage.transactionSync(() => {
      for (const id of old?.order ?? []) if (!order.includes(id)) this.storage.kv.delete('cell:' + id);
      for (const cell of cells) this.storage.kv.put('cell:' + cell.id, cell);
      this.storage.kv.put('meta', { title: meta.title, revision: meta.revision, metadata: meta.metadata, order });
    });
  }
  saveCell(id, version, source, type) {
    const doc = this.snapshot(); const cell = doc.cells.find(c => c.id === id);
    if (!cell) throw new Error('Cell no longer exists.');
    if (cell.version !== version) return { conflict: true, cell };
    const updated = { ...cell, source, type, version: cell.version + 1 };
    validateCell(updated); doc.cells[doc.cells.indexOf(cell)] = updated; doc.revision++;
    this.replace(doc); return { conflict: false, cell: updated };
  }
  structure(revision, operation) {
    const doc = this.snapshot();
    if (doc.revision !== revision) throw new Error('Notebook changed elsewhere. Refresh before changing its structure.');
    if (operation.type === 'insert') {
      const cell = { id: crypto.randomUUID(), type: operation.cellType, source: '', version: 1, metadata: {}, outputs: [] };
      validateCell(cell); doc.cells.splice(Math.min(doc.cells.length, Math.max(0, operation.index ?? doc.cells.length)), 0, cell);
    } else if (operation.type === 'delete') doc.cells = doc.cells.filter(c => c.id !== operation.id);
    else if (operation.type === 'move') {
      const i = doc.cells.findIndex(c => c.id === operation.id);
      if (i < 0) throw new Error('Cell not found.');
      const [cell] = doc.cells.splice(i, 1); doc.cells.splice(Math.max(0, Math.min(doc.cells.length, operation.index)), 0, cell);
    } else if (operation.type === 'title') {
      if (typeof operation.title !== 'string' || operation.title.length > 120) throw new Error('Title must be at most 120 characters.');
      doc.title = operation.title.trim() || 'Untitled notebook';
    } else throw new Error('Unknown notebook operation.');
    doc.revision++; this.replace(doc); return this.snapshot();
  }
  import(text, revision) {
    const current = this.snapshot();
    if (current.revision !== revision) throw new Error('Notebook changed before import. Refresh and try again.');
    const doc = importNotebook(text); doc.revision = current.revision + 1; this.replace(doc); return this.snapshot();
  }
  saveRun(run) {
    const doc = this.snapshot(); const cell = doc.cells.find(c => c.id === run.cellId);
    if (!cell) return;
    // Keep provenance even when source changed while Python was running.
    cell.run = { id: run.id, generation: run.generation, sourceRevision: run.sourceRevision, status: run.status, truncated: run.truncated };
    cell.executionCount = run.executionCount ?? null;
    cell.outputs = [ ...(run.text ? [{ output_type: 'stream', name: run.status === 'failed' ? 'stderr' : 'stdout', text: run.text }] : []),
      ...(run.png ? [{ output_type: 'display_data', data: { 'image/png': run.png }, metadata: {} }] : []) ];
    // Imported metadata/source can leave less room than the stream's normal output cap.
    if (size(cell) > LIMITS.cellBytes || size(doc) > LIMITS.notebookBytes) {
      cell.run.truncated = true;
      cell.outputs = [{ output_type: 'stream', name: 'stderr', text: 'Output omitted: this notebook reached its saved-output limit.' }];
      if (size(cell) > LIMITS.cellBytes || size(doc) > LIMITS.notebookBytes) cell.outputs = [];
    }
    if (size(cell) > LIMITS.cellBytes || size(doc) > LIMITS.notebookBytes) return false;
    validateCell(cell); this.replace(doc); return true;
  }
}
