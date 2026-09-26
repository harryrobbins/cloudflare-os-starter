// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { plainText, renderMarkdown } from "../../src/client/ui/markdown.js";

const ALLOWED = new Set(["P", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "BLOCKQUOTE", "PRE", "CODE", "STRONG", "EM", "DEL", "A", "HR", "SPAN", "DIV"]);
function render(md) {
  const div = document.createElement("div");
  div.append(renderMarkdown(document, md));
  return div;
}
const tags = (el) => [...el.querySelectorAll("*")].map((e) => e.tagName);

describe("renderMarkdown", () => {
  it("paragraphs join lines and split on blank lines", () => {
    const d = render("one\ntwo\n\nthree");
    expect([...d.querySelectorAll("p")].map((p) => p.textContent)).toEqual(["one two", "three"]);
  });
  it.each([["# A", "H3"], ["## A", "H4"], ["### A", "H5"], ["#### A", "H6"], ["###### A", "H6"]])("%s → %s", (md, tag) => {
    expect(render(md).firstElementChild?.tagName).toBe(tag);
  });
  it("lists, ordered lists and task boxes", () => {
    const d = render("- a\n- b\n\n1. one\n2) two\n\n- [ ] todo\n- [x] done");
    expect(d.querySelectorAll("ul")).toHaveLength(2);
    expect([...d.querySelectorAll("ol li")].map((l) => l.textContent)).toEqual(["one", "two"]);
    const tasks = d.querySelectorAll(".md-task");
    expect(tasks).toHaveLength(2);
    expect(tasks[0].getAttribute("aria-label")).toBe("Not done:");
    expect(tasks[1].classList.contains("done")).toBe(true);
  });
  it("switching list type starts a new list", () => {
    expect(tags(render("- a\n1. b")).filter((t) => t === "UL" || t === "OL")).toEqual(["UL", "OL"]);
  });
  it("code fences keep text verbatim", () => {
    const d = render("```js\nconst a = '<b>';\n```\nafter");
    expect(d.querySelector("pre code")?.textContent).toBe("const a = '<b>';");
    expect(d.querySelector("b")).toBeNull();
    expect(d.querySelector("p")?.textContent).toBe("after");
  });
  it("unterminated fence runs to the end", () => {
    expect(render("~~~\nx\ny").querySelector("code")?.textContent).toBe("x\ny");
  });
  it("block quotes and rules", () => {
    const d = render("> quoted **bold**\n> more\n\n---");
    expect(d.querySelector("blockquote strong")?.textContent).toBe("bold");
    expect(d.querySelector("hr")).not.toBeNull();
  });
  it("inline formatting", () => {
    const d = render("a `code` **b** __c__ *i* _j_ ~~s~~");
    expect(d.querySelector("code")?.textContent).toBe("code");
    expect([...d.querySelectorAll("strong")].map((e) => e.textContent)).toEqual(["b", "c"]);
    expect([...d.querySelectorAll("em")].map((e) => e.textContent)).toEqual(["i", "j"]);
    expect(d.querySelector("del")?.textContent).toBe("s");
  });
  it("links: http, https and mailto only, opened safely", () => {
    const d = render("[site](https://example.com) [mail](mailto:a@b.c) [bad](javascript:alert(1)) see http://x.org/path.");
    const links = [...d.querySelectorAll("a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["https://example.com", "mailto:a@b.c", "http://x.org/path"]);
    for (const a of links) { expect(a.target).toBe("_blank"); expect(a.rel).toBe("noopener noreferrer"); }
    expect(d.textContent).toContain("bad");
  });
  it.each([
    "<script>alert(1)</script>",
    '<img src=x onerror="alert(1)">',
    "[x](javascript:alert(1))",
    '<a href="javascript:alert(1)">x</a>',
    "**<iframe src=//evil>**",
    "<svg onload=alert(1)>",
    "```\n</code><script>x</script>\n```",
    "- <style>body{}</style>",
  ])("never creates markup from %j", (md) => {
    const d = render(md);
    for (const t of tags(d)) expect(ALLOWED.has(t)).toBe(true);
    for (const a of d.querySelectorAll("a")) expect(a.getAttribute("href")).toMatch(/^(https?:|mailto:)/);
    for (const e of d.querySelectorAll("*")) for (const attr of e.attributes) expect(attr.name.startsWith("on")).toBe(false);
  });
  it("empty and nullish input", () => {
    expect(render("").childNodes).toHaveLength(0);
    expect(render(/** @type {any} */ (null)).childNodes).toHaveLength(0);
  });
  it("CRLF line endings", () => {
    expect([...render("a\r\n\r\nb").querySelectorAll("p")]).toHaveLength(2);
  });
});

describe("plainText", () => {
  it("strips markup for snippets and names", () => {
    expect(plainText("# Title\n\n**bold** and `code` [link](https://x.y)\n```\nhidden\n```")).toBe("Title bold and code link");
    expect(plainText(/** @type {any} */ (undefined))).toBe("");
  });
});
