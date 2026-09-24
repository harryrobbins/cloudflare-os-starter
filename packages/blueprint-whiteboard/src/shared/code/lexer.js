// @ts-check
// Syntax highlighting for code blocks: small hand-written lexers, one scanner loop per language
// family, turning code text into [class, text] tokens. The shared renderer (../render.js) draws
// them as <tspan>s, so the canvas and the server's SVG/HTML/PDF export highlight identically.
//
// Why not Prism or highlight.js: both are regular-expression grammars, and a regular expression
// cannot be interrupted once it starts matching, so one catastrophic-backtracking pattern (both
// libraries have shipped such fixes) would stall the Durable Object during an export. These lexers
// use no regular expressions on the code at all: each step looks at a bounded number of
// characters and consumes what it looked at, so the work is linear in the text. On top of that,
// every scan is counted (WORK_PER_CHAR per character plus a constant) and a lexer that ever went
// over its budget stops and the rest of the block is plain text. The output never contains
// markup: tokens are text, and the renderer escapes every character of them.
//
// Tokens partition the input exactly: joining every token's text gives the input back.

import { LIMITS } from "../protocol.js";
import { resolveLanguage } from "./languages.js";

/**
 * Token classes. "" is plain text (punctuation, operators, identifiers without a role).
 * @typedef {""|"comment"|"keyword"|"string"|"number"|"type"|"function"|"property"|"tag"|"meta"
 *   |"variable"|"constant"|"inserted"|"deleted"|"heading"} TokenClass
 */

/** @typedef {[TokenClass, string]} Token */

/** Every class a token may have, in palette order. */
export const TOKEN_CLASSES = /** @type {const} */ ([
  "", "comment", "keyword", "string", "number", "type", "function", "property", "tag", "meta",
  "variable", "constant", "inserted", "deleted", "heading",
]);

/** Characters of work allowed per input character before a block degrades to plain text. */
export const WORK_PER_CHAR = 8;
/** Work every block may spend regardless of length. */
export const WORK_BASE = 4096;
/** Longest input highlighted; the rest (only reachable by calling tokenize directly) is plain. */
export const MAX_HIGHLIGHT_CHARS = LIMITS.codeText;
/** Longest lookahead for a "(" after a name, or a ":" after a JSON key. */
const PEEK = 32;

/** Thrown by a Scanner over its budget; tokenize catches it and degrades. */
class OverBudget extends Error {}

class Scanner {
  /** @param {string} src @param {number} budget */
  constructor(src, budget) {
    this.src = src;
    this.i = 0;
    this.n = src.length;
    /** @type {Token[]} */
    this.out = [];
    this.work = 0;
    this.budget = budget;
  }

  /** Counts `k` characters of work. @param {number} k */
  spend(k) {
    this.work += k;
    if (this.work > this.budget) throw new OverBudget();
  }

  /** @param {number} [d] */
  ch(d = 0) {
    return this.src.charCodeAt(this.i + d);
  }

  /** Whether the text at i starts with `s` (the first character is compared before spending). @param {string} s */
  startsWith(s) {
    if (this.src.charCodeAt(this.i) !== s.charCodeAt(0)) return false;
    this.spend(s.length);
    return this.src.startsWith(s, this.i);
  }

  /** Emits src[i, end) as `cls` (merged with the previous token when the class is the same). @param {TokenClass} cls @param {number} end */
  emit(cls, end) {
    if (end <= this.i) return;
    const text = this.src.slice(this.i, end);
    this.spend(end - this.i);
    const last = this.out[this.out.length - 1];
    if (last && last[0] === cls) last[1] += text;
    else this.out.push([cls, text]);
    this.i = end;
  }

  /** End of the current line (index of "\n", or n). @param {number} [from] */
  lineEnd(from = this.i) {
    const j = this.src.indexOf("\n", from);
    const end = j < 0 ? this.n : j;
    this.spend(end - from);
    return end;
  }

  /** Index after the first `needle` at or after `from`, or n when missing. @param {string} needle @param {number} from */
  through(needle, from) {
    const j = this.src.indexOf(needle, from);
    const end = j < 0 ? this.n : j + needle.length;
    this.spend(end - from);
    return end;
  }

  /** End of a run of characters satisfying `test`, from `from`. @param {(c: number) => boolean} test @param {number} [from] */
  run(test, from = this.i) {
    let j = from;
    while (j < this.n && test(this.src.charCodeAt(j))) j++;
    this.spend(j - from);
    return j;
  }

  /** Index of the first non-blank (space or tab) character at or after `from`, looking at most PEEK. @param {number} from */
  skipBlank(from) {
    let j = from;
    const stop = Math.min(this.n, from + PEEK);
    while (j < stop && (this.src.charCodeAt(j) === 32 || this.src.charCodeAt(j) === 9)) j++;
    this.spend(j - from);
    return j;
  }
}

// ---------------------------------------------------------------------------------------------
// Character classes
// ---------------------------------------------------------------------------------------------

/** @param {number} c */
const isDigit = (c) => c >= 48 && c <= 57;
/** @param {number} c */
const isAlpha = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c > 127 && c !== 0x2028 && c !== 0x2029 && c !== 0xa0;
/** @param {number} c */
const isIdent = (c) => isAlpha(c) || isDigit(c);
/** @param {number} c */
const isSpace = (c) => c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11 || c === 0xa0;
/** @param {number} c */
const isUpper = (c) => c >= 65 && c <= 90;
/** @param {number} c */
const isHex = (c) => isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);

/** @param {string} words */
const set = (words) => new Set(words.split(/\s+/).filter(Boolean));

