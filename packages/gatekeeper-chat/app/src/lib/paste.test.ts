import { describe, expect, it } from "vitest";

import { isSingleUrl, looksLikeCode, transformPaste } from "./paste.js";

describe("isSingleUrl", () => {
  it("accepts one http(s) URL", () => {
    expect(isSingleUrl("https://example.test/a?b=1#c")).toBe(true);
    expect(isSingleUrl("  http://example.test  ")).toBe(true);
  });

  it("rejects anything with a second token, and anything that is not a URL", () => {
    expect(isSingleUrl("https://example.test and more")).toBe(false);
    expect(isSingleUrl("example.test")).toBe(false);
    expect(isSingleUrl("javascript:alert(1)")).toBe(false);
    expect(isSingleUrl("")).toBe(false);
  });
});

describe("looksLikeCode", () => {
  it("recognises an indented function", () => {
    expect(looksLikeCode("function add(a, b) {\n  return a + b;\n}")).toBe(true);
  });

  it("recognises Python", () => {
    expect(looksLikeCode("def add(a, b):\n    return a + b")).toBe(true);
  });

  it("recognises JSON and markup", () => {
    expect(looksLikeCode('{\n  "a": 1,\n  "b": 2\n}')).toBe(true);
    expect(looksLikeCode('<div class="x">\n  <span>hi</span>\n</div>')).toBe(true);
  });

  it("recognises a shell transcript on its own", () => {
    expect(looksLikeCode("$ pnpm install\n$ pnpm build")).toBe(true);
  });

  it("leaves prose alone", () => {
    expect(looksLikeCode("Hi there.\nI wanted to ask about the release.")).toBe(false);
    expect(looksLikeCode("One line only")).toBe(false);
    expect(looksLikeCode("A list:\n- one\n- two")).toBe(false);
  });

  it("leaves a log alone", () => {
    expect(looksLikeCode("12:00 INFO started\n12:01 INFO stopped")).toBe(false);
  });

  it("does not fence something already fenced", () => {
    expect(looksLikeCode("```\nconst a = 1;\nconst b = 2;\n```")).toBe(false);
  });
});

describe("transformPaste", () => {
  it("links a selected phrase", () => {
    expect(
      transformPaste({
        value: "see the notes for details",
        selectionStart: 8,
        selectionEnd: 13,
        pasted: "https://example.test/n",
      }),
    ).toEqual({
      kind: "link",
      value: "see the [notes](https://example.test/n) for details",
      selectionStart: 39,
      selectionEnd: 39,
    });
  });

  it("leaves a URL pasted into empty space alone", () => {
    expect(
      transformPaste({ value: "", selectionStart: 0, selectionEnd: 0, pasted: "https://example.test" }),
    ).toBeNull();
  });

  it("fences pasted code and leaves the caret after it", () => {
    const result = transformPaste({
      value: "",
      selectionStart: 0,
      selectionEnd: 0,
      pasted: "function add(a, b) {\n  return a + b;\n}",
    });
    expect(result?.kind).toBe("code");
    expect(result?.value).toBe("```\nfunction add(a, b) {\n  return a + b;\n}\n```\n");
    expect(result?.selectionStart).toBe(result?.value.length);
  });

  it("opens a line before the fence when there is text in front of it", () => {
    const result = transformPaste({
      value: "here:",
      selectionStart: 5,
      selectionEnd: 5,
      pasted: "$ pnpm build\n$ pnpm test",
    });
    expect(result?.value).toBe("here:\n```\n$ pnpm build\n$ pnpm test\n```\n");
  });

  it("returns null for an ordinary paste", () => {
    expect(
      transformPaste({ value: "hi ", selectionStart: 3, selectionEnd: 3, pasted: "there" }),
    ).toBeNull();
  });
});
