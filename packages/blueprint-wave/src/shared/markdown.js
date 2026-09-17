// @ts-check
// Markdown-lite: a tokenizer that turns blip text into a node tree. No DOM, no HTML strings; the
// client builds elements from the tree (src/client/ui) and the export walks it. Shared by the
// server (getWaveMarkdown, exportMarkdown, paragraph anchors) and the client (read view).
//
// Supported: paragraphs, headings (# to ###), bold (**), italic (* or _), inline code, fenced
// code (``` or ~~~), links [text](url) with http, https and mailto only (anything else stays
// literal text), bare http(s) URLs, bullet and numbered lists with nesting, block quotes,
// thematic breaks (---), and blip-id autolinks: any `b_` + 12 hex token becomes a bliplink node.
// Single newlines inside a paragraph are kept as "break" nodes (people write chat, not prose).
//
// Safety: every input is accepted (unterminated fences and brackets, 16 k of "*", deeply nested
// markers); recursion is depth-limited and the inline scanner has a work budget, so time stays
// close to linear in the text length.

/**
 * @typedef {(
 *   {type: "text", text: string}
 * | {type: "bold", children: Inline[]}
 * | {type: "italic", children: Inline[]}
 * | {type: "code", text: string}
 * | {type: "link", href: string, children: Inline[]}
 * | {type: "bliplink", id: string}
 * | {type: "break"}
 * )} Inline
 */

/**
 * Every block carries `start` and `end`: character offsets into the source text of its first and
 * last line (end is exclusive, before the line's newline). Nested blocks (quote and list-item
 * children) carry offsets into the same source, not into the stripped content.
 * @typedef {(
 *   {type: "paragraph", children: Inline[], start: number, end: number}
 * | {type: "heading", level: 1|2|3, children: Inline[], start: number, end: number}
 * | {type: "code", lang: string, text: string, start: number, end: number}
 * | {type: "quote", children: Block[], start: number, end: number}
 * | {type: "list", ordered: boolean, first: number, items: ListItem[], start: number, end: number}
 * | {type: "hr", start: number, end: number}
 * )} Block
 */

/**
 * @typedef {{children: Block[], start: number, end: number}} ListItem
 */

/** Block nesting (quotes in lists in quotes...) beyond this is read as paragraph text. */
export const MAX_BLOCK_DEPTH = 6;
/** Inline nesting (bold in a link in italic...) beyond this is read as plain text. */
export const MAX_INLINE_DEPTH = 6;
/** indexOf calls the inline scanner may spend on one paragraph before giving up on markup. */
const INLINE_BUDGET = 20_000;
const URL_MAX = 2000;

