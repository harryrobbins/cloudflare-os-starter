import { describe, expect, it } from "vitest";

import { AdfError, adfToMarkdown, markdownToAdf, validateAdf, type AdfBlock, type AdfDoc, type AdfInline, type AdfText } from "../src/index.js";

const doc = (...content: AdfBlock[]): AdfDoc => ({ type: "doc", version: 1, content });
const p = (...content: AdfInline[]): AdfBlock => ({ type: "paragraph", content });
const t = (text: string, ...marks: ("strong" | "em" | "code" | { href: string; title?: string })[]): AdfText => {
  const ms = marks.map((m) => (typeof m === "string" ? { type: m } : { type: "link" as const, attrs: m.title ? { href: m.href, title: m.title } : { href: m.href } }));
  return ms.length ? { type: "text", text, marks: ms as never } : { type: "text", text };
};
const br: AdfInline = { type: "hardBreak" };
const mention = (id: string, text: string): AdfInline => ({ type: "mention", attrs: { id, text } });
const li = (...content: AdfBlock[]) => ({ type: "listItem" as const, content });

/** ADF → Markdown → ADF must reproduce the (validated) input. */
function roundTripAdf(input: AdfDoc): string {
  const md = adfToMarkdown(validateAdf(input));
  expect(markdownToAdf(md)).toEqual(validateAdf(input));
  return md;
}

/** Markdown → ADF → Markdown must reproduce canonical Markdown. */
function roundTripMd(md: string): AdfDoc {
  const adf = markdownToAdf(md);
  expect(adfToMarkdown(adf)).toBe(md);
  return adf;
}

describe("ADF → Markdown → ADF", () => {
  it("paragraphs and marks", () => {
    const md = roundTripAdf(doc(p(t("plain "), t("bold", "strong"), t(" and "), t("italic", "em"), t(" and "), t("code()", "code"), t("."))));
    expect(md).toBe("plain **bold** and _italic_ and `code()`.");
  });

  it("nested and adjacent marks", () => {
    expect(roundTripAdf(doc(p(t("both", "strong", "em"), t(" "), t("a", "strong"), t("b", "strong", "em"), t("c", "em"))))).toBe("**_both_** **a*b***_c_");
    expect(roundTripAdf(doc(p(t("snake"), t("case", "em"), t("word"))))).toBe("snake*case*word");
    expect(roundTripAdf(doc(p(t("see "), t("the ", { href: "https://x.test/a_b" }), t("docs", { href: "https://x.test/a_b" }, "strong"), t("!"))))).toBe(
      "see [the **docs**](https://x.test/a_b)!",
    );
    expect(roundTripAdf(doc(p(t("x", { href: "https://x.test/(a) b", title: 'say "hi"' }))))).toBe('[x](<https://x.test/(a) b> "say \\"hi\\"")');
    expect(roundTripAdf(doc(p(t("a`b", "code"), t(" "), t("`", "code"))))).toBe("``a`b`` `` ` ``");
    expect(roundTripAdf(doc(p(t("linked code", { href: "https://x.test" }, "code"))))).toBe("[`linked code`](https://x.test)");
  });

  it("escapes Markdown punctuation in text", () => {
    const md = roundTripAdf(doc(p(t("2 * 3 = 6, a_b, [x](y), `tick`, back\\slash, wow!"))));
    expect(md).toBe("2 \\* 3 = 6, a\\_b, \\[x\\](y), \\`tick\\`, back\\\\slash, wow!");
    roundTripAdf(doc(p(t("# not a heading")), p(t("- not a list")), p(t("1. not ordered")), p(t("> not a quote")), p(t("=== not setext"))));
    expect(roundTripAdf(doc(p(t("Look!"), t("here", { href: "https://x.test" }))))).toBe("Look\\![here](https://x.test)");
    roundTripAdf(doc(p(t("line one"), br, t("- still text"), br, t("2) also"))));
  });

  it("hard breaks and mentions", () => {
    const md = roundTripAdf(doc(p(t("Hi "), mention("11111111-1111-4111-8111-111111111111", "@Alice [A]"), t(","), br, t("see below."))));
    expect(md).toBe("Hi [@Alice \\[A\\]](mention:11111111-1111-4111-8111-111111111111),\nsee below.");
  });

  it("headings", () => {
    expect(roundTripAdf(doc({ type: "heading", attrs: { level: 1 }, content: [t("Title")] }, { type: "heading", attrs: { level: 3 }, content: [t("#tag "), t("x", "em")] }, p(t("body"))))).toBe(
      "# Title\n\n### #tag _x_\n\nbody",
    );
  });

  it("code blocks", () => {
    expect(roundTripAdf(doc({ type: "codeBlock", attrs: { language: "ts" }, content: [t("const a = 1;\n\nconsole.log(`${a}`);")] }))).toBe(
      "```ts\nconst a = 1;\n\nconsole.log(`${a}`);\n```",
    );
    expect(roundTripAdf(doc({ type: "codeBlock", content: [t("```\nfenced\n```")] }))).toBe("````\n```\nfenced\n```\n````");
    roundTripAdf(doc({ type: "codeBlock", content: [] }));
  });

  it("lists, nesting, ordered starts and adjacent lists", () => {
    const md = roundTripAdf(
      doc(
        { type: "bulletList", content: [li(p(t("one"))), li(p(t("two")), { type: "bulletList", content: [li(p(t("two.a"))), li(p(t("two.b")))] }), li(p(t("three")), p(t("more")))] },
        { type: "orderedList", attrs: { order: 3 }, content: [li(p(t("third"))), li(p(t("fourth")), { type: "codeBlock", attrs: { language: "sh" }, content: [t("ls -la")] })] },
        { type: "orderedList", content: [li(p(t("again")))] },
        { type: "bulletList", content: [li(p(t("x")))] },
        { type: "bulletList", content: [li(p(t("y")))] },
      ),
    );
    expect(md).toBe(
      [
        "- one",
        "- two",
        "  - two.a",
        "  - two.b",
        "- three",
        "",
        "  more",
        "",
        "3. third",
        "4. fourth",
        "",
        "   ```sh",
        "   ls -la",
        "   ```",
        "",
        "1) again",
        "",
        "- x",
        "",
        "* y",
      ].join("\n"),
    );
  });

  it("normalises whitespace at emphasis edges and merges runs", () => {
    const input = doc(p(t("a"), t(" bold ", "strong"), t("b"), t("c")));
    const md = adfToMarkdown(validateAdf(input));
    expect(md).toBe("a **bold** bc");
    expect(markdownToAdf(md)).toEqual(doc(p(t("a "), t("bold", "strong"), t(" bc"))));
  });

  it("drops empty paragraphs and empty text", () => {
    expect(adfToMarkdown(validateAdf(doc(p(), p(t("x")), { type: "paragraph", content: [{ type: "text", text: "" }] })))).toBe("x");
    expect(adfToMarkdown(validateAdf({ type: "doc", version: 1, content: [] }))).toBe("");
    expect(markdownToAdf("")).toEqual(doc());
  });
});

