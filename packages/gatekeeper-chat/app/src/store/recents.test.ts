import { beforeEach, describe, expect, it } from "vitest";

import {
  LANDING_KEY,
  lastChannel,
  MAX_RECENTS,
  readRecentChannels,
  RECENT_CHANNELS_KEY,
  recencyRank,
  readLanding,
  rememberRecentChannel,
  withRecent,
  writeLanding,
} from "./recents.js";

describe("withRecent", () => {
  it("puts the newest first", () => {
    expect(withRecent(["a", "b"], "c")).toEqual(["c", "a", "b"]);
  });

  it("moves a repeat visit to the front rather than duplicating it", () => {
    expect(withRecent(["a", "b", "c"], "c")).toEqual(["c", "a", "b"]);
  });

  it("is capped", () => {
    const many = Array.from({ length: 30 }, (_, index) => `c${index}`);
    expect(withRecent(many, "new")).toHaveLength(MAX_RECENTS);
  });
});

describe("recencyRank", () => {
  it("is the position, and infinite for something never opened", () => {
    expect(recencyRank(["a", "b"], "a")).toBe(0);
    expect(recencyRank(["a", "b"], "b")).toBe(1);
    expect(recencyRank(["a", "b"], "z")).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("the stored list", () => {
  beforeEach(() => window.localStorage.clear());

  it("round-trips", () => {
    rememberRecentChannel("a");
    rememberRecentChannel("b");
    expect(readRecentChannels()).toEqual(["b", "a"]);
  });

  it("survives junk", () => {
    window.localStorage.setItem(RECENT_CHANNELS_KEY, "{not json");
    expect(readRecentChannels()).toEqual([]);
  });

  it("resumes the most recent conversation the client still knows about", () => {
    rememberRecentChannel("gone");
    rememberRecentChannel("kept");
    rememberRecentChannel("also-gone");
    expect(lastChannel((id) => id === "kept")).toBe("kept");
    expect(lastChannel(() => false)).toBeNull();
  });
});

describe("the landing preference", () => {
  beforeEach(() => window.localStorage.clear());

  it("defaults to the inbox", () => {
    expect(readLanding()).toBe("inbox");
  });

  it("round-trips the other choice, and clears back to the default", () => {
    writeLanding("last-channel");
    expect(readLanding()).toBe("last-channel");
    writeLanding("inbox");
    expect(window.localStorage.getItem(LANDING_KEY)).toBeNull();
    expect(readLanding()).toBe("inbox");
  });

  it("treats junk as the default", () => {
    window.localStorage.setItem(LANDING_KEY, "somewhere-else");
    expect(readLanding()).toBe("inbox");
  });
});
