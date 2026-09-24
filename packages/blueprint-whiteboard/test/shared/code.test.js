// Code blocks in the shared contract: normalisation and limits, languages and detection, the
// lexers (snapshots per language, exact partition of the input, ReDoS and work-cap bounds,
// memoisation), layout, rendering (escaping, clipping, palette contrast) and the backup format.
import { describe, expect, it } from "vitest";
import { CODE_DEFAULTS, LIMITS, TYPE_DEFAULTS, cleanCode, cleanObjectPatch, normalizeNewObject, storedBytes } from "../../src/shared/protocol.js";
import { LANGUAGES, detectLanguage, resolveLanguage, languageLabel } from "../../src/shared/code/languages.js";
import { MEMO_SIZE, TOKEN_CLASSES, WORK_BASE, WORK_PER_CHAR, memoStats, tokenize } from "../../src/shared/code/lexer.js";
import { codeHeight, codeLayout, codeMetrics, codeRowCount, fitColumns, TAB_WIDTH } from "../../src/shared/code/layout.js";
import { CODE_THEMES } from "../../src/shared/code/theme.js";
import { boardToSvg, objectNode, serialize } from "../../src/shared/render.js";
import { buildBackup, buildClipboard, codeFenceToEntry, parseBackup, planCreates } from "../../src/shared/backup.js";

const ID = "o_00000000c0de";
const make = (fields) => ({ ...normalizeNewObject({ id: ID, type: "code", ...fields }), z: "a0", version: 1, createdAt: 0, updatedAt: 0, createdBy: "t" });
const board = (...list) => ({ schemaVersion: 1, revision: 1, title: "t", background: "dots", lastModified: 0, objects: Object.fromEntries(list.map((o) => [o.id, o])) });
const join = (tokens) => tokens.map((t) => t[1]).join("");
/** Non-plain tokens as "class:text", the readable form the snapshots keep. */
const marked = (lang, text) => tokenize(lang, text, { memo: false }).tokens.filter(([c, t]) => c && t.trim()).map(([c, t]) => `${c}:${t}`);

describe("code objects: normalisation and limits", () => {
  it("takes defaults, resolves language aliases and cleans every code field", () => {
    const o = normalizeNewObject({ id: ID, type: "code", text: "x = 1", language: "py", rot: 45 });
    expect(o).toMatchObject({ type: "code", w: TYPE_DEFAULTS.code.w, rot: 0, text: "x = 1", ...CODE_DEFAULTS, language: "python" });
    const p = cleanObjectPatch({
      language: "<script>", theme: "neon", lineNumbers: "yes", wrap: true, filename: "a\nb.py\u202e", rot: 10, packId: "x.1",
    }, "code");
    expect(p).toEqual({ wrap: true, filename: "a b.py" });
    expect(cleanObjectPatch({ language: "C++", theme: "dark", lineNumbers: false }, "code")).toEqual({ language: "cpp", theme: "dark", lineNumbers: false });
    // Other types never take code fields.
    expect(cleanObjectPatch({ language: "python", wrap: true }, "sticky")).toEqual({});
  });

  it("keeps code verbatim (tabs, blank lines, markup) but cuts it at 20,000 characters and 1,000 lines", () => {
    const code = "\tif (a < b) {\r\n\t\treturn '</text><script>';\n\n}";
    expect(cleanCode(code)).toBe("\tif (a < b) {\n\t\treturn '</text><script>';\n\n}");
    expect(cleanCode("x".repeat(LIMITS.codeText + 50))).toHaveLength(LIMITS.codeText);
    const many = Array.from({ length: 1500 }, (_, i) => `l${i}`).join("\n");
    const cut = cleanCode(many);
    expect(cut.split("\n")).toHaveLength(LIMITS.codeLines);
    expect(cut.endsWith("l999")).toBe(true);
    // A sticky keeps its own, lower limit.
    expect(cleanObjectPatch({ text: "y".repeat(10_000) }, "sticky").text).toHaveLength(LIMITS.text);
  });

  it("a full code block stays far inside the 64 KiB per-object budget", () => {
    const ascii = make({ text: ("const x = \"\\\\\";\t// ok\n").repeat(1000).slice(0, LIMITS.codeText) });
    expect(storedBytes(ascii)).toBeLessThan(LIMITS.objectBytes);
    const wide = make({ text: "語".repeat(LIMITS.codeText) });
    expect(storedBytes(wide)).toBeLessThan(LIMITS.objectBytes);
  });
});

