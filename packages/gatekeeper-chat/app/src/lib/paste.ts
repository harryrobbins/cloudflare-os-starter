// What to do with pasted text.
//
// Two transforms, both of which exist because the obvious result of a paste is not the useful one:
// dropping a URL on top of a selected phrase should link the phrase, and dropping thirty lines of a
// stack trace into a Markdown field should not reflow them into one paragraph. Both are guesses, so
// both are undoable -- and both live here, as pure functions over a string and a caret, because the
// heuristic is exactly the kind of thing that quietly starts fencing people's prose.

export type PasteKind = "link" | "code";

export interface PasteTransform {
  readonly kind: PasteKind;
  /** The whole field afterwards. */
  readonly value: string;
  /** Where to leave the caret or the selection. */
  readonly selectionStart: number;
  readonly selectionEnd: number;
}

/** A single http(s) URL and nothing else: no spaces, no second token. */
export function isSingleUrl(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || /\s/.test(trimmed)) return false;
  if (!/^https?:\/\/\S+$/i.test(trimmed)) return false;
  return URL.canParse(trimmed);
}

/**
 * Does this look like source rather than prose?
 *
 * Signals, not a parser. Each one is weak on its own -- prose is indented, prose contains the word
 * "if" -- so two are needed, and a block whose lines mostly end like sentences is rejected outright
 * however many signals it collects. A shell transcript counts double because `$ ` at the start of a
 * line is not something anybody writes by accident.
 */
export function looksLikeCode(text: string): boolean {
  const lines = text.split("\n");
  if (lines.length < 2) return false;
  const filled = lines.filter((line) => line.trim().length > 0);
  if (filled.length < 2) return false;
  // Already fenced: leave it exactly as it is.
  if (/^\s*```/.test(text)) return false;

  // A block that reads as sentences is prose, whatever else it contains.
  const sentences = filled.filter((line) => {
    const trimmed = line.trim();
    return /[.!?]["')]?$/.test(trimmed) && !/[{};]$/.test(trimmed);
  }).length;
  if (sentences >= filled.length * 0.6) return false;

  let signals = 0;
  if (filled.some((line) => /^(\t| {2,})\S/.test(line))) signals += 1;
  if (filled.filter((line) => /[{};]\s*$/.test(line)).length >= 2) signals += 1;
  if (
    /\b(function|const|let|var|class|def|import|export|return|if|for|while|SELECT|FROM)\b/.test(text) &&
    /[(){}[\];=<>]/.test(text)
  ) {
    signals += 1;
  }
  if (/^\s*(<\/?[a-z][\w-]*|[.#][\w-]+\s*\{)/m.test(text)) signals += 1;
  if (/^\s*[$#>]\s+\S/m.test(text)) signals += 2;
  return signals >= 2;
}

/**
 * The transform for one paste, or null to let the browser do what it always does.
 *
 * Pure: the caller supplies the field's current value and selection and applies whatever comes back.
 */
export function transformPaste(params: {
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  readonly pasted: string;
}): PasteTransform | null {
  const { value, selectionStart, selectionEnd, pasted } = params;
  const before = value.slice(0, selectionStart);
  const after = value.slice(selectionEnd);
  const selected = value.slice(selectionStart, selectionEnd);

  // A URL dropped on a selected phrase links the phrase. Only when something is selected: pasting a
  // URL into empty space should stay a URL, which the renderer autolinks anyway.
  if (selected.trim().length > 0 && isSingleUrl(pasted)) {
    const link = `[${selected}](${pasted.trim()})`;
    return {
      kind: "link",
      value: `${before}${link}${after}`,
      selectionStart: before.length + link.length,
      selectionEnd: before.length + link.length,
    };
  }

  if (looksLikeCode(pasted)) {
    // A fence needs its own line on both sides, and a blank line before it when there is already
    // text, or Markdown folds the opening backticks into the preceding paragraph.
    const lead = before.length === 0 ? "" : before.endsWith("\n") ? "" : "\n";
    const body = pasted.replace(/\n+$/, "");
    const fence = `${lead}\`\`\`\n${body}\n\`\`\`\n`;
    return {
      kind: "code",
      value: `${before}${fence}${after}`,
      selectionStart: before.length + fence.length,
      selectionEnd: before.length + fence.length,
    };
  }

  return null;
}
