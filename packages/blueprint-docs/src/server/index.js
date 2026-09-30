// Docs with Drawings: the Durable Object behind one document.
// Built from packages/blueprint-docs. Everything outside the "Drawings" section is upstream's
// bundled Docs format (cloudflare-os workspace-docs, Apache-2.0) with the omni-search push
// patch, kept as close to upstream as possible so upstream fixes can be merged by diff.
//
// Drawings: each drawing is a whole whiteboard kept in this Durable Object (DrawingHost, from
// packages/blueprint-whiteboard/src/embed/server.js). The document holds one block per drawing,
//   <figure data-block-id="b_..." class="doc-drawing" data-drawing-id="d_..." contenteditable="false"></figure>
// and never the drawing itself, so drawing edits and text edits never conflict. Clients render
// the figure from the drawing's stored SVG preview, which the server refreshes after each change.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { DrawingHost, isDrawingId } from "blueprint-whiteboard/embed/server";

const DEFAULT_TITLE = "Untitled document";
/** Quiet time after a drawing change before its preview is re-rendered and announced. */
const PREVIEW_DEBOUNCE_MS = 800;
/** A drawing that keeps changing still gets a fresh preview at least this often. */
const PREVIEW_MAX_WAIT_MS = 4000;

export class Gadget extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.subscribers = new Map();
    // RPC calls may overlap at await points. Chain mutations so each operation
    // observes and commits one authoritative document state in strict order.
    this.mutationQueue = Promise.resolve();
    this.drawings = new DrawingHost(ctx.storage, {
      onChange: (id) => this.schedulePreview(id),
      defaultTitle: "Untitled drawing",
    });
    /** @type {Map<string, {timer: any, since: number}>} */
    this.previewTimers = new Map();
  }

  enqueueMutation(fn) {
    const result = this.mutationQueue.then(fn);
    this.mutationQueue = result.catch(() => {});
    result.then(() => __cfosSearchSchedule(this, "edit"), () => {}); // cfos-search-push
    return result;
  }

  async loadDocument() {
    let doc = await this.ctx.storage.get("document:v2");
    if (doc) return doc;

    // Keep old documents readable. The first v2 client converts the legacy HTML
    // into stable top-level blocks and calls initializeBlocks().
    const [content, title, lastModified] = await Promise.all([
      this.ctx.storage.get("content"),
      this.ctx.storage.get("title"),
      this.ctx.storage.get("lastModified"),
    ]);
    return {
      revision: 0,
      title: title ?? DEFAULT_TITLE,
      blocks: null,
      legacyContent: content ?? "",
      lastModified: lastModified ?? null,
    };
  }

  async getDocument() {
    return this.loadDocument();
  }

  initializeBlocks(args) {
    return this.enqueueMutation(() => this.initializeBlocksLocked(args));
  }

  async initializeBlocksLocked({ blocks, title, senderId }) {
    let current = await this.ctx.storage.get("document:v2");
    const cleanBlocks = sanitizeBlocks(blocks);
    const cleanTitle = String(title || DEFAULT_TITLE);

    if (current) {
      // A newly opened client may win the initialization race by creating the
      // blank revision-1 shell before an agent seeds generated content. Treat
      // only that exact shell as replaceable; later empty documents may be an
      // intentional user edit and are never overwritten by initialization.
      const isBlankBootstrap = current.revision === 1 &&
        current.title === DEFAULT_TITLE && current.blocks.length === 0;
      const hasSeedContent = cleanBlocks.length > 0 || cleanTitle !== DEFAULT_TITLE;
      if (!isBlankBootstrap || !hasSeedContent) return current;
    }

    const now = Date.now();
    current = {
      revision: current ? current.revision + 1 : 1,
      title: cleanTitle,
      blocks: cleanBlocks.map((block) => ({ id: block.id, html: block.html, version: 1 })),
      lastModified: now,
    };
    await this.ctx.storage.put("document:v2", current);
    await this.broadcast({
      type: "snapshot",
      senderId,
      document: current,
    });
    return current;
  }

  // Explicit full-document writer for agents/importers. Unlike initializeBlocks,
  // this always applies, so callers never need to inspect revision state or
  // construct per-block applyOperation payloads just to populate a document.
  setDocument(args) {
    return this.enqueueMutation(() => this.setDocumentLocked(args));
  }

  async setDocumentLocked({ blocks, title, senderId }) {
    const previous = await this.ctx.storage.get("document:v2");
    const previousById = new Map((previous?.blocks || []).map((block) => [block.id, block]));
    const cleanBlocks = sanitizeBlocks(blocks);
    const document = {
      revision: (previous?.revision || 0) + 1,
      title: String(title || DEFAULT_TITLE),
      blocks: cleanBlocks.map((block) => ({
        id: block.id,
        html: block.html,
        version: (previousById.get(block.id)?.version || 0) + 1,
      })),
      lastModified: Date.now(),
    };
    await this.ctx.storage.put("document:v2", document);
    await this.broadcast({ type: "snapshot", senderId, document });
    return document;
  }

  // Apply a compact batch of block changes. The mutation queue is the single
  // authoritative order for all collaborators.
  applyOperation(operation) {
    return this.enqueueMutation(() => this.applyOperationLocked(operation));
  }

  async applyOperationLocked(operation) {
    let doc = await this.ctx.storage.get("document:v2");
    if (!doc) throw new Error("Document must be initialized first.");

    const byId = new Map(doc.blocks.map((block) => [block.id, block]));
    const accepted = [];
    const conflicts = [];

    for (const incoming of sanitizeBlocks(operation.upserts || [])) {
      const current = byId.get(incoming.id);
      const expected = Number(incoming.baseVersion || 0);
      if (current && expected !== current.version) {
        conflicts.push(current);
        continue;
      }
      if (!current && expected !== 0) continue;
      const next = { id: incoming.id, html: incoming.html, version: (current?.version || 0) + 1 };
      byId.set(next.id, next);
      accepted.push(next);
    }

    const deletedIds = [];
    for (const deletion of operation.deletes || []) {
      const id = String(deletion?.id || "");
      const current = byId.get(id);
      if (!current) continue;
      if (Number(deletion.baseVersion || 0) !== current.version) {
        conflicts.push(current);
        continue;
      }
      byId.delete(id);
      deletedIds.push(id);
    }

    // Ordering is intentionally last-writer-wins. Text/content remains guarded
    // by per-block versions, while inserts, moves and list restructuring stay
    // responsive and deterministic.
    const requestedOrder = Array.isArray(operation.order) ? operation.order.map(String) : [];
    const order = [];
    const seen = new Set();
    for (const id of requestedOrder) {
      if (byId.has(id) && !seen.has(id)) { order.push(id); seen.add(id); }
    }
    for (const block of doc.blocks) {
      if (byId.has(block.id) && !seen.has(block.id)) { order.push(block.id); seen.add(block.id); }
    }
    for (const id of byId.keys()) {
      if (!seen.has(id)) order.push(id);
    }

    const titleChanged = typeof operation.title === "string" && operation.title !== doc.title;
    const changed = accepted.length || deletedIds.length || titleChanged ||
      order.join("\n") !== doc.blocks.map((b) => b.id).join("\n");

    if (!changed) {
      return { status: conflicts.length ? "conflict" : "unchanged", revision: doc.revision, conflicts };
    }

    doc = {
      revision: doc.revision + 1,
      title: typeof operation.title === "string" ? operation.title : doc.title,
      blocks: order.map((id) => byId.get(id)),
      lastModified: Date.now(),
    };
    await this.ctx.storage.put("document:v2", doc);

    const event = {
      type: "operation",
      senderId: operation.senderId,
      revision: doc.revision,
      title: doc.title,
      upserts: accepted,
      deletedIds,
      order,
      lastModified: doc.lastModified,
    };
    await this.broadcast(event);
    return {
      status: conflicts.length ? "conflict" : "applied",
      ...event,
      conflicts,
    };
  }

  async subscribe(callback, client = {}) {
    __cfosSearchSchedule(this, "open"); // cfos-search-push
    const dup = callback.dup();
    const existing = Array.from(this.subscribers.values());
    const info = {
      callback: dup,
      clientId: String(client.clientId || ""),
      name: String(client.name || "Guest").slice(0, 40),
      color: String(client.color || "#e1632e"),
    };
    this.subscribers.set(dup, info);
    // Upstream also calls dup.onRpcBroken() here. Workers RPC stubs do not implement it (the call
    // goes to the client's callbacks and rejects), so a dead subscriber is dropped by broadcast()
    // when a delivery fails, and clients expire stale cursors by heartbeat.
    queueMicrotask(async () => {
      // Seed the newcomer with collaborators who were already connected.
      for (const person of existing) {
        try {
          await dup.presence({ type: "join", clientId: person.clientId, name: person.name, color: person.color, blockId: null });
        } catch (e) { break; }
      }
      await this.broadcastPresence({
        type: "join", clientId: info.clientId, name: info.name, color: info.color, blockId: null,
      });
    });
    return this.loadDocument();
  }

  async updatePresence(presence) {
    const event = {
      type: "cursor",
      clientId: String(presence.clientId || ""),
      name: String(presence.name || "Guest").slice(0, 40),
      color: String(presence.color || "#e1632e"),
      // Anchor/focus endpoints let clients render both a caret and highlighted
      // selections, including selections spanning multiple top-level blocks.
      anchorBlockId: presence.anchorBlockId ? String(presence.anchorBlockId) : null,
      anchorOffset: Math.max(0, Number(presence.anchorOffset || 0)),
      focusBlockId: presence.focusBlockId ? String(presence.focusBlockId) : null,
      focusOffset: Math.max(0, Number(presence.focusOffset || 0)),
      at: Date.now(),
    };
    await this.broadcastPresence(event);
  }

  // Best-effort fast path for pagehide. Clients also expire stale presence via
  // heartbeats because browsers cannot guarantee that unload RPC completes.
  async leavePresence(clientId) {
    await this.broadcastPresence({
      type: "leave",
      clientId: String(clientId || ""),
      at: Date.now(),
    });
  }

  async broadcast(event) {
    const calls = [];
    for (const [stub] of this.subscribers) {
      calls.push(Promise.resolve(stub.operation(event)).catch(() => this.subscribers.delete(stub)));
    }
    await Promise.all(calls);
  }

  async broadcastPresence(event) {
    const calls = [];
    for (const [stub] of this.subscribers) {
      calls.push(Promise.resolve(stub.presence(event)).catch(() => this.subscribers.delete(stub)));
    }
    await Promise.all(calls);
  }

  // --- Drawings ------------------------------------------------------------------------------
  // Agent-facing: createDrawing, listDrawings, drawing, removeDrawing, getDrawingPreview.
  // Editor-facing (the embedded whiteboard's live channel, one drawing at a time): drawingSubscribe,
  // drawingApply, drawingUndo, drawingHistory, drawingPresence, drawingLeave.

  /**
   * Creates a drawing and, unless `insertAfter` is null, adds its figure block to the document:
   * after the block with that id, at "start", or at the "end" (the default).
   * @param {{id?: string, title?: string, data?: any, by?: string, insertAfter?: string|null, senderId?: string}} [args]
   * @returns {Promise<{id: string, title: string, blockId: string|null, imported?: any}>}
   */
  async createDrawing(args = {}) {
    const a = args && typeof args === "object" ? args : {};
    const created = await this.drawings.create({ id: a.id, title: a.title, data: a.data, by: a.by });
    let blockId = null;
    if (a.insertAfter !== null) {
      blockId = await this.enqueueMutation(() => this.insertFigureLocked(created.id, a.insertAfter ?? "end", a.senderId));
    }
    this.schedulePreview(created.id, 0);
    return { ...created, blockId };
  }

  async insertFigureLocked(drawingId, insertAfter, senderId) {
    let doc = await this.ctx.storage.get("document:v2");
    if (!doc) doc = { revision: 0, title: DEFAULT_TITLE, blocks: [], lastModified: Date.now() };
    const blockId = "b_" + Date.now().toString(36) + Math.random().toString(36).slice(2);
    const block = { id: blockId, html: figureHtml(blockId, drawingId), version: 1 };
    const blocks = [...doc.blocks];
    const at = insertAfter === "start" ? 0
      : insertAfter === "end" ? blocks.length
      : blocks.findIndex((b) => b.id === insertAfter) + 1 || blocks.length;
    blocks.splice(at, 0, block);
    doc = { revision: doc.revision + 1, title: doc.title, blocks, lastModified: Date.now() };
    await this.ctx.storage.put("document:v2", doc);
    await this.broadcast({
      type: "operation",
      senderId: String(senderId || "drawings"),
      revision: doc.revision,
      title: doc.title,
      upserts: [block],
      deletedIds: [],
      order: blocks.map((b) => b.id),
      lastModified: doc.lastModified,
    });
    return blockId;
  }

  /** Every drawing: {id, title, revision, objects, lastModified, openBy, blockIds}. */
  async listDrawings() {
    const doc = await this.ctx.storage.get("document:v2");
    const blocksFor = new Map();
    for (const block of doc?.blocks ?? []) {
      const id = drawingIdOf(block.html);
      if (id) blocksFor.set(id, [...(blocksFor.get(id) ?? []), block.id]);
    }
    return (await this.drawings.list()).map((d) => ({ ...d, blockIds: blocksFor.get(d.id) ?? [] }));
  }

  /**
   * Calls one whiteboard method on one drawing, with the Whiteboard gadget's arguments and results:
   * drawing(id, "addStickies", {stickies: [...]}).
   * @param {string} id
   * @param {string} method
   * @param {any} [args]
   */
  drawing(id, method, args) {
    return this.drawings.call(id, method, args);
  }

  /** Deletes a drawing's data and every figure block that shows it. */
  async removeDrawing(id) {
    if (!isDrawingId(id)) throw new Error("removeDrawing: not a drawing id");
    await this.enqueueMutation(async () => {
      const doc = await this.ctx.storage.get("document:v2");
      if (!doc) return;
      const deletedIds = doc.blocks.filter((b) => drawingIdOf(b.html) === id).map((b) => b.id);
      if (!deletedIds.length) return;
      const blocks = doc.blocks.filter((b) => !deletedIds.includes(b.id));
      const next = { revision: doc.revision + 1, title: doc.title, blocks, lastModified: Date.now() };
      await this.ctx.storage.put("document:v2", next);
      await this.broadcast({
        type: "operation", senderId: "drawings", revision: next.revision, title: next.title,
        upserts: [], deletedIds, order: blocks.map((b) => b.id), lastModified: next.lastModified,
      });
    });
    return this.drawings.remove(id);
  }

  /** {revision, title, svg} for a figure; svg is null when the drawing is too large to preview. */
  getDrawingPreview(id) {
    return this.drawings.getPreview(id);
  }

  /** Re-renders a drawing's preview now (the editor calls it on close), and announces it. */
  async refreshDrawingPreview(id) {
    this.schedulePreview(id, 0);
    return this.drawings.previewMeta(id);
  }

  schedulePreview(id, delay = PREVIEW_DEBOUNCE_MS) {
    const now = Date.now();
    const pending = this.previewTimers.get(id);
    if (pending) clearTimeout(pending.timer);
    const since = pending?.since ?? now;
    const wait = Math.max(0, Math.min(delay, since + PREVIEW_MAX_WAIT_MS - now));
    const timer = setTimeout(() => {
      this.previewTimers.delete(id);
      this.publishPreview(id).catch((err) => console.warn("drawing preview failed:", String(err?.message ?? err)));
    }, wait);
    this.previewTimers.set(id, { timer, since });
  }

  async publishPreview(id) {
    if (!(await this.drawings.exists(id))) return;
    const meta = await this.drawings.refreshPreview(id);
    await this.broadcast({ type: "drawing", id, title: meta.title, revision: meta.revision, tooLarge: Boolean(meta.tooLarge) });
  }

  drawingSubscribe(id, callback, client) {
    return this.drawings.subscribe(id, callback, client);
  }

  async drawingApply(id, request) {
    return (await this.drawings.open(id)).api.applyOperation(request);
  }

  async drawingUndo(id, args) {
    return (await this.drawings.open(id)).api.undo(args);
  }

  async drawingHistory(id, limit) {
    return (await this.drawings.open(id)).api.getHistory(limit);
  }

  drawingPresence(id, presence) {
    return this.drawings.updatePresence(id, presence);
  }

  async drawingLeave(id, clientId, session) {
    await this.drawings.leavePresence(id, clientId, session);
    this.schedulePreview(id, 0);
  }

  async getGoogleDocInfo() {
    if (!this.env.GOOGLE_DOC) return null;
    const metadata = await this.env.GOOGLE_DOC.getMetadata();
    return { title: metadata.title, lastModified: metadata.lastModified };
  }

  async syncToGoogleDoc({ markdown }) {
    if (!this.env.GOOGLE_DOC) throw new Error("GOOGLE_DOC binding is not configured.");
    const next = String(markdown || "").trim() || " ";
    const current = await this.env.GOOGLE_DOC.getContent();
    if ((current || "").trim() === next.trim()) return { status: "unchanged" };
    if (!(current || "").trim()) await this.env.GOOGLE_DOC.appendText(next);
    else await this.env.GOOGLE_DOC.replaceText(current, next);
    return { status: "synced", metadata: await this.env.GOOGLE_DOC.getMetadata() };
  }
}