// ---------------------------------------------------------------------------------------------
// C-like family (JavaScript, TypeScript, Python, Go, Rust, Java, C, C++, C#, PHP, Ruby, Shell, SQL)
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {object} CLike
 * @property {string[]} [line]            line comment openers
 * @property {[string, string][]} [block] block comment delimiters
 * @property {string} [quotes]            quote characters of ordinary strings
 * @property {string} [multiline]         quote characters whose strings may span lines
 * @property {string} [raw]               quote characters without escapes
 * @property {string[]} [triple]          triple-quoted string delimiters (Python)
 * @property {Set<string>} [prefixes]     string prefixes (Python r"", f""; Rust b"", r"")
 * @property {Set<string>} keywords
 * @property {Set<string>} [types]
 * @property {Set<string>} [constants]
 * @property {Set<string>} [builtins]     drawn as functions
 * @property {boolean} [capitalTypes]     Capitalised names are types
 * @property {boolean} [ci]               keywords are case-insensitive (SQL)
 * @property {string} [variable]          prefix of variables ("$" PHP and Shell, "@" Ruby)
 * @property {boolean} [dollarIdent]      "$" may be part of a name (JavaScript)
 * @property {boolean} [decorators]       "@name" is meta
 * @property {boolean} [preprocessor]     "#" at the start of a line starts a meta line (C family)
 * @property {boolean} [hashNeedsSpace]   "#" comments only at the start of a word (Shell)
 * @property {boolean} [lifetimes]        'a is a lifetime, not a character (Rust)
 * @property {boolean} [symbols]          :name is a constant (Ruby)
 * @property {boolean} [macros]           name! is a function (Rust)
 * @property {Set<string>} [variables]    names drawn as variables (self, this)
 * @property {boolean} [noProperties]     a name after "." is not a property (Shell: file.txt)
 */

/**
 * @param {Scanner} s @param {CLike} L
 */
function lexCLike(s, L) {
  const line = L.line ?? [];
  const block = L.block ?? [];
  const quotes = L.quotes ?? "\"'";
  let lineStart = true; // only blanks since the last newline
  let prevSignificant = 0; // char code of the last non-blank character emitted
  let prevWord = ""; // the keyword just before, while only blanks follow it
  while (s.i < s.n) {
    const c = s.ch();
    const start = s.i;
    s.spend(1);
    if (c === 10) { s.emit("", s.i + 1); lineStart = true; continue; }
    if (isSpace(c)) { s.emit("", s.run((x) => isSpace(x) && x !== 10)); continue; }
    const atLineStart = lineStart;
    lineStart = false;
    const declares = prevWord;
    prevWord = "";
    // Comments
    let done = false;
    for (const opener of line) {
      if (c !== opener.charCodeAt(0) || !s.startsWith(opener)) continue;
      if (L.hashNeedsSpace && opener === "#" && start > 0 && !isSpace(s.src.charCodeAt(start - 1))) continue;
      s.emit("comment", s.lineEnd());
      done = true;
      break;
    }
    if (done) continue;
    for (const [open, close] of block) {
      if (c !== open.charCodeAt(0) || !s.startsWith(open)) continue;
      s.emit("comment", s.through(close, s.i + open.length));
      done = true;
      break;
    }
    if (done) continue;
    if (L.preprocessor && c === 35 /* # */ && atLineStart) {
      s.emit("meta", s.lineEnd());
      continue;
    }
    // Strings
    if (L.triple) {
      const t = L.triple.find((q) => c === q.charCodeAt(0) && s.startsWith(q));
      if (t) { s.emit("string", s.through(t, s.i + 3)); prevSignificant = 34; continue; }
    }
    if (quotes.includes(String.fromCharCode(c))) {
      if (L.lifetimes && c === 39 && lifetimeAt(s)) {
        s.emit("meta", s.run(isIdent, s.i + 1));
        prevSignificant = 97;
        continue;
      }
      s.emit("string", stringEnd(s, s.i, c, L));
      prevSignificant = 34;
      continue;
    }
    // Numbers
    if (isDigit(c) || (c === 46 && isDigit(s.ch(1)))) {
      s.emit("number", numberEnd(s));
      prevSignificant = 48;
      continue;
    }
    // Variables and decorators
    if (L.variable && c === L.variable.charCodeAt(0)) {
      const next = s.ch(1);
      if (c === 36 && next === 123 /* ${ */) {
        // ${name} in shell: to the closing brace, or the end of the line.
        const close = s.run((x) => x !== 125 && x !== 10, s.i + 2);
        s.emit("variable", s.src.charCodeAt(close) === 125 ? close + 1 : close);
        continue;
      }
      if (isAlpha(next) || (c === 36 && (isDigit(next) || next === 64 || next === 63 || next === 35 || next === 33 || next === 42))) {
        const end = isAlpha(next) ? s.run(isIdent, s.i + 1) : s.i + 2;
        s.emit("variable", end);
        prevSignificant = 97;
        continue;
      }
    }
    if (L.decorators && c === 64 /* @ */ && isAlpha(s.ch(1))) {
      s.emit("meta", s.run((x) => isIdent(x) || x === 46, s.i + 1));
      continue;
    }
    if (L.symbols && c === 58 /* : */ && isAlpha(s.ch(1)) && s.ch(-1) !== 58 && s.ch(1) !== 58) {
      s.emit("constant", s.run(isIdent, s.i + 1));
      continue;
    }
    // Names
    if (isAlpha(c) || (L.dollarIdent && c === 36)) {
      const end = s.run((x) => isIdent(x) || (!!L.dollarIdent && x === 36));
      const word = s.src.slice(s.i, end);
      // String prefixes: r"...", f'...', b"..."
      const q = s.src.charCodeAt(end);
      if (L.prefixes && (q === 34 || q === 39) && L.prefixes.has(word.toLowerCase())) {
        s.emit("string", end);
        if (L.triple) {
          const t = L.triple.find((tq) => q === tq.charCodeAt(0) && s.startsWith(tq));
          if (t) { s.emit("string", s.through(t, s.i + 3)); continue; }
        }
        s.emit("string", stringEnd(s, s.i, q, word.toLowerCase().includes("r") ? { ...L, raw: "\"'" } : L));
        continue;
      }
      const cls = DEFINES_FUNCTION.has(declares) && !L.keywords.has(word) ? "function"
        : DEFINES_TYPE.has(declares) && !L.keywords.has(word) ? "type"
        : classifyName(s, L, word, end, prevSignificant);
      s.emit(cls, end);
      if (cls === "keyword") prevWord = L.ci ? word.toLowerCase() : word;
      prevSignificant = 97;
      continue;
    }
    // Anything else: one character of punctuation.
    s.emit("", s.i + 1);
    prevSignificant = c;
  }
}

