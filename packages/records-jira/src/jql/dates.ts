// JQL date values, resolved to ISO instants at parse time.
//
// Accepted: 'yyyy/MM/dd HH:mm', 'yyyy-MM-dd HH:mm', 'yyyy/MM/dd', 'yyyy-MM-dd', a full ISO 8601
// instant with an offset (an extension), and relative periods such as '-7d', '-2w', '-4w 2d', '1h'
// (units y, M, w, d, h, m; relative to `now`). Functions: now(), startOfDay/endOfDay,
// startOfWeek/endOfWeek, startOfMonth/endOfMonth, startOfYear/endOfYear, each with an optional
// increment such as startOfDay(-1) or startOfMonth("+1M").
//
// Decision: every calendar calculation is in UTC (Jira uses the user's time zone), and weeks start
// on Monday unless `weekStartsOn` says Sunday. Date-only values mean midnight UTC.

export type DateContext = { now: Date; weekStartsOn?: 0 | 1 };

const UNIT_RE = /(\d+)\s*([yMwdhm])/g;

function addUnits(date: Date, sign: 1 | -1, amount: number, unit: string): Date {
  const d = new Date(date.getTime());
  const n = sign * amount;
  switch (unit) {
    case "y":
      d.setUTCFullYear(d.getUTCFullYear() + n);
      break;
    case "M":
      d.setUTCMonth(d.getUTCMonth() + n);
      break;
    case "w":
      d.setUTCDate(d.getUTCDate() + 7 * n);
      break;
    case "d":
      d.setUTCDate(d.getUTCDate() + n);
      break;
    case "h":
      d.setUTCHours(d.getUTCHours() + n);
      break;
    case "m":
      d.setUTCMinutes(d.getUTCMinutes() + n);
      break;
  }
  return d;
}

/** A relative period ('-4w 2d') applied to `base`, or null when `text` is not one. */
function applyPeriod(text: string, base: Date, defaultUnit?: string): Date | null {
  const s = text.trim();
  const m = /^([-+]?)\s*((?:\d+\s*[yMwdhm]?\s*)+)$/.exec(s);
  if (!m) return null;
  const sign: 1 | -1 = m[1] === "-" ? -1 : 1;
  const body = m[2]!.trim();
  if (/^\d+$/.test(body)) {
    // A bare number: Jira reads it as minutes for a date field, or the function's own unit.
    return addUnits(base, sign, Number(body), defaultUnit ?? "m");
  }
  if (!/^(?:\d+\s*[yMwdhm]\s*)+$/.test(body)) return null;
  let d = base;
  for (const part of body.matchAll(UNIT_RE)) d = addUnits(d, sign, Number(part[1]), part[2]!);
  return d;
}

/** Parse a JQL date literal. Returns an ISO instant, or null when the text is not a valid date. */
export function parseJqlDate(text: string, ctx: DateContext): string | null {
  const s = text.trim();
  const abs = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(s);
  if (abs) {
    const [y, mo, d, h, mi] = [Number(abs[1]), Number(abs[2]), Number(abs[3]), Number(abs[4] ?? 0), Number(abs[5] ?? 0)];
    const date = new Date(Date.UTC(y, mo - 1, d, h, mi));
    if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d || h > 23 || mi > 59) return null;
    return date.toISOString();
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const t = Date.parse(s.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  if (/^[-+]?\s*\d/.test(s)) {
    const d = applyPeriod(s, ctx.now);
    return d ? d.toISOString() : null;
  }
  return null;
}

type Period = "day" | "week" | "month" | "year";

function startOf(period: Period, now: Date, weekStartsOn: 0 | 1): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (period === "week") {
    const back = (d.getUTCDay() - weekStartsOn + 7) % 7;
    d.setUTCDate(d.getUTCDate() - back);
  } else if (period === "month") d.setUTCDate(1);
  else if (period === "year") d.setUTCMonth(0, 1);
  return d;
}

const PERIOD_UNIT: Record<Period, string> = { day: "d", week: "w", month: "M", year: "y" };

export const DATE_FUNCTIONS = [
  "now",
  "startofday",
  "endofday",
  "startofweek",
  "endofweek",
  "startofmonth",
  "endofmonth",
  "startofyear",
  "endofyear",
] as const;

/**
 * Evaluate a date function. Returns an ISO instant, or a string error message when the arguments
 * are wrong, or null when `name` is not a date function.
 */
export function evaluateDateFunction(name: string, args: string[], ctx: DateContext): { value: string } | { error: string } | null {
  const lower = name.toLowerCase();
  if (!(DATE_FUNCTIONS as readonly string[]).includes(lower)) return null;
  if (lower === "now") {
    if (args.length) return { error: `Function 'now' expected '0' arguments but received '${args.length}'.` };
    return { value: ctx.now.toISOString() };
  }
  const m = /^(start|end)of(day|week|month|year)$/.exec(lower)!;
  const edge = m[1] as "start" | "end";
  const period = m[2] as Period;
  if (args.length > 1) return { error: `Function '${name}' expected between '0' and '1' arguments but received '${args.length}'.` };
  const weekStartsOn = ctx.weekStartsOn ?? 1;
  let d = startOf(period, ctx.now, weekStartsOn);
  if (edge === "end") d = new Date(addUnits(d, 1, 1, PERIOD_UNIT[period]).getTime() - 1);
  if (args[0] !== undefined) {
    const shifted = applyPeriod(args[0], d, PERIOD_UNIT[period]);
    if (!shifted) return { error: `Duration for function '${name}' should have the format (+/-)n(yMwdm), e.g -1M for 1 month earlier.` };
    d = shifted;
  }
  return { value: d.toISOString() };
}
