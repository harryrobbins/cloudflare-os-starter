// @ts-check
// Languages a code block can be highlighted as: stable ids (stored in `language`), labels,
// aliases accepted from callers ("py", "c++", "sh"), each language's default indent, and a cheap
// guess of the language of pasted text. Pure data and bounded string checks; no DOM, shared by the
// client, the server's export and the agent methods.

/**
 * @typedef {object} Language
 * @property {string} id       stored in a code block's `language`
 * @property {string} label    shown in the header and the language picker
 * @property {string[]} aliases  other names accepted on input (lower case)
 * @property {string} indent   default indent unit for Tab ("  ", "    " or "\t")
 */

/** @type {readonly Language[]} */
export const LANGUAGES = Object.freeze([
  { id: "plain", label: "Plain text", aliases: ["text", "txt", "none", "plaintext"], indent: "  " },
  { id: "javascript", label: "JavaScript", aliases: ["js", "jsx", "mjs", "cjs", "node"], indent: "  " },
  { id: "typescript", label: "TypeScript", aliases: ["ts", "tsx", "mts", "cts"], indent: "  " },
  { id: "json", label: "JSON", aliases: ["jsonc", "json5"], indent: "  " },
  { id: "python", label: "Python", aliases: ["py", "python3", "py3"], indent: "    " },
  { id: "sql", label: "SQL", aliases: ["postgres", "postgresql", "mysql", "sqlite", "plsql", "tsql"], indent: "  " },
  { id: "html", label: "HTML", aliases: ["htm", "xml", "svg", "xhtml", "vue"], indent: "  " },
  { id: "css", label: "CSS", aliases: ["scss", "less", "sass"], indent: "  " },
  { id: "bash", label: "Shell", aliases: ["sh", "shell", "zsh", "console", "shellscript"], indent: "  " },
  { id: "yaml", label: "YAML", aliases: ["yml"], indent: "  " },
  { id: "markdown", label: "Markdown", aliases: ["md", "mdx"], indent: "  " },
  { id: "go", label: "Go", aliases: ["golang"], indent: "\t" },
  { id: "rust", label: "Rust", aliases: ["rs"], indent: "    " },
  { id: "java", label: "Java", aliases: ["kotlin", "kt"], indent: "    " },
  { id: "c", label: "C", aliases: ["h"], indent: "    " },
  { id: "cpp", label: "C++", aliases: ["c++", "cc", "cxx", "hpp", "hh"], indent: "    " },
  { id: "csharp", label: "C#", aliases: ["cs", "c#", "dotnet"], indent: "    " },
  { id: "php", label: "PHP", aliases: [], indent: "    " },
  { id: "ruby", label: "Ruby", aliases: ["rb"], indent: "  " },
  { id: "diff", label: "Diff", aliases: ["patch"], indent: "  " },
]);

export const LANGUAGE_IDS = Object.freeze(LANGUAGES.map((l) => l.id));

/** @type {Map<string, Language>} */
const BY_NAME = new Map();
for (const l of LANGUAGES) {
  BY_NAME.set(l.id, l);
  BY_NAME.set(l.label.toLowerCase(), l);
  for (const a of l.aliases) BY_NAME.set(a, l);
}

/**
 * The language id for an id, label or alias (case-insensitive), or null.
 * @param {unknown} name
 * @returns {string|null}
 */
export function resolveLanguage(name) {
  if (typeof name !== "string" || name.length > 40) return null;
  return BY_NAME.get(name.trim().toLowerCase())?.id ?? null;
}

/** @param {string} id */
export function languageLabel(id) {
  return BY_NAME.get(id)?.label ?? "Plain text";
}

/** @param {string} id */
export function defaultIndent(id) {
  return BY_NAME.get(id)?.indent ?? "  ";
}

/** Characters of pasted text the language guess looks at. */
export const DETECT_CHARS = 4000;

/**
 * A guess at the language of `text`, or "plain". Cheap and bounded: it looks at the first
 * DETECT_CHARS characters with anchored, backtracking-free patterns (no nested quantifiers).
 * @param {string} text
 * @returns {string}
 */
export function detectLanguage(text) {
  const s = String(text ?? "").slice(0, DETECT_CHARS);
  const t = s.trim();
  if (!t) return "plain";
  const has = (/** @type {RegExp} */ re) => re.test(s);
  if (/^(?:diff --git |--- \S|\+\+\+ \S|@@ -\d)/m.test(t) && /^[+-]/m.test(t) && /^(?:@@ |--- |diff )/m.test(t)) return "diff";
  if (t.startsWith("<?php")) return "php";
  if ((t[0] === "{" || t[0] === "[") && t.length < DETECT_CHARS && jsonLike(t)) return "json";
  if (/^<(?:!doctype|html|[a-z][a-z0-9-]*[\s>/])/i.test(t) && t.includes(">")) return "html";
  if (/^#!\s?\/\S*(?:ba|z|)sh\b/.test(t) || /^\$ \S/m.test(t)) return "bash";
  if (has(/^package [a-z]\w*\s*$/m) || (has(/^func /m) && has(/:= /))) return "go";
  if (has(/\bfn \w+\s?[(<]/) && (has(/\blet (?:mut )?\w/) || has(/\bimpl\b/) || has(/\w!\(/) || has(/->/))) return "rust";
  if (has(/^[ \t]*(?:def \w+\s?\(|class \w+[(:]|from [\w.]+ import |import \w+\s*$|elif |if __name__)/m) &&
    !has(/;\s*$/m)) return "python";
  if (has(/^#include\s*[<"]/m)) return has(/\b(?:std::|cout|namespace |template\s?<|class \w+)/) ? "cpp" : "c";
  if (has(/^using System|\bnamespace [\w.]+\s*[{;]?\s*$|Console\.Write/m)) return "csharp";
  if (has(/\b(?:public|private|protected) (?:static )?(?:final )?(?:class|void|interface) /) || has(/System\.out\.print/)) return "java";
  if (has(/^[ \t]*(?:def \w+[?!]?\s*$|require ['"]|puts |end\s*$)/m) && has(/^[ \t]*end\s*$/m)) return "ruby";
  if (/^(?:select|insert|update|delete|create|alter|drop|with)\s/i.test(t) || has(/\b(?:SELECT|FROM|WHERE|JOIN|GROUP BY)\b/)) return "sql";
  if (has(/^---\s*$/m) || (has(/^[\w-]+:(?: |$)/m) && !has(/[;{}]/) && has(/^[ \t]*[\w-]+: \S/m))) return "yaml";
  if (has(/^#{1,6} \S/m) || has(/^```/m) || has(/^[ \t]*[-*] \[[ x]\] /m)) return "markdown";
  if (has(/^[ \t]*[.#]?[\w-]+(?:[ ,>:.#][\w-]+)*\s*\{\s*$/m) && has(/^[ \t]*[\w-]+:[ \t]?[^;{}\s][^;{}]*;[ \t]*$/m) && !has(/\b(?:function|const|let|var|return)\b/)) return "css";
  if (has(/\b(?:interface \w+|type \w+\s?=|: (?:string|number|boolean|void|any|unknown)\b|as const\b|enum \w+)/)) return "typescript";
  if (has(/\b(?:function|const|let|var|=>|console\.log|require\(|export default|import .+ from)/)) return "javascript";
  return "plain";
}

/** @param {string} t */
function jsonLike(t) {
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}