/** Keywords whose next name is a function or a type being declared. */
const DEFINES_FUNCTION = set("def fn func function");
const DEFINES_TYPE = set("class struct interface enum trait type impl record module");

/**
 * @param {Scanner} s @param {CLike} L @param {string} word @param {number} end @param {number} prev
 * @returns {TokenClass}
 */
function classifyName(s, L, word, end, prev) {
  const key = L.ci ? word.toLowerCase() : word;
  if (prev !== 46 /* . */ || L.ci) {
    if (L.keywords.has(key)) return "keyword";
    if (L.constants?.has(key)) return "constant";
    if (L.types?.has(key)) return "type";
    if (L.variables?.has(word)) return "variable";
  }
  const after = s.skipBlank(end);
  const next = s.src.charCodeAt(after);
  if (L.macros && s.src.charCodeAt(end) === 33 /* ! */ && s.src.charCodeAt(end + 1) !== 61) return "function";
  if (next === 40 /* ( */) return "function";
  if (prev === 46 && !L.noProperties) return "property";
  if (L.capitalTypes && isUpper(word.charCodeAt(0)) && word.length > 1 && word !== word.toUpperCase()) return "type";
  if (L.builtins?.has(key)) return "function";
  return "";
}

/** Whether the quote at s.i starts a Rust lifetime ('a) rather than a character literal. @param {Scanner} s */
function lifetimeAt(s) {
  if (!isAlpha(s.ch(1))) return false;
  // 'x' is a character; 'abc without a closing quote right after the name is a lifetime.
  let j = s.i + 1;
  const stop = Math.min(s.n, j + PEEK);
  while (j < stop && isIdent(s.src.charCodeAt(j))) j++;
  s.spend(j - s.i);
  return s.src.charCodeAt(j) !== 39;
}

/**
 * End of the string starting at `from` with quote `q`: after the closing quote, or at the end of
 * the line (single-line strings) or of the text.
 * @param {Scanner} s @param {number} from @param {number} q @param {CLike} L
 */
function stringEnd(s, from, q, L) {
  const ch = String.fromCharCode(q);
  const multiline = (L.multiline ?? "").includes(ch);
  const escapes = !(L.raw ?? "").includes(ch);
  let j = from + 1;
  while (j < s.n) {
    const c = s.src.charCodeAt(j);
    if (escapes && c === 92 /* \ */) { j += 2; continue; }
    if (c === q) { j++; break; }
    if (c === 10 && !multiline) break;
    j++;
  }
  j = Math.min(j, s.n);
  s.spend(j - from);
  return j;
}

/** End of the number at s.i: digits, letters, "_" and "." (hex, suffixes, exponents with a sign). @param {Scanner} s */
function numberEnd(s) {
  let j = s.i;
  const hex = s.ch() === 48 && (s.ch(1) === 120 || s.ch(1) === 88);
  while (j < s.n) {
    const c = s.src.charCodeAt(j);
    if (isIdent(c) || (c === 46 && isDigit(s.src.charCodeAt(j + 1)))) { j++; continue; }
    const prev = s.src.charCodeAt(j - 1);
    if (!hex && (c === 43 || c === 45) && (prev === 101 || prev === 69) && isDigit(s.src.charCodeAt(j + 1))) { j++; continue; }
    break;
  }
  s.spend(j - s.i);
  return j;
}

// ---------------------------------------------------------------------------------------------
// Language definitions
// ---------------------------------------------------------------------------------------------

const JS_KEYWORDS = "async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch throw try typeof var void while with yield";
const JS_BUILTINS = "Array Object String Number Boolean Promise Map Set WeakMap JSON Math Date RegExp Error Symbol console window document globalThis require module exports process";

