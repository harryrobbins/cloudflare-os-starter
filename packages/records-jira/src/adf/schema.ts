// The supported subset of the Atlassian Document Format, and strict validation of untrusted ADF.
//
// Supported: doc, paragraph, heading, bulletList, orderedList, listItem, codeBlock, text (marks
// strong, em, code, link), hardBreak and mention. Any other node or mark fails validation with a
// message naming it, and the router answers 400: content is never silently dropped.

export type AdfMark =
  | { type: "strong" }
  | { type: "em" }
  | { type: "code" }
  | { type: "link"; attrs: { href: string; title?: string } };

export type AdfText = { type: "text"; text: string; marks?: AdfMark[] };
export type AdfInline = AdfText | { type: "hardBreak" } | { type: "mention"; attrs: { id: string; text?: string; accessLevel?: string } };

export type AdfParagraph = { type: "paragraph"; content?: AdfInline[] };
export type AdfHeading = { type: "heading"; attrs: { level: number }; content?: AdfInline[] };
export type AdfCodeBlock = { type: "codeBlock"; attrs?: { language?: string | null }; content?: AdfText[] };
export type AdfListItem = { type: "listItem"; content: AdfBlock[] };
export type AdfBulletList = { type: "bulletList"; content: AdfListItem[] };
export type AdfOrderedList = { type: "orderedList"; attrs?: { order?: number }; content: AdfListItem[] };
export type AdfBlock = AdfParagraph | AdfHeading | AdfCodeBlock | AdfBulletList | AdfOrderedList;

export type AdfDoc = { type: "doc"; version: 1; content: AdfBlock[] };

export const ADF_LIMITS = { maxNodes: 5_000, maxDepth: 16 } as const;

const BLOCK_TYPES = ["paragraph", "heading", "bulletList", "orderedList", "codeBlock"];
const INLINE_TYPES = ["text", "hardBreak", "mention"];
const MARK_TYPES = ["strong", "em", "code", "link"];

export class AdfError extends Error {
  override name = "AdfError";
  constructor(readonly path: string, message: string) {
    super(`${message} (at ${path})`);
  }
}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validate untrusted input as a supported ADF document and return it normalised: only the known
 * keys, attrs that matter, and empty text dropped. Throws AdfError.
 */
