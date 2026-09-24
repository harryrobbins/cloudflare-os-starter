// @ts-check
// Empty-board onboarding: when the whiteboard has no objects, a small card offers three ways to
// start (add a sticky note, paste text, choose a template). It does not block the canvas and
// disappears as soon as anything is on the board. "Not now" hides it for this visit.

import { h, icon } from "./dom.js";

/**
 * Whether the card shows. Pure.
 * @param {{objectCount: number, live: boolean, dismissed: boolean, presenting: boolean}} s
 */
export function shouldShowOnboarding({ objectCount, live, dismissed, presenting }) {
  return live && objectCount === 0 && !dismissed && !presenting;
}

/**
 * @param {import("./app.js").App} app
 * @param {{addSticky: () => void, pasteText: (from: HTMLElement) => void, chooseTemplate: (from: HTMLElement) => void, isPresenting: () => boolean}} actions
 */
export function createOnboarding(app, actions) {
  let dismissed = false;
  let seenLive = false;
  const title = h("h2", { id: "wb-onboarding-title" }, "Start your whiteboard");
  const stickyBtn = h("button", { type: "button", class: "btn primary wb-start-sticky", onclick: () => actions.addSticky() }, icon("sticky", 18), "Add a sticky note");
  const pasteBtn = h("button", { type: "button", class: "btn outline wb-start-paste", onclick: () => actions.pasteText(pasteBtn) }, icon("copy", 18), "Paste text");
  const templateBtn = h("button", { type: "button", class: "btn outline wb-start-template", onclick: () => actions.chooseTemplate(templateBtn) }, icon("frame", 18), "Choose a template");
  const el = h("section", { class: "wb-float wb-onboarding", "aria-labelledby": "wb-onboarding-title", hidden: true },
    title,
    h("p", null, "Add a note, paste a list (one note per line), or begin from a template. Press ? for keyboard shortcuts."),
    h("div", { class: "wb-onboarding-actions" }, stickyBtn, pasteBtn, templateBtn),
    h("button", {
      type: "button", class: "btn wb-onboarding-dismiss", onclick: () => {
        const hadFocus = el.contains(document.activeElement);
        dismissed = true;
        render();
        if (hadFocus) app.canvas.element.focus({ preventScroll: true });
      },
    }, "Not now"),
  );
  app.root.appendChild(el);

  function render() {
    const state = app.store.getState();
    if (state.connection === "live") seenLive = true;
    const show = shouldShowOnboarding({
      objectCount: Object.keys(state.board.objects).length, live: seenLive, dismissed, presenting: actions.isPresenting(),
    });
    if (el.hidden === !show) return;
    const hadFocus = el.contains(document.activeElement);
    el.hidden = !show;
    if (!show && hadFocus) app.canvas.element.focus({ preventScroll: true });
  }

  return { el, render };
}
