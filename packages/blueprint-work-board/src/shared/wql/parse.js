// @ts-check
// WQL parser: text → AST with positioned errors, plus the token stream used for highlighting.
// Never throws; bad terms are dropped from the best-effort AST.
//
//   query  := (or | sort-clause | ")" error)*
//   or     := and ("OR" and)*
//   and    := unary (("AND")? unary)*          AND binds tighter than OR
//   unary  := "-" unary | "NOT" unary | "(" or ")" | term | text
//   term   := field ":" op? value ("," value)*  op: < <= > >= =; value "a..b" is a range

import { COMPARABLE, FIELDS, PREDICATES, closest, didYouMean, fieldByName } from "./fields.js";

/**
 * @typedef {{ type: "and"|"or", children: Node[] }} GroupNode
 * @typedef {{ type: "not", child: Node }} NotNode
 * @typedef {{ type: "term", field: string, op: "eq"|"lt"|"lte"|"gt"|"gte"|"range", values: string[], span: [number, number] }} TermNode
 * @typedef {{ type: "is"|"has", value: string, span: [number, number] }} PredicateNode
 * @typedef {{ type: "text", value: string, span: [number, number] }} TextNode
 * @typedef {GroupNode|NotNode|TermNode|PredicateNode|TextNode} Node
 * @typedef {{ field: string, dir: "asc"|"desc" }} SortKey
 * @typedef {{ type: "query", where: Node|null, sort: SortKey[] }} Query
 * @typedef {{ message: string, start: number, end: number, suggestions: string[] }} WqlError
 * @typedef {{ start: number, end: number, kind: "field"|"op"|"value"|"keyword"|"paren"|"neg"|"text"|"sort"|"error" }} Token
 */

const OPS = /** @type {const} */ ([["<=", "lte"], [">=", "gte"], ["<", "lt"], [">", "gt"], ["=", "eq"]]);
const IDENT = /[A-Za-z_][A-Za-z0-9_.]*/y;
const SORT_FIELDS = FIELDS.filter((f) => f.sortable).flatMap((f) => [f.name, ...f.aliases]);
const FIELD_NAMES = [...FIELDS.map((f) => f.name), "is", "has", "sort"];