function figureHtml(blockId, drawingId) {
  return `<figure data-block-id="${blockId}" class="doc-drawing" data-drawing-id="${drawingId}" contenteditable="false"></figure>`;
}

/** The drawing a block shows, or null. */
function drawingIdOf(html) {
  const match = /^<figure\b[^>]*\bdata-drawing-id="(d_[0-9a-f]{12})"/.exec(String(html || ""));
  return match ? match[1] : null;
}

function base64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function escapeAttribute(text) {
  return String(text).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function sanitizeBlocks(blocks) {
  if (!Array.isArray(blocks)) return [];
  const result = [];
  const seen = new Set();
  for (const value of blocks) {
    const id = String(value?.id || "").slice(0, 100);
    const html = String(value?.html || "");
    if (!id || seen.has(id) || html.length > 10_000_000) continue;
    seen.add(id);
    result.push({ id, html, baseVersion: Number(value?.baseVersion || 0) });
  }
  return result;
}


const DOC_EXPORT_FORMATS = [
  { id: "markdown", label: "Markdown", mode: "server", contentType: "text/markdown", fileExtension: ".md" },
  { id: "html", label: "HTML", mode: "browser", contentType: "text/html", fileExtension: ".html" },
  { id: "pdf", label: "PDF", mode: "browser", contentType: "application/pdf", fileExtension: ".pdf" },
];

export class ExportHandler extends WorkerEntrypoint {
  async getExportFormats() {
    return DOC_EXPORT_FORMATS;
  }

  async export(gadget, id) {
    if (id !== "markdown") throw new Error("Unsupported document export format: " + id);
    const document = await gadget.getDocument();
    const parts = [];
    for (const block of document.blocks || []) {
      const drawingId = drawingIdOf(block.html);
      if (!drawingId) { parts.push(block.html); continue; }
      // A drawing becomes an image of its preview, so the Markdown stands alone.
      const preview = await gadget.getDrawingPreview(drawingId);
      const alt = escapeAttribute(preview?.title || "Drawing");
      parts.push(preview?.svg
        ? `<p><img src="data:image/svg+xml;base64,${base64Utf8(preview.svg)}" alt="${alt}"></p>`
        : `<p>[Drawing: ${alt}]</p>`);
    }
    const html = document.blocks ? parts.join("") : document.legacyContent || "";
    return new Response(htmlToMarkdown(html)).body;
  }
}

function htmlToMarkdown(html) {
  const tokens = String(html).match(/<!--[\s\S]*?-->|<![^>]*>|<[^>]+>|[^<]+/g) || [];
  const lists = [];
  const links = [];
  const blockquotes = [];
  let markdown = "";
  let inPre = false;

  for (const token of tokens) {
    if (!token.startsWith("<")) {
      let text = decodeHtml(token);
      if (!inPre) {
        text = text.replace(/\s+/g, " ").replace(/([\\*_[\]])/g, "\\$1");
      }
      markdown += text;
      continue;
    }
    if (token.startsWith("<!--") || token.startsWith("<!")) continue;

    const match = /^<\s*(\/?)\s*([a-z0-9]+)([^>]*)>/i.exec(token);
    if (!match) continue;
    const closing = match[1] === "/";
    const tag = match[2].toLowerCase();
    const attributes = match[3];

    if (closing) {
      switch (tag) {
        case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
        case "p": case "div":
          markdown += "\n\n";
          break;
        case "blockquote": {
          const start = blockquotes.pop();
          const content = markdown.slice(start).trim().replace(/\n{3,}/g, "\n\n");
          const quoted = content
            ? content.split("\n").map((line) => line ? "> " + line : ">").join("\n")
            : ">";
          markdown = markdown.slice(0, start) + quoted + "\n\n";
          break;
        }
        case "strong": case "b": markdown += "**"; break;
        case "em": case "i": markdown += "*"; break;
        case "s": case "strike": case "del": markdown += "~~"; break;
        case "code": if (!inPre) markdown += "\x60"; break;
        case "pre": markdown += "\n\x60\x60\x60\n\n"; inPre = false; break;
        case "a": markdown += "](" + (links.pop() || "") + ")"; break;
        case "li": if (!markdown.endsWith("\n")) markdown += "\n"; break;
        case "ul": case "ol": lists.pop(); break;
        case "td": case "th": markdown += "\t"; break;
        case "tr": markdown += "\n"; break;
      }
      continue;
    }

    switch (tag) {
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
        markdown += "\n\n" + "#".repeat(Number(tag[1])) + " ";
        break;
      case "p": case "div": markdown += "\n\n"; break;
      case "br": markdown += "  \n"; break;
      case "strong": case "b": markdown += "**"; break;
      case "em": case "i": markdown += "*"; break;
      case "s": case "strike": case "del": markdown += "~~"; break;
      case "code": if (!inPre) markdown += "\x60"; break;
      case "pre": markdown += "\n\n\x60\x60\x60\n"; inPre = true; break;
      case "blockquote": markdown += "\n\n"; blockquotes.push(markdown.length); break;
      case "hr": markdown += "\n\n---\n\n"; break;
      case "ul": lists.push({ type: "ul", count: 0 }); break;
      case "ol": lists.push({ type: "ol", count: 0 }); break;
      case "li": {
        const list = lists.at(-1) || { type: "ul", count: 0 };
        list.count += 1;
        markdown += (markdown.endsWith("\n") ? "" : "\n") +
          "  ".repeat(Math.max(0, lists.length - 1)) +
          (list.type === "ol" ? list.count + ". " : "- ");
        break;
      }
      case "a": links.push(readHtmlAttribute(attributes, "href")); markdown += "["; break;
      case "img": {
        const alt = readHtmlAttribute(attributes, "alt").replace(/[\[\]]/g, "\\$&");
        markdown += "![" + alt + "](" + readHtmlAttribute(attributes, "src") + ")";
        break;
      }
    }
  }

  const clean = markdown
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return clean ? clean + "\n" : "";
}

function readHtmlAttribute(source, name) {
  const pattern = new RegExp(name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i");
  const match = pattern.exec(source);
  return decodeHtml(match ? match[1] ?? match[2] ?? match[3] ?? "" : "");
}

function decodeHtml(value) {
  return String(value).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, entity) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x")) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith("#")) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
    return { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " }[lower];
  });
}


