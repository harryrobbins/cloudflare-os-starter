// Who has read how far.
//
// `GET channels/:id/messages` carries the other members' `lastReadSeq` for a `dm` or a `group`, and
// the socket keeps it current. Turning those numbers into "an avatar sits after the last message this
// person has read" is a small piece of arithmetic with two awkward cases -- a cursor ahead of
// everything the client holds, and several people sharing a position -- so it lives here with tests
// rather than inside a `useMemo`.

import type { MessageId, UserId } from "../contract.js";
import { formatRelative } from "./format.js";

export interface SeenCursor {
  readonly userId: UserId;
  readonly lastReadSeq: number;
  /** When this client *watched* the read happen. Absent for a cursor that arrived with the page. */
  readonly seenAt?: number;
}

export interface SeenReader {
  readonly userId: UserId;
  readonly seenAt?: number;
}

export interface SeenInput {
  readonly cursors: readonly SeenCursor[];
  /** Ascending by `seq`, as the store keeps them. */
  readonly messages: readonly {
    readonly id: MessageId;
    readonly seq: number;
    readonly rootId: MessageId | null;
    readonly local?: unknown;
  }[];
  readonly meId?: UserId;
}

/**
 * Where each reader's marker goes: the newest message at or below their cursor.
 *
 * Pending rows are skipped -- they have no `seq` the server has ever seen, so nobody can have read
 * one -- and so are thread replies, because the markers are drawn on the channel's own list. A reader
 * whose cursor is below everything on screen gets no marker at all rather than one pinned to the
 * oldest row, which would say something untrue about how far back they have got.
 */
export function seenMarkers(input: SeenInput): ReadonlyMap<MessageId, readonly SeenReader[]> {
  const timeline = input.messages.filter(
    (message) => message.local === undefined && message.rootId === null,
  );
  const markers = new Map<MessageId, SeenReader[]>();
  if (timeline.length === 0) return markers;

  for (const cursor of input.cursors) {
    if (cursor.userId === input.meId) continue;
    let target: MessageId | null = null;
    for (const message of timeline) {
      if (message.seq > cursor.lastReadSeq) break;
      target = message.id;
    }
    if (target === null) continue;
    const readers = markers.get(target);
    const reader: SeenReader =
      cursor.seenAt === undefined
        ? { userId: cursor.userId }
        : { userId: cursor.userId, seenAt: cursor.seenAt };
    if (readers === undefined) markers.set(target, [reader]);
    else readers.push(reader);
  }
  return markers;
}

/**
 * `Seen by Alice Chen (2m ago) and Bob Okafor`.
 *
 * The time is only ever shown for a read this tab actually witnessed over the socket: the contract's
 * `ReadCursor` carries a sequence number and nothing else, so claiming a time for a cursor that
 * arrived with the page would be an invention.
 */
export function describeSeen(
  readers: readonly SeenReader[],
  nameOf: (id: UserId) => string | undefined,
  now: number = Date.now(),
): string {
  const parts = readers.map((reader) => {
    const name = nameOf(reader.userId) ?? "Someone";
    return reader.seenAt === undefined ? name : `${name} (${formatRelative(reader.seenAt, now)})`;
  });
  if (parts.length === 0) return "Not seen yet";
  if (parts.length === 1) return `Seen by ${parts[0]}`;
  if (parts.length <= 4) {
    return `Seen by ${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  }
  const rest = parts.length - 3;
  return `Seen by ${parts.slice(0, 3).join(", ")} and ${rest} ${rest === 1 ? "other" : "others"}`;
}
