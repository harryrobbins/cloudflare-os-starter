// Which conversations this browser has been in lately.
//
// A per-browser convenience, like the theme and the drafts, so it lives in localStorage rather than on
// the membership row: "where was I" is a property of this tab's owner, not of the account. The list is
// what makes the quick switcher's empty state useful and what "Pick up where you left off" reads.

import { readSetting, writeSetting } from "./drafts.js";

export const RECENT_CHANNELS_KEY = "chat.recentChannels.v1";
/** Long enough to cover a working day's conversations, short enough to stay a *recent* list. */
export const MAX_RECENTS = 12;

/** Pure: the list after visiting `channelId`, most recent first and deduplicated. */
export function withRecent(
  recents: readonly string[],
  channelId: string,
  max: number = MAX_RECENTS,
): string[] {
  return [channelId, ...recents.filter((id) => id !== channelId)].slice(0, max);
}

/** How recently a channel was open: 0 for the most recent, then 1, 2, … and `Infinity` for never. */
export function recencyRank(recents: readonly string[], channelId: string): number {
  const index = recents.indexOf(channelId);
  return index === -1 ? Number.POSITIVE_INFINITY : index;
}

export function readRecentChannels(): string[] {
  const raw = readSetting(RECENT_CHANNELS_KEY);
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string").slice(0, MAX_RECENTS);
  } catch {
    return [];
  }
}

export function rememberRecentChannel(channelId: string): void {
  writeSetting(RECENT_CHANNELS_KEY, JSON.stringify(withRecent(readRecentChannels(), channelId)));
}

/** The conversation to resume: the most recent one this client still knows about. */
export function lastChannel(known: (channelId: string) => boolean): string | null {
  return readRecentChannels().find(known) ?? null;
}

// --- where `/` goes --------------------------------------------------------

export const LANDING_KEY = "chat.landing.v1";

/**
 * What `/` should show.
 *
 * `inbox` is the default, deliberately: dropping straight into the last channel is fast but it hides
 * the one question the app is best placed to answer, which is what happened while you were gone.
 * People who disagree can say so in Settings, and then `/` resumes the last conversation instead.
 */
export type Landing = "inbox" | "last-channel";

export function readLanding(): Landing {
  return readSetting(LANDING_KEY) === "last-channel" ? "last-channel" : "inbox";
}

export function writeLanding(landing: Landing): void {
  writeSetting(LANDING_KEY, landing === "inbox" ? null : landing);
}