// ---------------------------------------------------------------------------
// cfos-search-push v1: injected by scripts/patch-format-search.mjs (cloudflare-os-starter).
// When this gadget's env has a SEARCH binding (the omni-search capsule, wired in with
// setGadgetBinding), its text is pushed to search a few seconds after each change. Unbound
// instances do nothing. Best-effort by design: it runs outside the save path and every step is
// caught, so indexing can never fail or delay a save.
// ---------------------------------------------------------------------------
const __CFOS_SEARCH = {
  kind: "doc",
  idKey: "cfos-search:externalId",
  debounceMs: 3000,
  maxWaitMs: 30000,
  timeoutMs: 20000,
  maxTitle: 300,
  maxBody: 200000,
};

function __cfosSearchSchedule(gadget, reason) {
  try {
    const env = gadget.env;
    if (!env || typeof env.SEARCH === "undefined") return;
    const s = gadget.__cfosSearch ||
      (gadget.__cfosSearch = { timer: null, since: null, running: false, again: false, last: null });
    const now = Date.now();
    if (s.since === null) s.since = now;
    if (s.timer) clearTimeout(s.timer);
    const wait = Math.max(0, Math.min(__CFOS_SEARCH.debounceMs, s.since + __CFOS_SEARCH.maxWaitMs - now));
    s.timer = setTimeout(() => {
      s.timer = null;
      s.since = null;
      __cfosSearchFlush(gadget).catch(() => {});
    }, wait);
  } catch (err) {
    // Never let indexing reach the caller; `reason` ("edit", "open") is for debugging only.
  }
}

