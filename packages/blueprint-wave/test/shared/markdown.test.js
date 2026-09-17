import { describe, expect, it } from "vitest";
import { MAX_BLOCK_DEPTH, citedBlipIds, firstLine, inlineText, paragraphsOf, parseMarkdown, plainText } from "../../src/shared/markdown.js";

const bid = (n) => "b_" + n.toString(16).padStart(12, "0");
const text = (t) => ({ type: "text", text: t });
/** Strips offsets so trees can be compared structurally. */
const shape = (blocks) => JSON.parse(JSON.stringify(blocks, (k, v) => (k === "start" || k === "end" ? undefined : v)));
const p = (...children) => ({ type: "paragraph", children });

describe("blocks", () => {
  it("parses paragraphs separated by blank lines, keeping single newlines as breaks", () => {
    const blocks = parseMarkdown("one\ntwo\n\nthree\n\n\n\nfour");
    expect(shape(blocks)).toEqual([
      p(text("one"), { type: "break" }, text("two")),
      p(text("three")),
      p(text("four")),
    ]);
  });

  it("parses headings 1 to 3 and treats deeper or unspaced hashes as text", () => {
    expect(shape(parseMarkdown("# A\n## B\n### C\n#### D\n#E\n# F ##"))).toEqual([
      { type: "heading", level: 1, children: [text("A")] },
      { type: "heading", level: 2, children: [text("B")] },
      { type: "heading", level: 3, children: [text("C")] },
      p(text("#### D"), { type: "break" }, text("#E")),
      { type: "heading", level: 1, children: [text("F")] },
    ]);
    expect(shape(parseMarkdown("#"))).toEqual([{ type: "heading", level: 1, children: [] }]);
  });

  it("parses fenced code with a language and keeps its content verbatim", () => {
    const blocks = parseMarkdown("```js\nconst a = **not bold** [x](y)\n\n  indented\n```\nafter");
    expect(shape(blocks)).toEqual([
      { type: "code", lang: "js", text: "const a = **not bold** [x](y)\n\n  indented" },
      p(text("after")),
    ]);
    expect(shape(parseMarkdown("~~~\ntilde\n~~~"))).toEqual([{ type: "code", lang: "", text: "tilde" }]);
    expect(shape(parseMarkdown("````\n```\ninner\n```\n````"))).toEqual([{ type: "code", lang: "", text: "```\ninner\n```" }]);
  });

  it("runs an unterminated fence to the end of the text", () => {
    expect(shape(parseMarkdown("before\n```\nx\ny"))).toEqual([p(text("before")), { type: "code", lang: "", text: "x\ny" }]);
    expect(shape(parseMarkdown("```"))).toEqual([{ type: "code", lang: "", text: "" }]);
  });

  it("parses bullet and numbered lists with one level of nesting and continuation lines", () => {
    const blocks = parseMarkdown("- one\n- two\n  more two\n  - nested a\n  - nested b\n- three\n\n1. first\n2. second\n\n5) fifth");
    const s = shape(blocks);
    expect(s).toHaveLength(3);
    expect(s[0].type).toBe("list");
    expect(s[0].ordered).toBe(false);
    expect(s[0].items).toHaveLength(3);
    expect(s[0].items[1].children).toEqual([
      p(text("two"), { type: "break" }, text("more two")),
      { type: "list", ordered: false, first: 1, items: [{ children: [p(text("nested a"))] }, { children: [p(text("nested b"))] }] },
    ]);
    expect(s[1]).toEqual({ type: "list", ordered: true, first: 1, items: [{ children: [p(text("first"))] }, { children: [p(text("second"))] }] });
    expect(s[2]).toEqual({ type: "list", ordered: true, first: 5, items: [{ children: [p(text("fifth"))] }] });
  });

  it("ends a list at a blank line unless another item follows, and keeps lazy continuation", () => {
    expect(shape(parseMarkdown("- a\nlazy\n- b\n\nnot an item"))).toEqual([
      { type: "list", ordered: false, first: 1, items: [{ children: [p(text("a"), { type: "break" }, text("lazy"))] }, { children: [p(text("b"))] }] },
      p(text("not an item")),
    ]);
    expect(shape(parseMarkdown("- a\n\n- b"))[0].items).toHaveLength(2);
    expect(shape(parseMarkdown("- a\n1. b"))).toEqual([
      { type: "list", ordered: false, first: 1, items: [{ children: [p(text("a"))] }] },
      { type: "list", ordered: true, first: 1, items: [{ children: [p(text("b"))] }] },
    ]);
  });

  it("parses block quotes with nested blocks", () => {
    expect(shape(parseMarkdown("> quoted **q**\n> second\n>\n> - item\n\nafter"))).toEqual([
      { type: "quote", children: [
        p(text("quoted "), { type: "bold", children: [text("q")] }, { type: "break" }, text("second")),
        { type: "list", ordered: false, first: 1, items: [{ children: [p(text("item"))] }] },
      ] },
      p(text("after")),
    ]);
  });

  it("parses thematic breaks but not list-looking lines", () => {
    expect(shape(parseMarkdown("---\n* * *\n___\n- - -\n--"))).toEqual([
      { type: "hr" }, { type: "hr" }, { type: "hr" }, { type: "hr" }, p(text("--")),
    ]);
  });

  it("interrupts a paragraph with a heading, fence, quote or list", () => {
    expect(shape(parseMarkdown("para\n# h\ntext\n- item\n> q\n```\nc\n```")).map((b) => b.type))
      .toEqual(["paragraph", "heading", "paragraph", "list", "quote", "code"]);
  });

  it("returns [] for empty and non-string input", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("   \n\n  ")).toEqual([]);
    expect(parseMarkdown(null)).toEqual([]);
    expect(parseMarkdown(undefined)).toEqual([]);
  });

  it("normalises CRLF and CR line endings", () => {
    expect(shape(parseMarkdown("a\r\nb\r\n\r\nc\rd"))).toEqual([p(text("a"), { type: "break" }, text("b")), p(text("c"), { type: "break" }, text("d"))]);
  });
});

