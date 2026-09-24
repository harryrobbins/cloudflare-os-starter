// Icons in the client: duplication, text editing only where an icon holds text, object-list
// labels, and the picker's pure logic (grid keyboard navigation, recent icons, results, shortcut).
import { describe, expect, it } from "vitest";
import { normalizeNewObject } from "../../src/shared/protocol.js";
import { getIcon, iconDefaults } from "../../src/shared/icons/registry.js";
import { buildDuplicates, canEditText, hitObject } from "../../src/client/ui/canvas/model.js";
import { editorBox } from "../../src/client/ui/canvas/text-editor.js";
import { keyAction, SHORTCUTS_HINT, TOOL_KEYS } from "../../src/client/ui/canvas/keymap.js";
import { describeObject } from "../../src/client/ui/outline.js";
import { typeLabel } from "../../src/client/ui/stylebar.js";
import {
  RECENT_MAX, gridMove, iconName, isPickerShortcut, pickerResults, pushRecent,
} from "../../src/client/ui/icon-picker.js";

let seq = 0;
function iconObject(packId, iconId, fields = {}) {
  const d = iconDefaults(/** @type {any} */ (getIcon(packId, iconId)));
  return {
    ...normalizeNewObject({ id: "o_" + (++seq).toString(16).padStart(12, "0"), type: "icon", packId, iconId, w: d.w, h: d.h, style: d.style, ...fields }),
    z: "a0", version: 1, createdAt: 0, updatedAt: 0, createdBy: "t",
  };
}

describe("canvas model", () => {
  it("duplicates icons with their pack and icon ids", () => {
    const o = iconObject("core.1", "decision", { text: "Go?", rot: 15 });
    let n = 0;
    const { creates } = buildDuplicates({ [o.id]: o }, [o.id], () => "o_ffffffffff0" + n++);
    expect(creates[0]).toMatchObject({ type: "icon", packId: "core.1", iconId: "decision", text: "Go?", rot: 15, x: 20, y: 20 });
  });

  it("edits text only for icons that hold it", () => {
    const stencil = iconObject("core.1", "decision");
    const glyph = iconObject("tabler.1", "user");
    expect(canEditText(stencil)).toBe(true);
    expect(canEditText(glyph)).toBe(false);
    expect(editorBox(stencil, () => undefined)).toMatchObject({ centerVertically: true, singleLine: false });
    expect(editorBox(glyph, () => undefined)).toBeNull();
  });

  it("hits an icon anywhere in its box", () => {
    const o = iconObject("tabler.1", "user", { x: 0, y: 0 });
    expect(hitObject(o, { x: 2, y: 94 }, 1, () => undefined)).toBe(true);
  });

  it("labels icons in the objects list by their icon", () => {
    expect(typeLabel("icon")).toBe("Icon");
    expect(describeObject(iconObject("tabler.1", "database"), {})).toBe("Database");
    expect(describeObject(iconObject("core.1", "decision", { text: "Ship  it?" }), {})).toBe("Decision: Ship it?");
    expect(describeObject({ ...iconObject("tabler.1", "user"), iconId: "gone" }, {})).toBe("unknown icon");
  });
});

describe("icon picker logic", () => {
  it("moves through a grid with arrow keys, Home/End and Page keys", () => {
    // 10 cells, 4 columns: rows [0-3] [4-7] [8-9]
    expect(gridMove(0, "ArrowRight", 10, 4)).toBe(1);
    expect(gridMove(0, "ArrowLeft", 10, 4)).toBe(0);
    expect(gridMove(1, "ArrowDown", 10, 4)).toBe(5);
    expect(gridMove(6, "ArrowDown", 10, 4)).toBe(6); // no cell below: stay
    expect(gridMove(5, "ArrowUp", 10, 4)).toBe(1);
    expect(gridMove(5, "Home", 10, 4)).toBe(0);
    expect(gridMove(5, "End", 10, 4)).toBe(9);
    expect(gridMove(0, "PageDown", 10, 4)).toBe(9);
    expect(gridMove(9, "PageUp", 10, 4)).toBe(0);
    expect(gridMove(3, "a", 10, 4)).toBeNull();
    expect(gridMove(0, "ArrowRight", 0, 4)).toBeNull();
  });

  it("keeps recent icons most recent first, unique and bounded", () => {
    let list = /** @type {string[]} */ ([]);
    for (let i = 0; i < RECENT_MAX + 5; i++) list = pushRecent(list, `tabler.1/i${i}`);
    expect(list).toHaveLength(RECENT_MAX);
    expect(list[0]).toBe(`tabler.1/i${RECENT_MAX + 4}`);
    list = pushRecent(list, list[3]);
    expect(new Set(list).size).toBe(list.length);
    expect(list[0]).toBe(`tabler.1/i${RECENT_MAX + 1}`);
  });

  it("lists results for a search, a category or the recent icons", () => {
    expect(pickerResults("", "all", []).length).toBeGreaterThan(200);
    const flow = pickerResults("", "core.1:flowchart", []);
    expect(flow.every((e) => e.packId === "core.1" && e.category === "flowchart")).toBe(true);
    const recent = ["tabler.1/user", "core.1/decision", "tabler.1/gone"];
    expect(pickerResults("", "recent", recent).map((e) => e.id)).toEqual(["user", "decision"]);
    expect(pickerResults("diamond", "recent", recent).map((e) => e.id)).toEqual(["decision"]);
    expect(pickerResults("database", "all", [])[0].id).toBe("database");
  });

  it("gives every result an accessible name that says what it adds", () => {
    expect(iconName(/** @type {any} */ (getIcon("core.1", "decision")))).toBe("Decision shape");
    expect(iconName(/** @type {any} */ (getIcon("tabler.1", "user")))).toBe("User icon");
  });

  it("opens on a plain I, which no canvas shortcut uses", () => {
    expect(isPickerShortcut({ key: "i" })).toBe(true);
    expect(isPickerShortcut({ key: "I" })).toBe(true);
    for (const mod of ["ctrlKey", "metaKey", "altKey", "shiftKey"]) expect(isPickerShortcut({ key: "i", [mod]: true })).toBe(false);
    expect(Object.keys(TOOL_KEYS)).not.toContain("i");
    expect(keyAction({ key: "i" })).toBeNull();
    expect(SHORTCUTS_HINT).toContain("I opens icons and shapes");
  });
});
