import { describe, it, expect } from "vitest";
import { describeLink, linkToEntry, objectLink, LINK_LIMIT } from "../../src/shared/link-card.js";
import { readPaste, placeEntries, clipboardPayload } from "../../src/client/ui/clipboard.js";
import { parseBackup } from "../../src/shared/backup.js";

describe("local URL cards", () => {
  it.each(["https://youtu.be/dQw4w9WgXcQ?t=43", "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=43s", "https://youtube.com/shorts/dQw4w9WgXcQ", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"])("recognises videos and preserves destination: %s", (url) => {
    expect(describeLink(url)).toMatchObject({ videoId: "dQw4w9WgXcQ", url });
  });
  it.each(["javascript:alert(1)", "data:text/html,hello", "https://user:pass@example.com", "https://example.com\nhttps://other.com", "https://example.com/\u0000", "https://example.com/" + "a".repeat(LINK_LIMIT)])("rejects unsafe or ambiguous URL %#", (url) => {
    expect(describeLink(url)).toBeNull();
  });
  it("does not mistake lookalike hosts or malformed IDs for YouTube", () => {
    expect(describeLink("https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ").videoId).toBeNull();
    expect(describeLink("https://youtube.com/watch?v=invalid").videoId).toBeNull();
  });
  it("pastes one rectangle and roundtrips clipboard and backup", () => {
    const result = readPaste({ text: "https://example.com/project?a=1#notes" }, null);
    expect(result.kind).toBe("link");
    const { creates } = placeEntries(result.entries, { objects: {}, at: { x: 0, y: 0 }, makeId: () => "o_000000000123" });
    expect(creates).toHaveLength(1);
    expect(creates[0].type).toBe("rect");
    expect(objectLink(creates[0]).host).toBe("example.com");
    const payload = clipboardPayload({ [creates[0].id]: creates[0] }, [creates[0].id]);
    const parsed = parseBackup(payload.json);
    expect(objectLink(parsed.entries[0].object).url).toBe("https://example.com/project?a=1#notes");
    expect(readPaste({ text: payload.text }, payload).kind).toBe("objects");
  });
  it("does not turn prose, code or altered labels into hidden destinations", () => {
    const entry = linkToEntry("https://example.com");
    expect(objectLink({ ...entry.object, text: entry.object.text.replace("Website · example.com", "Project reference") }).host).toBe("example.com");
    expect(objectLink({ type: "code", text: "https://example.com" })).toBeNull();
    expect(readPaste({ text: "Visit https://example.com" }, null).kind).toBe("text");
    expect(readPaste({ text: "```js\nconst n = 1;\n```" }, null).kind).toBe("code");
  });
});
