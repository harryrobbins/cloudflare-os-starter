import { describe, expect, it } from "vitest";

import type { BadgeSummary, Membership, Message } from "../contract.js";
import {
  applyIncoming,
  applyRead,
  badgeTotals,
  clearChannelBadges,
  documentTitle,
  firstUnreadSeq,
  isUnread,
  shouldNotify,
  unreadCount,
} from "./unread.js";

function membership(patch: Partial<Membership> = {}): Membership {
  return {
    channelId: "c1",
    userId: "me",
    joinedAt: 0,
    lastReadSeq: 10,
    manualUnreadSeq: null,
    notify: "all",
    muted: false,
    starred: false,
    ...patch,
  };
}

function message(patch: Partial<Message> = {}): Message {
  return {
    id: "m1",
    channelId: "c1",
    seq: 11,
    rootId: null,
    authorId: "alice",
    body: "hello",
    kind: "user",
    createdAt: 1000,
    editedAt: null,
    deletedAt: null,
    replyCount: 0,
    lastReplyAt: null,
    reactions: [],
    attachments: [],
    mentions: [],
    ...patch,
  };
}

describe("firstUnreadSeq", () => {
  it("is null when the read cursor is level with the channel", () => {
    expect(firstUnreadSeq(membership({ lastReadSeq: 10 }), 10)).toBeNull();
  });

  it("is the message after the read cursor", () => {
    expect(firstUnreadSeq(membership({ lastReadSeq: 10 }), 14)).toBe(11);
  });

  it("is null when there is no membership at all", () => {
    expect(firstUnreadSeq(undefined, 14)).toBeNull();
  });

  it("uses the manual marker even when the read cursor is caught up", () => {
    expect(firstUnreadSeq(membership({ lastReadSeq: 14, manualUnreadSeq: 12 }), 14)).toBe(12);
  });

  it("takes the earlier of the two cursors", () => {
    expect(firstUnreadSeq(membership({ lastReadSeq: 5, manualUnreadSeq: 12 }), 14)).toBe(6);
    expect(firstUnreadSeq(membership({ lastReadSeq: 12, manualUnreadSeq: 8 }), 14)).toBe(8);
  });

  it("ignores a manual marker above the channel's high-water mark", () => {
    expect(firstUnreadSeq(membership({ lastReadSeq: 14, manualUnreadSeq: 99 }), 14)).toBeNull();
  });
});

describe("unreadCount", () => {
  it("counts every message at or after the first unread", () => {
    expect(unreadCount(membership({ lastReadSeq: 10 }), 14)).toBe(4);
  });

  it("is zero when caught up", () => {
    expect(unreadCount(membership({ lastReadSeq: 14 }), 14)).toBe(0);
    expect(isUnread(membership({ lastReadSeq: 14 }), 14)).toBe(false);
  });

  it("counts from a manual marker", () => {
    expect(unreadCount(membership({ lastReadSeq: 14, manualUnreadSeq: 12 }), 14)).toBe(3);
  });
});

describe("applyRead", () => {
  it("advances the cursor", () => {
    expect(applyRead(membership({ lastReadSeq: 10 }), 12, 20).lastReadSeq).toBe(12);
  });

  it("never moves the cursor backwards", () => {
    expect(applyRead(membership({ lastReadSeq: 10 }), 4, 20).lastReadSeq).toBe(10);
  });

  it("returns the same object when nothing changes, so React can skip the render", () => {
    const before = membership({ lastReadSeq: 10 });
    expect(applyRead(before, 10, 20)).toBe(before);
  });

  it("clears a manual marker once the reader reaches the end of the channel", () => {
    const after = applyRead(membership({ lastReadSeq: 10, manualUnreadSeq: 8 }), 14, 14);
    expect(after.manualUnreadSeq).toBeNull();
    expect(after.lastReadSeq).toBe(14);
  });

  it("keeps a manual marker while there is still unread below it", () => {
    const after = applyRead(membership({ lastReadSeq: 10, manualUnreadSeq: 8 }), 12, 20);
    expect(after.manualUnreadSeq).toBe(8);
  });
});

