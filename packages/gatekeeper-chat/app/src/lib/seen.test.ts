import { describe, expect, it } from "vitest";

import { describeSeen, seenMarkers, type SeenInput } from "./seen.js";

const messages = [
  { id: "m1", seq: 1, rootId: null },
  { id: "m2", seq: 2, rootId: null },
  { id: "m3", seq: 3, rootId: null },
];

const run = (patch: Partial<SeenInput>): ReadonlyMap<string, readonly { userId: string }[]> =>
  seenMarkers({ cursors: [], messages, meId: "me", ...patch });

describe("seenMarkers", () => {
  it("puts a reader after the newest message at or below their cursor", () => {
    const markers = run({ cursors: [{ userId: "u-alice", lastReadSeq: 2 }] });
    expect([...markers.keys()]).toEqual(["m2"]);
  });

  it("stacks readers who are at the same place", () => {
    const markers = run({
      cursors: [
        { userId: "u-alice", lastReadSeq: 3 },
        { userId: "u-bob", lastReadSeq: 3 },
      ],
    });
    expect(markers.get("m3")?.map((reader) => reader.userId)).toEqual(["u-alice", "u-bob"]);
  });

  it("clamps a cursor ahead of everything on screen to the newest message", () => {
    expect([...run({ cursors: [{ userId: "u-alice", lastReadSeq: 99 }] }).keys()]).toEqual(["m3"]);
  });

  it("gives no marker to somebody who has read nothing we hold", () => {
    expect(run({ cursors: [{ userId: "u-alice", lastReadSeq: 0 }] }).size).toBe(0);
  });

  it("never marks your own cursor", () => {
    expect(run({ cursors: [{ userId: "me", lastReadSeq: 3 }] }).size).toBe(0);
  });

  it("ignores pending rows and thread replies, which nobody can have read", () => {
    const markers = seenMarkers({
      cursors: [{ userId: "u-alice", lastReadSeq: 9 }],
      messages: [
        { id: "m1", seq: 1, rootId: null },
        { id: "r1", seq: 2, rootId: "m1" },
        { id: "local:x", seq: Number.MAX_SAFE_INTEGER, rootId: null, local: { state: "pending" } },
      ],
      meId: "me",
    });
    expect([...markers.keys()]).toEqual(["m1"]);
  });

  it("is empty when there is nothing on screen", () => {
    expect(seenMarkers({ cursors: [{ userId: "a", lastReadSeq: 1 }], messages: [] }).size).toBe(0);
  });

  it("keeps the witnessed time when there is one", () => {
    const markers = run({ cursors: [{ userId: "u-alice", lastReadSeq: 3, seenAt: 1000 }] });
    expect(markers.get("m3")?.[0]).toEqual({ userId: "u-alice", seenAt: 1000 });
  });
});

const nameOf = (id: string): string | undefined =>
  ({ "u-alice": "Alice Chen", "u-bob": "Bob Okafor" })[id];

describe("describeSeen", () => {
  it("names one reader", () => {
    expect(describeSeen([{ userId: "u-alice" }], nameOf)).toBe("Seen by Alice Chen");
  });

  it("adds a time only for a read this tab watched happen", () => {
    const now = 10 * 60_000;
    expect(describeSeen([{ userId: "u-alice", seenAt: now - 120_000 }], nameOf, now)).toBe(
      "Seen by Alice Chen (2m ago)",
    );
  });

  it("joins two", () => {
    expect(describeSeen([{ userId: "u-alice" }, { userId: "u-bob" }], nameOf)).toBe(
      "Seen by Alice Chen and Bob Okafor",
    );
  });

  it("collapses a crowd", () => {
    const readers = ["a", "b", "c", "d", "e"].map((userId) => ({ userId }));
    expect(describeSeen(readers, () => "X")).toBe("Seen by X, X, X and 2 others");
  });

  it("falls back for somebody the directory has not seen", () => {
    expect(describeSeen([{ userId: "ghost" }], nameOf)).toBe("Seen by Someone");
  });
});
