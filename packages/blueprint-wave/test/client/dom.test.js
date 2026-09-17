// isTextField (src/client/ui/dom.js) decides whether Escape and undo belong to a focused field or
// to the app; the window.name carry codec keeps unsaved edits across a reload. Fake targets: no DOM
// in this environment.
import { describe, expect, it } from "vitest";
import { CARRY_PREFIX, CARRY_UPDATE_MAX_CHARS, decodeCarry, encodeCarry, isTextField } from "../../src/client/ui/dom.js";

/** A target whose closest() finds `field` (or nothing). */
const target = (/** @type {any} */ field) => ({ closest: () => field });

describe("isTextField", () => {
  it("is true in text inputs, textareas, selects and contenteditable", () => {
    expect(isTextField(/** @type {any} */ (target({ tagName: "INPUT", type: "text" })))).toBe(true);
    expect(isTextField(/** @type {any} */ (target({ tagName: "INPUT", type: "" })))).toBe(true);
    expect(isTextField(/** @type {any} */ (target({ tagName: "TEXTAREA" })))).toBe(true);
    expect(isTextField(/** @type {any} */ (target({ tagName: "DIV" })))).toBe(true);
  });

  it("is false on a range slider (the History scrubber: Escape returns to live), checkboxes and outside fields", () => {
    expect(isTextField(/** @type {any} */ (target({ tagName: "INPUT", type: "range" })))).toBe(false);
    expect(isTextField(/** @type {any} */ (target({ tagName: "INPUT", type: "checkbox" })))).toBe(false);
    expect(isTextField(/** @type {any} */ (target(null)))).toBe(false);
    expect(isTextField(null)).toBe(false);
  });
});

describe("window.name carry: unsaved edits", () => {
  it("round-trips the blip, its text and the unacknowledged Yjs update", () => {
    const pending = { blipId: "b_0123456789ab", text: "Hello unsent", update: "AAECAwQ=" };
    expect(decodeCarry(encodeCarry({ pending })).pending).toEqual(pending);
  });

  it("drops a malformed or oversized update but keeps the text (shown to copy, never appended)", () => {
    const base = { blipId: "b_0123456789ab", text: "Hello" };
    expect(decodeCarry(encodeCarry({ pending: { ...base, update: "not base64!" } })).pending).toEqual({ ...base, update: null });
    const huge = "A".repeat(CARRY_UPDATE_MAX_CHARS + 4);
    expect(decodeCarry(encodeCarry({ pending: { ...base, update: huge } })).pending).toEqual({ ...base, update: null });
    // A carry written by an older client (text only) still decodes.
    const old = CARRY_PREFIX + JSON.stringify({ pending: base });
    expect(decodeCarry(old).pending).toEqual({ ...base, update: null });
  });
});