describe("Markdown → ADF → Markdown", () => {
  it("canonical Markdown survives", () => {
    roundTripMd("Intro with **strong**, _em_, `code` and a [link](https://example.test/path?q=1).\n\n## Steps\n\n1. First\n2. Second\n   - nested\n\n```js\nlet x = 1;\n```");
    roundTripMd("[@Bob Brown](mention:22222222-2222-4222-8222-222222222222) please look\nat this");
  });

  it("reads common human Markdown", () => {
    expect(markdownToAdf("*em* and __strong__ and ***both***\n* item\n+ other")).toEqual(
      doc(
        p(t("em", "em"), t(" and "), t("strong", "strong"), t(" and "), t("both", "strong", "em")),
        { type: "bulletList", content: [li(p(t("item")))] },
        { type: "bulletList", content: [li(p(t("other")))] },
      ),
    );
    expect(markdownToAdf("2 * 3 * 4 and snake_case_name")).toEqual(doc(p(t("2 * 3 * 4 and snake_case_name"))));
    expect(markdownToAdf("- a\nlazy continuation\n- b")).toEqual(doc({ type: "bulletList", content: [li(p(t("a"), br, t("lazy continuation"))), li(p(t("b")))] }));
    expect(markdownToAdf("> quoted\n| a | b |")).toEqual(doc(p(t("> quoted"), br, t("| a | b |"))));
    expect(markdownToAdf("hard\\\nbreak and trailing  \nspaces")).toEqual(doc(p(t("hard"), br, t("break and trailing"), br, t("spaces"))));
    expect(markdownToAdf("~~~\nraw *text*\n~~~")).toEqual(doc({ type: "codeBlock", content: [t("raw *text*")] }));
  });
});

