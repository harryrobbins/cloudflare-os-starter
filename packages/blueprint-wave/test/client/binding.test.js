// Editor binding and caret maths without a DOM: diffStrings cases, a fake textarea driven through
// bindTextarea (input diffing, remote updates with selection restore, composition, undo/redo via
// the UndoManager and the capture-phase keys, selection callbacks), and resolveCarets.
import * as Y from "yjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindTextarea, diffStrings, relativeAt } from "../../src/client/editor/binding.js";
import { CARET_TAG_MS, createCaretActivity, indexOf, resolveCarets } from "../../src/client/editor/carets.js";
import { encodeBytes } from "../../src/shared/protocol.js";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

/** A minimal textarea: value, selection, listeners. */
function fakeTextarea() {
  const listeners = new Map();
  return {
    value: "",
    selectionStart: 0,
    selectionEnd: 0,
    selectionDirection: "forward",
    addEventListener(type, fn) { listeners.set(type + "|" + fn.name, fn); (this._byType ??= {})[type] = [...(this._byType[type] ?? []), fn]; },
    removeEventListener(type, fn) { const l = this._byType?.[type]; if (l) this._byType[type] = l.filter((f) => f !== fn); },
    setSelectionRange(s, e) { this.selectionStart = s; this.selectionEnd = e; },
    fire(type, event = {}) { for (const fn of this._byType?.[type] ?? []) fn({ preventDefault() {}, stopPropagation() {}, ...event }); },
    /** Types as a person would: sets value and caret, then fires input. */
    type(value, caret = value.length) { this.value = value; this.selectionStart = this.selectionEnd = caret; this.fire("input"); },
  };
}

function handleFor(initial = "") {
  const doc = new Y.Doc();
  const text = doc.getText("t");
  if (initial) text.insert(0, initial);
  return { doc, text, blipId: "b_000000000001", whenSaved: () => Promise.resolve(), close() {} };
}

describe("diffStrings", () => {
  const cases = [
    ["insert at end", "hello", "hello world", { index: 5, removed: 0, inserted: " world" }],
    ["insert in middle", "held", "hello world", { index: 3, removed: 0, inserted: "lo worl" }],
    ["delete", "hello world", "helloworld", { index: 5, removed: 1, inserted: "" }],
    ["replace", "hello world", "hello there", { index: 6, removed: 5, inserted: "there" }],
    ["both sides changed", "abcdef", "xbcdey", { index: 0, removed: 6, inserted: "xbcdey" }],
    ["repeated chars: suffix never eats the prefix", "aaa", "aaaa", { index: 3, removed: 0, inserted: "a" }],
    ["repeated chars delete", "aaaa", "aaa", { index: 3, removed: 1, inserted: "" }],
    ["paste-like bulk replace", "one two three", "1 2 3", { index: 0, removed: 13, inserted: "1 2 3" }],
    ["clear", "abc", "", { index: 0, removed: 3, inserted: "" }],
    ["unchanged", "same", "same", { index: 0, removed: 0, inserted: "" }],
  ];
  for (const [name, prev, next, expected] of cases) {
    it(name, () => {
      const d = diffStrings(prev, next);
      expect(d).toEqual(expected);
      expect(prev.slice(0, d.index) + d.inserted + prev.slice(d.index + d.removed)).toBe(next);
    });
  }

  it("never splits a surrogate pair", () => {
    const prev = "a😀b";
    for (const next of ["a😁b", "a😀😀b", "ab", "😀b", "a😀"]) {
      const d = diffStrings(prev, next);
      expect(prev.slice(0, d.index) + d.inserted + prev.slice(d.index + d.removed)).toBe(next);
      const cut = (s, i) => s.charCodeAt(i - 1) >= 0xd800 && s.charCodeAt(i - 1) <= 0xdbff;
      expect(cut(prev, d.index)).toBe(false);
      expect(cut(prev, d.index + d.removed)).toBe(false);
    }
  });
});

