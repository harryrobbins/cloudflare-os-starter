import { describe, expect, it } from "vitest";

import { isTypingTarget, listKeyAction } from "./keys.js";

describe("listKeyAction", () => {
  it("moves down and clamps at the end", () => {
    expect(listKeyAction("ArrowDown", 0, 3, false)).toEqual({ type: "select", index: 1 });
    expect(listKeyAction("ArrowDown", 2, 3, false)).toEqual({ type: "select", index: 2 });
  });

  it("moves up, and leaves for the box from the first row", () => {
    expect(listKeyAction("ArrowUp", 2, 3, false)).toEqual({ type: "select", index: 1 });
    expect(listKeyAction("ArrowUp", 0, 3, false)).toEqual({ type: "focusInput" });
  });

  it("jumps with Home and End", () => {
    expect(listKeyAction("Home", 2, 5, false)).toEqual({ type: "select", index: 0 });
    expect(listKeyAction("End", 0, 5, false)).toEqual({ type: "select", index: 4 });
  });

  it("opens with Enter and previews with Space or ArrowRight", () => {
    expect(listKeyAction("Enter", 1, 3, false)).toEqual({ type: "open", index: 1 });
    expect(listKeyAction(" ", 1, 3, false)).toEqual({ type: "preview", index: 1 });
    expect(listKeyAction("ArrowRight", 1, 3, false)).toEqual({ type: "preview", index: 1 });
  });

  it("closes the preview with ArrowLeft or Escape, then Escape returns to the box", () => {
    expect(listKeyAction("ArrowLeft", 1, 3, true)).toEqual({ type: "closePreview" });
    expect(listKeyAction("ArrowLeft", 1, 3, false)).toEqual({ type: "none" });
    expect(listKeyAction("Escape", 1, 3, true)).toEqual({ type: "closePreview" });
    expect(listKeyAction("Escape", 1, 3, false)).toEqual({ type: "focusInput" });
  });

  it("does nothing useful on an empty list except leaving it", () => {
    expect(listKeyAction("ArrowDown", -1, 0, false)).toEqual({ type: "none" });
    expect(listKeyAction("Escape", -1, 0, false)).toEqual({ type: "focusInput" });
  });

  it("treats an unselected list as the first row", () => {
    expect(listKeyAction("Enter", -1, 3, false)).toEqual({ type: "open", index: 0 });
  });
});

describe("isTypingTarget", () => {
  it("recognises text fields but not buttons or checkboxes", () => {
    const text = document.createElement("input");
    const box = document.createElement("input");
    box.type = "checkbox";
    expect(isTypingTarget(text)).toBe(true);
    expect(isTypingTarget(document.createElement("textarea"))).toBe(true);
    expect(isTypingTarget(box)).toBe(false);
    expect(isTypingTarget(document.createElement("button"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