describe("validateAdf rejects what it cannot keep", () => {
  const reject = (input: unknown) => {
    try {
      validateAdf(input);
    } catch (err) {
      expect(err).toBeInstanceOf(AdfError);
      return (err as Error).message;
    }
    throw new Error("expected rejection");
  };

  it("non-documents", () => {
    expect(reject("plain string")).toMatch(/Operation value must be an Atlassian Document/);
    expect(reject({ type: "doc", version: 2, content: [] })).toMatch(/version 1/);
    expect(reject({ type: "doc", version: 1 })).toMatch(/content array/);
  });

  it("unsupported nodes and marks", () => {
    expect(reject(doc({ type: "table", content: [] } as never))).toMatch(/Unsupported ADF node type 'table'.*\(at \$\.content\[0\]\)/);
    expect(reject(doc({ type: "blockquote", content: [p(t("x"))] } as never))).toMatch(/'blockquote'/);
    expect(reject(doc(p({ type: "emoji", attrs: { shortName: ":)" } } as never)))).toMatch(/'emoji'.*content\[0\]\.content\[0\]/);
    expect(reject(doc(p({ type: "text", text: "x", marks: [{ type: "underline" }] } as never)))).toMatch(/Unsupported ADF mark 'underline'/);
    expect(reject(doc(p({ type: "text", text: "x", marks: [{ type: "textColor", attrs: { color: "#f00" } }] } as never)))).toMatch(/'textColor'/);
    expect(reject(doc({ type: "bulletList", content: [p(t("x"))] } as never))).toMatch(/Lists contain listItem/);
    expect(reject(doc({ type: "codeBlock", content: [t("x", "strong")] } as never))).toMatch(/cannot have marks/);
    expect(reject(doc({ type: "heading", attrs: { level: 7 }, content: [] } as never))).toMatch(/level from 1 to 6/);
    expect(reject(doc(p({ type: "mention", attrs: {} } as never)))).toMatch(/attrs\.id/);
  });

  it("bounds", () => {
    const deep = (n: number): AdfBlock => (n === 0 ? p(t("x")) : { type: "bulletList", content: [li(deep(n - 1))] });
    expect(reject(doc(deep(20)))).toMatch(/nests deeper/);
    expect(reject(doc(p(...Array.from({ length: 5001 }, () => t("x")))))).toMatch(/more than 5000 nodes/);
  });

  it("ignores extra attrs such as localId", () => {
    expect(validateAdf({ type: "doc", version: 1, content: [{ type: "paragraph", attrs: { localId: "abc" }, content: [{ type: "text", text: "x" }] }] })).toEqual(doc(p(t("x"))));
  });
});

describe("randomised round trips", () => {
  // Deterministic PRNG so failures reproduce.
  let seed = 1234567;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const WORDS = ["alpha", "beta", "x*y", "a_b", "[br]", "`t`", "\\", "#1", "- d", "1.", "!", "wow!", "  ", " sp ", "é", "snake_case", "**", "__", "<a>", "(p)"];

  const EMPHASIS_WORDS = ["alpha", "beta", "x*y", "a_b", "snake_case", "é", "wow! ok", "1. go", "#1 hash", "- d"];
  const inline = (): AdfInline => {
    const r = rnd();
    if (r < 0.08) return br;
    if (r < 0.14) return mention("22222222-2222-4222-8222-222222222222", pick(["@Bob", "@B [x]", "@a_b"]));
    const marks: ("strong" | "em" | "code" | { href: string })[] = [];
    if (rnd() < 0.3) marks.push("strong");
    if (rnd() < 0.3) marks.push("em");
    if (rnd() < 0.15) marks.push("code");
    if (rnd() < 0.15) marks.push({ href: pick(["https://x.test/a_b", "https://x.test/(p) q"]) });
    // Emphasis is kept to word-bounded text: CommonMark's flanking rules cannot express strong or
    // em that starts or ends with punctuation directly against a word (a documented limit).
    const emphatic = marks.includes("strong") || marks.includes("em");
    const vocab = emphatic && !marks.includes("code") ? EMPHASIS_WORDS : WORDS;
    return t(Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => pick(vocab)).join(emphatic ? " " : pick([" ", ""])), ...marks);
  };
  const inlines = () => Array.from({ length: 1 + Math.floor(rnd() * 6) }, inline);
  const block = (depth: number): AdfBlock => {
    const r = rnd();
    if (r < 0.5 || depth > 2) return p(...inlines());
    if (r < 0.6) return { type: "heading", attrs: { level: 1 + Math.floor(rnd() * 6) }, content: inlines() };
    if (r < 0.7) return { type: "codeBlock", ...(rnd() < 0.5 ? { attrs: { language: "js" } } : {}), content: [t(pick(["a\nb", "```x", "  indented", "~~~"]))] };
    const items = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => li(...Array.from({ length: 1 + Math.floor(rnd() * 2) }, () => block(depth + 1))));
    return r < 0.85 ? { type: "bulletList", content: items } : { type: "orderedList", ...(rnd() < 0.3 ? { attrs: { order: 5 } } : {}), content: items };
  };
  const plain = (d: AdfDoc): string =>
    JSON.stringify(d)
      .match(/"text":"((?:[^"\\]|\\.)*)"/g)!
      ?.map((m) => JSON.parse(m.slice(7)) as string)
      .join("")
      .replace(/^@/gm, "")
      .replace(/\s+/g, "") ?? "";

  it("Markdown is a fixed point after one conversion and text is preserved", () => {
    for (let i = 0; i < 1000; i++) {
      const input = validateAdf(doc(...Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => block(0))));
      const md1 = adfToMarkdown(input);
      const back = markdownToAdf(md1);
      const md2 = adfToMarkdown(back);
      expect(md2, `case ${i}: ${JSON.stringify(input)}`).toBe(md1);
      expect(markdownToAdf(md2)).toEqual(back);
      expect(plain(back).replace(/@/g, ""), `case ${i}`).toBe(plain(input).replace(/@/g, ""));
    }
  });
});
