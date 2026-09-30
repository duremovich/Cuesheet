// Typing dates, times, durations and timecodes into custom field cells (R9): lenient input,
// normalised storage (what `checkCustomValue` in src/shared/custom-fields.ts accepts).
// Pure; see values.test.ts.

type Parsed = { value: string } | { error: string };

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

function validDay(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * A date: `2026-09-30`, `9/30/2026`, `9/30/26`, `30.9.2026`, `today`, `tomorrow`,
 * `yesterday` → `YYYY-MM-DD`. `now` is for tests.
 */
export function parseDate(text: string, now = new Date()): Parsed | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  const rel = { today: 0, tomorrow: 1, yesterday: -1 }[t];
  if (rel !== undefined) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + rel);
    return { value: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` };
  }
  const ymd = dayParts(t);
  if (!ymd) return { error: "Use a date like 2026-09-30 or 9/30/2026" };
  const [y, m, d] = ymd;
  if (!validDay(y, m, d)) return { error: "That day doesn't exist" };
  return { value: `${y}-${pad(m)}-${pad(d)}` };
}

/** [year, month, day] from `2026-09-30`, `9/30/2026`, `9/30/26` or `30.9.2026`. */
function dayParts(t: string): [number, number, number] | null {
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (iso) return [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(t);
  if (us) {
    const y = Number(us[3]);
    return [y < 100 ? y + 2000 : y, Number(us[1]), Number(us[2])];
  }
  const eu = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(t);
  return eu ? [Number(eu[3]), Number(eu[2]), Number(eu[1])] : null;
}

/** A date and time: a date plus `19:30`, `7:30pm`, `7pm` → `YYYY-MM-DDTHH:MM`. */
export function parseDateTime(text: string, now = new Date()): Parsed | null {
  const t = text.trim();
  if (!t) return null;
  const m = /^(.+?)[T\s]+(\d{1,2})(?::(\d{2}))?\s*([ap]m)?$/i.exec(t);
  if (!m) return { error: "Use a date and time like 2026-09-30 19:30" };
  const date = parseDate(m[1] ?? "", now);
  if (!date || "error" in date) return date ?? { error: "Missing the date" };
  let h = Number(m[2]);
  const min = Number(m[3] ?? "0");
  const ap = m[4]?.toLowerCase();
  if (ap) {
    if (h < 1 || h > 12) return { error: "Hours must be 1–12 with am/pm" };
    h = (h % 12) + (ap === "pm" ? 12 : 0);
  }
  if (h > 23 || min > 59) return { error: "That time doesn't exist" };
  return { value: `${date.value}T${pad(h)}:${pad(min)}` };
}

/** `2026-09-30T19:30` → `2026-09-30 19:30` (display). */
export function formatDateTime(v: unknown): string {
  return typeof v === "string" ? v.replace("T", " ") : "";
}

/**
 * A duration: `h:mm:ss(.ms)`, `mm:ss`, `90` / `90s` (seconds), `1h 30m`, `2m 5.5s` →
 * `h:mm:ss(.mmm)` without trailing zeros in the fraction.
 */
export function parseDuration(text: string): Parsed | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  let seconds: number | null = null;
  const colon = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(t);
  if (colon) {
    const [h, m, s] = [Number(colon[1] ?? 0), Number(colon[2]), Number(colon[3])];
    if (m > 59 && colon[1] !== undefined) return { error: "Minutes must be under 60" };
    if (s >= 60) return { error: "Seconds must be under 60" };
    seconds = h * 3600 + m * 60 + s;
  } else if (/^\d+(\.\d+)?\s*s?$/.test(t)) {
    seconds = Number.parseFloat(t);
  } else {
    const units =
      /^(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m)?\s*(?:(\d+(?:\.\d+)?)\s*s)?$/.exec(t);
    if (units && (units[1] || units[2] || units[3])) {
      seconds = Number(units[1] ?? 0) * 3600 + Number(units[2] ?? 0) * 60 + Number(units[3] ?? 0);
    }
  }
  if (seconds === null || !Number.isFinite(seconds)) {
    return { error: "Use a duration like 1:30, 0:01:30.5 or 90s" };
  }
  return { value: formatSeconds(seconds) };
}

/** Seconds → `h:mm:ss(.mmm)`. */
export function formatSeconds(total: number): string {
  const ms = Math.round(total * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const frac = ms % 1000;
  const fraction = frac ? `.${pad(frac, 3).replace(/0+$/, "")}` : "";
  return `${h}:${pad(m)}:${pad(s)}${fraction}`;
}

/** A timecode `hh:mm:ss:ff` (`;` for drop frame), `h:mm:ss:ff` or `hhmmssff` → `hh:mm:ss:ff`. */
export function parseTimecode(text: string): Parsed | null {
  const t = text.trim();
  if (!t) return null;
  const m =
    /^(\d{1,2})[:.](\d{2})[:.](\d{2})([:;.])(\d{2})$/.exec(t) ??
    /^(\d{2})(\d{2})(\d{2})()(\d{2})$/.exec(t);
  if (!m) return { error: "Use a timecode like 01:00:10:12" };
  const [h, min, s, f] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[5])];
  if (min > 59 || s > 59) return { error: "Minutes and seconds must be under 60" };
  const sep = m[4] === ";" ? ";" : ":";
  return { value: `${pad(h)}:${pad(min)}:${pad(s)}${sep}${pad(f)}` };
}

/** A URL as typed: `example.com/x` gets `https://`. */
export function parseUrl(text: string): Parsed | null {
  const t = text.trim();
  if (!t) return null;
  if (/^(https?:\/\/|mailto:)\S/i.test(t)) return { value: t };
  if (/^[\w-]+(\.[\w-]+)+(\/|$)/i.test(t)) return { value: `https://${t}` };
  return { error: "Use a web address like https://example.com" };
}

/** The href for a stored URL value (only http(s) and mailto open). */
export function urlHref(v: unknown): string | null {
  if (typeof v !== "string") return null;
  return /^(https?:\/\/|mailto:)/i.test(v.trim()) ? v.trim() : null;
}