const BLIP_ID_RE = /b_[0-9a-f]{12}(?![0-9a-zA-Z_])/y;
const BARE_URL_RE = /https?:\/\/[^\s<>"'`]+/y;
const SAFE_SCHEME_RE = /^(https?:\/\/|mailto:)/i;
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`~]*)/;
const HEADING_RE = /^ {0,3}(#{1,3})(?:[ \t]+(.*?))?[ \t]*$/;
const HR_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE_RE = /^ {0,3}> ?/;
const ITEM_RE = /^( *)([-*+]|\d{1,9}[.)])(?:[ \t]+|$)/;
const BLANK_RE = /^[ \t]*$/;
const WORD_RE = /[\p{L}\p{N}_]/u;
const PUNCT_RE = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;

/**
 * @typedef {{text: string, start: number, end: number}} Line  offsets into the ORIGINAL source
 */

/**
 * @param {string} text
 * @returns {Line[]}
 */
function splitLines(text) {
  /** @type {Line[]} */
  const lines = [];
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    const ch = i < text.length ? text.charCodeAt(i) : 10;
    if (ch === 10 || ch === 13) {
      lines.push({ text: text.slice(start, i), start, end: i });
      if (ch === 13 && text.charCodeAt(i + 1) === 10) i++;
      start = i + 1;
    }
  }
  return lines;
}

/** @param {Line} line */
const isBlank = (line) => BLANK_RE.test(line.text);

/**
 * The list "type" of an item match: the bullet character, or "o" plus the number delimiter.
 * @param {RegExpExecArray} m
 */
const itemMarker = (m) => (/\d/.test(m[2][0]) ? "o" + m[2][m[2].length - 1] : m[2]);

/**
 * Whether a line starts a block other than a paragraph (so it interrupts one).
 * @param {Line} line @param {number} depth
 */
function startsBlock(line, depth) {
  const t = line.text;
  if (FENCE_OPEN_RE.test(t) || HEADING_RE.test(t) || HR_RE.test(t)) return true;
  if (depth >= MAX_BLOCK_DEPTH) return false;
  return QUOTE_RE.test(t) || ITEM_RE.test(t);
}

/**
 * @param {Line[]} lines
 * @param {number} depth
 * @returns {Block[]}
 */
function parseBlocks(lines, depth) {
  /** @type {Block[]} */
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const t = line.text;

    const fence = FENCE_OPEN_RE.exec(t);
    if (fence) {
      const marker = fence[1];
      let j = i + 1;
      let closed = false;
      for (; j < lines.length; j++) {
        const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[j].text);
        if (m && m[1][0] === marker[0] && m[1].length >= marker.length) { closed = true; break; }
      }
      const body = lines.slice(i + 1, j).map((l) => l.text).join("\n");
      const last = closed ? lines[j] : lines[Math.max(i, j - 1)];
      blocks.push({ type: "code", lang: fence[2].slice(0, 32), text: body, start: line.start, end: last.end });
      i = closed ? j + 1 : j;
      continue;
    }

    const heading = HEADING_RE.exec(t);
    if (heading) {
      const content = (heading[2] ?? "").replace(/[ \t]+#+$/, "").replace(/^#+$/, "").trim();
      blocks.push({ type: "heading", level: /** @type {1|2|3} */ (heading[1].length), children: parseInline(content, 0), start: line.start, end: line.end });
      i++;
      continue;
    }

    if (HR_RE.test(t)) {
      blocks.push({ type: "hr", start: line.start, end: line.end });
      i++;
      continue;
    }

    if (depth < MAX_BLOCK_DEPTH && QUOTE_RE.test(t)) {
      /** @type {Line[]} */
      const inner = [];
      let j = i;
      for (; j < lines.length; j++) {
        const m = QUOTE_RE.exec(lines[j].text);
        if (!m) break;
        inner.push({ text: lines[j].text.slice(m[0].length), start: lines[j].start + m[0].length, end: lines[j].end });
      }
      blocks.push({ type: "quote", children: parseBlocks(inner, depth + 1), start: line.start, end: lines[j - 1].end });
      i = j;
      continue;
    }

    const item = depth < MAX_BLOCK_DEPTH ? ITEM_RE.exec(t) : null;
    if (item) {
      const ordered = /\d/.test(item[2][0]);
      // A different bullet character or number delimiter starts a new list.
      const marker = itemMarker(item);
      const baseIndent = item[1].length;
      /** @type {ListItem[]} */
      const items = [];
      let j = i;
      let first = ordered ? Number(item[2].slice(0, -1)) : 1;
      if (!Number.isFinite(first)) first = 1;
      while (j < lines.length) {
        const m = ITEM_RE.exec(lines[j].text);
        if (!m || m[1].length > baseIndent + 1 || itemMarker(m) !== marker) break;
        const contentIndent = m[0].length || m[1].length + m[2].length + 1;
        /** @type {Line[]} */
        const own = [{ text: lines[j].text.slice(m[0].length), start: lines[j].start + m[0].length, end: lines[j].end }];
        let k = j + 1;
        let lastContent = j;
        for (; k < lines.length; k++) {
          const l = lines[k];
          if (isBlank(l)) { own.push({ text: "", start: l.start, end: l.end }); continue; }
          const indent = /^ */.exec(l.text)?.[0].length ?? 0;
          if (indent >= contentIndent) {
            own.push({ text: l.text.slice(contentIndent), start: l.start + contentIndent, end: l.end });
            lastContent = k;
            continue;
          }
          // Less indented: a sibling item, another block, or a lazy paragraph continuation.
          if (ITEM_RE.test(l.text) || startsBlock(l, depth + 1) || isBlank(lines[k - 1])) break;
          own.push({ text: l.text.trimStart(), start: l.start + indent, end: l.end });
          lastContent = k;
        }
        while (own.length > 1 && own[own.length - 1].text === "") own.pop();
        items.push({ children: parseBlocks(own, depth + 1), start: lines[j].start, end: lines[lastContent].end });
        // Skip the blank lines that followed; the list continues only with another item.
        j = k;
        if (j < lines.length && isBlank(lines[j])) {
          let p = j;
          while (p < lines.length && isBlank(lines[p])) p++;
          const next = p < lines.length ? ITEM_RE.exec(lines[p].text) : null;
          if (next && next[1].length <= baseIndent + 1 && itemMarker(next) === marker) j = p;
          else break;
        }
      }
      blocks.push({ type: "list", ordered, first, items, start: line.start, end: items[items.length - 1].end });
      i = j;
      continue;
    }

    // Paragraph: consecutive non-blank lines up to the next block start.
    let j = i + 1;
    while (j < lines.length && !isBlank(lines[j]) && !startsBlock(lines[j], depth)) j++;
    const text = lines.slice(i, j).map((l) => l.text.trim()).join("\n");
    blocks.push({ type: "paragraph", children: parseInline(text, 0), start: line.start, end: lines[j - 1].end });
    i = j;
  }
  return blocks;
}

/**
 * Inline scanner. Emphasis needs a closer that is not preceded by whitespace and content that
 * does not start with whitespace; otherwise the marker is literal. Backslash escapes ASCII
 * punctuation. `depth` bounds recursion; `budget` bounds the total search work.
 * @param {string} s
 * @param {number} depth
 * @param {{n: number}} [budget]
 * @returns {Inline[]}
 */
function parseInline(s, depth, budget = { n: INLINE_BUDGET }) {
  /** @type {Inline[]} */
  const out = [];
  let buf = "";
  const flush = () => { if (buf) { out.push({ type: "text", text: buf }); buf = ""; } };
  const literal = depth >= MAX_INLINE_DEPTH;

  /**
   * First index >= from where `delim` closes an emphasis run (not preceded by whitespace).
   * @param {string} delim @param {number} from
   */
  const findCloser = (delim, from) => {
    let j = s.indexOf(delim, from);
    while (j !== -1) {
      if (--budget.n < 0) return -1;
      if (!/\s/.test(s[j - 1]) && (delim !== "_" || !WORD_RE.test(s[j + 1] ?? ""))) return j;
      j = s.indexOf(delim, j + 1);
    }
    return -1;
  };

  for (let i = 0; i < s.length;) {
    const ch = s[i];
    if (ch === "\n") { flush(); out.push({ type: "break" }); i++; continue; }
    if (literal || budget.n <= 0) { buf += ch; i++; continue; }

    if (ch === "\\" && i + 1 < s.length && PUNCT_RE.test(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }

    if (ch === "`") {
      let k = 1;
      while (s[i + k] === "`") k++;
      const run = "`".repeat(k);
      let j = s.indexOf(run, i + k);
      while (j !== -1 && s[j + k] === "`") {
        if (--budget.n < 0) { j = -1; break; }
        let e = j + k;
        while (s[e] === "`") e++;
        j = s.indexOf(run, e);
      }
      if (j === -1) { buf += run; i += k; continue; }
      let code = s.slice(i + k, j).replace(/\n/g, " ");
      if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);
      flush();
      out.push({ type: "code", text: code });
      i = j + k;
      continue;
    }

    if (ch === "*" || ch === "_") {
      const triple = s[i + 1] === ch && s[i + 2] === ch && s[i + 3] !== ch;
      const double = !triple && s[i + 1] === ch;
      const delim = triple ? ch + ch + ch : double ? ch + ch : ch;
      const after = s[i + delim.length] ?? "";
      const before = s[i - 1] ?? "";
      const flanking = after !== "" && !/\s/.test(after) && after !== ch
        && (ch !== "_" || !WORD_RE.test(before));
      const j = flanking ? findCloser(delim, i + delim.length + 1) : -1;
      if (j === -1) { buf += delim; i += delim.length; continue; }
      flush();
      const children = parseInline(s.slice(i + delim.length, j), depth + 1, budget);
      out.push(triple ? { type: "bold", children: [{ type: "italic", children }] }
        : double ? { type: "bold", children } : { type: "italic", children });
      i = j + delim.length;
      continue;
    }

    if (ch === "[") {
      const close = matchBracket(s, i, budget);
      if (close !== -1 && s[close + 1] === "(") {
        const end = matchParen(s, close + 1, budget);
        const url = end === -1 ? null : s.slice(close + 2, end);
        if (url !== null && url.length <= URL_MAX && !/[\s<>]/.test(url)) {
          const label = s.slice(i + 1, close);
          const raw = s.slice(i, end + 1);
          flush();
          if (SAFE_SCHEME_RE.test(url)) out.push({ type: "link", href: url, children: parseInline(label, depth + 1, budget) });
          else out.push({ type: "text", text: raw });
          i = end + 1;
          continue;
        }
      }
      buf += ch;
      i++;
      continue;
    }

    if (ch === "b" && s[i + 1] === "_" && !WORD_RE.test(s[i - 1] ?? "")) {
      BLIP_ID_RE.lastIndex = i;
      const m = BLIP_ID_RE.exec(s);
      if (m) { flush(); out.push({ type: "bliplink", id: m[0] }); i += m[0].length; continue; }
    }

    if (ch === "h" && (s.startsWith("http://", i) || s.startsWith("https://", i)) && !WORD_RE.test(s[i - 1] ?? "")) {
      BARE_URL_RE.lastIndex = i;
      const m = BARE_URL_RE.exec(s);
      if (m) {
        let url = m[0].replace(/[.,;:!?'")\]]+$/, "");
        // Keep a closing paren that balances one inside the URL (Wikipedia-style links).
        if (m[0].endsWith(")") && (url.match(/\(/g) ?? []).length > (url.match(/\)/g) ?? []).length) url += ")";
        const scheme = url.startsWith("https") ? 8 : 7;
        if (url.length > scheme && url.length <= URL_MAX) {
          flush();
          out.push({ type: "link", href: url, children: [{ type: "text", text: url }] });
          i += url.length;
          continue;
        }
      }
    }

    buf += ch;
    i++;
  }
  flush();
  return out;
}

