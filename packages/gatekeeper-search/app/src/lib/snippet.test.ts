import { describe, expect, it } from "vitest";

import { sanitizeSnippet } from "./snippet.js";

describe("sanitizeSnippet", () => {
  it("keeps <mark> as a flag and the rest as text", () => {
    expect(sanitizeSnippet("the <mark>atlas</mark> deck")).toEqual([
      { text: "the ", mark: false },
      { text: "atlas", mark: true },
      { text: " deck", mark: false },
    ]);
  });

  it("decodes escaped text once, so it renders literally", () => {
    expect(sanitizeSnippet("a &lt;script&gt;x&lt;/script&gt; &amp; b")).toEqual([
      { text: "a <script>x</script> & b", mark: false },
    ]);
  });

  it("drops script and style elements with their content", () => {
    const segments = sanitizeSnippet(`ok<script>alert(1)</script><style>body{}</style> fine`);
    expect(segments).toEqual([{ text: "ok fine", mark: false }]);
  });

  it("strips every attribute and every other element, keeping their text", () => {
    const segments = sanitizeSnippet(
      `<mark onclick="steal()" class="x">hit</mark> <a href="javascript:alert(1)">link</a> <img src=x onerror=alert(1)><b>bold</b>`,
    );
    expect(segments).toEqual([
      { text: "hit", mark: true },
      { text: " link bold", mark: false },
    ]);
    // Only text survives, so nothing that could carry an attribute exists in the output at all.
    expect(JSON.stringify(segments)).not.toMatch(/onclick|onerror|javascript|href|src/u);
  });

  it("flattens nested marks and text inside other elements within a mark", () => {
    expect(sanitizeSnippet("<mark>a<b>b</b><mark>c</mark></mark>d")).toEqual([
      { text: "abc", mark: true },
      { text: "d", mark: false },
    ]);
  });

  it("handles empty and unbalanced input", () => {
    expect(sanitizeSnippet("")).toEqual([]);
    expect(sanitizeSnippet("<mark>open")).toEqual([{ text: "open", mark: true }]);
    expect(sanitizeSnippet("<!-- c -->x")).toEqual([{ text: "x", mark: false }]);
  });
});
