// @ts-check
// Wires clipboard, backup and import, templates, shortcuts help, empty-board onboarding, deep
// links and presentation mode into the app shell. The shell calls mountShare() once, forwards
// shell commands (keymap.js "command" actions), store changes, and asks for extra context-menu
// items.

import { h, icon } from "./dom.js";
import { modal, openMenu, showToast } from "./dialogs.js";
import { createClipboard, writeClipboard } from "./clipboard.js";
import { downloadBackupDialog, importBackupDialog, pasteTextDialog } from "./backup.js";
import { chooseTemplate, insertTemplate } from "./templates.js";
import { openHelp } from "./help.js";
import { createOnboarding } from "./onboarding.js";
import { createPresentation, presentationFrames } from "./presentation.js";
import { linkFor, watchLinks } from "./deep-link.js";

export { SHARE_CSS } from "./share.css.js";

/** @typedef {{label: string, onSelect: () => void, danger?: boolean, className?: string}} MenuItem */

/**
 * Shows a link that could not be copied, selected, so it can be copied by hand.
 * @param {string} link @param {HTMLElement|null} returnFocus
 */
function showLinkDialog(link, returnFocus) {
  return modal((close) => {
    const input = /** @type {HTMLInputElement} */ (h("input", { class: "wb-link-input", readonly: true, value: link, "aria-label": "Link", "data-autofocus": true }));
    input.addEventListener("focus", () => input.select());
    return h("div", { class: "modal wb-link", "aria-labelledby": "wb-link-title" },
      h("h2", { id: "wb-link-title" }, "Copy link"),
      h("p", null, "Copying was blocked here. Copy this link yourself; it opens this whiteboard at the same place."),
      input,
      h("div", { class: "modal-actions" }, h("button", { type: "button", class: "btn primary", onclick: () => close(null) }, "Done")),
    );
  }, null, returnFocus);
}

/**
 * @param {import("./app.js").App} app
 * @param {{topbar: HTMLElement}} where
 */
export function mountShare(app, { topbar }) {
  const { store, canvas } = app;
  const ui = { showToast: (/** @type {string} */ m) => { showToast(m); } };
  const clipboard = createClipboard(app, ui);
  const presentation = createPresentation(app, ui);

  const focusBack = () => canvas.element;

  /** @param {HTMLElement|null} [from] */
  async function pasteText(from = null) {
    await pasteTextDialog((text) => { clipboard.pasteText(text); }, from ?? focusBack());
  }

  /** @param {HTMLElement|null} [from] */
  async function templates(from = null) {
    const id = await chooseTemplate(from ?? focusBack());
    if (id) insertTemplate(app, clipboard, id);
  }

  /** @param {HTMLElement|null} [from] */
  function help(from = null) {
    return openHelp(from ?? /** @type {HTMLElement|null} */ (document.activeElement instanceof HTMLElement ? document.activeElement : focusBack()));
  }

  /** @param {string} [frameId] */
  function present(frameId) {
    const sel = canvas.getSelection();
    const selected = sel.length === 1 ? store.getState().board.objects[sel[0]] : undefined;
    presentation.start(frameId ?? (selected?.type === "frame" ? selected.id : undefined));
  }

  /** @param {string} id */
  function copyLink(id) {
    const o = store.getState().board.objects[id];
    if (!o) return;
    const kind = o.type === "frame" ? "frame" : "object";
    const link = linkFor(kind, id);
    if (writeClipboard(link)) {
      showToast(`Link to this ${kind} copied`, { timeout: 3000 });
      app.announce(`Link to this ${kind} copied`);
    } else {
      showLinkDialog(link, canvas.element);
    }
  }

  const onboarding = createOnboarding(app, {
    addSticky: () => { canvas.addAtCenter("sticky"); },
    pasteText: (from) => { pasteText(from); },
    chooseTemplate: (from) => { templates(from); },
    isPresenting: () => presentation.isActive(),
  });

  // ---- board menu (topbar)
  const menuBtn = h("button", {
    type: "button", class: "btn icon-only wb-board-menu", title: "Board menu: shortcuts, present, templates, backup",
    "aria-label": "Board menu", "aria-haspopup": "menu",
  }, icon("more", 18));
  menuBtn.addEventListener("click", () => {
    /** @type {MenuItem[]} */
    const items = [
      { label: "Keyboard shortcuts (?)", className: "board-help", onSelect: () => { help(menuBtn); } },
    ];
    if (presentationFrames(store.getState().board.objects).length) {
      items.push({ label: "Present frames (Shift+P)", className: "board-present", onSelect: () => present() });
    }
    items.push({ label: "Add a template…", className: "board-template", onSelect: () => { templates(menuBtn); } });
    if (clipboard.hasCopied()) items.push({ label: "Paste", className: "board-paste", onSelect: () => { clipboard.pasteCopied(); } });
    items.push({ label: "Paste text as sticky notes…", className: "board-paste-text", onSelect: () => { pasteText(menuBtn); } });
    items.push({ label: "Download board backup", className: "board-backup", onSelect: () => { downloadBackupDialog(app, menuBtn); } });
    items.push({ label: "Import backup…", className: "board-import", onSelect: () => { importBackupDialog(app, menuBtn); } });
    openMenu(menuBtn, items, { label: "Board" });
  });
  topbar.appendChild(menuBtn);

  const links = watchLinks(app, { present: (id) => present(id) });

  return {
    clipboard,
    presentation,
    /**
     * A shell command from the keyboard. Returns true when handled here.
     * @param {string} command
     */
    command(command) {
      if (command === "help") { help(); return true; }
      if (command === "present") { if (presentation.isActive()) presentation.stop(); else present(); return true; }
      return false;
    },
    /**
     * Extra items for the canvas context menu.
     * @param {import("../../shared/protocol.js").WhiteboardObject[]} objs  the selection
     * @returns {MenuItem[]}
     */
    contextItems(objs) {
      /** @type {MenuItem[]} */
      const items = [];
      if (objs.length) {
        items.push({ label: "Copy", className: "ctx-copy", onSelect: () => { clipboard.copySelection(false); } });
        items.push({ label: "Cut", className: "ctx-cut", onSelect: () => { clipboard.copySelection(true); } });
        if (objs.length === 1) {
          const kind = objs[0].type === "frame" ? "frame" : "object";
          items.push({ label: `Copy link to ${kind}`, className: "ctx-link", onSelect: () => copyLink(objs[0].id) });
          if (kind === "frame") items.push({ label: "Present from this frame", className: "ctx-present", onSelect: () => present(objs[0].id) });
        }
      } else {
        if (clipboard.hasCopied()) items.push({ label: "Paste", className: "ctx-paste", onSelect: () => { clipboard.pasteCopied(); } });
        items.push({ label: "Paste text as sticky notes…", className: "ctx-paste-text", onSelect: () => { pasteText(); } });
        items.push({ label: "Add a template…", className: "ctx-template", onSelect: () => { templates(); } });
      }
      return items;
    },
    /**
     * @param {import("../store-contract.js").ClientState} state
     * @param {import("../store-contract.js").Change} change
     */
    onChange(state, change) {
      links.onChange(state, change);
      if (change.kind === "snapshot" || change.kind === "objects" || change.kind === "connection") {
        onboarding.render();
        if (change.kind !== "connection") presentation.onObjectsChanged();
      }
    },
    render: () => onboarding.render(),
    copyLink,
    destroy() {
      clipboard.destroy();
      links.destroy();
      presentation.stop();
    },
  };
}
