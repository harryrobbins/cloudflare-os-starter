/**
 * The renderer is the app's only path from a message body to the DOM, so these tests are the
 * sanitising contract: no raw HTML, no scriptable URL, hardened anchors, and mention chips whose
 * display name is escaped.
 */
import { describe, expect, it } from "vitest";

import { renderMarkdown, renderSnippet, toPlainText } from "./markdown.js";

const names = {
  nameOf: (id: string): string | undefined => ({ "u-alice": "Alice Chen", "u-x": '<img src=x>' })[id],
  channelNameOf: (id: string): string | undefined => ({ "c-design": "design" })[id],
  meId: "u-me",
};

describe("renderMarkdown", () => {
  it("renders basic Markdown", () => {
    const html = renderMarkdown("**bold** and `code`", names);
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>code</code>");
  });

  it("strips a script tag", () => {
    const html = renderMarkdown("<script>alert(1)</script>hi", names);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(1)</script>");
  });

  it("strips an image, which the CSP would block anyway", () => {
    expect(renderMarkdown('<img src=x onerror="alert(1)">', names)).not.toContain("onerror");
  });

  it("drops a javascript: link but keeps its text", () => {
    const html = renderMarkdown("[click](javascript:alert(1))", names);
    expect(html).not.toContain("javascript:");
    expect(html).toContain("click");
  });

  it("hardens an ordinary link", () => {
    const html = renderMarkdown("[site](https://example.test)", names);
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
  });

  it("allows mailto", () => {
    expect(renderMarkdown("[mail](mailto:a@example.test)", names)).toContain("mailto:");
  });

  it("resolves a user mention to a chip with the display name", () => {
    const html = renderMarkdown("hi <@u-alice>", names);
    expect(html).toContain("@Alice Chen");
    expect(html).toContain('data-mention="user"');
    expect(html).toContain('data-mention-id="u-alice"');
  });

  it("marks a mention of the reader", () => {
    expect(renderMarkdown("<@u-me>", names)).toContain("mention-me");
  });

  it("escapes a display name that looks like markup", () => {
    const html = renderMarkdown("<@u-x>", names);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("says unknown for a mention of somebody the directory has not seen", () => {
    expect(renderMarkdown("<@u-ghost>", names)).toContain("@unknown");
  });

  it("resolves a channel mention", () => {
    const html = renderMarkdown("see <#c-design>", names);
    expect(html).toContain("#design");
    expect(html).toContain('data-mention="channel"');
  });

  it("keeps a code fence intact", () => {
    expect(renderMarkdown("```\nline\n```", names)).toContain("<pre>");
  });

  it("turns a single newline into a line break", () => {
    expect(renderMarkdown("one\ntwo", names)).toContain("<br>");
  });

  it("renders a GFM table", () => {
    expect(renderMarkdown("| a | b |\n| - | - |\n| 1 | 2 |", names)).toContain("<table>");
  });
});

describe("renderSnippet", () => {
  it("keeps the match marks and nothing else", () => {
    const html = renderSnippet("the <mark>build</mark> is green");
    expect(html).toBe("the <mark>build</mark> is green");
  });

  it("accepts the bracket form too", () => {
    expect(renderSnippet("the [[build]] is green")).toContain("<mark>build</mark>");
  });

  it("escapes everything else", () => {
    expect(renderSnippet("<script>x</script>")).not.toContain("<script");
  });
});

describe("toPlainText", () => {
  it("flattens Markdown for a notification body", () => {
    expect(toPlainText("**bold** [link](https://x.test)\n\n- item")).toBe("bold link item");
  });

  it("replaces a code fence with a word", () => {
    expect(toPlainText("see ```js\nconst a = 1\n```")).toBe("see code");
  });
});
