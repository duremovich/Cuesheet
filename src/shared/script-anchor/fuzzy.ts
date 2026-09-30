// Fuzzy quote search: windows of the quote's length (in words) are pre-scored by a word
// multiset Dice coefficient (O(1) per step, words interned to integers), the best window
// of each region is refined by trying nearby starts and lengths, and those are scored by
// the character-bigram Dice coefficient against the quote, which is the similarity reported.
import type { Joined } from "./text";

const WORD = /[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu;

interface Tokens {
  starts: Int32Array;
  ends: Int32Array;
  /** Interned lowercase word per token. */
  ids: Int32Array;
  vocab: Map<string, number>;
}

function words(text: string): { start: number; end: number; word: string }[] {
  const out: { start: number; end: number; word: string }[] = [];
  for (const m of text.matchAll(WORD)) {
    const start = m.index ?? 0;
    out.push({ start, end: start + m[0].length, word: m[0].toLowerCase() });
  }
  return out;
}

const tokenCache = new WeakMap<Joined, Tokens>();

function joinedTokens(j: Joined): Tokens {
  const hit = tokenCache.get(j);
  if (hit) return hit;
  const list = words(j.text);
  const vocab = new Map<string, number>();
  const t: Tokens = {
    starts: new Int32Array(list.length),
    ends: new Int32Array(list.length),
    ids: new Int32Array(list.length),
    vocab,
  };
  list.forEach((w, i) => {
    let id = vocab.get(w.word);
    if (id === undefined) {
      id = vocab.size;
      vocab.set(w.word, id);
    }
    t.starts[i] = w.start;
    t.ends[i] = w.end;
    t.ids[i] = id;
  });
  tokenCache.set(j, t);
  return t;
}

/** Bigrams of a lowercased string as numeric keys → counts (reusing `into`). */
function bigrams(s: string, into = new Map<number, number>()): Map<number, number> {
  into.clear();
  const t = s.toLowerCase();
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.charCodeAt(i) * 65536 + t.charCodeAt(i + 1);
    into.set(g, (into.get(g) ?? 0) + 1);
  }
  return into;
}

const scratch = new Map<number, number>();

function diceOf(qa: Map<number, number>, na: number, b: string): number {
  const nb = b.length - 1;
  if (na <= 0 || nb <= 0) return 0;
  const gb = bigrams(b, scratch);
  let inter = 0;
  for (const [g, n] of gb) inter += Math.min(n, qa.get(g) ?? 0);
  return (2 * inter) / (na + nb);
}

/** Character-bigram Dice coefficient (case-insensitive), 0..1. */
export function diceSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a.toLowerCase() === b.toLowerCase() ? 1 : 0;
  return diceOf(new Map(bigrams(a)), a.length - 1, b);
}

export interface FuzzyHit {
  start: number;
  end: number;
  score: number;
}

/** Windows pre-scored by word Dice below this are never considered. */
const MIN_WORD_DICE = 0.2;
/** How many regions (best pre-scored windows) get refined with the bigram score. */
const REGIONS = 8;
/** How many of those also try nearby starts and lengths. */
const REFINE = 3;
/** Start shift (in words) tried either side of a region's window when refining. */
const SHIFT = 1;

/**
 * The best spans of `j` for `quote` within joined positions [from, to), best first
 * (score = bigram Dice, 3 decimals), overlapping spans removed, at most `limit`. `center`
 * breaks ties (nearer wins).
 */