/** @param {string} source @returns {{ ast: Query, errors: WqlError[], tokens: Token[] }} */
export function parseFull(source) {
  const text = String(source ?? "");
  let pos = 0;
  /** @type {WqlError[]} */ const errors = [];
  /** @type {Token[]} */ const tokens = [];
  /** @type {SortKey[]} */ const sort = [];

  const err = (/** @type {string} */ message, /** @type {number} */ start, /** @type {number} */ end, suggestions = /** @type {string[]} */ ([])) => {
    errors.push({ message, start, end: Math.max(end, start), suggestions });
  };
  const tok = (/** @type {number} */ start, /** @type {number} */ end, /** @type {Token["kind"]} */ kind) => { if (end > start) tokens.push({ start, end, kind }); };
  const ws = () => { while (pos < text.length && /\s/.test(text[pos])) pos++; };
  const boundary = (/** @type {number} */ i) => i >= text.length || /[\s()]/.test(text[i]);

  /** The bare word at pos (up to whitespace, a paren or a quote), without consuming it. */
  const peekWord = () => {
    let end = pos;
    while (end < text.length && !/[\s()"]/.test(text[end])) end++;
    return text.slice(pos, end);
  };
  const keywordAt = (/** @type {string} */ kw) => peekWord().toUpperCase() === kw;

  /** Reads a double-quoted string at pos. */
  const quoted = () => {
    const start = pos++;
    let value = "";
    while (pos < text.length && text[pos] !== '"') {
      if (text[pos] === "\\" && pos + 1 < text.length) pos++;
      value += text[pos++];
    }
    if (pos >= text.length) { err("Unterminated quote: add a closing \".", start, text.length); return { value, start, end: pos, ok: false }; }
    pos++;
    return { value, start, end: pos, ok: true };
  };

  /** One value of a term: quoted or bare (up to whitespace, paren or comma). */
  const value = () => {
    if (text[pos] === '"') return { ...quoted(), bare: false };
    const start = pos;
    while (pos < text.length && !/[\s(),"]/.test(text[pos])) pos++;
    return { value: text.slice(start, pos), start, end: pos, ok: pos > start, bare: true };
  };

  /** @returns {Node|null} */
  function parseOr() {
    const children = [];
    const first = parseAnd();
    if (first.node) children.push(first.node);
    let before = first.consumed;
    for (;;) {
      ws();
      if (!keywordAt("OR")) break;
      const at = pos;
      pos += 2;
      tok(at, pos, "keyword");
      const next = parseAnd();
      if (!before || !next.consumed) err("OR needs a condition on both sides.", at, at + 2);
      if (next.node) children.push(next.node);
      before = next.consumed;
    }
    return group("or", children);
  }

  /** @returns {{ node: Node|null, consumed: boolean }} */
  function parseAnd() {
    const children = [];
    let consumed = false;
    for (;;) {
      ws();
      if (pos >= text.length || text[pos] === ")" || keywordAt("OR")) break;
      if (keywordAt("AND")) {
        const at = pos;
        pos += 3;
        tok(at, pos, "keyword");
        ws();
        if (!consumed || pos >= text.length || text[pos] === ")" || keywordAt("OR")) err("AND needs a condition on both sides.", at, at + 3);
        continue;
      }
      const result = parseUnary();
      consumed = true;
      if (result) children.push(result);
    }
    return { node: group("and", children), consumed };
  }

  /** @returns {Node|null} */
  function parseUnary() {
    const at = pos;
    if (text[pos] === "-" || keywordAt("NOT")) {
      const width = text[pos] === "-" ? 1 : 3;
      pos += width;
      tok(at, pos, width === 1 ? "neg" : "keyword");
      if (width === 3) ws();
      if (pos >= text.length || /[\s)]/.test(text[pos]) || (width === 3 && keywordAt("OR"))) {
        err(width === 1 ? "Nothing to exclude after “-”." : "Nothing to exclude after NOT.", at, at + width);
        return null;
      }
      const sortsBefore = sort.length;
      const child = parseUnary();
      if (sort.length > sortsBefore) { sort.length = sortsBefore; err("A sort cannot be excluded.", at, pos); }
      return child ? negate(child) : null;
    }
    if (text[pos] === "(") {
      tok(pos, pos + 1, "paren");
      pos++;
      const errorsBefore = errors.length;
      const inner = parseOr();
      ws();
      if (text[pos] === ")") {
        tok(pos, pos + 1, "paren");
        pos++;
        if (!inner && errors.length === errorsBefore && text.slice(at + 1, pos - 1).trim() === "") err("Empty parentheses.", at, pos);
      } else err("Missing “)” for this “(”.", at, at + 1);
      return inner;
    }
    if (text[pos] === '"') {
      const q = quoted();
      tok(q.start, q.end, "text");
      return { type: "text", value: q.value, span: [q.start, q.end] };
    }
    IDENT.lastIndex = pos;
    const ident = IDENT.exec(text);
    if (ident && text[pos + ident[0].length] === ":") return parseTerm(ident[0]);
    const word = peekWord();
    const start = pos;
    pos += word.length;
    if (!word) { pos++; tok(start, pos, "error"); err("Unexpected character.", start, pos); return null; }
    tok(start, pos, "text");
    return { type: "text", value: word, span: [start, pos] };
  }

  /** @param {string} name @returns {Node|null} */
  function parseTerm(name) {
    const start = pos;
    const lower = name.toLowerCase();
    pos += name.length + 1;
    const fieldEnd = pos;
    const field = lower === "is" || lower === "has" || lower === "sort" ? null : fieldByName(name);
    let op = /** @type {TermNode["op"]} */ ("eq");
    let opAt = pos;
    for (const [sym, name2] of OPS) if (text.startsWith(sym, pos)) { op = name2; pos += sym.length; break; }
    const opEnd = pos;
    /** @type {ReturnType<typeof value>[]} */
    const values = [];
    let broken = false;
    for (;;) {
      const v = value();
      if (!v.ok) {
        if (v.bare) { broken = true; err(values.length ? `Enter a value after the comma.` : `Enter a value for “${name}”.`, values.length ? v.start - 1 : start, v.start); }
        else { broken = true; values.push(v); }
        break;
      }
      values.push(v);
      if (text[pos] !== ",") break;
      pos++;
    }
    const end = pos;
    const mark = (/** @type {Token["kind"]} */ kind) => {
      tok(start, fieldEnd, kind);
      tok(opAt, opEnd, kind === "error" ? "error" : "op");
      for (const v of values) tok(v.start, v.end, kind === "error" ? "error" : kind === "sort" ? "sort" : "value");
    };
    if (broken) { mark("error"); return null; }

    if (lower === "sort") {
      mark("sort");
      if (op !== "eq") { err("sort: takes field names, not a comparison.", start, end); return null; }
      for (const v of values) {
        const desc = v.value.startsWith("-");
        const sf = fieldByName(desc ? v.value.slice(1) : v.value);
        if (!sf || !sf.sortable) err(didYouMean(`Cannot sort by “${v.value}”.`, closest(v.value.replace(/^-/, ""), SORT_FIELDS)), v.start, v.end, closest(v.value.replace(/^-/, ""), SORT_FIELDS));
        else sort.push({ field: sf.name, dir: desc ? "desc" : "asc" });
      }
      return null;
    }
    if (lower === "is" || lower === "has") {
      if (op !== "eq") { mark("error"); err(`${lower}: cannot be compared.`, start, end); return null; }
      /** @type {Node[]} */
      const nodes = [];
      tok(start, fieldEnd, "field");
      for (const v of values) {
        const raw = v.value.toLowerCase();
        const canonical = lower === "is" ? (PREDICATES.includes(raw) ? raw : null) : fieldByName(v.value)?.name ?? null;
        if (!canonical) {
          tok(v.start, v.end, "error");
          const s = closest(raw, lower === "is" ? PREDICATES : FIELDS.map((f) => f.name));
          err(didYouMean(lower === "is" ? `Unknown predicate “is:${v.value}”.` : `Unknown field “${v.value}”.`, s), v.start, v.end, s);
        } else {
          tok(v.start, v.end, "value");
          nodes.push({ type: /** @type {"is"|"has"} */ (lower), value: canonical, span: [values.length > 1 ? v.start : start, v.end] });
        }
      }
      return group("or", nodes);
    }
    if (!field) {
      mark("error");
      const s = closest(name, FIELD_NAMES);
      err(didYouMean(`Unknown field “${name}”.`, s), start, fieldEnd - 1, s);
      return null;
    }
    const comparable = COMPARABLE.has(field.type);
    if (op !== "eq" && !comparable) { mark("error"); err(`“${field.name}” cannot be compared with ${text.slice(opAt, opEnd)}.`, opAt, opEnd); return null; }
    if (op !== "eq" && values.length > 1) { mark("error"); err("A comparison takes one value.", start, end); return null; }
    let list = values.map((v) => v.value);
    if (values.length === 1 && values[0].bare && values[0].value.includes("..")) {
      const parts = values[0].value.split("..");
      if (op !== "eq") { mark("error"); err("A range cannot be combined with a comparison.", start, end); return null; }
      if (!comparable) { mark("error"); err(`“${field.name}” does not support ranges.`, values[0].start, values[0].end); return null; }
      if (parts.length !== 2 || !parts[0] || !parts[1]) { mark("error"); err("A range needs two values, like 1..5.", values[0].start, values[0].end); return null; }
      op = "range";
      list = parts;
    }
    mark("field");
    return { type: "term", field: field.name, op, values: list, span: [start, end] };
  }

  /** @type {Node[]} */
  const top = [];
  while (pos < text.length) {
    const node = parseOr();
    if (node) top.push(node);
    ws();
    if (text[pos] === ")") { tok(pos, pos + 1, "error"); err("Unmatched “)”.", pos, pos + 1); pos++; }
  }
  tokens.sort((a, b) => a.start - b.start);
  return { ast: { type: "query", where: group("and", top), sort }, errors, tokens };
}

/** @param {string} text @returns {{ ast: Query, errors: WqlError[] }} */
export function parse(text) {
  const { ast, errors } = parseFull(text);
  return { ast, errors };
}

/** Syntax-colouring tokens (whitespace omitted). @param {string} text @returns {Token[]} */
export function highlight(text) { return parseFull(text).tokens; }

/** Builds an and/or group, flattening same-type children; null when empty. @param {"and"|"or"} type @param {Node[]} children @returns {Node|null} */
export function group(type, children) {
  /** @type {Node[]} */
  const flat = [];
  for (const c of children) {
    if (!c) continue;
    if (c.type === type) flat.push(.../** @type {GroupNode} */ (c).children); else flat.push(c);
  }
  return flat.length === 0 ? null : flat.length === 1 ? flat[0] : { type, children: flat };
}

/** @param {Node} node @returns {Node} */
export function negate(node) { return node.type === "not" ? node.child : { type: "not", child: node }; }