/** @type {Record<string, CLike>} */
const CLIKE = {
  javascript: {
    line: ["//"], block: [["/*", "*/"]], quotes: "\"'`", multiline: "`",
    keywords: set(JS_KEYWORDS), constants: set("true false null undefined NaN Infinity"),
    builtins: set(JS_BUILTINS), capitalTypes: true, dollarIdent: true, decorators: true, variables: set("this"),
  },
  typescript: {
    line: ["//"], block: [["/*", "*/"]], quotes: "\"'`", multiline: "`",
    keywords: set(JS_KEYWORDS + " abstract as asserts declare enum implements interface is keyof namespace private protected public readonly satisfies type infer override"),
    types: set("string number boolean void any unknown never object bigint symbol"),
    constants: set("true false null undefined NaN Infinity"),
    builtins: set(JS_BUILTINS), capitalTypes: true, dollarIdent: true, decorators: true, variables: set("this"),
  },
  python: {
    line: ["#"], quotes: "\"'", triple: ['"""', "'''"], prefixes: set("r u b f br rb fr rf"),
    keywords: set("and as assert async await break class continue def del elif else except finally for from global if import in is lambda match case nonlocal not or pass raise return try while with yield"),
    constants: set("True False None Ellipsis NotImplemented"),
    types: set("int str float list dict set tuple bool bytes object complex frozenset"),
    builtins: set("print len range open super isinstance enumerate zip map filter sorted min max sum abs any all type"),
    decorators: true, capitalTypes: true, variables: set("self cls"),
  },
  go: {
    line: ["//"], block: [["/*", "*/"]], quotes: "\"'`", multiline: "`", raw: "`",
    keywords: set("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var"),
    types: set("bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr any"),
    constants: set("true false nil iota"),
    builtins: set("append cap close copy delete len make new panic print println recover"), capitalTypes: false,
  },
  rust: {
    line: ["//"], block: [["/*", "*/"]], quotes: "\"'", multiline: "\"", prefixes: set("b r br"), lifetimes: true, macros: true,
    keywords: set("as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return static struct super trait type unsafe use where while"),
    types: set("i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String Vec Option Result Box Self"),
    constants: set("true false None Some Ok Err"), capitalTypes: true, variables: set("self"),
  },
  java: {
    line: ["//"], block: [["/*", "*/"]], quotes: "\"'",
    keywords: set("abstract assert break case catch class const continue default do else enum extends final finally for goto if implements import instanceof interface native new package private protected public return static strictfp super switch synchronized throw throws transient try volatile while var record yield fun val when object companion data override"),
    types: set("boolean byte char double float int long short void String"),
    constants: set("true false null"), capitalTypes: true, decorators: true, variables: set("this"),
  },
  c: {
    line: ["//"], block: [["/*", "*/"]], quotes: "\"'", preprocessor: true,
    keywords: set("auto break case const continue default do else enum extern for goto if inline register restrict return sizeof static struct switch typedef union volatile while"),
    types: set("char double float int long short signed unsigned void size_t bool int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t FILE"),
    constants: set("NULL true false EOF"), builtins: set("printf scanf malloc free memcpy strlen fprintf sprintf"),
  },
  cpp: {
    line: ["//"], block: [["/*", "*/"]], quotes: "\"'", preprocessor: true,
    keywords: set("alignas alignof auto break case catch class const constexpr const_cast continue decltype default delete do dynamic_cast else enum explicit export extern for friend goto if inline mutable namespace new noexcept operator private protected public register reinterpret_cast return sizeof static static_assert static_cast struct switch template throw try typedef typeid typename union using virtual volatile while co_await co_return co_yield concept requires"),
    types: set("bool char char8_t char16_t char32_t double float int long short signed unsigned void wchar_t size_t string vector map std"),
    constants: set("true false nullptr NULL"), capitalTypes: true, variables: set("this"),
  },
  csharp: {
    line: ["//"], block: [["/*", "*/"]], quotes: "\"'", preprocessor: true,
    keywords: set("abstract as base break case catch checked class const continue default delegate do else enum event explicit extern finally fixed for foreach goto if implicit in interface internal is lock namespace new operator out override params private protected public readonly ref return sealed sizeof stackalloc static struct switch throw try typeof unchecked unsafe using virtual volatile while async await var get set init record when where yield"),
    types: set("bool byte char decimal double float int long object sbyte short string uint ulong ushort void dynamic"),
    constants: set("true false null"), capitalTypes: true, variables: set("this"),
  },
  php: {
    line: ["//", "#"], block: [["/*", "*/"]], quotes: "\"'", multiline: "\"'", variable: "$",
    keywords: set("abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while yield"),
    constants: set("true false null TRUE FALSE NULL"), capitalTypes: true,
  },
  ruby: {
    line: ["#"], quotes: "\"'", multiline: "\"'", variable: "@", symbols: true,
    keywords: set("alias and begin break case class def defined? do else elsif end ensure for if in module next not or redo rescue retry return super then undef unless until when while yield require require_relative attr_accessor attr_reader attr_writer private protected public"),
    constants: set("true false nil"), capitalTypes: true, variables: set("self"), builtins: set("puts print p raise"),
  },
  bash: {
    line: ["#"], quotes: "\"'", multiline: "\"'", raw: "'", variable: "$", hashNeedsSpace: true, noProperties: true,
    keywords: set("if then else elif fi case esac for while until do done in function select time return exit local export readonly declare unset shift break continue"),
    builtins: set("echo printf cd ls cat grep sed awk read source test set eval exec trap mkdir rm cp mv chmod chown curl git sudo npm pnpm node docker kubectl"),
    constants: set("true false"),
  },
  sql: {
    line: ["--"], block: [["/*", "*/"]], quotes: "'\"`", multiline: "'", ci: true,
    keywords: set("select from where and or not insert into values update set delete create table view index drop alter add column primary key foreign references join inner left right full outer cross on as group by order having limit offset union all distinct case when then else end is null like in between exists with returning begin commit rollback transaction grant revoke default constraint unique check cascade if replace desc asc"),
    types: set("int integer bigint smallint serial varchar char text boolean bool date time timestamp timestamptz numeric decimal real float double uuid json jsonb blob"),
    constants: set("true false null"), builtins: set("count sum avg min max coalesce now lower upper cast"),
  },
};

// ---------------------------------------------------------------------------------------------
// JSON, YAML, CSS, HTML, Markdown, Diff
// ---------------------------------------------------------------------------------------------

/** @param {Scanner} s */
function lexJson(s) {
  while (s.i < s.n) {
    const c = s.ch();
    s.spend(1);
    if (isSpace(c)) { s.emit("", s.run(isSpace)); continue; }
    if (c === 34) {
      const end = stringEnd(s, s.i, 34, {});
      const after = skipSpaces(s, end);
      s.emit(s.src.charCodeAt(after) === 58 ? "property" : "string", end);
      continue;
    }
    if (c === 47 && s.ch(1) === 47) { s.emit("comment", s.lineEnd()); continue; } // JSONC
    if (c === 47 && s.ch(1) === 42) { s.emit("comment", s.through("*/", s.i + 2)); continue; }
    if (isDigit(c) || (c === 45 && isDigit(s.ch(1)))) { s.emit("number", numberEndFrom(s, s.i + (c === 45 ? 1 : 0))); continue; }
    if (isAlpha(c)) {
      const end = s.run(isIdent);
      const w = s.src.slice(s.i, end);
      s.emit(w === "true" || w === "false" || w === "null" ? "constant" : "", end);
      continue;
    }
    s.emit("", s.i + 1);
  }
}

