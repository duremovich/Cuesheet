// Old block → new block mapping between two versions (patience diff over block texts),
// used to predict where an anchor should land before searching, and for the page summary.
import type { ScriptText } from "../script";

/**
 * `map[oldBlock]` = the new block with identical text that the diff pairs it with, or -1.
 * Pairs are monotonic (no crossings). Patience diff: blocks unique in both sides of a range
 * are paired along their longest increasing run, equal neighbours are paired outward from
 * each pair, and the gaps between pairs are diffed the same way. O(n log n) per level.
 */
export function mapBlocks(oldText: ScriptText, newText: ScriptText): Int32Array {
  const a = oldText.blocks.map((b) => b.text);
  const b = newText.blocks.map((b) => b.text);
  const map = new Int32Array(a.length).fill(-1);
  // Ranges [a0, a1) × [b0, b1) still to diff.
  const stack: [number, number, number, number][] = [[0, a.length, 0, b.length]];
  while (stack.length > 0) {
    let [a0, a1, b0, b1] = stack.pop() as [number, number, number, number];
    // Common head and tail.
    while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) map[a0++] = b0++;
    while (a0 < a1 && b0 < b1 && a[a1 - 1] === b[b1 - 1]) map[--a1] = --b1;
    if (a0 >= a1 || b0 >= b1) continue;
    const pairs = uniquePairs(a, a0, a1, b, b0, b1);
    if (pairs.length === 0) continue;
    const run = longestIncreasing(pairs);
    let pa = a0;
    let pb = b0;
    for (const [i, k] of run) {
      stack.push([pa, i, pb, k]);
      map[i] = k;
      pa = i + 1;
      pb = k + 1;
    }
    stack.push([pa, a1, pb, b1]);
  }
  return map;
}

/** (i, k) for texts occurring exactly once in a[a0,a1) and once in b[b0,b1), by i. */
function uniquePairs(
  a: string[],
  a0: number,
  a1: number,
  b: string[],
  b0: number,
  b1: number,
): [number, number][] {
  const count = new Map<string, { na: number; nb: number; i: number; k: number }>();
  for (let i = a0; i < a1; i++) {
    const t = a[i] as string;
    const c = count.get(t);
    if (c) c.na++;
    else count.set(t, { na: 1, nb: 0, i, k: -1 });
  }
  for (let k = b0; k < b1; k++) {
    const c = count.get(b[k] as string);
    if (c) {
      c.nb++;
      c.k = k;
    }
  }
  const out: [number, number][] = [];
  for (const c of count.values()) if (c.na === 1 && c.nb === 1) out.push([c.i, c.k]);
  return out.sort((x, y) => x[0] - y[0]);
}

/** Longest subsequence of pairs (sorted by i) whose k increases (patience sorting). */
function longestIncreasing(pairs: [number, number][]): [number, number][] {
  const tails: number[] = []; // index into pairs of the smallest tail for each length
  const prev = new Int32Array(pairs.length).fill(-1);
  pairs.forEach(([, k], idx) => {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((pairs[tails[mid] as number] as [number, number])[1] < k) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[idx] = tails[lo - 1] as number;
    tails[lo] = idx;
  });
  const out: [number, number][] = [];
  let cur = tails.length ? (tails[tails.length - 1] as number) : -1;
  while (cur >= 0) {
    out.push(pairs[cur] as [number, number]);
    cur = prev[cur] as number;
  }
  return out.reverse();
}

export type PageStatus = "same" | "changed" | "new";

export interface PageDiff {
  /** Pages of the new version whose blocks all have an identical block in the old one ("same"), some do ("changed"), or none do ("new"). */
  pages: { page: number; label: string; status: PageStatus }[];
  same: number;
  changed: number;
  new: number;
  /** Old pages none of whose blocks survive. */
  removed: number;
  blocksInserted: number;
  blocksDeleted: number;
}

/** A page-level summary of what changed between two versions (the import report). */
export function diffPages(oldText: ScriptText, newText: ScriptText): PageDiff {
  const map = mapBlocks(oldText, newText);
  const kept = new Uint8Array(newText.blocks.length);
  for (const k of map) if (k >= 0) kept[k] = 1;
  const byPage = new Map<number, { kept: number; total: number }>();
  for (const b of newText.blocks) {
    const e = byPage.get(b.page) ?? { kept: 0, total: 0 };
    e.total++;
    e.kept += kept[b.i] ?? 0;
    byPage.set(b.page, e);
  }
  const labels = new Map(newText.pages.map((p) => [p.page, p.label]));
  const pages: PageDiff["pages"] = [];
  const counts = { same: 0, changed: 0, new: 0 };
  for (const [page, e] of [...byPage].sort((x, y) => x[0] - y[0])) {
    const status: PageStatus = e.kept === e.total ? "same" : e.kept === 0 ? "new" : "changed";
    counts[status]++;
    pages.push({ page, label: labels.get(page) ?? String(page), status });
  }
  const oldPages = new Map<number, boolean>();
  oldText.blocks.forEach((b, i) => {
    oldPages.set(b.page, (oldPages.get(b.page) ?? false) || (map[i] as number) >= 0);
  });
  let removed = 0;
  for (const survives of oldPages.values()) if (!survives) removed++;
  let deleted = 0;
  for (const k of map) if (k < 0) deleted++;
  const inserted = newText.blocks.length - (map.length - deleted);
  return {
    pages,
    ...counts,
    removed,
    blocksInserted: inserted,
    blocksDeleted: deleted,
  };
}
