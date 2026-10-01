import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { Notebook, exportNotebook, validateCell } from '../core/notebook.js';
import { validateIntent } from '../../../gatekeeper-runtime/src/protocol.ts';

export class Gadget extends DurableObject {
  /** Bounded, side-effect-free contract for describeBinding. */
  describeGadget() {
    return {
      "gadget": "notebook",
      "contract": 1,
      "summary": "A saved Python notebook. Chat may edit cells; execution uses the existing owner permit flow and PYTHON binding.",
      "operations": [
        {
          "name": "getNotebook",
          "description": "Read saved cells and current versions; independent of Python execution.",
          "input": {},
          "example": "await env.Blueprint.getNotebook();",
          "returns": "{title, revision, cells}"
        },
        {
          "name": "appendCell",
          "description": "Append a validated cell using current revisions. Does not execute Python.",
          "input": {
            "type": "object",
            "properties": {
              "type": {
                "enum": [
                  "markdown",
                  "code",
                  "raw"
                ]
              },
              "source": {
                "type": "string"
              }
            },
            "required": [
              "type",
              "source"
            ]
          },
          "example": "await env.Blueprint.appendCell({ type: \"markdown\", source: \"## Next experiment\" });",
          "returns": "Cell with generated id and version"
        },
        {
          "name": "exportNotebook",
          "description": "Export saved content and outputs as Jupyter JSON; never executes cells.",
          "input": {},
          "example": "await env.Blueprint.exportNotebook();",
          "returns": "string"
        },
        {
          "name": "getRuntimeStatus",
          "description": "Read Python status (cached); returns connected:false if PYTHON is absent.",
          "input": {},
          "example": "await env.Blueprint.getRuntimeStatus();",
          "returns": "{connected, generation?, sequence?, active?}"
        }
      ],
      "adapt": {
        "client": "client.js: adapt block (title, actionLabel, styles, actions, onReady)",
        "server": "server.js: class Gadget",
        "readme": "README.md#adapting-this-gadget"
      }
    };
  }

  constructor(ctx, env) { super(ctx, env); this.notebook = new Notebook(ctx.storage); }
  /** Adds a validated cell using current revisions. It never executes Python. */
  appendCell(input) {
    validateCell({ id: "validation", type: input?.type, source: input?.source, outputs: [] });
    const before = this.getNotebook();
    if (before.cells.length >= 100) throw new Error("Too many cells.");
    // Validate the eventual document before inserting an empty cell.
    if (new TextEncoder().encode(JSON.stringify(before)).length + new TextEncoder().encode(JSON.stringify(input)).length + 256 > 2_000_000) throw new Error("Notebook storage limit reached.");
    const next = this.changeStructure(before.revision, { type: "insert", cellType: input.type, index: before.cells.length });
    const cell = next.cells[next.cells.length - 1];
    return this.saveCell(cell.id, cell.version, input.source, input.type).cell;
  }

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