/** @param {Scanner} s @param {number} from */
function numberEndFrom(s, from) {
  const save = s.i;
  s.i = from;
  const end = numberEnd(s);
  s.i = save;
  return end;
}

/** Index after spaces/newlines from `from`, looking at most PEEK characters. @param {Scanner} s @param {number} from */
function skipSpaces(s, from) {
  let j = from;
  const stop = Math.min(s.n, from + PEEK);
  while (j < stop && isSpace(s.src.charCodeAt(j))) j++;
  s.spend(j - from);
  return j;
}

/** @param {Scanner} s */
function lexYaml(s) {
  let blockIndent = -1; // inside a | or > block scalar: lines indented more than this are text
  while (s.i < s.n) {
    const end = s.lineEnd();
    const indentEnd = s.run((c) => c === 32 || c === 9);
    const indent = indentEnd - s.i;
    const empty = indentEnd === end;
    if (blockIndent >= 0) {
      if (empty || indent > blockIndent) { s.emit("string", end); s.emit("", Math.min(s.n, end + 1)); continue; }
      blockIndent = -1;
    }
    s.emit("", indentEnd);
    if (!empty && (s.startsWith("---") || s.startsWith("..."))) {
      s.emit("meta", end);
    } else {
      if ((s.ch() === 45 /* - */) && (s.i + 1 === end || s.ch(1) === 32)) s.emit("keyword", s.i + 1);
      s.emit("", s.run((c) => c === 32, s.i));
      // key: value
      const colon = yamlKeyEnd(s, s.i, end);
      if (colon >= 0) {
        s.emit("property", colon);
        s.emit("", colon + 1);
      }
      if (yamlValue(s, end)) blockIndent = indent;
    }
    s.emit("", Math.min(s.n, end + 1));
  }
}

/**
 * Index of the ":" ending a mapping key that starts at `from`, or -1. Stops at a quote, "#" or
 * the end of the line. @param {Scanner} s @param {number} from @param {number} end
 */
function yamlKeyEnd(s, from, end) {
  const first = s.src.charCodeAt(from);
  if (first === 35 || first === 34 || first === 39 || first === 123 || first === 91) return -1;
  for (let j = from; j < end; j++) {
    const c = s.src.charCodeAt(j);
    if (c === 58 /* : */ && (j + 1 === end || s.src.charCodeAt(j + 1) === 32 || s.src.charCodeAt(j + 1) === 9)) {
      s.spend(j - from);
      return j > from ? j : -1;
    }
    if (c === 35 && j > from && s.src.charCodeAt(j - 1) === 32) break;
  }
  s.spend(end - from);
  return -1;
}

/**
 * The rest of a YAML line after the key. Returns true when it opens a block scalar (| or >).
 * @param {Scanner} s @param {number} end
 */
function yamlValue(s, end) {
  let block = false;
  while (s.i < end) {
    const c = s.ch();
    s.spend(1);
    if (c === 32 || c === 9) { s.emit("", s.run((x) => x === 32 || x === 9)); continue; }
    if (c === 35 && (s.i === 0 || isSpace(s.ch(-1)))) { s.emit("comment", end); break; }
    if (c === 34 || c === 39) { s.emit("string", Math.min(end, stringEnd(s, s.i, c, c === 39 ? { raw: "'" } : {}))); continue; }
    if ((c === 124 || c === 62) && isBlockIndicator(s, end)) { s.emit("keyword", s.run((x) => x === 124 || x === 62 || x === 45 || x === 43 || isDigit(x))); block = true; continue; }
    if (c === 38 || c === 42) { s.emit("variable", s.run((x) => !isSpace(x) && x !== 44 && x !== 93 && x !== 125, s.i + 1)); continue; } // &anchor *alias
    if (c === 33) { s.emit("meta", s.run((x) => !isSpace(x), s.i + 1)); continue; } // !tag
    if (c === 91 || c === 93 || c === 123 || c === 125 || c === 44) { s.emit("", s.i + 1); continue; }
    // A plain scalar to the end of the line (or a " #" comment, or flow punctuation).
    let j = s.i;
    while (j < end) {
      const x = s.src.charCodeAt(j);
      if (x === 35 && isSpace(s.src.charCodeAt(j - 1))) break;
      if (x === 44 || x === 93 || x === 125) break;
      j++;
    }
    let k = j;
    while (k > s.i && isSpace(s.src.charCodeAt(k - 1))) k--;
    const word = s.src.slice(s.i, k);
    s.spend(j - s.i);
    const cls = /** @type {TokenClass} */ (YAML_CONSTANTS.has(word) ? "constant" : isNumeric(word) ? "number" : "string");
    s.emit(cls, k);
    s.emit("", j);
  }
  return block;
}

const YAML_CONSTANTS = set("true false null ~ yes no on off True False Null TRUE FALSE NULL");

/** @param {Scanner} s @param {number} end */
function isBlockIndicator(s, end) {
  let j = s.i + 1;
  while (j < end && (s.src.charCodeAt(j) === 45 || s.src.charCodeAt(j) === 43 || isDigit(s.src.charCodeAt(j)))) j++;
  s.spend(j - s.i);
  while (j < end && s.src.charCodeAt(j) === 32) j++;
  return j === end || s.src.charCodeAt(j) === 35;
}

