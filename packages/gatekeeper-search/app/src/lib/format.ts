// Dates for the result list and the preview.

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 86_400_000],
  ["month", 30 * 86_400_000],
  ["week", 7 * 86_400_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** "3 hours ago", "yesterday", "just now". */
export function relativeTime(at: number, now: number = Date.now()): string {
  const delta = at - now;
  const size = Math.abs(delta);
  if (size < 45_000) return "just now";
  for (const [unit, ms] of UNITS) {
    if (size >= ms || unit === "minute") return relative.format(Math.round(delta / ms), unit);
  }
  return "just now";
}

const absolute = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" });

/** "24 Sept 2026, 14:05", for a `title` tooltip and the preview. */
export function absoluteTime(at: number): string {
  return absolute.format(new Date(at));
}

const monthFormat = new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });

/** "Sept 2026" from "2026-09"; anything else as is. */
export function monthLabel(value: string): string {
  const match = /^(\d{4})-(\d{2})$/u.exec(value);
  if (match === null) return value;
  return monthFormat.format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)));
}

export function formatCount(n: number): string {
  return new Intl.NumberFormat("en-GB").format(n);
}
