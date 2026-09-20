import { describe, expect, it } from "vitest";

import type { Message } from "../contract.js";
import type { LocalMessage } from "../store/merge.js";
import { buildRows, GROUP_WINDOW_MS } from "./grouping.js";

const DAY = 86_400_000;
/** A fixed local-noon base, so a day boundary in the test is a day boundary in any timezone. */
const NOON = new Date(2026, 8, 17, 12, 0, 0).getTime();

function message(patch: Partial<Message> & { id: string; seq: number }): LocalMessage {
  return {
    channelId: "c1",
    rootId: null,
    authorId: "alice",
    body: "hello",
    kind: "user",
    createdAt: NOON,
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

describe("buildRows", () => {
  it("opens with a day divider", () => {
    const rows = buildRows([message({ id: "a", seq: 1 })]);
    expect(rows[0]!.kind).toBe("day");
    expect(rows[1]).toMatchObject({ kind: "message", startsGroup: true });
  });

  it("inserts a divider at each new calendar day", () => {
    const rows = buildRows([
      message({ id: "a", seq: 1, createdAt: NOON - DAY }),
      message({ id: "b", seq: 2, createdAt: NOON }),
    ]);
    expect(rows.filter((row) => row.kind === "day")).toHaveLength(2);
  });

  it("groups consecutive messages from one author inside five minutes", () => {
    const rows = buildRows([
      message({ id: "a", seq: 1 }),
      message({ id: "b", seq: 2, createdAt: NOON + 60_000 }),
    ]);
    expect(rows[2]).toMatchObject({ kind: "message", startsGroup: false });
  });

  it("breaks the group after five minutes", () => {
    const rows = buildRows([
      message({ id: "a", seq: 1 }),
      message({ id: "b", seq: 2, createdAt: NOON + GROUP_WINDOW_MS + 1 }),
    ]);
    expect(rows[2]).toMatchObject({ startsGroup: true });
  });

  it("breaks the group when the author changes", () => {
    const rows = buildRows([
      message({ id: "a", seq: 1 }),
      message({ id: "b", seq: 2, authorId: "bob", createdAt: NOON + 1000 }),
    ]);
    expect(rows[2]).toMatchObject({ startsGroup: true });
  });

  it("never groups a system message with what came before", () => {
    const rows = buildRows([
      message({ id: "a", seq: 1 }),
      message({ id: "b", seq: 2, kind: "system", createdAt: NOON + 1000 }),
    ]);
    expect(rows[2]).toMatchObject({ startsGroup: true });
  });

  it("puts the New messages rule above the first unread", () => {
    const rows = buildRows(
      [
        message({ id: "a", seq: 1 }),
        message({ id: "b", seq: 2, createdAt: NOON + 1000 }),
        message({ id: "c", seq: 3, createdAt: NOON + 2000 }),
      ],
      { firstUnreadSeq: 2, meId: "me" },
    );
    const index = rows.findIndex((row) => row.kind === "unread");
    expect(index).toBeGreaterThan(-1);
    expect(rows[index + 1]).toMatchObject({ kind: "message", key: "b" });
  });

  it("places the rule at most once", () => {
    const rows = buildRows(
      [message({ id: "a", seq: 1 }), message({ id: "b", seq: 2, createdAt: NOON + 1000 })],
      { firstUnreadSeq: 1, meId: "me" },
    );
    expect(rows.filter((row) => row.kind === "unread")).toHaveLength(1);
  });

  it("does not put the rule above your own message", () => {
    const rows = buildRows(
      [
        message({ id: "a", seq: 1, authorId: "me" }),
        message({ id: "b", seq: 2, createdAt: NOON + 1000 }),
      ],
      { firstUnreadSeq: 1, meId: "me" },
    );
    const index = rows.findIndex((row) => row.kind === "unread");
    expect(rows[index + 1]).toMatchObject({ key: "b" });
  });

  it("starts a fresh group after the rule", () => {
    const rows = buildRows(
      [
        message({ id: "a", seq: 1 }),
        message({ id: "b", seq: 2, createdAt: NOON + 1000 }),
      ],
      { firstUnreadSeq: 2, meId: "me" },
    );
    const index = rows.findIndex((row) => row.kind === "unread");
    expect(rows[index + 1]).toMatchObject({ startsGroup: true });
  });

  it("omits the rule when everything is read", () => {
    const rows = buildRows([message({ id: "a", seq: 1 })], { firstUnreadSeq: null });
    expect(rows.some((row) => row.kind === "unread")).toBe(false);
  });
});