describe("bindTextarea", () => {
  it("applies typed edits as one transaction with the local origin", async () => {
    const h = handleFor("hello");
    const ta = fakeTextarea();
    const origins = [];
    h.doc.on("afterTransaction", (txn) => origins.push(txn.origin));
    const b = bindTextarea(ta, h, { origin: "me", requestAnimationFrame: null });
    expect(ta.value).toBe("hello");
    ta.type("hello world");
    ta.type("hello there");
    ta.type("hi there");
    expect(h.text.toString()).toBe("hi there");
    expect(origins).toEqual(["me", "me", "me"]);
    b.destroy();
  });

  it("keeps the caret after the local person's text when a peer inserts exactly at the caret", () => {
    const h = handleFor("Start.");
    const ta = fakeTextarea();
    const b = bindTextarea(ta, h, { requestAnimationFrame: null });
    ta.type("Start. brav"); // caret at the end, after "brav"
    h.doc.transact(() => h.text.insert(11, " alpha0"), "remote");
    expect(ta.value).toBe("Start. brav alpha0");
    expect([ta.selectionStart, ta.selectionEnd]).toEqual([11, 11]);
    ta.type("Start. bravo0 alpha0", 13);
    expect(h.text.toString()).toBe("Start. bravo0 alpha0");
    // A range does not grow over text inserted at either edge.
    ta.setSelectionRange(7, 13); // "bravo0"
    h.doc.transact(() => { h.text.insert(13, "!"); h.text.insert(7, "["); }, "remote");
    expect(ta.value).toBe("Start. [bravo0! alpha0");
    expect([ta.selectionStart, ta.selectionEnd]).toEqual([8, 14]);
    b.destroy();
  });

  it("sets the value on remote updates and keeps the caret on the same text", async () => {
    const h = handleFor("hello world");
    const ta = fakeTextarea();
    const b = bindTextarea(ta, h, { requestAnimationFrame: null });
    ta.setSelectionRange(6, 6); // before "world"
    h.doc.transact(() => h.text.insert(0, "Oh, "), "remote");
    expect(ta.value).toBe("Oh, hello world");
    expect([ta.selectionStart, ta.selectionEnd]).toEqual([10, 10]);
    ta.setSelectionRange(4, 9); // "hello" selected
    h.doc.transact(() => h.text.delete(0, 4), "remote");
    expect(ta.value).toBe("hello world");
    expect([ta.selectionStart, ta.selectionEnd]).toEqual([0, 5]);
    b.destroy();
  });

  it("queues remote updates during composition and applies them on compositionend", () => {
    const h = handleFor("abc");
    const ta = fakeTextarea();
    const b = bindTextarea(ta, h, { requestAnimationFrame: null });
    ta.fire("compositionstart");
    ta.value = "abcか"; ta.fire("input"); // ignored while composing
    h.doc.transact(() => h.text.insert(0, "R"), "remote");
    expect(ta.value).toBe("abcか"); // untouched mid-composition
    expect(h.text.toString()).toBe("Rabc");
    ta.value = "abc漢"; ta.selectionStart = ta.selectionEnd = 4;
    ta.fire("compositionend");
    expect(h.text.toString()).toBe("Rabc漢");
    expect(ta.value).toBe("Rabc漢");
    b.destroy();
  });

  it("maps a composition onto remote edits before and after it, caret included", () => {
    const h = handleFor("hello world");
    const ta = fakeTextarea();
    const b = bindTextarea(ta, h, { requestAnimationFrame: null });
    ta.setSelectionRange(5, 5);
    ta.fire("compositionstart");
    ta.value = "hello漢 world"; ta.selectionStart = ta.selectionEnd = 6; ta.fire("input");
    h.doc.transact(() => { h.text.insert(11, "!"); h.text.insert(0, ">> "); }, "remote");
    h.doc.transact(() => h.text.delete(3, 1), "remote"); // "h" gone: ">> ello world!"
    expect(ta.value).toBe("hello漢 world");
    ta.value = "hello漢字 world"; ta.selectionStart = ta.selectionEnd = 7;
    ta.fire("compositionend");
    expect(h.text.toString()).toBe(">> ello漢字 world!");
    expect(ta.value).toBe(">> ello漢字 world!");
    expect([ta.selectionStart, ta.selectionEnd]).toEqual([9, 9]);
    // Later typing diffs against the reconciled value, not the pre-composition one.
    ta.type(">> ello漢字 world!?", 17);
    expect(h.text.toString()).toBe(">> ello漢字 world!?");
    b.destroy();
  });

  it("undoes and redoes local edits (not remote ones) through the UndoManager and the keys", async () => {
    const h = handleFor("");
    const ta = fakeTextarea();
    const b = bindTextarea(ta, h, { requestAnimationFrame: null });
    ta.type("one");
    // Beyond captureTimeout: a separate undo step. Real time, because lib0 binds Date.now at import
    // and fake timers cannot move the UndoManager's clock.
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 600));
    ta.type("one two");
    h.doc.transact(() => h.text.insert(0, "R:"), "remote");
    expect(ta.value).toBe("R:one two");
    expect(b.canUndo()).toBe(true);
    ta.fire("keydown", { key: "z", ctrlKey: true });
    expect(ta.value).toBe("R:one");
    expect(h.text.toString()).toBe("R:one");
    ta.fire("keydown", { key: "z", ctrlKey: true });
    expect(ta.value).toBe("R:");
    expect(b.canUndo()).toBe(false);
    expect(b.canRedo()).toBe(true);
    ta.fire("keydown", { key: "Z", ctrlKey: true, shiftKey: true });
    expect(ta.value).toBe("R:one");
    ta.fire("keydown", { key: "y", metaKey: true });
    expect(ta.value).toBe("R:one two");
    b.destroy();
  });

  it("reports the selection as relative positions, throttled, only when it changes", () => {
    const h = handleFor("hello");
    const ta = fakeTextarea();
    const seen = [];
    const b = bindTextarea(ta, h, { requestAnimationFrame: null, onSelectionChange: (a, hd) => seen.push([a, hd]) });
    vi.advanceTimersByTime(40);
    expect(seen).toHaveLength(1);
    ta.setSelectionRange(1, 3); ta.fire("select");
    ta.setSelectionRange(2, 4); ta.fire("keyup");
    ta.setSelectionRange(2, 4); ta.fire("mouseup");
    vi.advanceTimersByTime(40);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual([relativeAt(h.text, 2), relativeAt(h.text, 4)]);
    ta.fire("select");
    vi.advanceTimersByTime(40);
    expect(seen).toHaveLength(2); // unchanged: not reported again
    ta.selectionDirection = "backward"; ta.fire("select");
    vi.advanceTimersByTime(40);
    expect(seen[2]).toEqual([relativeAt(h.text, 4), relativeAt(h.text, 2)]);
    b.destroy();
  });
});

