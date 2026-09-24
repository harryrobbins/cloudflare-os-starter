// @ts-check
// "Download board backup" and "Import backup…": the portable JSON format of src/shared/backup.js.
//
// Saving a file from inside the gadget: the gadget iframe's sandbox has no `allow-downloads`, so
// a download started in the frame may be blocked silently, and nothing in the frame can tell. The
// platform's own route is the gadget's Export menu, where the server offers "Whiteboard backup
// (JSON)" (ExportHandler in src/server/index.js). So the Download button tries a download and
// always opens a dialog that also offers Copy, and names the Export menu.
//
// Import reads a file (or pasted text), shows what it holds and what is wrong with it, then
// creates the objects through the store in batches of IMPORT_BATCH, so each batch is validated by
// the server like any edit and the page stays responsive.

import { LIMITS, newId } from "../../shared/protocol.js";
import { BACKUP_LIMITS, buildBackup, importOffset, parseBackup, planCreates } from "../../shared/backup.js";
import { h } from "./dom.js";
import { modal } from "./dialogs.js";
import { writeClipboard } from "./clipboard.js";

/** @typedef {import("../../shared/backup.js").ParsedBackup} ParsedBackup */

/** Objects created per store call when importing. */
export const IMPORT_BATCH = 500;
/** Largest backup shown as text straight away (beyond it, behind "Show as text"). */
const SHOW_TEXT_MAX = 200_000;

const TYPE_NAMES = /** @type {Record<string, [string, string]>} */ ({
  sticky: ["sticky note", "sticky notes"], rect: ["rectangle", "rectangles"], ellipse: ["ellipse", "ellipses"],
  text: ["text label", "text labels"], frame: ["frame", "frames"], pen: ["drawing", "drawings"], connector: ["connector", "connectors"],
  code: ["code block", "code blocks"],
});

/**
 * "3 sticky notes, 1 frame" for a preview.
 * @param {Record<string, number>} counts
 */
export function describeCounts(counts) {
  const parts = Object.entries(counts).filter(([, n]) => n > 0)
    .map(([type, n]) => `${n} ${(TYPE_NAMES[type] ?? [type, type])[n === 1 ? 0 : 1]}`);
  return parts.length ? parts.join(", ") : "no objects";
}

/**
 * A safe file name from a board title.
 * @param {string} title @param {number} [now]
 */
export function backupFileName(title, now = Date.now()) {
  const stem = String(title || "whiteboard").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "whiteboard";
  return `${stem}-${new Date(now).toISOString().slice(0, 10)}.whiteboard.json`;
}

/**
 * Tries to save `text` as a file. Returns false when the browser refused outright; a sandboxed
 * frame may also drop it silently.
 * @param {string} name @param {string} text
 */
