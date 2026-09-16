import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { Notebook, exportNotebook } from '../core/notebook.js';
import { validateIntent } from '../../../gatekeeper-runtime/src/protocol.ts';

export class Gadget extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.notebook = new Notebook(ctx.storage); }
  getNotebook() { return this.notebook.snapshot(); }
  saveCell(id, version, source, type) { return this.notebook.saveCell(id, version, source, type); }
  changeStructure(revision, operation) { return this.notebook.structure(revision, operation); }
  importNotebook(text, revision) { return this.notebook.import(text, revision); }
  exportNotebook() { return exportNotebook(this.notebook.snapshot()); }
  async #runtime() {
    if (!this.env.PYTHON) throw new Error('Connect Notebook Python as PYTHON in Connections to run cells.');
    return this.env.PYTHON;
  }
  async getRuntimeStatus(fresh = false) {
    if (!this.env.PYTHON) return { connected: false };
    if (!fresh && this.runtimeStatus && Date.now() < this.runtimeStatusExpires) return this.runtimeStatus;
    const runtime = await this.#runtime();
    try {
      this.runtimeStatus = { connected: true, ...await runtime.getStatus() };
      const active = ['pending', 'submission-unknown', 'running'].includes(this.runtimeStatus.active?.status);
      this.runtimeStatusExpires = Date.now() + (active ? 1000 : 60_000);
      return this.runtimeStatus;
    }
    finally { /* env.PYTHON is a service binding; the loopback owns each session. */ }
  }
  async submitRun(input, permit) {
    const intent = validateIntent(input);
    if (intent.operation === 'execute') {
      const cell = this.notebook.snapshot().cells.find(c => c.id === intent.cellId);
      if (!cell || cell.type !== 'code' || cell.source !== intent.source || cell.version !== intent.sourceRevision) throw new Error('Cell changed. Save and run the current revision.');
    }
    const runtime = await this.#runtime();
    try {
      const result = await runtime.submit(intent, permit);
      this.runtimeStatusExpires = 0;
      if (intent.operation === 'execute') {
        this.ctx.storage.kv.put('latestRun', result.id);
        this.ctx.storage.kv.delete('latestRunResult');
      }
      return result;
    } finally { /* env.PYTHON is a service binding; the loopback owns each session. */ }
  }
  async refreshRun() {
    const id = this.ctx.storage.kv.get('latestRun');
    if (!id || !this.env.PYTHON) return null;
    const cached = this.ctx.storage.kv.get('latestRunResult');
    if (cached?.id === id) return cached;
    const runtime = await this.#runtime();
    try {
      const run = await runtime.getRun(id);
      if (run && this.ctx.storage.kv.get("latestRun") === id && this.notebook.saveRun(run) === false) return { ...run, storageFull: true };
      if (run && !['pending', 'submission-unknown', 'running'].includes(run.status) && this.ctx.storage.kv.get('latestRun') === id) this.ctx.storage.kv.put('latestRunResult', run);
      return run;
    } finally { /* env.PYTHON is a service binding; the loopback owns each session. */ }
  }
}
export class ExportHandler extends WorkerEntrypoint {
  async getExportFormats() { return [{ id: 'ipynb', label: 'Jupyter notebook', mode: 'server', contentType: 'application/x-ipynb+json', fileExtension: '.ipynb' }]; }
  async export(gadget, id) {
    if (id !== 'ipynb') throw new Error('Unknown export format.');
    return new Response(await gadget.exportNotebook()).body;
  }
}
