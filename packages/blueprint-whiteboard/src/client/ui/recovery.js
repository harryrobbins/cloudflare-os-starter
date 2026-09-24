// @ts-check
// The terminal recovery screen (interim, until the host can replace the iframe's RPC stub): shown by
// main.js when the connection is unrecoverable while changes are still unacknowledged. It says how
// many, offers a data-only download of the last acknowledged board plus the pending changes, and
// makes reloading an explicit choice. The recovery data is built on demand and only ever handed to
// the viewer: never kept in window.name, storage or logs.

import { h, inertOthers, trapTab } from "./dom.js";
import { changesText } from "../sync/connection.js";

/** @typedef {import("../store-contract.js").ClientState} ClientState */
/** @typedef {import("../store-contract.js").RecoveryData} RecoveryData */

export const RECOVERY_OVERLAY_ID = "wb-connection-overlay";

/**
 * The file name of a recovery download (no board title: it is content).
 * @param {number} now
 */
export function recoveryFileName(now) {
  const d = new Date(now);
  const p = (/** @type {number} */ n) => String(n).padStart(2, "0");
  return `whiteboard-unsaved-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
}

/**
 * Offers `text` as a file download. The platform's iframe sandbox may block downloads, so the
 * screen also offers the same text to copy by hand.
 * @param {string} name
 * @param {string} text
 */
function download(name, text) {
  try {
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const a = h("a", { href: url, download: name, hidden: true });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch { /* blocked: the copy fallback remains */ }
}

/**
 * @param {{
 *   getState: () => ClientState,
 *   getData: () => RecoveryData,
 *   onReload: () => void,
 *   autoReloadMinutes: number,
 * }} opts
 * @returns {{update: (state: ClientState) => void, close: () => void, el: HTMLElement}}
 */
export function showRecoveryScreen({ getState, getData, onReload, autoReloadMinutes }) {
  document.getElementById(RECOVERY_OVERLAY_ID)?.remove();
  const count = h("p", { id: "wb-recovery-count" });
  const copyArea = /** @type {HTMLTextAreaElement} */ (h("textarea", {
    class: "recovery-data", readonly: true, rows: 6, hidden: true,
    "aria-label": "Unsaved changes as data. Select all and copy it somewhere safe.",
    style: { width: "100%", font: "12px ui-monospace, monospace", resize: "vertical" },
  }));
  const fill = () => {
    copyArea.value = JSON.stringify(getData(), null, 2);
    return copyArea.value;
  };
  const downloadBtn = h("button", {
    type: "button", class: "btn primary", "data-autofocus": true,
    onclick: () => download(recoveryFileName(Date.now()), fill()),
  }, "Download unsaved changes");
  const showBtn = h("button", {
    type: "button", class: "btn outline", "aria-expanded": "false", "aria-controls": "wb-recovery-data",
    onclick: () => {
      const open = copyArea.hidden;
      if (open) fill();
      copyArea.hidden = !open;
      showBtn.setAttribute("aria-expanded", String(open));
      if (open) {
        copyArea.focus();
        copyArea.select();
      }
    },
  }, "Show as text");
  copyArea.id = "wb-recovery-data";
  const reloadBtn = h("button", { type: "button", class: "btn danger-text", onclick: () => onReload() }, "Reload and lose them");
  const box = h("div", {
    class: "modal recovery", role: "alertdialog", "aria-modal": "true",
    "aria-labelledby": "wb-recovery-title", "aria-describedby": "wb-recovery-count wb-recovery-help",
  },
  h("h2", { id: "wb-recovery-title" }, "Connection lost"),
  count,
  h("p", { id: "wb-recovery-help" },
    "Download them first: the file holds the last saved board and your unsaved changes as data. " +
    "The whiteboard keeps trying to reconnect meanwhile."),
  copyArea,
  h("p", { class: "recovery-note", style: { fontSize: "13px" } },
    `If nothing changes, the page reloads by itself after ${autoReloadMinutes} minutes.`),
  h("div", { class: "modal-actions" }, reloadBtn, showBtn, downloadBtn));
  const el = h("div", { id: RECOVERY_OVERLAY_ID, class: "modal-scrim", dataset: { state: "recovery" } }, box);
  el.addEventListener("keydown", (e) => {
    // Escape does not dismiss it: every way out is an explicit choice.
    if (e.key === "Escape") e.preventDefault();
    trapTab(box, e);
  });
  document.body.appendChild(el);
  const restoreInert = inertOthers([el]);

  /** @param {ClientState} state */
  const update = (state) => {
    const n = state.pendingCount;
    count.textContent = n
      ? `${changesText(n)} ${n === 1 ? "has" : "have"} not been saved. Reloading the page would lose ${n === 1 ? "it" : "them"}.`
      : "All changes are saved.";
    el.dataset.count = String(n);
  };
  update(getState());
  downloadBtn.focus();

  return {
    el,
    update,
    close() {
      restoreInert();
      el.remove();
    },
  };
}
