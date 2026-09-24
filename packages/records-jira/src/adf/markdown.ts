// ADF ↔ Markdown for the supported subset.
//
// The Markdown dialect (what the Projects module stores):
//   paragraphs; ATX headings (`# `…`###### `); `-` / `*` bullet lists and `1.` / `1)` ordered
//   lists, nested by indentation; fenced code blocks with an optional language; inline
//   `**strong**`, `_em_` (or `*em*`), `` `code` ``, `[text](href "title")`, and mentions written
//   as `[@Display Name](mention:<accountId>)` — an ordinary link to any other Markdown renderer.
// A line break inside a paragraph is an ADF hardBreak (and a hardBreak is written as a plain
// newline), so text typed with single newlines keeps its lines in Jira. Anything else in Markdown
// (quotes, tables, HTML, images) is kept as literal text.
//
// Round trips are exact for canonical input, up to these normalisations: whitespace at the edges
// of strong/em spans moves outside the span, adjacent text with identical marks merges, empty
// paragraphs and empty text disappear, paragraph edges are trimmed, a hardBreak inside a heading
// becomes a space, and marks are ordered link, strong, em, code. Known limit (shared with
// CommonMark itself): strong/em whose text begins or ends with punctuation pressed against a word
// on the outside may read back differently; word-bounded emphasis always round-trips.

import type { AdfBlock, AdfDoc, AdfInline, AdfListItem, AdfMark, AdfText } from "./schema.js";

// ---------------------------------------------------------------------------------------------
// ADF → Markdown

const MARK_ORDER = ["link", "strong", "em", "code"] as const;

function sortMarks(marks: AdfMark[] | undefined): AdfMark[] {
  return [...(marks ?? [])].sort((a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type));
}

function sameMark(a: AdfMark, b: AdfMark): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "link" && b.type === "link") return a.attrs.href === b.attrs.href && (a.attrs.title ?? "") === (b.attrs.title ?? "");
  return true;
}

function sameMarks(a: AdfMark[] | undefined, b: AdfMark[] | undefined): boolean {
  const x = sortMarks(a);
  const y = sortMarks(b);
  return x.length === y.length && x.every((m, i) => sameMark(m, y[i]!));
}

const isCode = (n: AdfInline) => n.type === "text" && !!n.marks?.some((m) => m.type === "code");

function mergeRuns(nodes: AdfInline[]): AdfInline[] {
  const merged: AdfInline[] = [];
  for (const n of nodes) {
    if (n.type === "text" && !n.text) continue;
    const prev = merged[merged.length - 1];
    if (n.type === "text" && prev?.type === "text" && sameMarks(prev.marks, n.marks)) {
      merged[merged.length - 1] = { ...prev, text: prev.text + n.text };
    } else merged.push(n);
  }
  return merged;
}

/**
 * Put inline content in the form Markdown can carry: newlines in text become hardBreaks (spaces
 * in code), whitespace at the edges of strong/em spans and of lines moves out or is dropped,
 * hardBreaks at the edges disappear, and neighbours with identical marks merge.
 */
export function normaliseInlines(nodes: AdfInline[]): AdfInline[] {
  const split: AdfInline[] = [];
  for (const n of nodes) {
    if (n.type !== "text") {
      split.push(n);
      continue;
    }
    const marks = sortMarks(n.marks);
    const code = marks.some((m) => m.type === "code");
    const lines = code ? [n.text.replace(/\n/g, " ")] : n.text.split("\n");
    lines.forEach((text, i) => {
      if (i > 0) split.push({ type: "hardBreak" });
      if (!text) return;
      const emphatic = marks.some((m) => m.type === "strong" || m.type === "em") && !code;
      if (!emphatic) {
        split.push(marks.length ? { type: "text", text, marks } : { type: "text", text });
        return;
      }
      const plainMarks = marks.filter((m) => m.type === "link");
      const lead = /^\s+/.exec(text)?.[0] ?? "";
      const trail = /\s+$/.exec(text.slice(lead.length))?.[0] ?? "";
      const core = text.slice(lead.length, text.length - trail.length);
      const plain = (t: string): AdfText => (plainMarks.length ? { type: "text", text: t, marks: plainMarks } : { type: "text", text: t });
      if (lead) split.push(plain(lead));
      if (core) split.push({ type: "text", text: core, marks });
      if (trail) split.push(plain(trail));
    });
  }
  const merged = mergeRuns(split);
  // Trim whitespace at line edges (Markdown drops it), outside code.
  for (let i = 0; i < merged.length; i++) {
    const n = merged[i]!;
    if (n.type !== "text" || isCode(n)) continue;
    const prev = merged[i - 1];
    const next = merged[i + 1];
    let text = n.text;
    if (!prev || prev.type === "hardBreak") text = text.replace(/^\s+/, "");
    if (!next || next.type === "hardBreak") text = text.replace(/\s+$/, "");
    merged[i] = { ...n, text };
  }
  const out = mergeRuns(merged);
  while (out[0]?.type === "hardBreak") out.shift();
  while (out[out.length - 1]?.type === "hardBreak") out.pop();
  // Trimming can expose new line edges (a node that was only whitespace); repeat until stable.
  return JSON.stringify(out) === JSON.stringify(nodes) ? out : normaliseInlines(out);
}

