// @ts-check
// Presentation mode: the editing chrome is hidden and the view fits one frame at a time, in
// stacking order (z, then id). Next / previous / first / last / exit by keyboard (the
// "presentation" commands in ./canvas/keymap.js) or by the buttons of the presentation bar.
//
// It moves only this viewer's camera. Nobody else's view is moved: others see the presenter's
// viewport in the minimap like anyone's, and can choose to follow them. Camera moves glide unless
// the viewer asks for reduced motion (the canvas handles that).

import { compareObjects } from "../../shared/protocol.js";
import { h, icon } from "./dom.js";
import { keyAction } from "./canvas/keymap.js";

/** @typedef {import("../../shared/protocol.js").WhiteboardObject} WhiteboardObject */

/**
 * Frames in presentation order: stacking order (z, then id).
 * @param {Record<string, WhiteboardObject>} objects
 * @returns {WhiteboardObject[]}
 */
export function presentationFrames(objects) {
  return Object.values(objects).filter((o) => o.type === "frame").sort(compareObjects);
}

/**
 * The index after a step, clamped to the list.
 * @param {number} index @param {number} count @param {"next"|"previous"|"first"|"last"} step
 */
export function stepIndex(index, count, step) {
  if (count <= 0) return -1;
  switch (step) {
    case "first": return 0;
    case "last": return count - 1;
    case "next": return Math.min(count - 1, index + 1);
    case "previous": return Math.max(0, index - 1);
  }
  return index;
}

/**
 * @param {import("./app.js").App} app
 * @param {{showToast: (message: string) => void}} ui
 */
export function createPresentation(app, { showToast }) {
  const { store, canvas, root } = app;
  /** @type {string|null} */
  let currentId = null;
  let active = false;
  /** @type {HTMLElement|null} */
  let returnFocus = null;

  const status = h("span", { class: "wb-present-status", "aria-live": "polite", "aria-atomic": "true" });
  const prevBtn = h("button", { type: "button", class: "btn icon-only wb-present-prev", "aria-label": "Previous frame", title: "Previous frame (←)", onclick: () => go("previous") }, icon("arrowLeft", 20));
  const nextBtn = h("button", { type: "button", class: "btn icon-only wb-present-next", "aria-label": "Next frame", title: "Next frame (→)", onclick: () => go("next") }, icon("arrowRight", 20));
  const exitBtn = h("button", { type: "button", class: "btn outline wb-present-exit", title: "Stop presenting (Escape)", onclick: () => stop() }, "Exit");
  const bar = h("div", { class: "wb-float wb-present-bar", role: "toolbar", "aria-label": "Presentation", hidden: true },
    prevBtn, status, nextBtn, exitBtn);
  root.appendChild(bar);

  const frames = () => presentationFrames(store.getState().board.objects);

  function show() {
    const list = frames();
    let i = currentId ? list.findIndex((f) => f.id === currentId) : -1;
    if (i < 0 && list.length) { i = 0; currentId = list[0].id; }
    if (i < 0) { stop(); return; }
    const f = list[i];
    canvas.fitObjects([f.id], { padding: 32 });
    status.textContent = `${i + 1} of ${list.length}: ${f.text || "Untitled frame"}`;
    prevBtn.setAttribute("aria-disabled", String(i === 0));
    nextBtn.setAttribute("aria-disabled", String(i === list.length - 1));
  }

  /** @param {"next"|"previous"|"first"|"last"} step */
  function go(step) {
    if (!active) return;
    const list = frames();
    const i = list.findIndex((f) => f.id === currentId);
    const next = stepIndex(i < 0 ? 0 : i, list.length, step);
    if (next < 0) { stop(); return; }
    currentId = list[next].id;
    show();
  }

  /** @param {KeyboardEvent} e */
  function onKey(e) {
    if (!active || e.defaultPrevented || e.isComposing) return;
    const t = e.target instanceof Element ? e.target : null;
    if (t?.closest?.("input, textarea, select, .modal-scrim, .menu")) return;
    // Buttons of the bar keep their own Enter and Space.
    if (t && bar.contains(t) && (e.key === "Enter" || e.key === " ")) return;
    const action = keyAction(e, "presentation");
    if (!action || action.type !== "present") {
      // Editing shortcuts do nothing while presenting (except those the chrome-free view keeps).
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (action.step === "exit") stop();
    else go(action.step);
  }

  function onResize() {
    if (active) show();
  }

  /**
   * Starts presenting at `frameId` (or the first frame). Without frames it explains why not.
   * @param {string} [frameId]
   */
  function start(frameId) {
    const list = frames();
    if (!list.length) {
      showToast("Add a frame to present: each frame is one slide.");
      return false;
    }
    currentId = frameId && list.some((f) => f.id === frameId) ? frameId : list[0].id;
    if (!active) {
      active = true;
      returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      canvas.setSelection([]);
      root.classList.add("presenting");
      bar.hidden = false;
      window.addEventListener("keydown", onKey, true);
      window.addEventListener("resize", onResize);
      app.announce("Presenting. Arrow keys move between frames; Escape stops.");
    }
    show();
    canvas.element.focus({ preventScroll: true });
    return true;
  }

  function stop() {
    if (!active) return;
    active = false;
    root.classList.remove("presenting");
    bar.hidden = true;
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", onResize);
    app.announce("Stopped presenting");
    const target = returnFocus?.isConnected ? returnFocus : canvas.element;
    target.focus({ preventScroll: true });
  }

  return {
    start,
    stop,
    isActive: () => active,
    /** Keeps the bar right when frames change while presenting. */
    onObjectsChanged() {
      if (!active) return;
      const list = frames();
      if (!list.length) { stop(); return; }
      if (!list.some((f) => f.id === currentId)) {
        // The frame on show was deleted: move on to the first one.
        currentId = list[0].id;
        show();
        return;
      }
      const i = list.findIndex((f) => f.id === currentId);
      status.textContent = `${i + 1} of ${list.length}: ${list[i].text || "Untitled frame"}`;
      prevBtn.setAttribute("aria-disabled", String(i === 0));
      nextBtn.setAttribute("aria-disabled", String(i === list.length - 1));
    },
  };
}