/** @param {string} w */
function isNumeric(w) {
  if (!w || w.length > 40) return false;
  let digits = 0;
  for (let i = 0; i < w.length; i++) {
    const c = w.charCodeAt(i);
    if (isDigit(c)) digits++;
    else if (!(c === 46 || c === 95 || c === 101 || c === 69 || ((c === 43 || c === 45) && (i === 0 || w[i - 1] === "e" || w[i - 1] === "E")) || (i === 1 && (c === 120 || c === 111)) || isHex(c))) return false;
  }
  return digits > 0 && (isDigit(w.charCodeAt(0)) || w.charCodeAt(0) === 45 || w.charCodeAt(0) === 43 || w.charCodeAt(0) === 46);
}

/** @param {Scanner} s */
function lexCss(s) {
  let depth = 0;
  let paren = 0; // inside (...) of an at-rule: (max-width: 600px)
  let value = false; // after "prop:" inside a block
  while (s.i < s.n) {
    const c = s.ch();
    s.spend(1);
    if (isSpace(c)) { s.emit("", s.run(isSpace)); continue; }
    if (c === 47 && s.ch(1) === 42) { s.emit("comment", s.through("*/", s.i + 2)); continue; }
    if (c === 47 && s.ch(1) === 47) { s.emit("comment", s.lineEnd()); continue; } // SCSS, Less
    if (c === 34 || c === 39) { s.emit("string", stringEnd(s, s.i, c, {})); continue; }
    if (c === 123) { depth++; value = false; s.emit("", s.i + 1); continue; }
    if (c === 125) { depth = Math.max(0, depth - 1); value = false; s.emit("", s.i + 1); continue; }
    if (c === 59) { value = false; s.emit("", s.i + 1); continue; }
    if (c === 40 && !value) { paren++; s.emit("", s.i + 1); continue; }
    if (c === 41 && paren > 0 && !value) { paren--; s.emit("", s.i + 1); continue; }
    if (c === 41 && paren > 0 && depth === 0) { paren--; value = false; s.emit("", s.i + 1); continue; }
    if (c === 64 /* @ */) { s.emit("keyword", s.run((x) => isIdent(x) || x === 45, s.i + 1)); continue; }
    if (c === 36 /* $var */) { s.emit("variable", s.run((x) => isIdent(x) || x === 45, s.i + 1)); continue; }
    if (value) {
      if (c === 35 /* #hex */) { s.emit("number", s.run(isIdent, s.i + 1)); continue; }
      if (isDigit(c) || ((c === 46 || c === 45) && isDigit(s.ch(1)))) {
        s.emit("number", s.run((x) => isIdent(x) || x === 46 || x === 37, s.i + 1));
        continue;
      }
      if (c === 33 /* !important */) { s.emit("keyword", s.run(isIdent, s.i + 1)); continue; }
      if (isAlpha(c) || c === 45) {
        const end = s.run((x) => isIdent(x) || x === 45);
        s.emit(s.src.charCodeAt(end) === 40 ? "function" : "constant", end);
        continue;
      }
      s.emit("", s.i + 1);
      continue;
    }
    if ((depth > 0 || paren > 0) && (isAlpha(c) || c === 45)) {
      // A property name when a ":" follows (after blanks); otherwise a nested selector.
      const end = s.run((x) => isIdent(x) || x === 45);
      const after = s.skipBlank(end);
      if (s.src.charCodeAt(after) === 58 && !cssSelectorAhead(s, after + 1)) {
        s.emit("property", end);
        s.emit("", after + 1);
        value = true;
        continue;
      }
      s.emit("tag", end);
      continue;
    }
    // Selectors
    if (c === 46 || c === 35) { s.emit("type", s.run((x) => isIdent(x) || x === 45, s.i + 1)); continue; }
    if (c === 58) { s.emit("meta", s.run((x) => isIdent(x) || x === 45 || x === 58, s.i + 1)); continue; }
    if (isAlpha(c)) { s.emit("tag", s.run((x) => isIdent(x) || x === 45)); continue; }
    s.emit("", s.i + 1);
  }
}

/**
 * Whether what follows a "name:" inside a block is a nested selector ("a:hover {") rather than a
 * value: a "{" comes before any ";" or "}" within a bounded lookahead.
 * @param {Scanner} s @param {number} from
 */
function cssSelectorAhead(s, from) {
  const stop = Math.min(s.n, from + 4 * PEEK);
  let j = from;
  while (j < stop) {
    const c = s.src.charCodeAt(j);
    if (c === 123) break;
    if (c === 59 || c === 125 || c === 10 || c === 41) { s.spend(j - from); return false; }
    j++;
  }
  s.spend(j - from);
  return j < stop;
}

/** @param {Scanner} s */
function lexHtml(s) {
  while (s.i < s.n) {
    const c = s.ch();
    s.spend(1);
    if (c === 60 /* < */) {
      if (s.ch(1) === 33 && s.startsWith("<!--")) { s.emit("comment", s.through("-->", s.i + 4)); continue; }
      if (s.ch(1) === 33 || s.ch(1) === 63) { s.emit("meta", s.through(">", s.i + 2)); continue; } // <!DOCTYPE>, <?xml?>
      const closing = s.ch(1) === 47;
      const nameStart = s.i + (closing ? 2 : 1);
      if (!isAlpha(s.src.charCodeAt(nameStart))) { s.emit("", s.i + 1); continue; }
      const nameEnd = s.run((x) => isIdent(x) || x === 45 || x === 58 || x === 46, nameStart);
      const name = s.src.slice(nameStart, nameEnd).toLowerCase();
      s.emit("tag", nameEnd);
      htmlAttributes(s);
      if (!closing && (name === "script" || name === "style")) embedded(s, name);
      continue;
    }
    if (c === 38 /* &entity; */) {
      const end = s.run((x) => isIdent(x) || x === 35, s.i + 1);
      if (s.src.charCodeAt(end) === 59 && end > s.i + 1) { s.emit("constant", end + 1); continue; }
      s.emit("", s.i + 1);
      continue;
    }
    // Text up to the next < or &.
    s.emit("", s.run((x) => x !== 60 && x !== 38, s.i + 1));
  }
}