describe("languages", () => {
  it("has the promised languages with unique ids and resolvable aliases", () => {
    const ids = LANGUAGES.map((l) => l.id);
    for (const id of ["plain", "javascript", "typescript", "json", "python", "sql", "html", "css", "bash", "yaml", "markdown", "go", "rust", "java", "c", "cpp", "csharp", "php", "ruby", "diff"]) {
      expect(ids).toContain(id);
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect(resolveLanguage("JS")).toBe("javascript");
    expect(resolveLanguage("Shell")).toBe("bash");
    expect(resolveLanguage("c#")).toBe("csharp");
    expect(resolveLanguage("nope")).toBe(null);
    expect(resolveLanguage("x".repeat(1000))).toBe(null);
    expect(languageLabel("cpp")).toBe("C++");
  });

  it("guesses the language of common snippets", () => {
    const cases = {
      python: "import os\n\ndef main():\n    print('hi')\n",
      javascript: "const x = require('x');\nconsole.log(x);\n",
      typescript: "interface A { b: string }\nconst a: A = { b: '' };\n",
      json: '{"a": [1, 2], "b": null}',
      html: "<!DOCTYPE html>\n<html><body></body></html>",
      bash: "#!/bin/bash\necho hi\n",
      go: "package main\n\nfunc main() {}\n",
      rust: "fn main() {\n    let mut v = Vec::new();\n    println!(\"{}\", 1);\n}\n",
      sql: "SELECT a FROM t WHERE b = 1;",
      diff: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n",
      php: "<?php echo 1;",
      yaml: "name: x\non:\n  push: {}\n".replace("{}", "[main]"),
      markdown: "# Title\n\nSome *text*.\n",
      cpp: "#include <iostream>\nint main() { std::cout << 1; }\n",
      c: "#include <stdio.h>\nint main(void) { printf(\"x\"); }\n",
      csharp: "using System;\nnamespace A { }\n",
      java: "public class A { public static void main(String[] a) { System.out.println(1); } }",
      ruby: "require 'x'\ndef hi\n  puts 'hi'\nend\n",
      css: ".a {\n  color: red;\n}\n",
      plain: "just some words",
    };
    for (const [lang, text] of Object.entries(cases)) expect([lang, detectLanguage(text)]).toEqual([lang, lang]);
  });
});

describe("lexers", () => {
  const FIXTURES = {
    javascript: "import { a } from \"b\";\n// note\nconst s = `x ${y}`, n = 0x1f + 1e-3;\nclass A extends B { m() { return this.x?.y(null); } }\n/* block\ncomment */",
    typescript: "type T = { a: string };\n@decorator\nexport interface I extends T { f(): Promise<void> }\nlet v = x as unknown as number;",
    json: "{\n  \"key\": \"value\",\n  \"n\": -1.5e2,\n  \"ok\": [true, false, null]\n}",
    python: "@app.route('/x')\nasync def f(self, n: int = 0) -> str:\n    '''doc\n    string'''\n    s = rf\"\\d{n}\" # comment\n    return None if n else True",
    sql: "-- report\nSELECT u.id, COUNT(*) AS n FROM users u\nLEFT JOIN t ON t.id = u.id WHERE name = 'O''Brien' /* x */ GROUP BY 1;",
    html: "<!-- c -->\n<a href=\"/x?a=1&amp;b\" data-x=y disabled>Hi &lt;there&gt;</a>\n<script>if (a < b) alert(\"</a>\")</script><style>p { color: #fff }</style>",
    css: "@media (max-width: 600px) {\n  .a > #b:hover, li::before { margin: 0 auto !important; color: rgb(0, 0, 0); }\n}\n/* end */",
    bash: "#!/usr/bin/env bash\nset -e\nfor f in *.txt; do echo \"$f ${HOME}\" | grep -v '#no' # real comment\ndone",
    yaml: "# config\nversion: 2\nservices:\n  - name: \"web\"\n    image: nginx:1.27 # pinned\n    anchors: &base\n    enabled: true\nscript: |\n  echo hi\n  echo there\nnext: ~",
    markdown: "# Heading\n\n- **bold** and _em_ and `code` and [link](https://example.com)\n> quote\n```js\nconst a = 1;\n```\n1. done",
    go: "package main\n\nimport \"fmt\"\n\nfunc main() {\n\tx := []int{1, 2}\n\tfmt.Println(len(x), nil, `raw\nstring`)\n}",
    rust: "#[derive(Debug)]\nfn longest<'a>(x: &'a str) -> Option<String> {\n    let c = 'c';\n    println!(\"{}\", x); // done\n    None\n}",
    java: "@Override\npublic static void main(String[] args) {\n    List<Integer> xs = new ArrayList<>();\n    System.out.println(\"hi\" + 42L);\n}",
    c: "#include <stdio.h>\n#define MAX 10\nint main(void) {\n    char *s = \"x\\n\"; /* c */\n    return printf(\"%d\", MAX) > 0 ? 0 : 1;\n}",
    cpp: "#include <vector>\ntemplate <typename T>\nclass Box { public: std::vector<T> items; bool empty() const { return items.size() == 0; } };",
    csharp: "using System;\n#region x\npublic class A : IDisposable {\n    public async Task<int> Run(string s) => await Task.FromResult(s?.Length ?? 0);\n}",
    php: "<?php\n// c\n# also c\n$name = \"World\";\necho \"Hello {$name}\" . strtoupper('x');\nfunction f(array $a): ?int { return null; }",
    ruby: "require 'json'\nclass A < B\n  attr_reader :name\n  def initialize(name)\n    @name = name # set\n  end\nend",
    diff: "diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n context\n-old line\n+new line\n\\ No newline at end of file",
    plain: "Just <b>plain</b> text & \"quotes\"",
  };

  it("has a fixture for every language", () => {
    expect(Object.keys(FIXTURES).toSorted()).toEqual(LANGUAGES.map((l) => l.id).toSorted());
  });

  for (const [lang, text] of Object.entries(FIXTURES)) {
    it(`highlights ${lang}`, () => {
      const { tokens, degraded } = tokenize(lang, text, { memo: false });
      expect(degraded).toBe(false);
      expect(join(tokens)).toBe(text); // tokens partition the input
      for (const [cls] of tokens) expect(TOKEN_CLASSES).toContain(cls);
      expect(marked(lang, text)).toMatchSnapshot();
    });
  }

  it("classifies the essentials", () => {
    expect(marked("python", "def f(): return 'x'  # c")).toEqual(["keyword:def", "function:f", "keyword:return", "string:'x'", "comment:# c"]);
    expect(marked("json", '{"k": "v"}')).toEqual(['property:"k"', 'string:"v"']);
    expect(marked("diff", "+a\n-b\n@@ -1 +1 @@")).toEqual(["inserted:+a", "deleted:-b", "keyword:@@ -1 +1 @@"]);
    expect(marked("sql", "select 1 from t")).toEqual(["keyword:select", "number:1", "keyword:from"]);
    expect(marked("html", "<b class=x>")).toEqual(["tag:<b", "property:class", "string:x", "tag:>"]);
    expect(marked("css", "a{color:red}")).toEqual(["tag:a", "property:color", "constant:red"]);
    expect(marked("rust", "fn f<'a>() {}")).toEqual(["keyword:fn", "function:f", "meta:'a"]);
  });

  it("returns plain text for unknown languages and the empty string", () => {
    expect(tokenize("nope", "<x>").tokens).toEqual([["", "<x>"]]);
    expect(tokenize("python", "").tokens).toEqual([]);
  });

  it("memoises by (language, text), bounded", () => {
    const text = "const memo = " + Math.random();
    const before = memoStats.misses;
    const a = tokenize("javascript", text);
    const b = tokenize("javascript", text);
    expect(b).toBe(a);
    expect(memoStats.misses).toBe(before + 1);
    expect(tokenize("typescript", text)).not.toBe(a);
    for (let i = 0; i < MEMO_SIZE + 5; i++) tokenize("plain", "fill " + i);
    expect(tokenize("javascript", text)).not.toBe(a); // evicted
  });
});

describe("lexers are bounded (ReDoS and work cap)", () => {
  const N = LIMITS.codeText;
  const ADVERSARIAL = [
    "\\".repeat(N), "\"".repeat(N), "'".repeat(N), "`".repeat(N), "/*".repeat(N / 2), "*/".repeat(N / 2),
    "<".repeat(N), "<a ".repeat(N / 3), "<!--".repeat(N / 4), "[".repeat(N), "[a](".repeat(N / 4), "*_".repeat(N / 2),
    "`a".repeat(N / 2), "${".repeat(N / 2), "$".repeat(N), "#".repeat(N), "@".repeat(N), "a(".repeat(N / 2),
    "a ".repeat(N / 2), "1e+".repeat(N / 3), "0x".repeat(N / 2), "'a".repeat(N / 2), ": ".repeat(N / 2),
    "- ".repeat(N / 2), "\n".repeat(N), " \n".repeat(N / 2), "\t".repeat(N), "a:b{".repeat(N / 4), "```\n".repeat(N / 4),
    "\"\"\"".repeat(N / 3), "&".repeat(N), "{\"a\":".repeat(N / 5), "<script>".repeat(N / 8), "|\n  ".repeat(N / 4),
    "a".repeat(N), "语".repeat(N), "\ud83d\ude00".repeat(N / 2), "\ud800".repeat(N),
  ];

  it("every language handles adversarial inputs within WORK_PER_CHAR per character, fast", () => {
    let worst = 0;
    const t0 = performance.now();
    for (const lang of LANGUAGES.map((l) => l.id)) {
      for (const input of ADVERSARIAL) {
        const r = tokenize(lang, input, { memo: false });
        expect(join(r.tokens)).toBe(input);
        expect(r.work).toBeLessThanOrEqual(WORK_BASE + WORK_PER_CHAR * input.length + 64);
        worst = Math.max(worst, r.work / input.length);
      }
    }
    // 20 languages x 38 inputs of 10,000-20,000 characters: generous even for slow CI.
    expect(performance.now() - t0).toBeLessThan(15_000);
    expect(worst).toBeLessThan(WORK_PER_CHAR);
  });

  it("the work cap degrades the rest of a block to plain text instead of running on", () => {
    const text = "const a = 1; // x\n".repeat(200);
    const r = tokenize("javascript", text, { budget: 500 });
    expect(r.degraded).toBe(true);
    expect(join(r.tokens)).toBe(text);
    expect(r.tokens[r.tokens.length - 1][0]).toBe("");
    expect(r.work).toBeLessThanOrEqual(600);
  });

  it("language detection is bounded on adversarial text", () => {
    const t0 = performance.now();
    for (const input of ADVERSARIAL) detectLanguage(input);
    for (const input of ["import " + "a".repeat(50_000), " ".repeat(50_000) + "x", "a-".repeat(30_000) + "{", "\n".repeat(50_000) + "def"]) detectLanguage(input);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

describe("layout", () => {
  it("expands tabs, counts wide characters as two columns, wraps or clips at the width", () => {
    const narrow = make({ text: "\tab\n" + "x".repeat(100), w: 200, lineNumbers: false });
    const m = codeMetrics(narrow);
    expect(m.cols).toBe(Math.floor((200 - 2 * m.pad) / m.charW));
    const clipped = codeLayout(narrow);
    expect(clipped.rows[0].segs.map((s) => s[1]).join("")).toBe(" ".repeat(TAB_WIDTH) + "ab");
    expect(clipped.rows[1].segs[0][1].length).toBe(m.cols + 1); // clipped one column past the edge
    expect(codeRowCount(narrow)).toBe(2);
    const wrapped = { ...narrow, wrap: true };
    expect(codeRowCount(wrapped)).toBe(1 + Math.ceil(100 / m.cols));
    expect(codeLayout({ ...wrapped, h: 5000 }).rows.filter((r) => r.number !== null).map((r) => r.number)).toEqual([1, 2]);
    expect(fitColumns("語語語", 4)).toBe("語…");
  });

  it("the fitted height grows with lines and only rows inside the box are laid out", () => {
    const one = make({ text: "a" });
    const ten = make({ text: "a\n".repeat(9) + "a" });
    expect(codeHeight(ten) - codeHeight(one)).toBeCloseTo(9 * 14 * 1.5, 0);
    const huge = make({ text: "x\n".repeat(999), h: 200 });
    expect(codeLayout(huge).rows.length).toBeLessThan(15);
  });
});

describe("rendering", () => {
  const evil = "</text><script>alert(1)</script>\n<![CDATA[ ]]> & \"q\" <tspan fill=\"red\">x</tspan>\u0001";

  it("never produces markup from code, in any language", () => {
    for (const language of LANGUAGES.map((l) => l.id)) {
      const o = make({ text: evil, language, filename: "<img src=x onerror=1>.js", h: 400 });
      const svg = boardToSvg(board(o));
      expect(svg).not.toContain("<script");
      expect(svg).not.toContain("<img");
      expect(svg).not.toContain("<![CDATA[");
      expect(svg).not.toContain('<tspan fill="red"');
      expect(svg).not.toContain("\u0001");
      expect(svg).toContain("&lt;/");
      expect(svg).toMatch(/&lt;script&gt;|&lt;<\/tspan><tspan[^>]*>script/);
      // Well-formed: exactly one svg root closes, and every <text> opened closes.
      expect(svg.match(/<text\b/g)?.length).toBe(svg.match(/<\/text>/g)?.length);
    }
  });

  it("draws a header, line numbers and coloured tokens clipped to the body", () => {
    const o = make({ text: "def f():\n    return 1", language: "python", theme: "dark", filename: "main.py", h: 200 });
    const svg = serialize(/** @type {any} */ (objectNode(o, () => undefined)));
    expect(svg).toContain(`fill="${CODE_THEMES.dark.background}"`);
    expect(svg).toContain(">main.py<");
    expect(svg).toContain(">Python<");
    expect(svg).toContain(`<tspan fill="${CODE_THEMES.dark.tokens.keyword}">def</tspan>`);
    expect(svg).toMatch(/<svg x="0" y="[\d.]+" width="480" height="[\d.]+" viewBox="[^"]+" overflow="hidden">/);
    expect(svg).toContain(">1</tspan>");
    expect(svg).toContain(">2</tspan>");
    const noNumbers = serialize(/** @type {any} */ (objectNode({ ...o, lineNumbers: false }, () => undefined)));
    expect(noNumbers).not.toContain('text-anchor="end" aria-hidden="true"');
  });

  it("every palette colour reaches WCAG AA (4.5:1) on its background, in both themes", () => {
    const lum = (hex) => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    for (const theme of Object.values(CODE_THEMES)) {
      for (const cls of TOKEN_CLASSES) expect(ratio(theme.tokens[cls], theme.background)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(theme.gutter, theme.background)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(theme.headerText, theme.header)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("backup and clipboard", () => {
  it("round-trips every code field through the backup format and placement", () => {
    const o = make({ text: "SELECT 1;", language: "sql", theme: "dark", lineNumbers: false, wrap: true, filename: "q.sql", h: 90 });
    const doc = buildBackup(board(o));
    expect(doc.objects[0]).toMatchObject({ type: "code", language: "sql", theme: "dark", lineNumbers: false, wrap: true, filename: "q.sql" });
    const parsed = /** @type {any} */ (parseBackup(JSON.stringify(doc)));
    expect(parsed.counts).toEqual({ code: 1 });
    const { creates } = planCreates(parsed.entries, { newId: () => "o_111111111111" });
    expect(creates[0]).toMatchObject({ type: "code", text: "SELECT 1;", language: "sql", theme: "dark", lineNumbers: false, wrap: true, filename: "q.sql", h: 90 });
    const clip = buildClipboard([o], board(o).objects);
    expect(clip.objects[0].language).toBe("sql");
  });

  it("an untrusted backup's code fields are cleaned like any create", () => {
    const parsed = /** @type {any} */ (parseBackup({ format: "cloudflare-os-whiteboard", version: 1, objects: [
      { id: "a", type: "code", text: "x", language: "<svg>", theme: 7, lineNumbers: "no", filename: "a\u0000b", markup: "<b>" },
    ] }));
    expect(parsed.entries[0].object).toMatchObject({ language: "plain", theme: "light", lineNumbers: true, filename: "ab" });
    expect(parsed.entries[0].object).not.toHaveProperty("markup");
  });

  it("reads one fenced Markdown block as a code block, and nothing else", () => {
    const e = /** @type {any} */ (codeFenceToEntry("```python\nprint(1)\n\tx = 2\n```\n", detectLanguage));
    expect(e.object).toMatchObject({ type: "code", text: "print(1)\n\tx = 2", language: "python" });
    expect(e.object.h).toBe(codeHeight(e.object));
    expect(/** @type {any} */ (codeFenceToEntry("```\nSELECT 1 FROM t\n```", detectLanguage)).object.language).toBe("sql");
    expect(/** @type {any} */ (codeFenceToEntry("~~~js\na\n~~~", detectLanguage)).object.language).toBe("javascript");
    expect(codeFenceToEntry("no fence")).toBe(null);
    expect(codeFenceToEntry("```js\na\n```\ntext\n```py\nb\n```")).toBe(null);
    expect(codeFenceToEntry("```js\nunclosed")).toBe(null);
  });
});
