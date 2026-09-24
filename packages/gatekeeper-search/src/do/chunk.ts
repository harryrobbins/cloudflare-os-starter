// Chunking: ~400 approximate tokens (chars / 4) with 15% overlap, on paragraph boundaries.
//
// bge-base-en-v1.5 reads 512 tokens, so 400 leaves room for the title the embedding text carries.
// A short document is one chunk. A paragraph longer than a chunk is cut into windows at whitespace;
// the overlap is carried as whole trailing paragraphs where they fit, else as the tail of the last one.

import { CHUNK_OVERLAP, CHUNK_TOKENS } from "../shared/contract.js";

export const CHARS_PER_TOKEN = 4;
export const TARGET_CHARS = CHUNK_TOKENS * CHARS_PER_TOKEN;
export const OVERLAP_CHARS = Math.round(TARGET_CHARS * CHUNK_OVERLAP);
const SEPARATOR = "\n\n";

export function approxTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Splits a body into chunk texts. Never returns an empty list: an empty body is one empty chunk. */
export function chunkBody(body: string): string[] {
  const text = body.trim();
  if (text.length <= TARGET_CHARS) return [text];

  const pieces = text
    .split(/\n\s*\n/u)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
    .flatMap((paragraph) =>
      paragraph.length <= TARGET_CHARS ? [paragraph] : windows(paragraph, TARGET_CHARS - OVERLAP_CHARS - SEPARATOR.length),
    );

  const chunks: string[] = [];
  let current: string[] = [];
  let length = 0;
  for (const piece of pieces) {
    const added = (current.length > 0 ? SEPARATOR.length : 0) + piece.length;
    if (current.length > 0 && length + added > TARGET_CHARS) {
      chunks.push(current.join(SEPARATOR));
      current = overlapTail(current);
      length = joinedLength(current);
      if (current.length > 0 && length + SEPARATOR.length + piece.length > TARGET_CHARS) {
        current = [];
        length = 0;
      }
    }
    length += (current.length > 0 ? SEPARATOR.length : 0) + piece.length;
    current.push(piece);
  }
  if (current.length > 0) chunks.push(current.join(SEPARATOR));
  return chunks;
}

function joinedLength(parts: readonly string[]): number {
  return parts.reduce((sum, part) => sum + part.length, 0) + Math.max(0, parts.length - 1) * SEPARATOR.length;
}

/** The trailing paragraphs of a finished chunk that fit in the overlap, or the tail of the last one. */
function overlapTail(parts: readonly string[]): string[] {
  const tail: string[] = [];
  for (let i = parts.length - 1; i >= 0; i--) {
    const candidate = [parts[i]!, ...tail];
    if (joinedLength(candidate) > OVERLAP_CHARS) break;
    tail.unshift(parts[i]!);
  }
  if (tail.length > 0) return tail;
  const last = parts[parts.length - 1]!;
  const cut = last.slice(-OVERLAP_CHARS);
  const space = cut.search(/\s/u);
  const trimmed = (space >= 0 && space < cut.length / 2 ? cut.slice(space) : cut).trim();
  return trimmed.length > 0 ? [trimmed] : [];
}

/** Cuts a long paragraph into windows of at most `size` characters, at whitespace where possible. */
function windows(paragraph: string, size: number): string[] {
  const out: string[] = [];
  let rest = paragraph;
  while (rest.length > size) {
    let cut = rest.lastIndexOf(" ", size);
    if (cut < size / 2) cut = size;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

/**
 * The chunk texts FTS5 indexes: the title leads chunk 0 so a title word is findable, and the body
 * chunks follow.
 */
export function documentChunks(title: string, body: string): string[] {
  const chunks = chunkBody(body);
  const heading = title.trim();
  if (heading.length > 0) {
    chunks[0] = chunks[0]!.length > 0 ? `${heading}${SEPARATOR}${chunks[0]}` : heading;
  }
  return chunks;
}

/** What is embedded for a chunk: later chunks carry the title too, for context. */
export function embedText(title: string, ord: number, text: string): string {
  const heading = title.trim();
  if (ord === 0 || heading.length === 0) return text;
  return `${heading}${SEPARATOR}${text}`;
}
