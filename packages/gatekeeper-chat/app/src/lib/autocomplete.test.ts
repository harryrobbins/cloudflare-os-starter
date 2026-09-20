import { describe, expect, it } from "vitest";

import { findTrigger } from "./autocomplete.js";

describe("findTrigger", () => {
  it("finds a mention at the start of the body", () => {
    expect(findTrigger("@al", 3)).toMatchObject({ kind: "user", query: "al", start: 0, end: 3 });
  });

  it("finds a mention after a space", () => {
    expect(findTrigger("hello @al", 9)).toMatchObject({ kind: "user", query: "al" });
  });

  it("finds a channel trigger", () => {
    expect(findTrigger("see #des", 8)).toMatchObject({ kind: "channel", query: "des" });
  });

  it("offers an empty mention list as soon as @ is typed", () => {
    expect(findTrigger("@", 1)).toMatchObject({ kind: "user", query: "" });
  });

  it("needs two characters before offering emoji", () => {
    expect(findTrigger(":t", 2)).toBeNull();
    expect(findTrigger(":th", 3)).toMatchObject({ kind: "emoji", query: "th" });
  });

  it("ignores an email address", () => {
    expect(findTrigger("alice@example", 13)).toBeNull();
  });

  it("ignores a port in a URL", () => {
    expect(findTrigger("http://host:8080", 16)).toBeNull();
  });

  it("stops at whitespace", () => {
    expect(findTrigger("@alice said hello", 17)).toBeNull();
  });

  it("does not re-trigger on a completed token", () => {
    expect(findTrigger("<@u-alice> ", 11)).toBeNull();
  });

  it("triggers after an opening bracket", () => {
    expect(findTrigger("(@al", 4)).toMatchObject({ kind: "user", query: "al" });
  });

  it("reports the range to replace", () => {
    const trigger = findTrigger("hi @ali", 7);
    expect(trigger).not.toBeNull();
    expect("hi @ali".slice(trigger!.start, trigger!.end)).toBe("@ali");
  });
});