/**
 * Index of the "]" matching the "[" at `open`, honouring nesting and backslash escapes; -1 when
 * unmatched or the budget runs out.
 * @param {string} s @param {number} open @param {{n: number}} budget
 */
function matchBracket(s, open, budget) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (--budget.n < 0) return -1;
    const ch = s[i];
    if (ch === "\\") { i++; continue; }
    if (ch === "[") depth++;
    else if (ch === "]" && --depth === 0) return i;
    else if (ch === "\n" && depth > 0 && s[i + 1] === "\n") return -1;
  }
  return -1;
}

/**
 * Index of the ")" matching the "(" at `open` (balanced parens, no whitespace allowed inside a
 * link destination); -1 when unmatched, when whitespace appears first, or when the budget runs out.
 * @param {string} s @param {number} open @param {{n: number}} budget
 */
function matchParen(s, open, budget) {
  let depth = 0;
  for (let i = open; i < s.length && i - open <= URL_MAX + 2; i++) {
    if (--budget.n < 0) return -1;
    const ch = s[i];
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i;
    else if (ch === "\n") return -1;
  }
  return -1;
}

/**
 * The node tree of a Markdown-lite text.
 * @param {string} text
 * @returns {Block[]}
 */
export function parseMarkdown(text) {
  if (typeof text !== "string" || !text) return [];
  return parseBlocks(splitLines(text), 0);
}

