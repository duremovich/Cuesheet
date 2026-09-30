// Text matching shared by the record pickers (R5a) and the command palette (R5b).

/** Lowercased, trimmed query tokens. */
export function tokens(q: string): string[] {
  return q.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * How well `fields` match `q` (lower is better), or null for no match. Every token must
 * appear in some field. 0: the primary field (fields[0]) equals the query; 1: it starts
 * with it; 2: a word in it starts with it; 3: any other match. An empty query matches
 * everything with 3.
 */
export function matchScore(
  q: string,
  fields: readonly (string | null | undefined)[],
): number | null {
  const ts = tokens(q);
  if (ts.length === 0) return 3;
  const hay = fields.map((f) => (f ?? "").toLowerCase());
  if (!ts.every((t) => hay.some((h) => h.includes(t)))) return null;
  const primary = hay[0] ?? "";
  const whole = ts.join(" ");
  if (primary === whole) return 0;
  if (primary.startsWith(whole)) return 1;
  if (primary.split(/[\s\-_:/.]+/).some((w) => w.startsWith(ts[0] as string))) return 2;
  return 3;
}

/**
 * Items matching `q`, best first: by score, then `boost` (e.g. same scene) first, then the
 * input order. At most `limit`.
 */
export function rankItems<T>(
  items: readonly T[],
  q: string,
  fields: (t: T) => readonly (string | null | undefined)[],
  opts: { boost?: (t: T) => boolean; limit?: number } = {},
): T[] {
  const scored: { t: T; s: number; b: number; i: number }[] = [];
  items.forEach((t, i) => {
    const s = matchScore(q, fields(t));
    if (s !== null) scored.push({ t, s, b: opts.boost?.(t) ? 0 : 1, i });
  });
  scored.sort((x, y) => x.s - y.s || x.b - y.b || x.i - y.i);
  return scored.slice(0, opts.limit ?? 50).map((x) => x.t);
}