const ESCAPE_ANYWHERE = /[\\`*_[\]]/g;

function escapeText(text: string): string {
  return text.replace(ESCAPE_ANYWHERE, (c) => `\\${c}`);
}

function codeSpan(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") || (text.startsWith(" ") && text.endsWith(" ") && text.trim() !== "") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

function linkDestination(href: string, title?: string): string {
  const dest = /[\s()<>]/.test(href) || href === "" ? `<${href.replace(/[<>\\]/g, (c) => `\\${c}`)}>` : href.replace(/\\/g, "\\\\");
  return title ? `${dest} "${title.replace(/["\\]/g, (c) => `\\${c}`)}"` : dest;
}

const isAlnum = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);

function renderInlines(input: AdfInline[]): string {
  const nodes = normaliseInlines(input);
  let out = "";
  // Open marks, outermost first, with where each opener was written (em may switch _ → *).
  const active: { mark: AdfMark; at: number; delim: string }[] = [];

  const closeFrom = (index: number, nextChar: string | undefined) => {
    while (active.length > index) {
      const a = active.pop()!;
      if (a.mark.type === "link") out += `](${linkDestination(a.mark.attrs.href, a.mark.attrs.title)})`;
      else {
        if (a.delim === "_" && isAlnum(nextChar)) {
          out = `${out.slice(0, a.at)}*${out.slice(a.at + 1)}`;
          a.delim = "*";
        }
        out += a.delim;
      }
    }
  };

  // A `!` right before a link would read as an image elsewhere.
  const guardBang = () => {
    if (out.endsWith("!") && !out.endsWith("\\!")) out = `${out.slice(0, -1)}\\!`;
  };

  for (const node of nodes) {
    const marks = node.type === "text" ? sortMarks(node.marks).filter((m) => m.type !== "code") : [];
    let keep = 0;
    while (keep < active.length && marks.some((m) => sameMark(m, active[keep]!.mark))) keep++;
    const toOpen = marks.filter((m) => !active.slice(0, keep).some((a) => sameMark(a.mark, m)));
    const firstChar = node.type === "text" ? node.text[0] : node.type === "mention" ? "[" : "\n";
    closeFrom(keep, toOpen.length ? "*" : firstChar);
    for (const m of toOpen) {
      if (m.type === "link") {
        guardBang();
        active.push({ mark: m, at: out.length, delim: "[" });
        out += "[";
      } else if (m.type === "strong") {
        active.push({ mark: m, at: out.length, delim: "**" });
        out += "**";
      } else {
        const delim = isAlnum(out[out.length - 1]) ? "*" : "_";
        active.push({ mark: m, at: out.length, delim });
        out += delim;
      }
    }
    // A second break in a row is written `\` + newline, so the empty line does not end the paragraph.
    if (node.type === "hardBreak") out += out.endsWith("\n") || out === "" ? "\\\n" : "\n";
    else if (node.type === "mention") {
      const text = (node.attrs.text ?? `@${node.attrs.id}`).replace(/^@/, "");
      guardBang();
      out += `[@${escapeText(text)}](${linkDestination(`mention:${node.attrs.id}`)})`;
    } else if (node.marks?.some((m) => m.type === "code")) out += codeSpan(node.text);
    else out += escapeText(node.text);
  }
  closeFrom(0, undefined);
  // Characters that would start a block at the beginning of a line are escaped.
  return out
    .split("\n")
    .map((line) => line.replace(/^(\s*)([#>+\-=~])/, "$1\\$2").replace(/^(\s*\d+)([.)])(?=\s|$)/, "$1\\$2"))
    .join("\n");
}

function renderCode(block: { attrs?: { language?: string | null }; content?: AdfText[] }): string {
  const text = (block.content ?? []).map((t) => t.text).join("");
  const longest = Math.max(2, ...[...text.matchAll(/^\s*(`{3,})/gm)].map((m) => m[1]!.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${block.attrs?.language ?? ""}\n${text}${text && !text.endsWith("\n") ? "\n" : ""}${fence}`;
}

function indent(text: string, width: number): string {
  const pad = " ".repeat(width);
  return text
    .split("\n")
    .map((l, i) => (i === 0 || l === "" ? l : pad + l))
    .join("\n");
}

const isEmptyParagraph = (b: AdfBlock) => b.type === "paragraph" && normaliseInlines(b.content ?? []).length === 0;

function renderListItem(item: AdfListItem, marker: string): string {
  let body = "";
  const blocks = item.content.filter((b) => !isEmptyParagraph(b));
  blocks.forEach((b, i) => {
    const prev = blocks[i - 1];
    if (i > 0) body += b.type === "bulletList" || b.type === "orderedList" ? (prev?.type === b.type ? "\n\n" : "\n") : "\n\n";
    body += renderBlock(b, prev);
  });
  return marker + (body ? " " : "") + indent(body, marker.length + 1);
}

function renderBlock(block: AdfBlock, prev: AdfBlock | undefined): string {
  switch (block.type) {
    case "paragraph":
      return renderInlines(block.content ?? []);
    case "heading": {
      const text = renderInlines((block.content ?? []).map((n) => (n.type === "hardBreak" ? ({ type: "text", text: " " } as AdfText) : n)));
      return `${"#".repeat(block.attrs.level)} ${text.replace(/^\\([#])/, "$1")}`.trimEnd();
    }
    case "codeBlock":
      return renderCode(block);
    case "bulletList": {
      // Two lists in a row need different markers or they would read back as one.
      const bullet = prev?.type === "bulletList" ? "*" : "-";
      return block.content.map((item) => renderListItem(item, bullet)).join("\n");
    }
    case "orderedList": {
      const delim = prev?.type === "orderedList" ? ")" : ".";
      const start = block.attrs?.order ?? 1;
      return block.content.map((item, i) => renderListItem(item, `${start + i}${delim}`)).join("\n");
    }
  }
}

function renderBlocks(blocks: AdfBlock[]): string {
  const parts: string[] = [];
  blocks.forEach((b, i) => {
    if (isEmptyParagraph(b)) return;
    parts.push(renderBlock(b, blocks[i - 1]));
  });
  return parts.join("\n\n");
}

/** Serialise a validated ADF document to Markdown. */
export function adfToMarkdown(doc: AdfDoc): string {
  return renderBlocks(doc.content);
}

// ---------------------------------------------------------------------------------------------
// Markdown → ADF

const ITEM_RE = /^( {0,3})([-+*]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/;
const FENCE_RE = /^( {0,3})(`{3,}|~{3,})[ \t]*([^`\s]*)[^`]*$/;
const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;

const isBlank = (l: string) => l.trim() === "";
const indentOf = (l: string) => /^ */.exec(l)![0].length;

function startsBlock(line: string): boolean {
  return FENCE_RE.test(line) || HEADING_RE.test(line) || ITEM_RE.test(line);
}

function listKind(marker: string): string {
  return /\d/.test(marker) ? `ol${marker.slice(-1)}` : `ul${marker}`;
}

function parseBlocks(lines: string[]): AdfBlock[] {
  const blocks: AdfBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i++;
      continue;
    }
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const [, ind, marks, lang] = fence;
      const body: string[] = [];
      i++;
      const closeRe = new RegExp(`^ {0,3}${marks![0] === "`" ? "`" : "~"}{${marks!.length},}[ \\t]*$`);
      while (i < lines.length && !closeRe.test(lines[i]!)) {
        const l = lines[i]!;
        body.push(l.slice(Math.min(indentOf(l), ind!.length)));
        i++;
      }
      i++; // the closing fence (or the end)
      const text = body.join("\n");
      const content: AdfText[] = text ? [{ type: "text", text }] : [];
      blocks.push(lang ? { type: "codeBlock", attrs: { language: lang }, content } : { type: "codeBlock", content });
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading) {
      blocks.push({ type: "heading", attrs: { level: heading[1]!.length }, content: parseInlines(heading[2] ?? "") });
      i++;
      continue;
    }
    const item = ITEM_RE.exec(line);
    if (item) {
      i = parseList(lines, i, blocks);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && !isBlank(lines[i]!) && (para.length === 0 || !startsBlock(lines[i]!))) {
      para.push(lines[i]!.replace(/^[ \t]+/, "").replace(/(?<!\\)[ \t]+$/, ""));
      i++;
    }
    blocks.push({ type: "paragraph", content: parseInlines(para.join("\n")) });
  }
  return blocks;
}

function parseList(lines: string[], start: number, out: AdfBlock[]): number {
  const first = ITEM_RE.exec(lines[start]!)!;
  const kind = listKind(first[2]!);
  const items: AdfListItem[] = [];
  let i = start;
  while (i < lines.length) {
    const m = ITEM_RE.exec(lines[i]!);
    if (!m || listKind(m[2]!) !== kind) break;
    const spaces = m[3]?.length ?? 1;
    const contentIndent = m[1]!.length + m[2]!.length + (spaces > 4 ? 1 : spaces);
    const itemLines: string[] = [spaces > 4 ? " ".repeat(spaces - 1) + (m[4] ?? "") : m[4] ?? ""];
    i++;
    while (i < lines.length) {
      const l = lines[i]!;
      if (isBlank(l)) {
        let j = i;
        while (j < lines.length && isBlank(lines[j]!)) j++;
        if (j < lines.length && indentOf(lines[j]!) >= contentIndent) {
          for (; i < j; i++) itemLines.push("");
          continue;
        }
        break;
      }
      if (indentOf(l) >= contentIndent) {
        itemLines.push(l.slice(contentIndent));
        i++;
        continue;
      }
      if (startsBlock(l)) break;
      const last = itemLines[itemLines.length - 1];
      if (last !== undefined && !isBlank(last)) {
        itemLines.push(l.trimStart());
        i++;
        continue;
      }
      break;
    }
    const content = parseBlocks(itemLines);
    items.push({ type: "listItem", content: content.length ? content : [{ type: "paragraph", content: [] }] });
    let j = i;
    while (j < lines.length && isBlank(lines[j]!)) j++;
    const next = j < lines.length ? ITEM_RE.exec(lines[j]!) : null;
    if (next && listKind(next[2]!) === kind) i = j;
    else break;
  }
  if (kind.startsWith("ol")) {
    const order = Number(/\d+/.exec(first[2]!)![0]);
    out.push(order !== 1 ? { type: "orderedList", attrs: { order }, content: items } : { type: "orderedList", content: items });
  } else out.push({ type: "bulletList", content: items });
  return i;
}

const PUNCT = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c);

function runLength(s: string, i: number, ch: string, end: number): number {
  let n = 0;
  while (i + n < end && s[i + n] === ch) n++;
  return n;
}

/** Index of the closing backtick run for a code span opened at `i` with `n` backticks, or -1. */
function codeClose(s: string, i: number, n: number, end: number): number {
  let j = i + n;
  while (j < end) {
    if (s[j] === "`") {
      const r = runLength(s, j, "`", end);
      if (r === n) return j;
      j += r;
    } else j++;
  }
  return -1;
}

/** Unescaped `ch` delimiters outside code spans in [from, to): odd means an inner span is still open. */
function delimiterCount(s: string, from: number, to: number, ch: string): number {
  let n = 0;
  for (let j = from; j < to; j++) {
    if (s[j] === "\\") j++;
    else if (s[j] === "`") {
      const r = runLength(s, j, "`", to);
      const close = codeClose(s, j, r, to);
      j = (close < 0 ? j + r : close + r) - 1;
    } else if (s[j] === ch) n++;
  }
  return n;
}

function findCloser(s: string, from: number, end: number, ch: string, d: number, openerRun: number): number {
  let j = from;
  while (j < end) {
    const c = s[j]!;
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "`") {
      const n = runLength(s, j, "`", end);
      const close = codeClose(s, j, n, end);
      j = close < 0 ? j + n : close + n;
      continue;
    }
    if (c === ch) {
      const r = runLength(s, j, ch, end);
      const before = s[j - 1];
      const after = j + r < end ? s[j + r] : undefined;
      const okBefore = j > from && !isSpace(before);
      const okAfter = ch !== "_" || !isAlnum(after);
      if (okBefore && okAfter) {
        if (d === 1 && r === 1) return j;
        // Delimiter runs longer than the opener: a run that cannot open anything closes with its
        // last delimiters (the earlier ones close inner spans); one that can also open closes with
        // its first (CommonMark's order), subject to the "rule of 3".
        const leftFlanking = after !== undefined && !isSpace(after) && (!PUNCT.test(after) || isSpace(before) || PUNCT.test(before!));
        if (d === 1 && r >= 2) {
          // An inner `**` still open (two delimiters beyond balanced pairs) closes first.
          if (!leftFlanking || delimiterCount(s, from, j, ch) % 4 === 2) return j + r - 1;
          if ((1 + r) % 3 !== 0) return j;
        }
        if (d === 2 && r >= 2) {
          const takeLast = r >= 3 && (openerRun >= 3 || !leftFlanking || delimiterCount(s, from, j, ch) % 2 === 1);
          return takeLast ? j + r - 2 : j;
        }
      }
      j += r;
      continue;
    }
    j++;
  }
  return -1;
}

/** Scan a link `[text](dest "title")` at `i`. */
function scanLink(s: string, i: number, end: number): { textEnd: number; href: string; title?: string; next: number } | null {
  let depth = 0;
  let j = i;
  for (; j < end; j++) {
    const c = s[j];
    if (c === "\\") {
      j++;
      continue;
    }
    if (c === "`") {
      const n = runLength(s, j, "`", end);
      const close = codeClose(s, j, n, end);
      if (close >= 0) j = close + n - 1;
      else j += n - 1;
      continue;
    }
    if (c === "[") depth++;
    else if (c === "]" && --depth === 0) break;
  }
  if (j >= end || s[j + 1] !== "(") return null;
  const textEnd = j;
  let k = j + 2;
  while (k < end && s[k] === " ") k++;
  let href = "";
  if (s[k] === "<") {
    k++;
    while (k < end && s[k] !== ">") {
      if (s[k] === "\\" && k + 1 < end) k++;
      else if (s[k] === "\n") return null;
      href += s[k];
      k++;
    }
    if (s[k] !== ">") return null;
    k++;
  } else {
    let parens = 0;
    while (k < end && !/\s/.test(s[k]!)) {
      if (s[k] === "\\" && k + 1 < end && PUNCT.test(s[k + 1]!)) {
        href += s[k + 1];
        k += 2;
        continue;
      }
      if (s[k] === "(") parens++;
      if (s[k] === ")") {
        if (parens === 0) break;
        parens--;
      }
      href += s[k];
      k++;
    }
  }
  while (k < end && s[k] === " ") k++;
  let title: string | undefined;
  if (s[k] === '"') {
    k++;
    title = "";
    while (k < end && s[k] !== '"') {
      if (s[k] === "\\" && k + 1 < end) k++;
      title += s[k];
      k++;
    }
    if (s[k] !== '"') return null;
    k++;
    while (k < end && s[k] === " ") k++;
  }
  if (s[k] !== ")") return null;
  return { textEnd, href, ...(title ? { title } : {}), next: k + 1 };
}

function unescapeText(s: string): string {
  return s.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "$1");
}

function parseRange(s: string, start: number, end: number, marks: AdfMark[], out: AdfInline[]): void {
  let buf = "";
  const flush = () => {
    if (buf) out.push(marks.length ? { type: "text", text: buf, marks: [...marks] } : { type: "text", text: buf });
    buf = "";
  };
  const withMark = (m: AdfMark) => (marks.some((x) => x.type === m.type) ? marks : [...marks, m]);
  let i = start;
  while (i < end) {
    const c = s[i]!;
    if (c === "\\" && i + 1 < end) {
      const n = s[i + 1]!;
      if (n === "\n") {
        flush();
        out.push({ type: "hardBreak" });
        i += 2;
        continue;
      }
      if (PUNCT.test(n)) {
        buf += n;
        i += 2;
        continue;
      }
    }
    if (c === "\n") {
      flush();
      out.push({ type: "hardBreak" });
      i++;
      continue;
    }
    if (c === "`") {
      const n = runLength(s, i, "`", end);
      const close = codeClose(s, i, n, end);
      if (close >= 0) {
        flush();
        let text = s.slice(i + n, close).replace(/\n/g, " ");
        if (text.length >= 2 && text.startsWith(" ") && text.endsWith(" ") && text.trim() !== "") text = text.slice(1, -1);
        const codeMarks = withMark({ type: "code" });
        if (text) out.push({ type: "text", text, marks: [...codeMarks] });
        i = close + n;
        continue;
      }
      buf += s.slice(i, i + n);
      i += n;
      continue;
    }
    if (c === "[") {
      const link = scanLink(s, i, end);
      if (link) {
        const textSrc = s.slice(i + 1, link.textEnd);
        if (link.href.startsWith("mention:") && link.href.length > 8) {
          flush();
          const name = unescapeText(textSrc).replace(/^@/, "");
          out.push({ type: "mention", attrs: { id: link.href.slice(8), text: `@${name}` } });
        } else {
          flush();
          const mark: AdfMark = { type: "link", attrs: link.title ? { href: link.href, title: link.title } : { href: link.href } };
          parseRange(s, i + 1, link.textEnd, withMark(mark), out);
        }
        i = link.next;
        continue;
      }
    }
    if (c === "*" || c === "_") {
      const run = runLength(s, i, c, end);
      const prevOk = c !== "_" || !isAlnum(s[i - 1]);
      let matched = false;
      for (const d of run >= 2 ? [2, 1] : [1]) {
        if (!prevOk || isSpace(s[i + d])) continue;
        const close = findCloser(s, i + d, end, c, d, run);
        if (close >= 0) {
          flush();
          parseRange(s, i + d, close, withMark(d === 2 ? { type: "strong" } : { type: "em" }), out);
          i = close + d;
          matched = true;
          break;
        }
      }
      if (matched) continue;
      buf += s.slice(i, i + run);
      i += run;
      continue;
    }
    buf += c;
    i++;
  }
  flush();
}

function parseInlines(text: string): AdfInline[] {
  const out: AdfInline[] = [];
  parseRange(text, 0, text.length, [], out);
  // Drop hard breaks at the edges and merge text runs.
  while (out[0]?.type === "hardBreak") out.shift();
  while (out[out.length - 1]?.type === "hardBreak") out.pop();
  return mergeText(out);
}

function mergeText(nodes: AdfInline[]): AdfInline[] {
  const merged: AdfInline[] = [];
  for (const n of nodes) {
    const node: AdfInline = n.type === "text" && n.marks ? { type: "text", text: n.text, marks: sortMarks(n.marks) } : n;
    const prev = merged[merged.length - 1];
    if (node.type === "text" && prev?.type === "text" && sameMarks(prev.marks, node.marks)) {
      merged[merged.length - 1] = { ...prev, text: prev.text + node.text };
    } else merged.push(node);
  }
  return merged;
}

/** Parse Markdown (the dialect above) into an ADF document. */
export function markdownToAdf(markdown: string): AdfDoc {
  const lines = markdown.replace(/\r\n?/g, "\n").replace(/^\t+/gm, (t) => "    ".repeat(t.length)).split("\n");
  const content = parseBlocks(lines).filter((b) => !(b.type === "paragraph" && (b.content ?? []).length === 0));
  return { type: "doc", version: 1, content };
}