/**
 * Character offsets of each top-level block, in order: `start` is the offset of the block's
 * first character (a "Reply after this paragraph" anchor is a relative position at `start`),
 * `end` the exclusive end of its last line.
 * @param {string} text
 * @returns {{start: number, end: number}[]}
 */
export function paragraphsOf(text) {
  return parseMarkdown(text).map((b) => ({ start: b.start, end: b.end }));
}

/**
 * The text of a tree without markup: inline nodes joined, blocks separated by blank lines, list
 * items prefixed with "- " or "N. ", quotes with "> ".
 * @param {Block[]} blocks
 * @returns {string}
 */
export function plainText(blocks) {
  return blocks.map((b) => blockText(b)).join("\n\n");
}

/** @param {Block} b @returns {string} */
function blockText(b) {
  switch (b.type) {
    case "paragraph":
    case "heading":
      return inlineText(b.children);
    case "code":
      return b.text;
    case "hr":
      return "";
    case "quote":
      return plainText(b.children).split("\n").map((l) => "> " + l).join("\n");
    case "list":
      return b.items.map((item, n) => {
        const prefix = b.ordered ? `${b.first + n}. ` : "- ";
        const body = item.children.map((c) => blockText(c)).join("\n").split("\n");
        return body.map((l, k) => (k === 0 ? prefix : " ".repeat(prefix.length)) + l).join("\n");
      }).join("\n");
    default:
      return "";
  }
}

