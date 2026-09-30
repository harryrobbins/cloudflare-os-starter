import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';

export class Gadget extends DurableObject {
  getDocument() { return this.ctx.storage.kv.get('document') ?? { revision: 0 }; }
  setDocument(request) {
    const current = this.getDocument();
    if (!request || request.expectedRevision !== current.revision) throw new Error('conflict: diagram changed elsewhere; reload before saving.');
    const input = request.document;
    if (!input || !['mermaid', 'd2'].includes(input.language) || !['tala', 'dagre', 'elk'].includes(input.layout)) throw new Error('invalid_request: diagram language or layout.');
    if (!['0','1','103','104','200'].includes(String(input.theme)) || typeof input.sketch !== 'boolean' || typeof input.live !== 'boolean') throw new Error('invalid_request: diagram options.');
    for (const language of ['d2', 'mermaid']) if (typeof input.drafts?.[language] !== 'string' || new TextEncoder().encode(input.drafts[language]).length > 100_000) throw new Error('invalid_request: draft exceeds 100,000 UTF-8 bytes.');
    const document = { revision: current.revision + 1, language: input.language, layout: input.layout, theme: String(input.theme), sketch: input.sketch, live: input.live, drafts: { d2: input.drafts.d2, mermaid: input.drafts.mermaid } };
    this.ctx.storage.kv.put('document', document);
    return document;
  }
  async renderDiagram(request) {
    if (!this.env.MERMAID2) throw new Error('not_connected: connect the MermaiD2 renderer to this gadget as MERMAID2.');
    return this.env.MERMAID2.render(request);
  }
  async readSkill(id) {
    if (!this.env.MERMAID2) throw new Error('not_connected: connect MERMAID2 to read the bundled skills.');
    return this.env.MERMAID2.readSkill(id);
  }
  async exportDiagram(format = 'svg', scale = 2) {
    const doc = this.getDocument();
    if (!doc.drafts) throw new Error('invalid_request: add a diagram first.');
    return this.renderDiagram({ source: doc.drafts[doc.language], language: doc.language, layout: doc.layout, theme: Number(doc.theme), sketch: doc.sketch, format, scale });
  }
}

export class ExportHandler extends WorkerEntrypoint {
  async getExportFormats(gadget) {
    const doc = await gadget.getDocument();
    return [
      ['svg', 'SVG', 'image/svg+xml', '.svg'], ['png', 'PNG', 'image/png', '.png'],
      ['jpeg', 'JPEG', 'image/jpeg', '.jpg'], ['webp', 'WebP', 'image/webp', '.webp'],
      ['pdf', 'PDF', 'application/pdf', '.pdf'], ['ascii', 'ASCII text', 'text/plain', '.txt'],
      ['source', 'Input source', 'text/plain', doc.language === 'd2' ? '.d2' : '.mmd'],
      ['d2', 'D2 source', 'text/plain', '.d2'], ['json', 'Diagram JSON', 'application/json', '.json'],
    ].map(([id, label, contentType, fileExtension]) => ({ id, label, contentType, fileExtension, mode: 'server' }));
  }
  async export(gadget, id) {
    const result = await gadget.exportDiagram(id, 2);
    return new Response(result.data, { headers: { 'Content-Type': result.contentType } }).body;
  }
}
