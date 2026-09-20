// Turning a flat message list into the rows the conversation renders.
//
// Three decisions, all made once here so the virtualised list and the thread pane cannot disagree:
// where a day divider goes, where the "New messages" rule goes, and whether a message continues the
// previous author's group. Grouping is five minutes, from the plan.

import type { MessageId, UserId } from "../contract.js";
import type { LocalMessage } from "../store/merge.js";
import { dayKey } from "./format.js";

export const GROUP_WINDOW_MS = 5 * 60 * 1000;

export type Row =
  | { readonly kind: "day"; readonly key: string; readonly at: number }
  | { readonly kind: "unread"; readonly key: string }
  | {
      readonly kind: "message";
      readonly key: MessageId;
      readonly message: LocalMessage;
      /** False when this message continues the previous author's group: no avatar, no name row. */
      readonly startsGroup: boolean;
    };

export function buildRows(
  messages: readonly LocalMessage[],
  options: { readonly firstUnreadSeq?: number | null; readonly meId?: UserId } = {},
): Row[] {
  const rows: Row[] = [];
  let previous: LocalMessage | null = null;
  let unreadPlaced = false;
  const firstUnread = options.firstUnreadSeq ?? null;

  for (const message of messages) {
    const day = dayKey(message.createdAt);
    if (previous === null || dayKey(previous.createdAt) !== day) {
      rows.push({ kind: "day", key: `day:${day}`, at: message.createdAt });
      previous = null; // A day boundary always starts a fresh group.
    }
    if (!unreadPlaced && firstUnread !== null && message.seq >= firstUnread) {
      // Never above your own message: the divider would claim you had not read what you just sent.
      if (message.authorId !== options.meId) {
        rows.push({ kind: "unread", key: "unread" });
        unreadPlaced = true;
        previous = null;
      }
    }
    const startsGroup =
      previous === null ||
      previous.authorId !== message.authorId ||
      previous.kind !== message.kind ||
      message.kind === "system" ||
      message.createdAt - previous.createdAt > GROUP_WINDOW_MS;
    rows.push({ kind: "message", key: message.id, message, startsGroup });
    previous = message;
  }
  return rows;
}