describe("carets", () => {
  it("resolves relative positions to indexes that follow the text, and skips malformed ones", () => {
    const { doc, text } = handleFor("hello world");
    const at = (i) => relativeAt(text, i);
    const peers = [
      { clientId: "p1", name: "Bo", color: "#ff0000", anchor: at(6), head: at(11) },
      { clientId: "p2", name: "Cy", color: "#00ff00", anchor: null, head: at(0) },
      { clientId: "p3", name: "Bad", color: "#0000ff", anchor: "!!!", head: "!!!" },
      { clientId: "p4", name: "Junk", color: "#0000ff", anchor: encodeBytes(new Uint8Array([9, 9, 9])), head: encodeBytes(new Uint8Array([9, 9, 9])) },
      { clientId: "p5", name: "Empty", color: "#0000ff", anchor: "", head: "" },
    ];
    expect(resolveCarets(peers, doc, text)).toEqual([
      { clientId: "p1", name: "Bo", color: "#ff0000", anchor: 6, head: 11 },
      { clientId: "p2", name: "Cy", color: "#00ff00", anchor: 0, head: 0 },
    ]);
    doc.transact(() => text.insert(0, "Oh, "), "remote");
    expect(resolveCarets(peers, doc, text)[0]).toMatchObject({ anchor: 10, head: 15 });
    const other = new Y.Doc();
    expect(indexOf(at(3), other, other.getText("t"))).toBeNull();
  });

  it("shows a peer's name tag only for a while after their caret moved (it covers the line above)", () => {
    const act = createCaretActivity();
    const p = (head, name = "Bo") => ({ clientId: "p1", name, head, anchor: head });
    act.touch([p("AAA="), { clientId: "p2", name: "Cy", head: "BBB=", anchor: null }], 1000);
    expect(act.tagVisible("p1", 1000)).toBe(true);
    expect(act.nextHide(1000)).toBe(CARET_TAG_MS);
    // The same encoded position again (someone else typed above it: the index moved, not the peer).
    act.touch([p("AAA="), { clientId: "p2", name: "Cy", head: "BBB=", anchor: null }], 1000 + CARET_TAG_MS - 1);
    expect(act.tagVisible("p1", 1000 + CARET_TAG_MS)).toBe(false);
    expect(act.nextHide(1000 + CARET_TAG_MS)).toBeNull();
    act.touch([p("CCC="), { clientId: "p2", name: "Cy", head: "BBB=", anchor: null }], 5000); // p1 moved
    expect(act.tagVisible("p1", 5001)).toBe(true);
    expect(act.tagVisible("p2", 5001)).toBe(false);
    act.touch([p("CCC=", "Bob")], 9000); // renamed; p2 left
    expect(act.tagVisible("p1", 9000)).toBe(true);
    expect(act.tagVisible("p2", 9000)).toBe(false);
    act.touch([{ clientId: "p2", name: "Cy", head: "BBB=", anchor: null }], 9500); // p2 back: shown again
    expect(act.tagVisible("p2", 9500)).toBe(true);
  });
});
