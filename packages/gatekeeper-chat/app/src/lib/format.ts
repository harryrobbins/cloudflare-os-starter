// Presentation helpers. Deliberately locale-pinned to `en-GB`: the times appear in screenshots and
// in tests, and a machine-dependent 12/24-hour clock would make both unstable. Everything here is
// pure, so it is covered by the store tests without a DOM.

const TIME = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });
const DAY = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long" });
const DAY_WITH_YEAR = new Intl.DateTimeFormat("en-GB", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});
const SHORT_DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
const FULL_DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric" });

/** `10:02`. */
export function formatTime(at: number): string {
  return TIME.format(at);
}

/** Local calendar day as `YYYY-MM-DD`, the key day dividers and grouping compare on. */
export function dayKey(at: number): string {
  const d = new Date(at);
  const month = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

/** `Today`, `Yesterday`, `Wednesday, 17 September`, or with the year once it is not this one. */
export function formatDayDivider(at: number, now: number = Date.now()): string {
  const key = dayKey(at);
  if (key === dayKey(now)) return "Today";
  if (key === dayKey(now - 86_400_000)) return "Yesterday";
  return new Date(at).getFullYear() === new Date(now).getFullYear()
    ? DAY.format(at)
    : DAY_WITH_YEAR.format(at);
}

/** `17 September 2026`. For a fact about a thing rather than a position in a conversation. */
export function formatFullDate(at: number): string {
  return FULL_DATE.format(at);
}

/** `10:02` today, `Yesterday 10:02`, `17 Sep 10:02` further back. For lists, not the conversation. */
export function formatListTime(at: number, now: number = Date.now()): string {
  const key = dayKey(at);
  if (key === dayKey(now)) return TIME.format(at);
  if (key === dayKey(now - 86_400_000)) return `Yesterday ${TIME.format(at)}`;
  return `${SHORT_DATE.format(at)} ${TIME.format(at)}`;
}

/** `just now`, `4m`, `3h`, `2d`, then a date. Used where space is tight (thread summaries). */
export function formatRelative(at: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  if (seconds < 7 * 86_400) return `${Math.round(seconds / 86_400)}d ago`;
  return SHORT_DATE.format(at);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** Up to two initials from a display name, falling back to the first character of anything. */
export function initials(name: string): string {
  const words = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[words.length - 1]![0]!).toUpperCase();
}

/**
 * A stable hue per user id, so a monogram avatar keeps its colour between sessions and machines.
 * A plain FNV-1a over the id: the value only has to be deterministic, not well distributed.
 */
export function hueFor(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 360;
}

/** `#general`, or the names of the other people in a DM or group. */
export function pluralise(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