describe("offsets", () => {
  it("reports the source range of every top-level block", () => {
    const src = "# T\n\npara one\nline two\n\n- a\n- b\n\n```\ncode\n```\n> q";
    const ranges = paragraphsOf(src);
    expect(ranges.map((r) => src.slice(r.start, r.end))).toEqual(["# T", "para one\nline two", "- a\n- b", "```\ncode\n```", "> q"]);
    expect(ranges[0]).toEqual({ start: 0, end: 3 });
  });
  it("keeps offsets into the original source for nested blocks", () => {
    const src = "> outer\n> - item text";
    const [quote] = parseMarkdown(src);
    const list = quote.children[1];
    expect(src.slice(list.start, list.end)).toBe("- item text");
    expect(src.slice(list.items[0].children[0].start, list.items[0].children[0].end)).toBe("item text");
  });
  it("gives CRLF text ranges that exclude the line ending", () => {
    const src = "a\r\n\r\nb";
    expect(paragraphsOf(src)).toEqual([{ start: 0, end: 1 }, { start: 5, end: 6 }]);
  });
});

describe("inline", () => {
  it("parses bold, italic, code and nesting", () => {
    expect(shape(parseMarkdown("**bold** *it* _it2_ `co de` ***both***"))).toEqual([p(
      { type: "bold", children: [text("bold")] }, text(" "),
      { type: "italic", children: [text("it")] }, text(" "),
      { type: "italic", children: [text("it2")] }, text(" "),
      { type: "code", text: "co de" }, text(" "),
      { type: "bold", children: [{ type: "italic", children: [text("both")] }] },
    )]);
    expect(shape(parseMarkdown("**bold with *it* inside**"))[0].children[0].children).toEqual([text("bold with "), { type: "italic", children: [text("it")] }, text(" inside")]);
  });

  it("leaves unmatched or badly flanked markers as text", () => {
    expect(inlineText(parseMarkdown("a * b * c")[0].children)).toBe("a * b * c");
    expect(shape(parseMarkdown("a * b * c"))).toEqual([p(text("a * b * c"))]);
    expect(shape(parseMarkdown("**"))).toEqual([p(text("**"))]);
    expect(shape(parseMarkdown("**a"))).toEqual([p(text("**a"))]);
    expect(shape(parseMarkdown("snake_case_name"))).toEqual([p(text("snake_case_name"))]);
    expect(shape(parseMarkdown("2 * 3 * 4 = 24"))).toEqual([p(text("2 * 3 * 4 = 24"))]);
  });

  it("handles backtick runs and escapes", () => {
    expect(shape(parseMarkdown("`` a`b `` and \\*not\\* \\`x\\`"))).toEqual([p({ type: "code", text: "a`b" }, text(" and *not* `x`"))]);
    expect(shape(parseMarkdown("`unterminated"))).toEqual([p(text("`unterminated"))]);
    expect(shape(parseMarkdown("`**not bold**`"))).toEqual([p({ type: "code", text: "**not bold**" })]);
  });

  it("links http, https and mailto only; other schemes stay literal text", () => {
    expect(shape(parseMarkdown("[a](https://x.y/z?q=1) [b](http://x) [c](mailto:me@x.y) [d](MAILTO:me@x.y)"))).toEqual([p(
      { type: "link", href: "https://x.y/z?q=1", children: [text("a")] }, text(" "),
      { type: "link", href: "http://x", children: [text("b")] }, text(" "),
      { type: "link", href: "mailto:me@x.y", children: [text("c")] }, text(" "),
      { type: "link", href: "MAILTO:me@x.y", children: [text("d")] },
    )]);
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "vbscript:x", "file:///etc/passwd", "//evil", "relative/path", "JAVASCRIPT:x", "java\nscript:x"]) {
      const blocks = parseMarkdown(`[click](${bad})`);
      expect(JSON.stringify(blocks)).not.toContain('"link"');
      expect(inlineText(blocks[0].children)).toBe(`[click](${bad})`);
    }
    // A destination with whitespace is not a link; the bare URL inside may still autolink.
    expect(inlineText(parseMarkdown("[x](https://a b)")[0].children)).toBe("[x](https://a b)");
    expect(shape(parseMarkdown("[x]( https://a)"))).toEqual([p(text("[x]( "), { type: "link", href: "https://a", children: [text("https://a")] }, text(")"))]);
    expect(shape(parseMarkdown("[x](https://a.b/c_(d))"))).toEqual([p({ type: "link", href: "https://a.b/c_(d)", children: [text("x")] })]);
  });

  it("nests inline markup inside link text and never links inside links", () => {
    expect(shape(parseMarkdown("[**b** and [in](https://y)](https://x)"))[0].children[0]).toMatchObject({ type: "link", href: "https://x" });
  });

  it("autolinks bare http(s) URLs and strips trailing punctuation", () => {
    expect(shape(parseMarkdown("see https://ex.am/ple?a=1, and http://x."))).toEqual([p(
      text("see "), { type: "link", href: "https://ex.am/ple?a=1", children: [text("https://ex.am/ple?a=1")] },
      text(", and "), { type: "link", href: "http://x", children: [text("http://x")] }, text("."),
    )]);
    expect(shape(parseMarkdown("nothttps://x"))).toEqual([p(text("nothttps://x"))]);
    expect(shape(parseMarkdown("(https://en.wikipedia.org/wiki/A_(b))"))[0].children[1]).toMatchObject({ href: "https://en.wikipedia.org/wiki/A_(b)" });
  });

  it("autolinks blip ids at word boundaries only", () => {
    const id = bid(0xabc);
    expect(shape(parseMarkdown(`see ${id} and [${id}] but not x${id} or ${id}z or b_123`))).toEqual([p(
      text("see "), { type: "bliplink", id }, text(" and ["), { type: "bliplink", id }, text(`] but not x${id} or ${id}z or b_123`),
    )]);
    expect(shape(parseMarkdown(`**${id}**`))).toEqual([p({ type: "bold", children: [{ type: "bliplink", id }] })]);
    expect(citedBlipIds(`${bid(1)} ${bid(2)} ${bid(1)}\n\n- ${bid(3)}\n> [${bid(4)}](https://x) \`${bid(5)}\``)).toEqual([bid(1), bid(2), bid(3), bid(4)]);
  });

  it("does not link a blip id in code", () => {
    expect(shape(parseMarkdown(`\`${bid(1)}\``))).toEqual([p({ type: "code", text: bid(1) })]);
    expect(shape(parseMarkdown("```\n" + bid(1) + "\n```"))).toEqual([{ type: "code", lang: "", text: bid(1) }]);
  });
});