export function fuzzyFind(
  j: Joined,
  quote: string,
  from: number,
  to: number,
  center: number | null,
  limit = 3,
): FuzzyHit[] {
  const q = words(quote);
  const k = q.length;
  if (k === 0 || quote.length < 2) return [];
  const t = joinedTokens(j);
  const lo = lowerBound(t.starts, from);
  const hi = lowerBound(t.starts, to);
  if (hi <= lo) return [];
  // Quote word counts by interned id (words the text doesn't have can't match anything).
  const qCount = new Int32Array(t.vocab.size);
  let known = 0;
  for (const w of q) {
    const id = t.vocab.get(w.word);
    if (id !== undefined) {
      qCount[id] = (qCount[id] as number) + 1;
      known++;
    }
  }
  const size = Math.min(k, hi - lo);

  // 1. Every window of the quote's length, pre-scored by word Dice; the best per region
  //    (windows starting within `step` words of each other), so candidates come from
  //    different places.
  const step = Math.max(1, Math.ceil(k / 3));
  const regionScore = new Float64Array(Math.ceil((hi - lo) / step) + 1);
  const regionStart = new Int32Array(regionScore.length).fill(-1);
  if (known > 0) {
    const win = new Int32Array(t.vocab.size);
    const ids = t.ids;
    let inter = 0;
    for (let i = lo; i < lo + size; i++) {
      const id = ids[i] as number;
      if ((win[id] as number) < (qCount[id] as number)) inter++;
      win[id] = (win[id] as number) + 1;
    }
    const minInter = Math.ceil((MIN_WORD_DICE * (size + k)) / 2);
    for (let s = lo; s + size <= hi; s++) {
      if (s > lo) {
        const out = ids[s - 1] as number;
        win[out] = (win[out] as number) - 1;
        if ((win[out] as number) < (qCount[out] as number)) inter--;
        const inn = ids[s + size - 1] as number;
        if ((win[inn] as number) < (qCount[inn] as number)) inter++;
        win[inn] = (win[inn] as number) + 1;
      }
      if (inter < minInter) continue;
      const d = (2 * inter) / (size + k);
      const r = Math.floor((s - lo) / step);
      if (d > (regionScore[r] as number)) {
        regionScore[r] = d;
        regionStart[r] = s;
      }
    }
  }
  const top: { s: number; d: number }[] = [];
  regionStart.forEach((s, r) => {
    if (s >= 0) top.push({ s, d: regionScore[r] as number });
  });
  top.sort((x, y) => y.d - x.d || x.s - y.s);
  top.length = Math.min(top.length, REGIONS);

  // 2. Bigram Dice of each region's window; then, for the best few, nearby starts and
  //    lengths too (the edit may have added or removed words).
  const sizes = [...new Set([k, k - 1, k + 1, Math.round(k * 0.8), Math.round(k * 1.25)])].filter(
    (n) => n >= 1,
  );
  const qGrams = new Map(bigrams(quote));
  const span = (s: number, e: number): FuzzyHit => {
    const start = t.starts[s] as number;
    const end = t.ends[e - 1] as number;
    return { start, end, score: diceOf(qGrams, quote.length - 1, j.text.slice(start, end)) };
  };
  const rough = top
    .map(({ s }) => ({ s, hit: span(s, Math.min(s + size, hi)) }))
    .sort((x, y) => y.hit.score - x.hit.score || x.s - y.s);
  const hits: FuzzyHit[] = rough.map(({ s: s0, hit }, rank) => {
    let best = hit;
    if (rank < REFINE) {
      for (let s = Math.max(lo, s0 - SHIFT); s <= s0 + SHIFT; s++) {
        for (const n of sizes) {
          if (s + n > hi || (s === s0 && n === size)) continue;
          const h = span(s, s + n);
          if (h.score > best.score) best = h;
        }
      }
    }
    return { ...best, score: Math.round(best.score * 1000) / 1000 };
  });
  const dist = (h: FuzzyHit) => (center === null ? 0 : Math.abs(h.start - center));
  hits.sort((x, y) => y.score - x.score || dist(x) - dist(y) || x.start - y.start);
  const out: FuzzyHit[] = [];
  for (const h of hits) {
    if (out.length >= limit) break;
    if (out.some((o) => overlaps(o, h))) continue;
    out.push(h);
  }
  return out;
}

export function overlaps(a: FuzzyHit, b: FuzzyHit): boolean {
  const inter = Math.min(a.end, b.end) - Math.max(a.start, b.start);
  return inter > 0.5 * Math.min(a.end - a.start, b.end - b.start);
}

/** First index whose value is ≥ pos. */
function lowerBound(starts: Int32Array, pos: number): number {
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((starts[mid] as number) < pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
