// Drawings inside a document: the figure blocks, their previews, and the full-page drawing editor.
//
// A drawing block is persisted as an empty figure,
//   <figure data-block-id="b_..." class="doc-drawing" data-drawing-id="d_..." contenteditable="false"></figure>
// and this module fills it on screen with the drawing's preview and an Edit button (the
// `.doc-drawing-ui` child, which canonical block HTML strips, so it never reaches the server).
// Editing mounts the whole whiteboard UI (packages/blueprint-whiteboard/src/embed/client.js) over
// the page, talking to this drawing through the document's own RPC stub.

import { mountWhiteboard, PALETTE } from "blueprint-whiteboard/embed/client";

export const DRAWING_CSS = `
.doc-page figure.doc-drawing { margin: 14px 0; padding: 0; }
.doc-drawing-ui {
  position: relative; border: 1px solid var(--line-strong); border-radius: 8px; background: #fff;
  overflow: hidden; user-select: none; -webkit-user-select: none;
}
.doc-drawing-ui .doc-drawing-img { display: block; max-width: 100%; max-height: 560px; margin: 0 auto; cursor: zoom-in; }
.doc-drawing-ui .doc-drawing-empty { padding: 36px 16px; text-align: center; color: var(--muted); cursor: pointer; }
.doc-drawing-bar {
  display: flex; align-items: center; gap: 8px; padding: 6px 8px 6px 12px;
  border-top: 1px solid var(--line); background: var(--surface-2); font-size: 12.5px; color: var(--muted);
}
.doc-drawing-bar .doc-drawing-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.doc-drawing-bar .doc-drawing-open {
  border: 1px solid var(--line-strong); background: var(--surface); color: var(--text); border-radius: 6px;
  padding: 3px 10px; font: inherit; cursor: pointer;
}
.doc-drawing-bar .doc-drawing-open:hover { border-color: var(--accent); color: var(--accent); }
.doc-page figure.doc-drawing.drawing-selected .doc-drawing-ui { outline: 2px solid var(--accent); outline-offset: 2px; }
html.drawing-open .app, html.drawing-open .image-controls, html.drawing-open .link-pop { display: none !important; }
.doc-drawing-editor { position: fixed; inset: 0; }
.doc-drawing-back {
  border: 1px solid rgba(0,0,0,.12); background: #fff; color: #1d2230; border-radius: 8px;
  padding: 4px 10px; margin-right: 8px; font: 13px system-ui, sans-serif; cursor: pointer; flex: none;
}
.doc-drawing-back:hover { background: #f1f2f5; }
.doc-drawing-failed {
  position: fixed; inset: 0; display: flex; flex-direction: column; gap: 12px; align-items: center;
  justify-content: center; font: 15px system-ui, sans-serif; background: #f6f6f4; color: #1d1d20;
}
html.document-export .doc-drawing-bar, html.document-export .doc-drawing-ui { border: none; }
html.document-export .doc-drawing-bar { display: none; }
@media print {
  .doc-drawing-bar { display: none !important; }
  .doc-drawing-ui { border: none; }
  .doc-page figure.doc-drawing { break-inside: avoid-page; }
}
`;

const DRAWING_ID_RE = /^d_[0-9a-f]{12}$/;

function hex(bytes) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export const newDrawingId = () => "d_" + hex(6);

/** UTF-8 SVG text as a data: URL an <img> can show (the gadget CSP allows only data: images). */
function svgDataUrl(svg) {
  const bytes = new TextEncoder().encode(svg);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return "data:image/svg+xml;base64," + btoa(binary);
}

/**
 * Removes the on-screen drawing UI from a detached clone of a block before its HTML is saved.
 * @param {Element} clone
 */
export function stripDrawingUi(clone) {
  for (const node of clone.querySelectorAll(".doc-drawing-ui")) node.remove();
  if (clone.matches("figure.doc-drawing")) clone.classList.remove("drawing-selected");
  for (const figure of clone.querySelectorAll("figure.doc-drawing.drawing-selected")) figure.classList.remove("drawing-selected");
}

/**
 * @param {object} options
 * @param {HTMLElement} options.editor        the contenteditable page
 * @param {any} options.gadget                the document's RPC stub
 * @param {any} options.RpcTarget
 * @param {{name: string}} options.viewer     who is editing (the signed-in account)
 * @param {() => string|null} options.activeBlockId  the top-level block holding the caret
 * @param {() => void} options.scheduleSave
 * @param {(kind: string, text: string) => void} options.setStatus
 * @param {boolean} [options.exportMode]      static HTML/PDF export: no editing controls
 */
