// "3 days ago" / "in 6 days" for member and invite details (last active, expiry).

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * DAY],
  ["month", 30 * DAY],
  ["week", 7 * DAY],
  ["day", DAY],
  ["hour", HOUR],
  ["minute", MINUTE],
];

const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** `t` relative to `now`, in the largest whole unit ("3 days ago", "in 6 days", "just now"). */
export function relativeTime(t: number, now = Date.now()): string {
  const diff = t - now;
  const abs = Math.abs(diff);
  if (abs < MINUTE) return "just now";
  for (const [unit, ms] of UNITS) {
    if (abs >= ms) return format.format(Math.trunc(diff / ms), unit);
  }
  return "just now";
}

/** A day, e.g. "Nov 18, 2026". */
export function shortDate(t: number): string {
  return new Date(t).toLocaleDateString(undefined, { dateStyle: "medium" });
}
