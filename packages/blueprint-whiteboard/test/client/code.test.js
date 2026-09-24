// Code blocks in the client: editor helpers (indent unit, Tab/Shift+Tab, Enter keeping the
// indent), the editor box and commit patch, the K shortcut, fenced paste, labels and duplicates.
import { describe, expect, it } from "vitest";
import { normalizeNewObject } from "../../src/shared/protocol.js";
import { indentEdit, indentUnitOf, newlineEdit } from "../../src/client/ui/canvas/code-editing.js";
import { editorBox, textPatch } from "../../src/client/ui/canvas/text-editor.js";
import { keyAction, helpGroups } from "../../src/client/ui/canvas/keymap.js";
import { readPaste, clipboardPayload } from "../../src/client/ui/clipboard.js";
import { describeObject, outlineRows } from "../../src/client/ui/outline.js";
import { buildDuplicates, canEditText } from "../../src/client/ui/canvas/model.js";
import { codePatch } from "../../src/client/ui/code-block.js";
import { codeHeight, codeMetrics } from "../../src/shared/code/layout.js";
import { CODE_THEMES } from "../../src/shared/code/theme.js";

const block = (fields = {}) => ({
  ...normalizeNewObject({ id: "o_0000000c0de1", type: "code", ...fields }), z: "a0", version: 1, createdAt: 0, updatedAt: 0, createdBy: "t",
});
/** Applies an Edit to a string. */
const run = (value, e) => value.slice(0, e.from) + e.insert + value.slice(e.to);

describe("code editing helpers", () => {
  it("detects the indent unit from the code, else the language", () => {
    expect(indentUnitOf("a\n\tb\n\tc", "python")).toBe("\t");
    expect(indentUnitOf("a\n    b\n        c", "javascript")).toBe("    ");
    expect(indentUnitOf("a\n  b", "python")).toBe("  ");
    expect(indentUnitOf("", "python")).toBe("    ");
    expect(indentUnitOf("", "go")).toBe("\t");
    expect(indentUnitOf("x", "javascript")).toBe("  ");
  });

  it("Tab inserts the unit at a caret and indents every selected line; Shift+Tab outdents", () => {
    const e1 = /** @type {any} */ (indentEdit("ab", 1, 1, "  ", false));
    expect(run("ab", e1)).toBe("a  b");
    expect([e1.selStart, e1.selEnd]).toEqual([3, 3]);
    const text = "one\ntwo\n\nthree";
    const e2 = /** @type {any} */ (indentEdit(text, 1, text.length - 1, "  ", false));
    expect(run(text, e2)).toBe("  one\n  two\n\n  three");
    const e3 = /** @type {any} */ (indentEdit(run(text, e2), 0, 20, "  ", true));
    expect(run(run(text, e2), e3)).toBe(text);
    expect(indentEdit("x", 0, 0, "  ", true)).toBe(null); // nothing to outdent
    const e4 = /** @type {any} */ (indentEdit("\tx\n    y", 0, 8, "\t", true));
    expect(run("\tx\n    y", e4)).toBe("x\ny");
    // A selection ending at the start of a line leaves that line alone.
    const e5 = /** @type {any} */ (indentEdit("a\nb", 0, 2, "  ", false));
    expect(run("a\nb", e5)).toBe("  a\nb");
  });

  it("Enter keeps the current line's indentation", () => {
    const value = "if x:\n    y = 1";
    const e = newlineEdit(value, value.length, value.length);
    expect(run(value, e)).toBe(value + "\n    ");
    expect(e.selStart).toBe(value.length + 5);
    expect(run("\tab", newlineEdit("\tab", 2, 2))).toBe("\ta\n\tb");
  });
});

describe("code editor box and commit", () => {
  it("covers the body below the header in the block's theme, past the gutter", () => {
    const o = block({ theme: "dark", text: "a\nb" });
    const box = /** @type {any} */ (editorBox(o, () => undefined));
    const m = codeMetrics(o);
    expect(box).toMatchObject({ x: o.x, y: m.bodyY, w: o.w, rot: 0, singleLine: false, maxLength: 20000 });
    expect(box.code).toMatchObject({ background: CODE_THEMES.dark.background, padLeft: m.pad + m.gutterW, wrap: false, language: "plain" });
    expect(box.color).toBe(CODE_THEMES.dark.tokens[""]);
    expect(canEditText(o)).toBe(true);
  });

  it("commits the code verbatim and refits the height", () => {
    const o = block({ text: "" });
    const patch = /** @type {any} */ (textPatch(o, "a\r\n\tb\n\nc"));
    expect(patch.text).toBe("a\n\tb\n\nc");
    expect(patch.h).toBe(codeHeight({ ...o, text: patch.text }));
    expect(textPatch({ ...o, text: "x", h: codeHeight({ ...o, text: "x" }) }, "x")).toBe(null);
  });

  it("style changes refit the height too", () => {
    const o = block({ text: "a\nb\nc", h: 100 });
    expect(codePatch(o, { style: { fontSize: 24 } }).h).toBe(codeHeight({ ...o, style: { ...o.style, fontSize: 24 } }));
    expect(codePatch({ ...o, h: codeHeight(o) }, { theme: "dark" })).toEqual({ theme: "dark" });
  });
});

describe("shortcut, paste, labels, duplicates", () => {
  it("K adds a code block (a shell command) and the help lists it", () => {
    expect(keyAction({ key: "k" })).toEqual({ type: "command", command: "code" });
    expect(keyAction({ key: "K", shiftKey: true })).toBe(null);
    const tools = helpGroups().find((g) => g.group === "Tools");
    expect(tools?.commands.some((c) => c.id === "code" && c.keys[0] === "K")).toBe(true);
  });

  it("a fenced block pasted onto the board becomes one code block; other text stays sticky notes", () => {
    const r = /** @type {any} */ (readPaste({ text: "```rust\nfn main() {}\n```" }, null));
    expect(r.kind).toBe("code");
    expect(r.entries[0].object).toMatchObject({ type: "code", language: "rust", text: "fn main() {}" });
    expect(readPaste({ text: "line one\nline two" }, null).kind).toBe("text");
  });

  it("copying a code block round-trips its fields; the plain text is the code", () => {
    const o = block({ text: "x = 1", language: "python", theme: "dark", filename: "a.py" });
    const payload = /** @type {any} */ (clipboardPayload({ [o.id]: o }, [o.id]));
    expect(payload.text).toBe("x = 1");
    const back = /** @type {any} */ (readPaste({ json: payload.json }, null));
    expect(back.entries[0].object).toMatchObject({ type: "code", language: "python", theme: "dark", filename: "a.py", text: "x = 1" });
  });

  it("the Objects list names code blocks by language and first line, and filters by it", () => {
    const o = block({ text: "\n  def main():\n    pass", language: "python", filename: "m.py" });
    expect(describeObject(o, {})).toBe("Python — def main(): (m.py)");
    expect(outlineRows({ [o.id]: o }, "python").rows).toHaveLength(1);
    expect(outlineRows({ [o.id]: o }, "code block").rows).toHaveLength(1);
  });

  it("duplicates keep the code fields", () => {
    const o = block({ text: "a", language: "go", theme: "dark", wrap: true, lineNumbers: false, filename: "x.go" });
    let n = 0;
    const { creates } = buildDuplicates({ [o.id]: o }, [o.id], () => "o_00000000000" + ++n);
    expect(creates[0]).toMatchObject({ type: "code", language: "go", theme: "dark", wrap: true, lineNumbers: false, filename: "x.go", text: "a" });
  });
});
