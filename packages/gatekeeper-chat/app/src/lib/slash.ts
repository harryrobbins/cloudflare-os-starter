// Slash commands.
//
// Parsing and the text-only transforms live here, as pure functions; the commands that *do* something
// (set a topic, mute, open a conversation, run a search) are executed by the composer, which is where
// the store and the router already are.
//
// The rule that keeps this safe: **only a known command is intercepted.** Typing `/deploy the thing`
// posts that message, exactly as it would have before. An app that swallowed every line beginning
// with a slash would need an escape hatch, and then the escape hatch would need explaining.

export type SlashArgs = "none" | "text" | "person" | "query";

export interface SlashCommand {
  readonly name: string;
  readonly args: SlashArgs;
  /** Shown in the inline picker. One line, imperative. */
  readonly summary: string;
  readonly example: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "me", args: "text", summary: "Post an action line in italics", example: "/me is making tea" },
  { name: "shrug", args: "text", summary: "Append ¯\\_(ツ)_/¯", example: "/shrug" },
  { name: "topic", args: "text", summary: "Set this channel's topic", example: "/topic release week" },
  { name: "mute", args: "none", summary: "Stop this conversation badging", example: "/mute" },
  { name: "unmute", args: "none", summary: "Let it badge again", example: "/unmute" },
  { name: "dm", args: "person", summary: "Open a direct message", example: "/dm @alice" },
  { name: "search", args: "query", summary: "Search messages", example: "/search upload cap" },
];

export interface ParsedSlash {
  readonly name: string;
  /** Everything after the command, trimmed. */
  readonly rest: string;
  readonly command: SlashCommand | undefined;
}

/**
 * `¯\_(ツ)_/¯` as *Markdown source*.
 *
 * Both escapes are load-bearing: `\\` renders one backslash, and the trailing `\_` renders an
 * underscore that cannot *close* the emphasis the first one would otherwise open -- so the pair stays
 * two literal underscores. Written with `String.raw` because the double-escaped string literal for
 * this is unreadable and impossible to review, and `slash.test.ts` renders it to prove it.
 */
export const SHRUG = String.raw`¯\\_(ツ)\_/¯`;

export function findCommand(name: string): SlashCommand | undefined {
  return SLASH_COMMANDS.find((command) => command.name === name.toLowerCase());
}

/**
 * The command a body starts with, or null when it does not start with one.
 *
 * The slash has to be the very first character -- no leading whitespace -- and the name has to be
 * letters. `/usr/bin/env` and `/ hello` are therefore ordinary messages, which is the point.
 */
export function parseSlash(body: string): ParsedSlash | null {
  const match = /^\/([A-Za-z]+)(?:\s+([\s\S]*))?$/.exec(body);
  if (match === null) return null;
  const name = match[1]!.toLowerCase();
  return { name, rest: (match[2] ?? "").trim(), command: findCommand(name) };
}

/**
 * The commands to offer while the caret is still inside `/…` at the start of an empty-ish draft.
 *
 * Null rather than an empty array when the picker should not be open at all, so the caller can tell
 * "no matches" from "not a command".
 */
export function slashSuggestions(body: string, caret: number): readonly SlashCommand[] | null {
  if (!body.startsWith("/")) return null;
  const head = body.slice(0, caret);
  // Once a space has been typed the name is settled and the picker gets out of the way.
  if (/\s/.test(head) || caret === 0) return null;
  const prefix = head.slice(1).toLowerCase();
  const matches = SLASH_COMMANDS.filter((command) => command.name.startsWith(prefix));
  return matches.length === 0 ? null : matches;
}

/** The draft after accepting a command from the picker, plus where the caret goes. */
export function completeSlash(
  body: string,
  command: SlashCommand,
): { readonly value: string; readonly caret: number } {
  const rest = body.slice(body.search(/\s/) === -1 ? body.length : body.search(/\s/));
  const inserted = command.args === "none" ? `/${command.name}` : `/${command.name} `;
  return { value: `${inserted}${rest}`, caret: inserted.length };
}

/**
 * The body a text-only command produces, or null when the command does something instead of saying
 * something.
 *
 * `/me` is italics rather than a message `kind`, deliberately: the server has three kinds (`user`,
 * `system`, `agent`) and none of them is "action", so inventing a fourth would be a contract change
 * for a typographic effect.
 */
export function applyTextCommand(parsed: ParsedSlash): string | null {
  if (parsed.name === "me") {
    if (parsed.rest.length === 0) return null;
    // A single line: `_..._` across a newline is not emphasis in any Markdown dialect.
    return `_${parsed.rest.replace(/\s*\n\s*/g, " ")}_`;
  }
  if (parsed.name === "shrug") {
    return parsed.rest.length === 0 ? SHRUG : `${parsed.rest} ${SHRUG}`;
  }
  return null;
}