/** Attributes of a start tag, through its ">" (or the end of the text). @param {Scanner} s */
function htmlAttributes(s) {
  while (s.i < s.n) {
    const c = s.ch();
    s.spend(1);
    if (c === 62) { s.emit("tag", s.i + 1); return; }
    if (c === 47 && s.ch(1) === 62) { s.emit("tag", s.i + 2); return; }
    if (c === 60) return; // a stray "<": let the caller start a new tag
    if (isSpace(c)) { s.emit("", s.run(isSpace)); continue; }
    if (c === 61) { s.emit("", s.i + 1); continue; }
    if (c === 34 || c === 39) { s.emit("string", stringEnd(s, s.i, c, { multiline: "\"'", raw: "\"'" })); continue; }
    const prev = s.out[s.out.length - 1];
    const afterEquals = prev && prev[0] === "" && prev[1].trimEnd().endsWith("=");
    const end = s.run((x) => !isSpace(x) && x !== 62 && x !== 61 && x !== 60 && (afterEquals || x !== 47), s.i + 1);
    s.emit(afterEquals ? "string" : "property", Math.max(end, s.i + 1));
  }
}

/**
 * Contents of <script> or <style> up to its closing tag, lexed as JavaScript or CSS.
 * @param {Scanner} s @param {string} name
 */
function embedded(s, name) {
  // Case-insensitive search for "</name" by scanning "<" characters (each looked at once).
  const tag = "</" + name;
  let j = s.i;
  let end = s.n;
  while (j < s.n) {
    const k = s.src.indexOf("<", j);
    if (k < 0) break;
    s.spend(k - j + tag.length);
    if (s.src.slice(k, k + tag.length).toLowerCase() === tag) { end = k; break; }
    j = k + 1;
  }
  if (end <= s.i) return;
  const inner = new Scanner(s.src.slice(s.i, end), s.budget - s.work);
  if (name === "script") lexCLike(inner, CLIKE.javascript);
  else lexCss(inner);
  s.work += inner.work;
  for (const t of inner.out) {
    const last = s.out[s.out.length - 1];
    if (last && last[0] === t[0]) last[1] += t[1];
    else s.out.push([t[0], t[1]]);
  }
  s.i = end;
}

/** @param {Scanner} s */
function lexMarkdown(s) {
  /** @type {{fence: string, lang: string|null, start: number}|null} */
  let fence = null;
  while (s.i < s.n) {
    const end = s.lineEnd();
    const lineStart = s.i;
    const indentEnd = s.run((c) => c === 32, s.i);
    if (fence) {
      const t = s.src.slice(indentEnd, end).trimEnd();
      s.spend(end - indentEnd);
      const mark = fence.fence;
      let closes = t.length >= mark.length;
      for (let k = 0; closes && k < t.length; k++) if (t.charCodeAt(k) !== mark.charCodeAt(0)) closes = false;
      if (!closes) { s.i = Math.min(s.n, end + 1); continue; } // highlighted with the whole fence later
      highlightInto(s, fence.lang, fence.start, lineStart);
      s.emit("", indentEnd);
      s.emit("meta", end);
      s.emit("", Math.min(s.n, end + 1));
      fence = null;
      continue;
    }
    const first = s.src.charCodeAt(indentEnd);
    if ((first === 96 || first === 126) && indentEnd - lineStart < 4) {
      const markEnd = s.run((c) => c === first, indentEnd);
      if (markEnd - indentEnd >= 3) {
        const info = s.src.slice(markEnd, end).trim().split(/\s/, 1)[0] ?? "";
        s.emit("meta", end);
        s.emit("", Math.min(s.n, end + 1));
        fence = { fence: s.src.slice(indentEnd, markEnd), lang: info ? resolveLanguage(info) : null, start: s.i };
        continue;
      }
    }
    s.emit("", indentEnd);
    if (first === 35 /* # */) {
      const hashes = s.run((c) => c === 35, indentEnd);
      if (hashes - indentEnd <= 6 && (hashes === end || s.src.charCodeAt(hashes) === 32)) { s.emit("heading", end); s.emit("", Math.min(s.n, end + 1)); continue; }
    }
    if (first === 62 /* > */) { s.emit("comment", end); s.emit("", Math.min(s.n, end + 1)); continue; }
    if ((first === 45 || first === 42 || first === 43) && s.src.charCodeAt(indentEnd + 1) === 32) s.emit("keyword", indentEnd + 1);
    else if (isDigit(first)) {
      const d = s.run(isDigit, indentEnd);
      if ((s.src.charCodeAt(d) === 46 || s.src.charCodeAt(d) === 41) && s.src.charCodeAt(d + 1) === 32) s.emit("keyword", d + 1);
    }
    markdownInline(s, end);
    s.emit("", Math.min(s.n, end + 1));
  }
  if (fence) highlightInto(s, fence.lang, fence.start, s.n);
}

/**
 * Emits src[from, to) highlighted as `lang` (plain "string" when unknown) and moves to `to`.
 * @param {Scanner} s @param {string|null} lang @param {number} from @param {number} to
 */
function highlightInto(s, lang, from, to) {
  s.i = from;
  if (to <= from) return;
  if (!lang || lang === "markdown" || lang === "plain" || !LEXERS[lang]) { s.emit("string", to); return; }
  const inner = new Scanner(s.src.slice(from, to), s.budget - s.work);
  LEXERS[lang](inner);
  s.work += inner.work;
  for (const t of inner.out) {
    const last = s.out[s.out.length - 1];
    if (last && last[0] === t[0]) last[1] += t[1];
    else s.out.push([t[0], t[1]]);
  }
  s.i = to;
}

/**
 * Inline Markdown on one line: `code`, **strong**, *emphasis*, [links](url). A closing marker is
 * searched for once per marker per line (a failed search is remembered), so a line full of
 * unmatched markers stays linear.
 * @param {Scanner} s @param {number} end
 */
