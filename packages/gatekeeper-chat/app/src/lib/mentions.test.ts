import { describe, expect, it } from "vitest";

import {
  channelToken,
  resolveMentions,
  mentionsToText,
  mentionsUser,
  parseChannelMentions,
  parseMentions,
  userToken,
} from "./mentions.js";

describe("tokens", () => {
  it("wraps an id so it cannot be confused with typed text", () => {
    expect(userToken("u-alice")).toBe("<@u-alice>");
    expect(channelToken("c-design")).toBe("<#c-design>");
  });
});

describe("parseMentions", () => {
  it("finds a user token", () => {
    expect(parseMentions("hello <@u-alice>")).toEqual([{ kind: "user", userId: "u-alice" }]);
  });

  it("deduplicates repeated mentions of one person", () => {
    expect(parseMentions("<@u-alice> and <@u-alice>")).toHaveLength(1);
  });

  it("keeps distinct people in order", () => {
    expect(parseMentions("<@u-bob> <@u-alice>")).toEqual([
      { kind: "user", userId: "u-bob" },
      { kind: "user", userId: "u-alice" },
    ]);
  });

  it("finds the bare kinds at a word boundary", () => {
    expect(parseMentions("heads up @channel")).toEqual([{ kind: "channel" }]);
    expect(parseMentions("@here now")).toEqual([{ kind: "here" }]);
    expect(parseMentions("hey @agent, summarise")).toEqual([{ kind: "agent" }]);
  });

  it("does not treat an email address as a mention", () => {
    expect(parseMentions("write to alice@here.example")).toEqual([]);
  });

  it("does not invent a mention for an unknown bare name", () => {
    expect(parseMentions("@nobody")).toEqual([]);
  });

  it("finds both a token and a bare kind in one body", () => {
    expect(parseMentions("<@u-alice> @here")).toEqual([
      { kind: "user", userId: "u-alice" },
      { kind: "here" },
    ]);
  });

  it("ignores a malformed token", () => {
    expect(parseMentions("<@ u-alice>")).toEqual([]);
    expect(parseMentions("<@u-alice")).toEqual([]);
  });
});

describe("parseChannelMentions", () => {
  it("collects channel ids once each", () => {
    expect(parseChannelMentions("see <#c-design> and <#c-design> and <#c-random>")).toEqual([
      "c-design",
      "c-random",
    ]);
  });
});

describe("mentionsUser", () => {
  it("is true for a direct mention", () => {
    expect(mentionsUser([{ kind: "user", userId: "me" }], "me", "alice")).toBe(true);
  });

  it("is false for somebody else's mention", () => {
    expect(mentionsUser([{ kind: "user", userId: "bob" }], "me", "alice")).toBe(false);
  });

  it("is false when you mentioned yourself", () => {
    expect(mentionsUser([{ kind: "user", userId: "me" }], "me", "me")).toBe(false);
  });

  it("counts @channel and @here but not @agent", () => {
    expect(mentionsUser([{ kind: "channel" }], "me", "alice")).toBe(true);
    expect(mentionsUser([{ kind: "here" }], "me", "alice")).toBe(true);
    expect(mentionsUser([{ kind: "agent" }], "me", "alice")).toBe(false);
  });
});

describe("mentionsToText", () => {
  const names = (id: string): string | undefined => ({ "u-alice": "Alice Chen" })[id];
  const channels = (id: string): string | undefined => ({ "c-design": "design" })[id];

  it("resolves tokens to display names", () => {
    expect(mentionsToText("hi <@u-alice> see <#c-design>", names, channels)).toBe(
      "hi @Alice Chen see #design",
    );
  });

  it("says unknown rather than leaking a raw id", () => {
    expect(mentionsToText("<@u-ghost>", names, channels)).toBe("@unknown");
  });
});

describe("resolveMentions", () => {
  const users = [
    { id: "u-alice", name: "Alice Chen" },
    { id: "u-al", name: "Alice" },
    { id: "u-bob", name: "Bob Okafor" },
  ];
  const channels = [
    { id: "c-design", name: "design" },
    { id: "d-1", name: null },
  ];

  it("turns a display name into an id token", () => {
    expect(resolveMentions("hi @Bob Okafor", users, channels)).toBe("hi <@u-bob>");
  });

  it("prefers the longest matching name", () => {
    expect(resolveMentions("hi @Alice Chen", users, channels)).toBe("hi <@u-alice>");
    expect(resolveMentions("hi @Alice", users, channels)).toBe("hi <@u-al>");
  });

  it("resolves a channel name", () => {
    expect(resolveMentions("see #design", users, channels)).toBe("see <#c-design>");
  });

  it("resolves at the start of the body", () => {
    expect(resolveMentions("@Alice Chen can you look?", users, channels)).toBe(
      "<@u-alice> can you look?",
    );
  });

  it("leaves an unknown name as plain text", () => {
    expect(resolveMentions("hi @Nobody At All", users, channels)).toBe("hi @Nobody At All");
  });

  it("refuses to guess between two people with the same name", () => {
    const ambiguous = [
      { id: "u-1", name: "Sam Taylor" },
      { id: "u-2", name: "Sam Taylor" },
    ];
    expect(resolveMentions("hi @Sam Taylor", ambiguous, [])).toBe("hi @Sam Taylor");
  });

  it("does not resolve inside an email address", () => {
    expect(resolveMentions("mail alice@Alice Chen", users, channels)).toBe("mail alice@Alice Chen");
  });

  it("leaves an existing token alone", () => {
    expect(resolveMentions("<@u-bob> hello", users, channels)).toBe("<@u-bob> hello");
  });

  it("round-trips with mentionsToText", () => {
    const names = (id: string): string | undefined =>
      users.find((user) => user.id === id)?.name;
    const channelNames = (id: string): string | undefined =>
      channels.find((channel) => channel.id === id)?.name ?? undefined;
    const wire = resolveMentions("hi @Alice Chen in #design", users, channels);
    expect(wire).toBe("hi <@u-alice> in <#c-design>");
    expect(mentionsToText(wire, names, channelNames)).toBe("hi @Alice Chen in #design");
  });

  it("handles a name with regex metacharacters", () => {
    expect(resolveMentions("hi @A. B (ops)", [{ id: "u-x", name: "A. B (ops)" }], [])).toBe(
      "hi <@u-x>",
    );
  });
});
