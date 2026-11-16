// The PDF page view's cue margin (pure): where each cue number sits beside the page, and
// what a positional cue's leader line says (in full, wrapped to the margin).
import type { CueRow } from "../../../../shared/tables";
import { markerBadge, markerText } from "../markers";

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
 * What a positional cue's leader line says, in full: a reference badge when the cue has
 * one ("LX 117", "TC 1:00:00"; the bare type is the tick's job) and the callout
 * (`markerText`: the SM call, else the trigger text, else the description).
 * "LX 117 · Steam wash", "Transition DAY to LATE FRIDAY NIGHT".
 */
export function leaderLabel(cue: CueRow): string {
  return [markerBadge(cue), markerText(cue)].filter(Boolean).join(" · ");
}

/**
 * Greedy word wrap: `text` in lines no wider than `width` by `measure`; a word wider than
 * a line on its own is broken by characters. Whitespace runs collapse; empty text → [].
 */
export function wrapLines(text: string, width: number, measure: (s: string) => number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines: string[] = [];
  let line = "";
  const breakWord = (w: string) => {
    let rest = w;
    while (rest && measure(rest) > width) {
      let n = 1;
      while (n < rest.length && measure(rest.slice(0, n + 1)) <= width) n++;
      lines.push(rest.slice(0, n));
      rest = rest.slice(n);
    }
    return rest;
  };
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (measure(next) <= width) {
      line = next;
      continue;
    }
    if (line) lines.push(line);
    line = breakWord(w);
  }
  if (line) lines.push(line);
  return lines;
}
