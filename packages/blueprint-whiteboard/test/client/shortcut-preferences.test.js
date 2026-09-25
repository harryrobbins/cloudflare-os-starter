import { afterEach, describe, expect, it } from "vitest";
import { keyAction } from "../../src/client/ui/canvas/keymap.js";
import { helpRows } from "../../src/client/ui/help.js";
import { setCharacterShortcutsEnabled } from "../../src/client/ui/shortcut-preferences.js";
afterEach(() => setCharacterShortcutsEnabled(true));
describe("character shortcut preference", () => {
  it("disables letters and shifted punctuation, retains navigation and modifier commands", () => {
    setCharacterShortcutsEnabled(false);
    for (const event of [{ key: "n" }, { key: "a" }, { key: "?", shiftKey: true }, { key: "C", shiftKey: true }, { key: "." }]) expect(keyAction(event)).toBeNull();
    expect(keyAction({ key: "z", ctrlKey: true })).toEqual({ type: "undo" });
    expect(keyAction({ key: "z", metaKey: true })).toEqual({ type: "undo" });
    expect(keyAction({ key: "Enter" })).toEqual({ type: "edit" });
    expect(keyAction({ key: "Escape" })).toEqual({ type: "escape" });
    expect(keyAction({ key: "ArrowRight" })).toEqual({ type: "nudge", dx: 1, dy: 0 });
    expect(keyAction({ key: " " }, "presentation")).toEqual({ type: "present", step: "next" });
    setCharacterShortcutsEnabled(true);
    expect(keyAction({ key: "n" })).toEqual({ type: "tool", tool: "sticky" });
  });
});
describe("help search", () => {
  it("matches actions and platform shortcuts and removes empty groups", () => {
    expect(helpRows(false, "CODE").flatMap((g) => g.rows).some((r) => /code/i.test(r.label))).toBe(true);
    expect(helpRows(false, "ctrl+z").flatMap((g) => g.rows).some((r) => r.label === "Undo")).toBe(true);
    expect(helpRows(true, "⌘z").flatMap((g) => g.rows).some((r) => r.label === "Undo")).toBe(true);
    expect(helpRows(false, "zznonexistentcommand")).toEqual([]);
    expect(helpRows(false, "  ")).toEqual(helpRows(false));
  });
});
