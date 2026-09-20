// Reactions: which emoji to offer, and who reacted.
//
// Two separate concerns that both belong outside React. The quick-pick row is "what does *this*
// person reach for", which is a frequency count in localStorage -- the same risk class as a draft, and
// wrapped the same way, because the accessor itself throws in a private window. The "who reacted"
// sentence is pure string work over the contract's `Reaction.userIds`, which is exactly the kind of
// thing that regresses into "You, You and 2 others" unless it is pinned by tests.

import { QUICK_REACTIONS } from "./emoji.js";
import { readSetting, writeSetting } from "../store/drafts.js";

export const EMOJI_FREQUENCY_KEY = "chat.emoji.frequency.v1";

/** How many emoji the hover bar and the picker's first group offer. */
export const QUICK_PICK_COUNT = 5;

export type EmojiFrequency = Readonly<Record<string, number>>;

/**
 * The quick-pick row: the reader's most-used emoji first, then the built-in defaults to fill the row.
 *
 * Padding with the defaults rather than showing a short row on a fresh profile is the point -- the row
 * has a fixed width, and a bar that grows from two buttons to five as you use the app looks broken.
 * Ties fall back to the default order so the row is stable between renders.
 */
export function rankQuickReactions(
  frequency: EmojiFrequency,
  defaults: readonly string[] = QUICK_REACTIONS,
  limit: number = QUICK_PICK_COUNT,
): readonly string[] {
  const ranked = Object.entries(frequency)
    .filter(([emoji, count]) => emoji.length > 0 && count > 0)
    .toSorted(([aEmoji, aCount], [bEmoji, bCount]) => {
      if (aCount !== bCount) return bCount - aCount;
      const aIndex = defaults.indexOf(aEmoji);
      const bIndex = defaults.indexOf(bEmoji);
      if (aIndex !== bIndex) return (aIndex === -1 ? 99 : aIndex) - (bIndex === -1 ? 99 : bIndex);
      return aEmoji < bEmoji ? -1 : 1;
    })
    .map(([emoji]) => emoji);

  const out: string[] = [];
  for (const emoji of [...ranked, ...defaults]) {
    if (out.length >= limit) break;
    if (!out.includes(emoji)) out.push(emoji);
  }
  return out;
}

/** One use of `emoji`, folded into the stored counts. Pure, so the decay rule is testable. */
export function countUse(frequency: EmojiFrequency, emoji: string): EmojiFrequency {
  const next: Record<string, number> = { ...frequency, [emoji]: (frequency[emoji] ?? 0) + 1 };
  // Bounded: keep the 24 most-used, so a year of reacting cannot grow the entry without limit.
  const kept = Object.entries(next)
    .toSorted(([, a], [, b]) => b - a)
    .slice(0, 24);
  return Object.fromEntries(kept);
}

// --- the stored half --------------------------------------------------------

let cachedFrequency: EmojiFrequency | null = null;
let cachedQuick: readonly string[] | null = null;
const listeners = new Set<() => void>();

export function readEmojiFrequency(): EmojiFrequency {
  if (cachedFrequency !== null) return cachedFrequency;
  const raw = readSetting(EMOJI_FREQUENCY_KEY);
  cachedFrequency = raw === null ? {} : parseFrequency(raw);
  return cachedFrequency;
}

function parseFrequency(raw: string): EmojiFrequency {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: Record<string, number> = {};
    for (const [emoji, count] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof count === "number" && Number.isFinite(count) && count > 0) out[emoji] = count;
    }
    return out;
  } catch {
    return {};
  }
}

/** Records one reaction the user *added*. Removing one is not a preference, so it does not count. */
export function recordEmojiUse(emoji: string): void {
  const next = countUse(readEmojiFrequency(), emoji);
  cachedFrequency = next;
  cachedQuick = null;
  writeSetting(EMOJI_FREQUENCY_KEY, JSON.stringify(next));
  for (const listener of listeners) listener();
}

/**
 * The current quick-pick row, as a stable reference.
 *
 * `useSyncExternalStore` compares the snapshot by identity, so recomputing the array on every read
 * would re-render every message row on every keystroke elsewhere in the app.
 */
export function quickReactions(): readonly string[] {
  if (cachedQuick === null) cachedQuick = rankQuickReactions(readEmojiFrequency());
  return cachedQuick;
}

export function subscribeQuickReactions(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test seam: forgets what was read from storage. */
export function resetEmojiFrequencyCache(): void {
  cachedFrequency = null;
  cachedQuick = null;
}

// --- who reacted ------------------------------------------------------------

/**
 * `You and Bob Okafor reacted with 👍`.
 *
 * "You" is always first, because the first thing anybody checks is whether their own reaction landed.
 * Past four names the tail collapses to a count: a tooltip is one line, and a channel-wide 👍 would
 * otherwise produce a paragraph.
 */
export function describeReactors(
  emoji: string,
  userIds: readonly string[],
  meId: string | undefined,
  nameOf: (id: string) => string | undefined,
): string {
  const mine = meId !== undefined && userIds.includes(meId);
  const others = userIds.filter((id) => id !== meId).map((id) => nameOf(id) ?? "Someone");
  const names = mine ? ["You", ...others] : others;
  return `${joinNames(names)} reacted with ${emoji}`;
}

function joinNames(names: readonly string[]): string {
  if (names.length === 0) return "Nobody";
  if (names.length === 1) return names[0]!;
  if (names.length <= 4) return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const rest = names.length - 3;
  return `${names.slice(0, 3).join(", ")} and ${rest} ${rest === 1 ? "other" : "others"}`;
}