/**
 * @param {Inline[]} nodes
 * @returns {string}
 */
export function inlineText(nodes) {
  let s = "";
  for (const n of nodes) {
    switch (n.type) {
      case "text": case "code": s += n.text; break;
      case "bliplink": s += n.id; break;
      case "break": s += "\n"; break;
      case "bold": case "italic": case "link": s += inlineText(n.children); break;
    }
  }
  return s;
}

/**
 * The first line of `text` with block and inline markers stripped, whitespace collapsed, at most
 * `max` characters (no ellipsis; the caller adds one when the text is longer). "" for an empty or
 * marker-only text. Fenced code returns its first content line.
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
export function firstLine(text, max) {
  if (typeof text !== "string") return "";
  const lines = text.split(/\r\n|\r|\n/, 400);
  for (let line of lines) {
    if (FENCE_OPEN_RE.test(line) || HR_RE.test(line)) continue;
    line = line.replace(/^ {0,3}(?:#{1,6}[ \t]+|>[ \t]?|(?:[-*+]|\d{1,9}[.)])[ \t]+)+/, "");
    const nodes = parseInline(line.slice(0, Math.max(max * 4, 400)), 0);
    const plain = inlineText(nodes).replace(/\s+/g, " ").trim();
    if (plain) return plain.slice(0, max);
  }
  return "";
}

/**
 * Every blip id cited in a text (bliplink nodes), in order of first appearance.
 * @param {string} text
 * @returns {string[]}
 */
export function citedBlipIds(text) {
  /** @type {string[]} */
  const ids = [];
  const seen = new Set();
  /** @param {Inline[]} nodes */
  const walkInline = (nodes) => {
    for (const n of nodes) {
      if (n.type === "bliplink" && !seen.has(n.id)) { seen.add(n.id); ids.push(n.id); }
      else if (n.type === "bold" || n.type === "italic" || n.type === "link") walkInline(n.children);
    }
  };
  /** @param {Block[]} blocks */
  const walk = (blocks) => {
    for (const b of blocks) {
      if (b.type === "paragraph" || b.type === "heading") walkInline(b.children);
      else if (b.type === "quote") walk(b.children);
      else if (b.type === "list") for (const item of b.items) walk(item.children);
    }
  };
  walk(parseMarkdown(text));
  return ids;
}
