import { describe, expect, it } from "vitest";

import { renderMarkdown } from "./markdown.js";

import {
  applyTextCommand,
  completeSlash,
  findCommand,
  parseSlash,
  SHRUG,
  slashSuggestions,
} from "./slash.js";

describe("parseSlash", () => {
  it("reads the name and the rest", () => {
    expect(parseSlash("/topic release week")).toMatchObject({ name: "topic", rest: "release week" });
  });

  it("reads a command with no argument", () => {
    expect(parseSlash("/mute")).toMatchObject({ name: "mute", rest: "" });
  });

  it("is case-insensitive on the name", () => {
    expect(parseSlash("/ME waves")?.name).toBe("me");
  });

  it("reports an unknown command as unknown rather than refusing to parse", () => {
    const parsed = parseSlash("/deploy the thing");
    expect(parsed?.name).toBe("deploy");
    expect(parsed?.command).toBeUndefined();
  });

  // The whole safety property: these are messages, not commands.
  it("is null for anything that is not a command at the very start", () => {
    expect(parseSlash("look at /usr/bin/env")).toBeNull();
    expect(parseSlash(" /mute")).toBeNull();
    expect(parseSlash("/usr/bin/env")).toBeNull();
    expect(parseSlash("/ hello")).toBeNull();
    expect(parseSlash("//mute")).toBeNull();
    expect(parseSlash("")).toBeNull();
  });

  it("keeps a multi-line argument", () => {
    expect(parseSlash("/me is\nhere")?.rest).toBe("is\nhere");
  });
});

describe("slashSuggestions", () => {
  it("offers everything for a bare slash", () => {
    expect(slashSuggestions("/", 1)).toHaveLength(7);
  });

  it("narrows by prefix", () => {
    expect(slashSuggestions("/m", 2)?.map((command) => command.name)).toEqual(["me", "mute"]);
  });

  it("closes once a space is typed", () => {
    expect(slashSuggestions("/me hello", 9)).toBeNull();
  });

  it("is null when nothing matches or the body is not a command", () => {
    expect(slashSuggestions("/zzz", 4)).toBeNull();
    expect(slashSuggestions("hello", 5)).toBeNull();
  });
});

describe("completeSlash", () => {
  it("leaves a trailing space for a command that takes an argument", () => {
    expect(completeSlash("/to", findCommand("topic")!)).toEqual({ value: "/topic ", caret: 7 });
  });

  it("leaves none for a command that does not", () => {
    expect(completeSlash("/mu", findCommand("mute")!)).toEqual({ value: "/mute", caret: 5 });
  });

  it("keeps anything already typed after the name", () => {
    expect(completeSlash("/to release week", findCommand("topic")!).value).toBe(
      "/topic  release week",
    );
  });
});

describe("applyTextCommand", () => {
  it("italicises /me", () => {
    expect(applyTextCommand(parseSlash("/me is making tea")!)).toBe("_is making tea_");
  });

  it("flattens a multi-line /me, because emphasis does not cross a newline", () => {
    expect(applyTextCommand(parseSlash("/me is\nmaking tea")!)).toBe("_is making tea_");
  });

  it("refuses an empty /me", () => {
    expect(applyTextCommand(parseSlash("/me")!)).toBeNull();
  });

  it("shrugs, with or without words", () => {
    expect(applyTextCommand(parseSlash("/shrug")!)).toBe(SHRUG);
    expect(applyTextCommand(parseSlash("/shrug who knows")!)).toBe(`who knows ${SHRUG}`);
  });

  it("has nothing to say about a command that does something", () => {
    expect(applyTextCommand(parseSlash("/mute")!)).toBeNull();
  });
});

// The shrug is Markdown source, and the escapes are the only reason it survives the renderer.
describe("the shrug renders", () => {
  it("comes out as ¯\\_(ツ)_/¯ with no emphasis", () => {
    const html = renderMarkdown(SHRUG, { nameOf: () => undefined, channelNameOf: () => undefined });
    expect(html).not.toContain("<em>");
    expect(text(html)).toBe("¯\\_(ツ)_/¯");
  });
});

function text(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}