describe("plainText and firstLine", () => {
  it("flattens a tree to text", () => {
    const src = "# T\n\nHello **b** [l](https://x) " + bid(1) + "\n\n- a\n- b\n  - c\n\n1. x\n\n> q\n\n```\ncode\n```";
    expect(plainText(parseMarkdown(src))).toBe("T\n\nHello b l " + bid(1) + "\n\n- a\n- b\n  - c\n\n1. x\n\n> q\n\ncode");
  });
  it("gives the first content line without markers, capped", () => {
    expect(firstLine("## **Hi** there [l](https://x)\nmore", 100)).toBe("Hi there l");
    expect(firstLine("\n\n> - 1. deep *x*", 100)).toBe("deep x");
    expect(firstLine("```js\ncode line\n```", 100)).toBe("code line");
    expect(firstLine("---\n\n   \nthe line", 3)).toBe("the");
    expect(firstLine("", 10)).toBe("");
    expect(firstLine("***", 10)).toBe("");
    expect(firstLine(null, 10)).toBe("");
    expect(firstLine("x".repeat(5000), 200)).toHaveLength(200);
  });
});

describe("hostile input", () => {
  const cases = {
    stars: "*".repeat(16000),
    underscores: "_".repeat(16000),
    openBold: "**a ".repeat(4000),
    altBold: "**a **b ".repeat(2000),
    brackets: "[".repeat(16000),
    linkOpen: "[a](".repeat(4000),
    nestedLinks: "[".repeat(2000) + "x" + "](https://x)".repeat(2000),
    backticks: "`".repeat(16000),
    mixedTicks: "` `` ``` ".repeat(1800),
    quotes: ">".repeat(16000),
    quoteLines: "> ".repeat(8000),
    bullets: "- ".repeat(8000),
    bulletLines: Array.from({ length: 4000 }, (_, i) => " ".repeat(i % 12) + "- x").join("\n"),
    ordered: Array.from({ length: 4000 }, (_, i) => `${i}. x`).join("\n"),
    fence: "```\n".repeat(4000),
    headings: "# ".repeat(8000),
    hr: "---\n".repeat(4000),
    newlines: "\n".repeat(16000),
    crlf: "a\r\n".repeat(5000),
    escapes: "\\".repeat(16000),
    ids: (bid(1) + " ").repeat(1000),
    urls: "https://x.y/".repeat(1300),
    wide: "日本語*テキスト*".repeat(2000),
    emoji: "\u{1F600}**\u{1F600}**".repeat(2000),
    nulls: "\u0000".repeat(16000),
    everything: ("# h\n> - **[`x`](https://x)** " + bid(2) + " *_y_*\n```\n").repeat(400),
  };
  for (const [name, input] of Object.entries(cases)) {
    it(`survives ${name} (${input.length} chars) quickly`, () => {
      const started = performance.now();
      const blocks = parseMarkdown(input);
      const ms = performance.now() - started;
      expect(Array.isArray(blocks)).toBe(true);
      expect(ms).toBeLessThan(250);
      // Walking the tree must be safe too.
      expect(typeof plainText(blocks)).toBe("string");
      expect(typeof firstLine(input, 200)).toBe("string");
      expect(paragraphsOf(input).every((r) => r.start <= r.end && r.end <= input.length)).toBe(true);
    });
  }

  it("bounds block nesting depth", () => {
    const deep = "> ".repeat(50) + "x";
    let node = parseMarkdown(deep)[0];
    let depth = 0;
    while (node && node.type === "quote") { depth++; node = node.children[0]; }
    expect(depth).toBe(MAX_BLOCK_DEPTH);
    expect(node.type).toBe("paragraph");
  });

  it("bounds inline nesting depth", () => {
    const deep = "*".repeat(40) + "x" + "*".repeat(40);
    let node = parseMarkdown(deep)[0].children[0];
    let depth = 0;
    while (node && (node.type === "bold" || node.type === "italic")) { depth++; node = node.children[0]; }
    expect(depth).toBeLessThanOrEqual(8);
  });

  it("scales roughly linearly", () => {
    const unit = "**a **b [c](d) `e` " + bid(3) + " *f* _g_ https://h\n";
    const time = (n) => {
      const s = unit.repeat(n);
      const t = performance.now();
      parseMarkdown(s);
      return performance.now() - t;
    };
    time(50);
    const small = Math.max(time(100), 0.5);
    const large = time(800);
    expect(large / small).toBeLessThan(40);
  });
});
