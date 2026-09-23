import { describe, expect, it } from "vitest";

import type { Message } from "../contract.js";
import {
  applyAgentRequest,
  applyDelete,
  applyReactions,
  localLastSeq,
  markSendFailed,
  mergeMessages,
  optimisticMessage,
  PENDING_SEQ,
  planCatchUp,
  reconcileSend,
  removeLocal,
  toggleReaction,
  type LocalMessage,
} from "./merge.js";

function message(patch: Partial<Message> & { id: string; seq: number }): Message {
  return {
    channelId: "c1",
    rootId: null,
    authorId: "alice",
    body: "hello",
    kind: "user",
    createdAt: patch.seq * 1000,
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

describe("mergeMessages", () => {
  it("sorts by seq", () => {
    const merged = mergeMessages([], [message({ id: "b", seq: 3 }), message({ id: "a", seq: 1 })]);
    expect(merged.map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("deduplicates by id, with the server row winning", () => {
    const existing = [message({ id: "a", seq: 1, body: "old" })];
    const merged = mergeMessages(existing, [message({ id: "a", seq: 1, body: "new" })]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.body).toBe("new");
  });

  it("returns the same array when there is nothing to merge", () => {
    const existing: LocalMessage[] = [message({ id: "a", seq: 1 })];
    expect(mergeMessages(existing, [])).toBe(existing);
  });

  it("keeps pending rows after every committed one", () => {
    const pending = optimisticMessage({
      clientId: "c-1",
      channelId: "c1",
      authorId: "me",
      body: "sending",
      rootId: null,
      attachments: [],
      mentions: [],
      now: 500,
    });
    const merged = mergeMessages([pending], [message({ id: "a", seq: 9 })]);
    expect(merged.map((entry) => entry.id)).toEqual(["a", "local:c-1"]);
  });

  it("orders several pending rows by the time they were typed", () => {
    const first = optimisticMessage({
      clientId: "c-1", channelId: "c1", authorId: "me", body: "one",
      rootId: null, attachments: [], mentions: [], now: 100,
    });
    const second = optimisticMessage({
      clientId: "c-2", channelId: "c1", authorId: "me", body: "two",
      rootId: null, attachments: [], mentions: [], now: 200,
    });
    const merged = mergeMessages([second, first], [message({ id: "a", seq: 1 })]);
    expect(merged.map((entry) => entry.body)).toEqual(["hello", "one", "two"]);
  });

  it("evicts an optimistic row when the server echoes its clientId under a real id", () => {
    const pending = optimisticMessage({
      clientId: "c-9", channelId: "c1", authorId: "me", body: "sent",
      rootId: null, attachments: [], mentions: [], now: 500,
    });
    const merged = mergeMessages(
      [message({ id: "a", seq: 1 }), pending],
      [message({ id: "server-1", seq: 2, clientId: "c-9", authorId: "me", body: "sent" })],
    );
    expect(merged.map((entry) => entry.id)).toEqual(["a", "server-1"]);
    expect(merged.every((entry) => entry.local === undefined)).toBe(true);
  });
});

describe("optimistic send", () => {
  const pending = optimisticMessage({
    clientId: "c-7", channelId: "c1", authorId: "me", body: "hi",
    rootId: null, attachments: [], mentions: [{ kind: "user", userId: "alice" }], now: 1234,
  });

  it("sorts to the end and is marked pending", () => {
    expect(pending.seq).toBe(PENDING_SEQ);
    expect(pending.local).toEqual({ state: "pending" });
    expect(pending.clientId).toBe("c-7");
  });

  it("is replaced by the committed message", () => {
    const committed = message({ id: "srv", seq: 5, clientId: "c-7", authorId: "me", body: "hi" });
    const reconciled = reconcileSend([pending], "c-7", committed);
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]!.id).toBe("srv");
    expect(reconciled[0]!.local).toBeUndefined();
  });

  it("reconciles a deduplicated resend identically", () => {
    const committed = message({ id: "srv", seq: 5, clientId: "c-7", authorId: "me" });
    const once = reconcileSend([pending], "c-7", committed);
    const twice = reconcileSend(once, "c-7", committed);
    expect(twice).toHaveLength(1);
    expect(twice[0]!.id).toBe("srv");
  });

  it("leaves other messages alone", () => {
    const list = mergeMessages([pending], [message({ id: "a", seq: 1 })]);
    const reconciled = reconcileSend(list, "c-7", message({ id: "srv", seq: 2, clientId: "c-7" }));
    expect(reconciled.map((entry) => entry.id)).toEqual(["a", "srv"]);
  });

  it("marks a failure without losing the body", () => {
    const failed = markSendFailed([pending], "c-7", "offline");
    expect(failed[0]!.local).toEqual({ state: "failed", error: "offline" });
    expect(failed[0]!.body).toBe("hi");
  });

  it("discards a failed row on request", () => {
    expect(removeLocal([pending], "c-7")).toHaveLength(0);
  });
});

describe("applyDelete", () => {
  it("replaces the row with a tombstone when one is supplied", () => {
    const tombstone = message({ id: "a", seq: 1, body: "", deletedAt: 99, replyCount: 2 });
    const after = applyDelete([message({ id: "a", seq: 1 })], "a", tombstone);
    expect(after).toHaveLength(1);
    expect(after[0]!.deletedAt).toBe(99);
  });

  it("removes the row entirely when there is no tombstone", () => {
    expect(applyDelete([message({ id: "a", seq: 1 })], "a", null)).toHaveLength(0);
  });
});

describe("reactions", () => {
  it("adds the caller to a new emoji", () => {
    expect(toggleReaction([], "👍", "me")).toEqual([{ emoji: "👍", userIds: ["me"] }]);
  });

  it("adds the caller to an existing emoji", () => {
    expect(toggleReaction([{ emoji: "👍", userIds: ["alice"] }], "👍", "me")).toEqual([
      { emoji: "👍", userIds: ["alice", "me"] },
    ]);
  });

  it("removes the caller and keeps the others", () => {
    expect(toggleReaction([{ emoji: "👍", userIds: ["alice", "me"] }], "👍", "me")).toEqual([
      { emoji: "👍", userIds: ["alice"] },
    ]);
  });

  it("drops the emoji when the caller was the last reactor", () => {
    expect(toggleReaction([{ emoji: "👍", userIds: ["me"] }], "👍", "me")).toEqual([]);
  });

  it("replaces a message's reaction list wholesale", () => {
    const after = applyReactions([message({ id: "a", seq: 1 })], "a", [
      { emoji: "🎉", userIds: ["bob"] },
    ]);
    expect(after[0]!.reactions).toEqual([{ emoji: "🎉", userIds: ["bob"] }]);
  });
});

describe("planCatchUp", () => {
  it("asks for nothing when the conversation was never loaded", () => {
    expect(planCatchUp({ serverLastSeq: 90, localLastSeq: 0, loaded: false })).toEqual({
      after: null,
      behind: 0,
    });
  });

  it("asks for nothing when the client is level", () => {
    expect(planCatchUp({ serverLastSeq: 40, localLastSeq: 40, loaded: true })).toEqual({
      after: null,
      behind: 0,
    });
  });

  it("pages from the client's own high-water mark", () => {
    expect(planCatchUp({ serverLastSeq: 48, localLastSeq: 40, loaded: true })).toEqual({
      after: 40,
      behind: 8,
    });
  });

  it("asks for nothing when the client is somehow ahead", () => {
    expect(planCatchUp({ serverLastSeq: 30, localLastSeq: 40, loaded: true }).after).toBeNull();
  });
});

describe("localLastSeq", () => {
  it("ignores pending rows, whose seq is a sentinel", () => {
    const pending = optimisticMessage({
      clientId: "c", channelId: "c1", authorId: "me", body: "x",
      rootId: null, attachments: [], mentions: [],
    });
    expect(localLastSeq([message({ id: "a", seq: 7 }), pending])).toBe(7);
  });

  it("is zero for an empty conversation", () => {
    expect(localLastSeq([])).toBe(0);
  });
});

function request(state: "pending" | "accepted" | "replied", updatedAt: number) {
  return { state, requesterId: "me", error: null, retryable: false, chatPath: null, replyId: null, updatedAt };
}

describe("applyAgentRequest", () => {

  it("sets the request on the one message it names", () => {
    const merged = applyAgentRequest([message({ id: "a", seq: 1 }), message({ id: "b", seq: 2 })], "b", request("accepted", 5));
    expect(merged[0]!.agentRequest).toBeUndefined();
    expect(merged[1]!.agentRequest?.state).toBe("accepted");
  });

  it("never lets an older event undo a newer one", () => {
    const replied = applyAgentRequest([message({ id: "a", seq: 1 })], "a", request("replied", 9));
    const stale = applyAgentRequest(replied, "a", request("accepted", 5));
    expect(stale[0]!.agentRequest?.state).toBe("replied");
  });
});