export function tryDownload(name, text) {
  try {
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const a = h("a", { href: url, download: name, hidden: true });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {import("./app.js").App} app
 * @param {HTMLElement|null} [returnFocus]
 */
export function downloadBackupDialog(app, returnFocus = null) {
  const board = app.store.getState().board;
  const doc = buildBackup(board);
  const text = JSON.stringify(doc, null, 2);
  const name = backupFileName(board.title);
  const counts = /** @type {Record<string, number>} */ ({});
  for (const o of doc.objects) counts[o.type] = (counts[o.type] ?? 0) + 1;
  tryDownload(name, text);
  return modal((close) => {
    const note = h("p", { class: "wb-backup-note", role: "status" });
    // Large backups are only rendered as text on request.
    const area = /** @type {HTMLTextAreaElement} */ (h("textarea", {
      class: "wb-backup-text", readonly: true, rows: "6", "aria-label": "Backup JSON", spellcheck: "false",
      hidden: text.length > SHOW_TEXT_MAX,
    }));
    area.value = text;
    return h("div", { class: "modal wb-backup", "aria-labelledby": "wb-backup-title" },
      h("h2", { id: "wb-backup-title" }, "Board backup"),
      h("p", null, `${describeCounts(counts)}, with the title and background. It holds no history, names or cursors.`),
      h("p", null, `If ${name} did not download (the whiteboard runs in a protected frame that may block downloads), copy the backup (Copy, or Show as text), or use the whiteboard's Export menu: Whiteboard backup (JSON).`),
      area,
      note,
      h("div", { class: "modal-actions" },
        area.hidden ? h("button", {
          type: "button", class: "btn outline wb-backup-show", onclick: (/** @type {MouseEvent} */ e) => {
            area.hidden = false;
            /** @type {HTMLElement} */ (e.currentTarget).remove();
            area.focus();
            area.select();
          },
        }, "Show as text") : null,
        h("button", { type: "button", class: "btn outline", onclick: () => { tryDownload(name, text); } }, "Download again"),
        h("button", {
          type: "button", class: "btn outline wb-backup-copy", onclick: () => {
            note.textContent = writeClipboard(text) ? "Copied." : "Copying was blocked. Select the text and copy it.";
          },
        }, "Copy"),
        h("button", { type: "button", class: "btn primary", "data-autofocus": true, onclick: () => close(null) }, "Done"),
      ),
    );
  }, null, returnFocus);
}

/**
 * Creates a parsed backup's objects in batches, placed like the server's importData (right of
 * existing content). Resolves with the new ids.
 * @param {import("./app.js").App} app
 * @param {ParsedBackup} parsed
 * @param {{structure?: boolean, onProgress?: (done: number, total: number) => void, yieldFn?: () => Promise<void>}} [opts]
 */
export async function importParsed(app, parsed, { structure = false, onProgress, yieldFn = () => new Promise((r) => setTimeout(r, 0)) } = {}) {
  const { store } = app;
  const objects = store.getState().board.objects;
  const room = Math.max(0, LIMITS.objects - Object.keys(objects).length);
  const { dx, dy } = importOffset(parsed.entries, objects, null);
  const { creates, dropped } = planCreates(parsed.entries, { newId: () => newId("object"), dx, dy, max: room });
  /** @type {string[]} */
  const ids = [];
  for (let i = 0; i < creates.length; i += IMPORT_BATCH) {
    ids.push(...store.createObjects(/** @type {any} */ (creates.slice(i, i + IMPORT_BATCH))));
    onProgress?.(Math.min(creates.length, i + IMPORT_BATCH), creates.length);
    if (i + IMPORT_BATCH < creates.length) await yieldFn();
  }
  if (structure && (parsed.title || parsed.background)) {
    /** @type {{title?: string, background?: "dots"|"grid"|"plain"}} */
    const patch = {};
    if (parsed.title) patch.title = parsed.title;
    if (parsed.background) patch.background = parsed.background;
    store.setStructure(patch);
  }
  return { ids, dropped };
}

/**
 * The import dialog: choose a file or paste text, check it, then import.
 * @param {import("./app.js").App} app
 * @param {HTMLElement|null} [returnFocus]
 */
export function importBackupDialog(app, returnFocus = null) {
  return modal((close) => {
    /** @type {ParsedBackup|null} */
    let parsed = null;
    const preview = h("div", { class: "wb-import-preview", role: "status", "aria-live": "polite" });
    const importBtn = h("button", { type: "button", class: "btn primary wb-import-go", "aria-disabled": "true" }, "Import");
    const structureBox = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", class: "wb-import-structure" }));
    const text = /** @type {HTMLTextAreaElement} */ (h("textarea", {
      class: "wb-import-text", rows: "5", spellcheck: "false", "aria-label": "Backup text",
      placeholder: "…or paste the backup's text here",
    }));
    const file = /** @type {HTMLInputElement} */ (h("input", { type: "file", accept: ".json,application/json", class: "wb-import-file", "data-autofocus": true }));

    /** @param {string} source */
    function check(source) {
      const r = parseBackup(source);
      parsed = "error" in r ? null : r;
      preview.replaceChildren();
      if ("error" in r) {
        preview.append(h("p", { class: "wb-import-error" }, r.error));
      } else {
        const room = Math.max(0, LIMITS.objects - Object.keys(app.store.getState().board.objects).length);
        const total = r.entries.length;
        preview.append(h("p", null, `This backup holds ${describeCounts(r.counts)}.`));
        if (r.title) preview.append(h("p", { class: "muted" }, `Title: ${r.title}`));
        if (total > room) preview.append(h("p", { class: "wb-import-error" }, `Only ${room} fit: a whiteboard holds at most ${LIMITS.objects} objects.`));
        if (r.skipped) {
          preview.append(h("p", { class: "wb-import-error" }, `${r.skipped} ${r.skipped === 1 ? "object" : "objects"} will be left out:`),
            h("ul", { class: "wb-import-errors" }, r.errors.map((m) => h("li", null, m)),
              r.skipped > r.errors.length ? h("li", null, `…and ${r.skipped - r.errors.length} more`) : null));
        }
      }
      const ok = !!parsed && parsed.entries.length > 0;
      importBtn.setAttribute("aria-disabled", String(!ok));
      importBtn.textContent = ok && parsed ? `Import ${parsed.entries.length} ${parsed.entries.length === 1 ? "object" : "objects"}` : "Import";
    }

    file.addEventListener("change", async () => {
      const f = file.files?.[0];
      if (!f) return;
      if (f.size > BACKUP_LIMITS.textChars) {
        parsed = null;
        preview.replaceChildren(h("p", { class: "wb-import-error" }, "This file is too large to be a whiteboard backup."));
        importBtn.setAttribute("aria-disabled", "true");
        return;
      }
      check(await f.text());
    });
    text.addEventListener("input", () => { if (text.value.trim()) check(text.value); });

    importBtn.addEventListener("click", async () => {
      if (!parsed || !parsed.entries.length || importBtn.dataset.busy) return;
      importBtn.dataset.busy = "true";
      const p = parsed;
      const { ids, dropped } = await importParsed(app, p, {
        structure: structureBox.checked,
        onProgress: (done, total) => { preview.replaceChildren(h("p", null, `Importing… ${done} of ${total}`)); },
      });
      close(null);
      if (ids.length) app.canvas.fitObjects(ids, { padding: 60 });
      app.announce(`Imported ${ids.length} ${ids.length === 1 ? "object" : "objects"}${dropped ? `; ${dropped} did not fit` : ""}`);
    });

    return h("div", { class: "modal wb-import", "aria-labelledby": "wb-import-title" },
      h("h2", { id: "wb-import-title" }, "Import a backup"),
      h("p", null, "Adds the backup's objects beside what is already here. Nothing on this whiteboard is replaced."),
      h("label", { class: "wb-field" }, h("span", null, "Backup file"), file),
      text,
      preview,
      h("label", { class: "wb-check" }, structureBox, h("span", null, "Also use the backup's title and background")),
      h("div", { class: "modal-actions" },
        h("button", { type: "button", class: "btn outline", onclick: () => close(null) }, "Cancel"),
        importBtn,
      ),
    );
  }, null, returnFocus);
}

/**
 * "Paste text": a place to paste (or type) lines that become sticky notes, for when the menu
 * cannot read the clipboard itself.
 * @param {(text: string) => void} onAdd
 * @param {HTMLElement|null} [returnFocus]
 */
export function pasteTextDialog(onAdd, returnFocus = null) {
  return modal((close) => {
    const area = /** @type {HTMLTextAreaElement} */ (h("textarea", {
      class: "wb-paste-text", rows: "8", "data-autofocus": true, "aria-label": "Text, one sticky note per line",
      placeholder: "Paste or type here. Each line becomes a sticky note.",
    }));
    const go = h("button", { type: "button", class: "btn primary", onclick: () => { const v = area.value; close(null); if (v.trim()) onAdd(v); } }, "Add sticky notes");
    area.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go.click(); }
    });
    return h("div", { class: "modal wb-paste", "aria-labelledby": "wb-paste-title" },
      h("h2", { id: "wb-paste-title" }, "Paste text as sticky notes"),
      h("p", null, `One sticky note per line (at most ${BACKUP_LIMITS.textStickies}). A table copied from a spreadsheet keeps its rows and columns.`),
      area,
      h("div", { class: "modal-actions" },
        h("button", { type: "button", class: "btn outline", onclick: () => close(null) }, "Cancel"),
        go,
      ),
    );
  }, null, returnFocus);
}