function markdownInline(s, end) {
  /** @type {Map<string, {from: number, at: number}>} */
  const found = new Map();
  /** First `needle` at or after `from` before `end`, or -1; cached per needle. @param {string} needle @param {number} from */
  const find = (needle, from) => {
    const hit = found.get(needle);
    if (hit && from >= hit.from && (hit.at < 0 || hit.at >= from)) return hit.at;
    const j = s.src.indexOf(needle, from);
    const at = j >= 0 && j + needle.length <= end ? j : -1;
    s.spend((at < 0 ? end : at) - from);
    found.set(needle, { from, at });
    return at;
  };
  while (s.i < end) {
    const c = s.ch();
    s.spend(1);
    if (c === 96 /* ` */) {
      const close = find("`", s.i + 1);
      if (close >= 0) { s.emit("string", close + 1); continue; }
    } else if (c === 42 || (c === 95 && !isIdent(s.ch(-1)))) {
      const double = s.ch(1) === c;
      const marker = double ? String.fromCharCode(c, c) : String.fromCharCode(c);
      const close = find(marker, s.i + marker.length);
      if (close > s.i + marker.length) { s.emit(double ? "keyword" : "type", close + marker.length); continue; }
    } else if (c === 91 /* [ */) {
      const close = find("](", s.i + 1);
      if (close >= 0) {
        const paren = find(")", close + 2);
        if (paren >= 0) {
          s.emit("", s.i + 1);
          s.emit("property", close);
          s.emit("", close + 2);
          s.emit("string", paren);
          s.emit("", paren + 1);
          continue;
        }
      }
    } else if (c === 60 /* <url> */ && (s.src.startsWith("<http", s.i))) {
      const close = find(">", s.i + 1);
      if (close >= 0) { s.emit("string", close + 1); continue; }
    }
    // Plain text up to the next marker character.
    s.emit("", s.run((x) => x !== 96 && x !== 42 && x !== 95 && x !== 91 && x !== 60 && x !== 10, s.i + 1));
  }
}

/** @param {Scanner} s */
function lexDiff(s) {
  while (s.i < s.n) {
    const end = s.lineEnd();
    const c = s.ch();
    /** @type {TokenClass} */
    let cls = "";
    if (s.startsWith("+++") || s.startsWith("---") || s.startsWith("diff ") || s.startsWith("index ")) cls = "meta";
    else if (s.startsWith("@@")) cls = "keyword";
    else if (c === 43) cls = "inserted";
    else if (c === 45) cls = "deleted";
    else if (c === 92) cls = "comment"; // "\ No newline at end of file"
    s.emit(cls, end);
    s.emit("", Math.min(s.n, end + 1));
  }
}

/** @type {Record<string, (s: Scanner) => void>} */
const LEXERS = {
  json: lexJson, yaml: lexYaml, css: lexCss, html: lexHtml, markdown: lexMarkdown, diff: lexDiff,
};
for (const [id, def] of Object.entries(CLIKE)) LEXERS[id] = (s) => lexCLike(s, def);

// ---------------------------------------------------------------------------------------------
// tokenize
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {object} TokenizeResult
 * @property {Token[]} tokens    partition the input
 * @property {boolean} degraded  the work cap was hit: tokens after that point are plain
 * @property {number} work       characters of work spent (for tests)
 */

/** Most results kept by the memo (keyed by language and text). */
export const MEMO_SIZE = 64;
/** @type {Map<string, TokenizeResult>} */
const memo = new Map();
export const memoStats = { hits: 0, misses: 0 };

/**
 * Tokens of `text` highlighted as `language` (an id from languages.js; unknown ids are plain).
 * Deterministic and bounded; memoised by (language, text), so re-rendering an unchanged block
 * never tokenizes again. The returned tokens must not be mutated.
 * @param {string} language @param {string} text
 * @param {{budget?: number, memo?: boolean}} [opts]  budget: work cap override (tests)
 * @returns {TokenizeResult}
 */
export function tokenize(language, text, opts = {}) {
  const src = String(text ?? "");
  const useMemo = opts.memo !== false && opts.budget === undefined;
  const key = language + "\u0000" + src;
  if (useMemo) {
    const hit = memo.get(key);
    if (hit) {
      memoStats.hits++;
      memo.delete(key);
      memo.set(key, hit);
      return hit;
    }
    memoStats.misses++;
  }
  const result = run(language, src, opts.budget);
  if (useMemo) {
    memo.set(key, result);
    if (memo.size > MEMO_SIZE) memo.delete(/** @type {string} */ (memo.keys().next().value));
  }
  return result;
}

/** @param {string} language @param {string} src @param {number} [budget] */
function run(language, src, budget) {
  const lexer = Object.hasOwn(LEXERS, language) ? LEXERS[language] : null;
  if (!src) return { tokens: [], degraded: false, work: 0 };
  if (!lexer) return { tokens: [["", src]], degraded: false, work: 0 };
  const head = src.length > MAX_HIGHLIGHT_CHARS ? src.slice(0, MAX_HIGHLIGHT_CHARS) : src;
  const s = new Scanner(head, budget ?? WORK_BASE + WORK_PER_CHAR * head.length);
  let degraded = head !== src;
  try {
    lexer(s);
  } catch (e) {
    if (!(e instanceof OverBudget)) throw e;
    degraded = true;
  }
  const tokens = s.out;
  // What the tokens cover (a lexer may have looked ahead without emitting, e.g. a Markdown fence).
  let covered = 0;
  for (const t of tokens) covered += t[1].length;
  if (covered < src.length) {
    const rest = src.slice(covered);
    const last = tokens[tokens.length - 1];
    if (last && last[0] === "") last[1] += rest;
    else tokens.push(["", rest]);
  }
  return { tokens, degraded, work: s.work };
}
