// Finding the autocomplete token in front of the caret.
//
// Split out of the composer so it can be tested without a DOM: the rules (word boundary, no whitespace
// inside the token, `:` needs two characters) are the sort of thing that regresses silently.

export interface Trigger {
  readonly kind: "user" | "channel" | "emoji";
  readonly query: string;
  readonly start: number;
  readonly end: number;
}

/**
 * The autocomplete token immediately before the caret.
 *
 * A trigger only counts at a word boundary, so an email address does not open the mention list and a
 * `http://host:8080` does not open the emoji list. A space ends it: mentions are one word.
 */
export function findTrigger(body: string, caret: number): Trigger | null {
  if (caret < 0 || caret > body.length) return null;
  for (let index = caret - 1; index >= 0 && caret - index <= 32; index--) {
    const character = body[index]!;
    if (/\s/.test(character)) return null;
    if (character !== "@" && character !== "#" && character !== ":") continue;
    const before = index === 0 ? "" : body[index - 1]!;
    if (before !== "" && !/\s|[([]/.test(before)) return null;
    const query = body.slice(index + 1, caret);
    if (/[\s<>]/.test(query)) return null;
    const kind = character === "@" ? "user" : character === "#" ? "channel" : "emoji";
    // `:` needs at least two characters before it is worth a list; `@` and `#` do not.
    if (kind === "emoji" && query.length < 2) return null;
    return { kind, query, start: index, end: caret };
  }
  return null;
}