describe("badgeTotals", () => {
  const badges: BadgeSummary = {
    unread: { c1: 3, c2: 5, c3: 1 },
    mentions: { c1: 1, c2: 2 },
    threads: 4,
  };

  it("sums unmuted conversations", () => {
    const totals = badgeTotals(badges, {
      c1: membership({ channelId: "c1" }),
      c2: membership({ channelId: "c2" }),
      c3: membership({ channelId: "c3" }),
    });
    expect(totals).toEqual({ unread: 9, mentions: 3, threads: 4, anyUnread: true });
  });

  it("excludes muted conversations entirely", () => {
    const totals = badgeTotals(badges, {
      c1: membership({ channelId: "c1" }),
      c2: membership({ channelId: "c2", muted: true }),
      c3: membership({ channelId: "c3" }),
    });
    expect(totals.unread).toBe(4);
    expect(totals.mentions).toBe(1);
  });
});

describe("documentTitle", () => {
  it("shows the mention count", () => {
    expect(documentTitle({ unread: 9, mentions: 2, threads: 0, anyUnread: true })).toBe("(2) Chat");
  });

  it("shows a dot for unread without mentions", () => {
    expect(documentTitle({ unread: 9, mentions: 0, threads: 0, anyUnread: true })).toBe("• Chat");
  });

  it("is plain when everything is read", () => {
    expect(documentTitle({ unread: 0, mentions: 0, threads: 0, anyUnread: false })).toBe("Chat");
  });
});

describe("applyIncoming", () => {
  const empty: BadgeSummary = { unread: {}, mentions: {}, threads: 0 };

  it("counts somebody else's message", () => {
    const next = applyIncoming(empty, message(), "me", membership());
    expect(next.unread.c1).toBe(1);
    expect(next.mentions.c1).toBeUndefined();
  });

  it("ignores your own message", () => {
    expect(applyIncoming(empty, message({ authorId: "me" }), "me", membership())).toBe(empty);
  });

  it("counts a mention of you separately", () => {
    const next = applyIncoming(
      empty,
      message({ mentions: [{ kind: "user", userId: "me" }] }),
      "me",
      membership(),
    );
    expect(next.mentions.c1).toBe(1);
  });

  it("does not count a mention in a conversation set to notify nothing", () => {
    const next = applyIncoming(
      empty,
      message({ mentions: [{ kind: "user", userId: "me" }] }),
      "me",
      membership({ notify: "none" }),
    );
    expect(next.unread.c1).toBe(1);
    expect(next.mentions.c1).toBeUndefined();
  });
});

describe("clearChannelBadges", () => {
  it("drops one channel's counters", () => {
    const next = clearChannelBadges({ unread: { c1: 2, c2: 1 }, mentions: { c1: 1 }, threads: 3 }, "c1");
    expect(next).toEqual({ unread: { c2: 1 }, mentions: {}, threads: 3 });
  });

  it("returns the same object when there is nothing to clear", () => {
    const before: BadgeSummary = { unread: { c2: 1 }, mentions: {}, threads: 0 };
    expect(clearChannelBadges(before, "c1")).toBe(before);
  });
});

describe("shouldNotify", () => {
  it("is false for your own message", () => {
    expect(shouldNotify(message({ authorId: "me" }), "me", membership())).toBe(false);
  });

  it("is false for a muted conversation", () => {
    expect(shouldNotify(message(), "me", membership({ muted: true }))).toBe(false);
  });

  it("is false when the conversation notifies about nothing", () => {
    expect(shouldNotify(message(), "me", membership({ notify: "none" }))).toBe(false);
  });

  it("requires a mention when set to mentions only", () => {
    expect(shouldNotify(message(), "me", membership({ notify: "mentions" }))).toBe(false);
    expect(
      shouldNotify(
        message({ mentions: [{ kind: "user", userId: "me" }] }),
        "me",
        membership({ notify: "mentions" }),
      ),
    ).toBe(true);
  });

  it("counts @channel as a mention of everybody but the author", () => {
    expect(
      shouldNotify(message({ mentions: [{ kind: "channel" }] }), "me", membership({ notify: "mentions" })),
    ).toBe(true);
  });
});
