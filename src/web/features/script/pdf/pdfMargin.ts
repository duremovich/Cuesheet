// The PDF page view's cue margin (pure): where each cue number sits beside the page, and
// what a positional cue's leader line says.
import type { CueRow } from "../../../../shared/tables";
import { triggerBadge } from "../markers";

export interface MarginItem {
  key: string;
  /** Where the entry wants its top (its target's height). */
  want: number;
  height: number;
}

/**
 * Margin entries without overlaps: in order of their wanted height (ties keep input
 * order), each at its wanted top unless the one above pushes it down; when that runs past
 * `max`, the run is pushed back up (never above `min`), so a crowded page bottom fans
 * upward instead of off the page. If everything can't fit, entries overflow downward
 * rather than overlap. Returns each entry's top.
 */
export function layoutMargin(
  items: readonly MarginItem[],
  opts: { gap?: number; min?: number; max?: number } = {},
): Map<string, number> {
  const gap = opts.gap ?? 2;
  const min = opts.min ?? 0;
  const max = opts.max ?? Number.POSITIVE_INFINITY;
  const order = items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => a.it.want - b.it.want || a.i - b.i);
  const tops = order.map(({ it }) => Math.max(min, it.want));
  for (let k = 1; k < order.length; k++) {
    const prev = order[k - 1] as { it: MarginItem };
    tops[k] = Math.max(tops[k] as number, (tops[k - 1] as number) + prev.it.height + gap);
  }
  // Too low: pull up from the bottom.
  let limit = max;
  for (let k = order.length - 1; k >= 0; k--) {
    const h = (order[k] as { it: MarginItem }).it.height;
    if ((tops[k] as number) + h <= limit) break;
    tops[k] = Math.max(min, limit - h);
    limit = (tops[k] as number) - gap;
  }
  // Never overlap (when the page is too short for all of them).
  for (let k = 1; k < order.length; k++) {
    const prev = order[k - 1] as { it: MarginItem };
    tops[k] = Math.max(tops[k] as number, (tops[k - 1] as number) + prev.it.height + gap);
  }
  const out = new Map<string, number>();
  order.forEach(({ it }, k) => {
    out.set(it.key, tops[k] as number);
  });
  return out;
}

/**
 * A short form of a cue's text for the leader line: the lead-in before a colon when
 * there is one ("PRESHOW: Title card…" → "PRESHOW"), else the first clause, cut at a word
 * boundary to `max` characters with an ellipsis.
 */
export function shortText(s: string | null | undefined, max = 28): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const colon = t.indexOf(": ");
  if (colon > 0 && colon <= max) return t.slice(0, colon);
  const clause = /^(.+?)[.;!?](?:\s|$)/.exec(t)?.[1] ?? t;
  if (clause.length <= max) return clause;
  const cut = clause.lastIndexOf(" ", max - 1);
  return `${clause.slice(0, cut > max / 2 ? cut : max - 1).trimEnd()}…`;
}

/**
 * What a positional cue's leader line says: the trigger badge ("VISUAL", "LX 117",
 * "TC 1:00:00") and a short form of what triggers it: the trigger value (a Visual cue's
 * "what we see"), else the description, else the SM call. "VISUAL · PRESHOW". Falls back
 * to the anchor's quote (the words at the line) when the cue says nothing.
 */
export function leaderLabel(cue: CueRow, quote = ""): string {
  const badge = triggerBadge(cue);
  const tv = cue.trigger_type === "LX" || cue.trigger_type === "SQ" ? "" : cue.trigger_value;
  const what =
    shortText(cue.trigger_type === "Timecode" ? "" : tv) ||
    shortText(cue.description) ||
    shortText(cue.sm_call?.replace(/^\[|\]$/g, "")) ||
    (badge ? "" : shortText(quote));
  return [badge, what].filter(Boolean).join(" · ");
}