export function validateAdf(input: unknown): AdfDoc {
  let count = 0;
  const bump = (path: string) => {
    if (++count > ADF_LIMITS.maxNodes) throw new AdfError(path, `The document has more than ${ADF_LIMITS.maxNodes} nodes`);
  };

  if (!isObject(input) || input.type !== "doc") {
    throw new AdfError("$", "Operation value must be an Atlassian Document (see the Atlassian Document Format)");
  }
  if (input.version !== 1) throw new AdfError("$.version", "Only ADF version 1 is supported");
  if (!Array.isArray(input.content)) throw new AdfError("$.content", "A document needs a content array");

  const children = (node: Json, path: string): unknown[] => {
    if (node.content === undefined) return [];
    if (!Array.isArray(node.content)) throw new AdfError(`${path}.content`, "content must be an array");
    return node.content;
  };

  const inline = (node: unknown, path: string): AdfInline | null => {
    bump(path);
    if (!isObject(node) || typeof node.type !== "string") throw new AdfError(path, "Expected an ADF node");
    if (!INLINE_TYPES.includes(node.type)) {
      throw new AdfError(path, `Unsupported ADF node type '${node.type}'. Supported inline nodes: ${INLINE_TYPES.join(", ")}`);
    }
    if (node.type === "hardBreak") return { type: "hardBreak" };
    if (node.type === "mention") {
      const attrs = node.attrs;
      if (!isObject(attrs) || typeof attrs.id !== "string" || !attrs.id) throw new AdfError(`${path}.attrs.id`, "A mention needs attrs.id");
      if (attrs.text !== undefined && typeof attrs.text !== "string") throw new AdfError(`${path}.attrs.text`, "Mention text must be a string");
      const text = typeof attrs.text === "string" && attrs.text ? attrs.text : `@${attrs.id}`;
      return { type: "mention", attrs: { id: attrs.id, text: text.startsWith("@") ? text : `@${text}` } };
    }
    if (typeof node.text !== "string") throw new AdfError(`${path}.text`, "A text node needs text");
    const marks = marksOf(node, path);
    if (!node.text) return null;
    return marks.length ? { type: "text", text: node.text, marks } : { type: "text", text: node.text };
  };

  const marksOf = (node: Json, path: string): AdfMark[] => {
    if (node.marks === undefined) return [];
    if (!Array.isArray(node.marks)) throw new AdfError(`${path}.marks`, "marks must be an array");
    const out: AdfMark[] = [];
    node.marks.forEach((m, i) => {
      const mp = `${path}.marks[${i}]`;
      if (!isObject(m) || typeof m.type !== "string") throw new AdfError(mp, "Expected a mark");
      if (!MARK_TYPES.includes(m.type)) throw new AdfError(mp, `Unsupported ADF mark '${m.type}'. Supported marks: ${MARK_TYPES.join(", ")}`);
      if (out.some((x) => x.type === m.type)) return;
      if (m.type === "link") {
        const attrs = m.attrs;
        if (!isObject(attrs) || typeof attrs.href !== "string") throw new AdfError(`${mp}.attrs.href`, "A link needs attrs.href");
        out.push({ type: "link", attrs: typeof attrs.title === "string" && attrs.title ? { href: attrs.href, title: attrs.title } : { href: attrs.href } });
      } else out.push({ type: m.type as "strong" | "em" | "code" });
    });
    return out;
  };

  const inlines = (node: Json, path: string): AdfInline[] =>
    children(node, path)
      .map((c, i) => inline(c, `${path}.content[${i}]`))
      .filter((x): x is AdfInline => x !== null);

  const listItem = (node: unknown, path: string, depth: number): AdfListItem => {
    bump(path);
    if (!isObject(node) || node.type !== "listItem") {
      throw new AdfError(path, `Unsupported ADF node type '${isObject(node) ? String(node.type) : typeof node}' in a list. Lists contain listItem nodes`);
    }
    return { type: "listItem", content: children(node, path).map((c, i) => block(c, `${path}.content[${i}]`, depth + 1)) };
  };

  const block = (node: unknown, path: string, depth: number): AdfBlock => {
    bump(path);
    if (depth > ADF_LIMITS.maxDepth) throw new AdfError(path, `The document nests deeper than ${ADF_LIMITS.maxDepth}`);
    if (!isObject(node) || typeof node.type !== "string") throw new AdfError(path, "Expected an ADF node");
    switch (node.type) {
      case "paragraph":
        return { type: "paragraph", content: inlines(node, path) };
      case "heading": {
        const level = isObject(node.attrs) ? node.attrs.level : undefined;
        if (typeof level !== "number" || !Number.isInteger(level) || level < 1 || level > 6) {
          throw new AdfError(`${path}.attrs.level`, "A heading needs attrs.level from 1 to 6");
        }
        return { type: "heading", attrs: { level }, content: inlines(node, path) };
      }
      case "codeBlock": {
        const lang = isObject(node.attrs) ? node.attrs.language : undefined;
        if (lang !== undefined && lang !== null && typeof lang !== "string") throw new AdfError(`${path}.attrs.language`, "language must be a string");
        const content: AdfText[] = [];
        children(node, path).forEach((c, i) => {
          const cp = `${path}.content[${i}]`;
          bump(cp);
          if (!isObject(c) || c.type !== "text" || typeof c.text !== "string") throw new AdfError(cp, "A codeBlock contains only text");
          if (Array.isArray(c.marks) && c.marks.length) throw new AdfError(`${cp}.marks`, "Text in a codeBlock cannot have marks");
          if (c.text) content.push({ type: "text", text: c.text });
        });
        return lang ? { type: "codeBlock", attrs: { language: lang }, content } : { type: "codeBlock", content };
      }
      case "bulletList":
        return { type: "bulletList", content: children(node, path).map((c, i) => listItem(c, `${path}.content[${i}]`, depth)) };
      case "orderedList": {
        const order = isObject(node.attrs) ? node.attrs.order : undefined;
        if (order !== undefined && (typeof order !== "number" || !Number.isInteger(order) || order < 0)) {
          throw new AdfError(`${path}.attrs.order`, "order must be a non-negative integer");
        }
        const content = children(node, path).map((c, i) => listItem(c, `${path}.content[${i}]`, depth));
        return order !== undefined && order !== 1 ? { type: "orderedList", attrs: { order }, content } : { type: "orderedList", content };
      }
      default:
        throw new AdfError(path, `Unsupported ADF node type '${node.type}'. Supported block nodes: ${BLOCK_TYPES.join(", ")}`);
    }
  };

  return { type: "doc", version: 1, content: input.content.map((c, i) => block(c, `$.content[${i}]`, 1)) };
}