async function __cfosSearchFlush(gadget) {
  const s = gadget.__cfosSearch;
  if (s.running) { s.again = true; return; }
  s.running = true;
  let timer = null;
  try {
    const env = gadget.env;
    if (!env || typeof env.SEARCH === "undefined") return;
    const storage = gadget.ctx.storage;
    const extracted = await __cfosSearchExtract(storage);
    if (!extracted) return;
    let externalId = await storage.get(__CFOS_SEARCH.idKey);
    // A blank or untouched instance is not worth a search result until someone writes in it.
    if (!externalId && extracted.trivial) return;
    const title = String(extracted.title || "").slice(0, __CFOS_SEARCH.maxTitle);
    const body = String(extracted.body || "").slice(0, __CFOS_SEARCH.maxBody);
    const fingerprint = title + "\n" + body;
    if (fingerprint === s.last) return;
    if (!externalId) {
      // Gadget code cannot see its own workpiece id, and one search account spans every workspace
      // of its owner, so each instance mints a stable id of its own on first push.
      externalId = __CFOS_SEARCH.kind + ":" + crypto.randomUUID();
      await storage.put(__CFOS_SEARCH.idKey, externalId);
    }
    await Promise.race([
      env.SEARCH.put({
        externalId,
        kind: __CFOS_SEARCH.kind,
        title,
        body,
        updatedAt: Number(extracted.updatedAt) || Date.now(),
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("SEARCH.put timed out")), __CFOS_SEARCH.timeoutMs);
      }),
    ]);
    s.last = fingerprint;
  } catch (err) {
    try { console.warn("[cfos-search-push] not indexed:", String((err && err.message) || err)); } catch {}
  } finally {
    if (timer) clearTimeout(timer);
    s.running = false;
    if (s.again) { s.again = false; __cfosSearchSchedule(gadget, "again"); }
  }
}

function __cfosSearchHtmlText(html) {
  return String(html == null ? "" : html)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|pre|ul|ol|table)\s*>/gi, "\n")
    .replace(/<\/(td|th)\s*>/gi, "\t")
    .replace(/<!--[\s\S]*?-->|<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, entity) => {
      const lower = entity.toLowerCase();
      const code = lower.startsWith("#x") ? parseInt(lower.slice(2), 16)
        : lower.startsWith("#") ? parseInt(lower.slice(1), 10) : -1;
      if (code >= 0) return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
      return { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " }[lower] || whole;
    })
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Docs: "document:v2" -> { title, blocks: [{ id, html }], lastModified }. A legacy (pre-v2) document
// is skipped; its first v2 client converts it, which is itself a mutation and triggers a push.
async function __cfosSearchExtract(storage) {
  const doc = await storage.get("document:v2");
  if (!doc || !Array.isArray(doc.blocks)) return null;
  const title = String(doc.title || "").trim() || "Untitled document";
  const body = doc.blocks.map((block) => __cfosSearchHtmlText(block && block.html))
    .filter(Boolean).join("\n\n");
  return {
    title,
    body,
    updatedAt: doc.lastModified,
    trivial: !body && title === "Untitled document",
  };
}