export function createDrawings({ editor, gadget, RpcTarget, viewer, activeBlockId, scheduleSave, setStatus, exportMode = false }) {
  /** @type {Map<string, {revision: number, title: string, url: string|null, tooLarge: boolean}>} */
  const previews = new Map();
  /** @type {Map<string, Promise<void>>} */
  const loading = new Map();
  /** @type {Set<string>} ids the server says it has no drawing for */
  const missing = new Set();
  /** @type {{id: string, host: HTMLElement, destroy: () => void}|null} */
  let open = null;

  const figures = (id) => [...editor.querySelectorAll(`figure.doc-drawing[data-drawing-id="${id}"]`)];

  function load(id) {
    if (!DRAWING_ID_RE.test(id)) return Promise.resolve();
    const inFlight = loading.get(id);
    if (inFlight) return inFlight;
    const task = (async () => {
      try {
        const preview = await gadget.getDrawingPreview(id);
        if (!preview) {
          missing.add(id);
          previews.delete(id);
        } else {
          missing.delete(id);
          previews.set(id, {
            revision: preview.revision,
            title: preview.title || "Drawing",
            url: preview.svg ? svgDataUrl(preview.svg) : null,
            tooLarge: Boolean(preview.tooLarge),
          });
        }
      } catch (err) {
        console.warn("Could not load drawing preview", id, err);
      } finally {
        loading.delete(id);
        for (const figure of figures(id)) render(figure);
      }
    })();
    loading.set(id, task);
    return task;
  }

  /** @param {Element} figure */
  function render(figure) {
    const id = figure.getAttribute("data-drawing-id") || "";
    let ui = figure.querySelector(":scope > .doc-drawing-ui");
    if (!ui) {
      ui = document.createElement("div");
      ui.className = "doc-drawing-ui";
      ui.setAttribute("contenteditable", "false");
      figure.replaceChildren(ui);
    }
    const preview = previews.get(id);
    const title = preview?.title ?? (missing.has(id) ? "Missing drawing" : "Drawing");
    const body = document.createElement("div");
    if (preview?.url) {
      const img = document.createElement("img");
      img.className = "doc-drawing-img";
      img.src = preview.url;
      img.alt = title;
      img.draggable = false;
      body.appendChild(img);
    } else {
      body.className = "doc-drawing-empty";
      body.textContent = missing.has(id) ? "This drawing was deleted."
        : preview?.tooLarge ? "This drawing is too large to preview here. Open it to see it."
        : preview ? "Empty drawing. Open it to start drawing."
        : "Loading drawing…";
    }
    const parts = [body];
    if (!exportMode) {
      const bar = document.createElement("div");
      bar.className = "doc-drawing-bar";
      const label = document.createElement("span");
      label.className = "doc-drawing-title";
      label.textContent = title;
      bar.appendChild(label);
      if (!missing.has(id)) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "doc-drawing-open";
        button.dataset.drawingId = id;
        button.textContent = "Edit drawing";
        bar.appendChild(button);
      }
      parts.push(bar);
    }
    ui.replaceChildren(...parts);
  }

  /** Fills every figure in the page that has no UI yet, and loads previews it lacks. */
  function hydrate() {
    for (const figure of editor.querySelectorAll("figure.doc-drawing[data-drawing-id]")) {
      const id = figure.getAttribute("data-drawing-id") || "";
      const ui = figure.querySelector(":scope > .doc-drawing-ui");
      if (!ui) render(figure);
      if (!previews.has(id) && !missing.has(id)) load(id);
    }
  }

  /** A server event: {type: "drawing", id, revision, title}. */
  function onEvent(event) {
    const cached = previews.get(event.id);
    if (cached && cached.revision >= event.revision && cached.title === event.title) return;
    if (figures(event.id).length) load(event.id);
    else previews.delete(event.id);
  }

  /** Resolves once every preview being loaded has arrived (the HTML/PDF export waits for it). */
  async function settled() {
    hydrate();
    while (loading.size) await Promise.all([...loading.values()]);
  }

  /** Inserts a new drawing after the block holding the caret (or at the end) and opens it. */
  async function insert() {
    const id = newDrawingId();
    setStatus("saving", "Creating drawing…");
    try {
      await gadget.createDrawing({ id, insertAfter: null, by: viewer.name });
    } catch (err) {
      console.error(err);
      setStatus("bad", "Drawing failed");
      return;
    }
    const figure = document.createElement("figure");
    figure.className = "doc-drawing";
    figure.setAttribute("data-drawing-id", id);
    figure.setAttribute("contenteditable", "false");
    const anchorId = activeBlockId();
    const anchor = anchorId ? [...editor.children].find((n) => n.getAttribute("data-block-id") === anchorId) : null;
    if (anchor) anchor.after(figure);
    else editor.appendChild(figure);
    if (!figure.nextElementSibling) {
      const p = document.createElement("p");
      p.appendChild(document.createElement("br"));
      figure.after(p);
    }
    previews.set(id, { revision: 0, title: "Untitled drawing", url: null, tooLarge: false });
    render(figure);
    load(id);
    scheduleSave();
    await openEditor(id);
  }

  /** @param {string} id */
  async function openEditor(id) {
    if (open) closeEditor();
    const host = document.createElement("div");
    host.className = "doc-drawing-editor";
    document.body.appendChild(host);
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    document.documentElement.classList.add("drawing-open");
    const adapter = {
      subscribe: (callback, client) => gadget.drawingSubscribe(id, callback, client),
      applyOperation: (request) => gadget.drawingApply(id, request),
      updatePresence: (presence) => gadget.drawingPresence(id, presence),
      leavePresence: (clientId, session) => gadget.drawingLeave(id, clientId, session),
      undo: (args) => gadget.drawingUndo(id, args),
      getHistory: (limit) => gadget.drawingHistory(id, limit),
      getDiagramRender: (diagramId) => gadget.drawingDiagramRender(id, diagramId),
      getBoard: () => gadget.drawing(id, "getBoard"),
    };
    const state = { id, host, destroy: () => {} };
    open = state;
    try {
      const mounted = await mountWhiteboard(host, {
        gadget: adapter,
        RpcTarget,
        viewer: { clientId: hex(8), name: viewer.name, color: PALETTE[Math.floor(Math.random() * PALETTE.length)] },
        onUnrecoverable: () => showFailure(host, "The drawing lost its connection."),
      });
      if (open !== state) { mounted.destroy(); return; }
      state.destroy = mounted.destroy;
      const back = document.createElement("button");
      back.type = "button";
      back.className = "doc-drawing-back";
      back.textContent = "← Back to document";
      back.title = "Close the drawing and return to the document";
      back.addEventListener("click", () => closeEditor());
      mounted.topbar?.prepend(back);
    } catch (err) {
      console.error(err);
      if (open === state) showFailure(host, "The drawing could not be opened: " + (err?.message ?? err));
    }
  }

  function showFailure(host, message) {
    const box = document.createElement("div");
    box.className = "doc-drawing-failed";
    box.setAttribute("role", "alert");
    const text = document.createElement("p");
    text.textContent = message;
    const back = document.createElement("button");
    back.type = "button";
    back.className = "doc-drawing-back";
    back.textContent = "← Back to document";
    back.addEventListener("click", () => closeEditor());
    const reload = document.createElement("button");
    reload.type = "button";
    reload.className = "doc-drawing-back";
    reload.textContent = "Reload";
    reload.addEventListener("click", () => location.reload());
    box.append(text, back, reload);
    host.appendChild(box);
  }

  function closeEditor() {
    if (!open) return;
    const { id, host, destroy } = open;
    open = null;
    try { destroy(); } catch (err) { console.warn(err); }
    host.remove();
    document.documentElement.classList.remove("drawing-open");
    gadget.refreshDrawingPreview(id).catch(() => {});
    const figure = figures(id)[0];
    figure?.scrollIntoView({ block: "nearest" });
  }

  if (!exportMode) {
    editor.addEventListener("mousedown", (e) => {
      if (e.target.closest?.(".doc-drawing-ui")) e.preventDefault(); // keep the caret where it was
    });
    editor.addEventListener("click", (e) => {
      const button = e.target.closest?.(".doc-drawing-open");
      const figure = e.target.closest?.("figure.doc-drawing");
      for (const selected of editor.querySelectorAll("figure.doc-drawing.drawing-selected")) {
        if (selected !== figure) selected.classList.remove("drawing-selected");
      }
      if (!figure) return;
      figure.classList.add("drawing-selected");
      const id = figure.getAttribute("data-drawing-id") || "";
      if (button || (e.target.closest?.(".doc-drawing-empty") && !missing.has(id))) openEditor(id);
    });
    editor.addEventListener("dblclick", (e) => {
      const figure = e.target.closest?.("figure.doc-drawing");
      const id = figure?.getAttribute("data-drawing-id") || "";
      if (figure && DRAWING_ID_RE.test(id) && !missing.has(id)) openEditor(id);
    });
    // Leave the drawing's presence promptly when the page goes away.
    window.addEventListener("pagehide", () => { if (open) closeEditor(); });
  }

  return {
    hydrate, onEvent, settled, insert,
    open: openEditor, close: closeEditor,
    get openId() { return open?.id ?? null; },
  };
}
