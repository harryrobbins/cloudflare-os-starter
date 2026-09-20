import { describe, expect, it } from "vitest";

import type {
  BadgeSummary,
  Channel,
  Membership,
  Message,
  ThreadSummary,
  User,
} from "../contract.js";
import { computeDigest, firstName, greeting, summarise, type DigestInput } from "./digest.js";

const ME = "u-me";

function channel(id: string, patch: Partial<Channel> = {}): Channel {
  return {
    id,
    kind: "public",
    name: id,
    topic: null,
    purpose: null,
    createdBy: ME,
    createdAt: 0,
    archived: false,
    memberCount: 3,
    lastSeq: 10,
    ...patch,
  };
}

function membership(channelId: string, patch: Partial<Membership> = {}): Membership {
  return {
    channelId,
    userId: ME,
    joinedAt: 0,
    lastReadSeq: 0,
    manualUnreadSeq: null,
    notify: "all",
    muted: false,
    starred: false,
    ...patch,
  };
}

function user(id: string, name: string): User {
  return {
    id,
    name,
    email: null,
    avatarKey: null,
    firstSeenAt: 0,
    lastSeenAt: 0,
    tz: null,
    online: false,
  };
}

function input(patch: Partial<DigestInput> = {}): DigestInput {
  const channels = [
    channel("general"),
    channel("design"),
    channel("d-alice", { kind: "dm", name: null, memberIds: [ME, "u-alice"] }),
  ];
  return {
    channels: Object.fromEntries(channels.map((entry) => [entry.id, entry])),
    memberships: Object.fromEntries(channels.map((entry) => [entry.id, membership(entry.id)])),
    badges: { unread: {}, mentions: {}, threads: 0 },
    users: { [ME]: user(ME, "Harry Robbins"), "u-alice": user("u-alice", "Alice Chen") },
    threads: [],
    meId: ME,
    recents: [],
    ...patch,
  };
}

function thread(rootId: string, patch: Partial<ThreadSummary>): ThreadSummary {
  return {
    rootId,
    channelId: "general",
    root: { body: "Can we ship today?", id: rootId } as Message,
    replyCount: 3,
    lastReplyAt: 0,
    lastReadReplySeq: 0,
    unreadReplies: 1,
    following: true,
    participantIds: [],
    ...patch,
  };
}

const badges = (patch: Partial<BadgeSummary>): BadgeSummary => ({
  unread: {},
  mentions: {},
  threads: 0,
  ...patch,
});

describe("computeDigest", () => {
  it("is quiet when nothing is waiting", () => {
    const digest = computeDigest(input());
    expect(digest.quiet).toBe(true);
    expect(digest.totalUnread).toBe(0);
  });

  it("separates mentions from ordinary unread", () => {
    const digest = computeDigest(
      input({ badges: badges({ unread: { general: 4, design: 2 }, mentions: { design: 1 } }) }),
    );
    expect(digest.mentions.map((entry) => entry.channelId)).toEqual(["design"]);
    expect(digest.unread.map((entry) => entry.channelId)).toEqual(["general"]);
    expect(digest.totalUnread).toBe(6);
    expect(digest.totalMentions).toBe(1);
    expect(digest.quiet).toBe(false);
  });

  it("puts a direct message above a channel", () => {
    const digest = computeDigest(
      input({ badges: badges({ unread: { general: 1, "d-alice": 1 } }) }),
    );
    expect(digest.unread.map((entry) => entry.channelId)).toEqual(["d-alice", "general"]);
    expect(digest.unread[0]?.label).toBe("Alice Chen");
  });

  it("ignores a muted conversation entirely", () => {
    const digest = computeDigest(
      input({
        memberships: {
          general: membership("general", { muted: true }),
          design: membership("design"),
          "d-alice": membership("d-alice"),
        },
        badges: badges({ unread: { general: 9 }, mentions: { general: 3 } }),
      }),
    );
    expect(digest.quiet).toBe(true);
    expect(digest.totalUnread).toBe(0);
  });

  it("ignores an archived channel and one you are not in", () => {
    const digest = computeDigest(
      input({
        channels: { general: channel("general", { archived: true }), gone: channel("gone") },
        memberships: { general: membership("general") },
        badges: badges({ unread: { general: 2, gone: 2 } }),
      }),
    );
    expect(digest.quiet).toBe(true);
  });

  it("lists followed threads with new replies, newest first", () => {
    const digest = computeDigest(
      input({
        threads: [
          thread("old", { lastReplyAt: 100 }),
          thread("new", { lastReplyAt: 900 }),
          thread("read", { unreadReplies: 0, lastReplyAt: 999 }),
          thread("unfollowed", { following: false, lastReplyAt: 999 }),
        ],
      }),
    );
    expect(digest.threads.map((entry) => entry.rootId)).toEqual(["new", "old"]);
    expect(digest.threads[0]?.channelLabel).toBe("#general");
    expect(digest.threads[0]?.preview).toBe("Can we ship today?");
  });

  it("offers recent conversations, skipping the ones already listed as unread", () => {
    const digest = computeDigest(
      input({
        badges: badges({ unread: { design: 1 } }),
        recents: ["design", "d-alice", "general", "never-heard-of-it"],
      }),
    );
    expect(digest.recent.map((entry) => entry.channelId)).toEqual(["d-alice", "general"]);
  });

  it("caps the recent list", () => {
    const digest = computeDigest(
      input({ recents: ["general", "design", "d-alice"], recentLimit: 2 }),
    );
    expect(digest.recent).toHaveLength(2);
  });
});

const at = (hour: number): Date => new Date(2026, 8, 20, hour, 0, 0);

describe("greeting", () => {
  it("changes with the hour", () => {
    expect(greeting(at(8), "Harry Robbins")).toBe("Good morning, Harry");
    expect(greeting(at(14), "Harry Robbins")).toBe("Good afternoon, Harry");
    expect(greeting(at(21), "Harry Robbins")).toBe("Good evening, Harry");
    expect(greeting(at(3), "Harry Robbins")).toBe("Good evening, Harry");
  });

  it("drops the name when there is not one", () => {
    expect(greeting(at(8), null)).toBe("Good morning");
    expect(greeting(at(8), "   ")).toBe("Good morning");
  });
});

describe("firstName", () => {
  it("takes the first word", () => {
    expect(firstName("Harry Robbins")).toBe("Harry");
    expect(firstName("Cher")).toBe("Cher");
    expect(firstName(null)).toBeNull();
  });
});

describe("summarise", () => {
  it("says nothing new when it is quiet", () => {
    expect(summarise(computeDigest(input()))).toBe("Nothing new");
  });

  it("counts conversations, mentions and threads", () => {
    const digest = computeDigest(
      input({ badges: badges({ unread: { general: 4, design: 2 }, mentions: { design: 1 } }) }),
    );
    expect(summarise(digest)).toBe("6 unread in 2 conversations · 1 mention");
  });
});
