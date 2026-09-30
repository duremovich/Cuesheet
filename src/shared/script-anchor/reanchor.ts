// Re-anchoring (decision 0004, ux.md §New script version): each anchor of the old version
// is looked for in the new one, in this order:
//
//   1. prefix + quote + suffix found exactly     → matched (same page, ≤ NEAR_BLOCKS from
//      where the diff predicts it) or moved; confidence 1.
//   2. quote found exactly (without that context) → moved, confidence 0.9.
//   3. fuzzy quote: bigram Dice ≥ FUZZY_THRESHOLD, searched within ±WINDOW of the document
//      around the predicted position first, then everywhere → changed, confidence = score.
//   4. context only: prefix or suffix found exactly → changed, confidence 0.5, anchored
//      where the quote would be (between them). If prefix and suffix are now adjacent, the
//      quote was cut → missing.
//   5. otherwise missing (to = null).
//
// Where more than one place qualifies, the one nearest the predicted position wins: the
// old block's position mapped through a patience diff of the two versions' blocks
// (./diff.ts), interpolated between unchanged blocks. Pure and deterministic.
import type { Anchor, AnchorStats, ReanchorResult, ScriptText } from "../script";
import { ANCHOR_STATES, normalizeText } from "../script";
import { mapBlocks } from "./diff";
import { type FuzzyHit, fuzzyFind } from "./fuzzy";
import { anchorAt, anchorStart, blockAt, type Joined, joinBlocks, pageLabel } from "./text";

/** Bigram Dice at or above which a fuzzy match is accepted (`changed`). */
export const FUZZY_THRESHOLD = 0.8;
/** Share of the document searched around the predicted position before the whole of it. */
export const WINDOW = 0.15;
/** An exact match this many blocks or fewer from the prediction (same page) is `matched`. */
export const NEAR_BLOCKS = 3;
export const CONFIDENCE_EXACT = 1;
export const CONFIDENCE_QUOTE_ONLY = 0.9;
export const CONFIDENCE_CONTEXT = 0.5;
/** Context shorter than this (after trimming) isn't trusted on its own (step 4). */
const MIN_CONTEXT = 8;
/** Occurrences of a quote examined at most (a one-word quote in a long script). */
const MAX_OCCURRENCES = 2000;

export interface AnchorInput {
  cueId: string;
  /** block < 0 (or outside the old text) = no known position (e.g. a missing anchor). */
  anchor: Anchor;
}

/** Re-anchor every anchor of `oldText` in `newText`. Results are in input order. */
export function reanchor(
  oldText: ScriptText,
  newText: ScriptText,
  anchors: readonly AnchorInput[],
): ReanchorResult[] {
  const oj = joinBlocks(oldText);
  const nj = joinBlocks(newText);
  const predict = predictor(oj, nj, mapBlocks(oldText, newText));
  return anchors.map(({ cueId, anchor }) => reanchorOne(oj, nj, predict, cueId, anchor));
}

/** Counts by state. */
export function anchorStats(results: readonly { state: ReanchorResult["state"] }[]): AnchorStats {
  const out = Object.fromEntries(ANCHOR_STATES.map((s) => [s, 0])) as AnchorStats;
  for (const r of results) out[r.state]++;
  return out;
}

type Predict = (anchor: Anchor) => number | null;

/**
 * Old anchor → predicted joined position in the new text: exact through a mapped block,
 * else interpolated between the nearest mapped blocks around it.
 */
function predictor(oj: Joined, nj: Joined, map: Int32Array): Predict {
  const n = map.length;
  const prevMapped = new Int32Array(n);
  const nextMapped = new Int32Array(n);
  let last = -1;
  for (let i = 0; i < n; i++) {
    if ((map[i] as number) >= 0) last = i;
    prevMapped[i] = last;
  }
  last = -1;
  for (let i = n - 1; i >= 0; i--) {
    if ((map[i] as number) >= 0) last = i;
    nextMapped[i] = last;
  }
  const oldLen = Math.max(1, oj.text.length);
  return (anchor) => {
    const start = anchorStart(oj, anchor);
    if (start === null) return null;
    const b = anchor.block;
    const mapped = map[b] as number;
    if (mapped >= 0) return (nj.starts[mapped] as number) + anchor.offset;
    const p = prevMapped[b] as number;
    const q = nextMapped[b] as number;
    // Old span [o0, o1) between the mapped neighbours ↔ new span [n0, n1).
    const o0 = p >= 0 ? (oj.ends[p] as number) : 0;
    const o1 = q >= 0 ? (oj.starts[q] as number) : oj.text.length;
    const n0 = p >= 0 ? (nj.ends[map[p] as number] as number) : 0;
    const n1 = q >= 0 ? (nj.starts[map[q] as number] as number) : nj.text.length;
    if (p < 0 && q < 0) return Math.round((start / oldLen) * nj.text.length);
    const f = o1 > o0 ? (start - o0) / (o1 - o0) : 0;
    return Math.round(n0 + f * (n1 - n0));
  };
}

function reanchorOne(
  oj: Joined,
  nj: Joined,
  predict: Predict,
  cueId: string,
  from: Anchor,
): ReanchorResult {
  const quote = normalizeText(from.quote);
  const prefix = from.prefix;
  const suffix = from.suffix;
  const expected = predict(from);
  const oldStart = anchorStart(oj, from);
  const oldLabel = oldStart === null ? null : pageLabel(oj, from.block);
  const doc = nj.text;
  /** Of non-empty `positions`, the one nearest the prediction. */
  const nearest = (positions: number[]) => pickNearest(positions, expected) as number;
  const candidates = (hits: FuzzyHit[]) =>
    hits
      .filter((h) => h.score > 0)
      .map((h) => ({ anchor: anchorAt(nj, h.start, h.end), score: h.score }));
  const missing = (hits: FuzzyHit[]): ReanchorResult => ({
    cueId,
    from,
    to: null,
    state: "missing",
    confidence: 0,
    candidates: candidates(hits),
  });
  const result = (
    start: number,
    length: number,
    state: ReanchorResult["state"],
    confidence: number,
    hits: FuzzyHit[] = [],
  ): ReanchorResult => ({
    cueId,
    from,
    to: anchorAt(nj, start, start + length),
    state,
    confidence,
    candidates: candidates(hits),
  });
  /** matched when on the same page label and near the prediction, else moved. */
  const placeState = (start: number): "matched" | "moved" => {
    if (expected === null || oldLabel === null) return "moved";
    const block = blockAt(nj, start);
    const near = Math.abs(block - blockAt(nj, Math.min(expected, doc.length))) <= NEAR_BLOCKS;
    return near && pageLabel(nj, block) === oldLabel ? "matched" : "moved";
  };

  // 1. The quote with its context.
  const full = occurrences(doc, prefix + quote + suffix).map((p) => p + prefix.length);
  if (full.length > 0) {
    const at = nearest(full);
    return result(at, quote.length, placeState(at), CONFIDENCE_EXACT);
  }

  if (quote.length > 0) {
    // 2. The quote alone: prefer places where one side of the context still matches.
    const bare = occurrences(doc, quote);
    if (bare.length > 0) {
      const pre = prefix.trimStart();
      const suf = suffix.trimEnd();
      const withContext = bare.filter(
        (p) =>
          (pre.length >= MIN_CONTEXT && doc.startsWith(pre, p - pre.length)) ||
          (suf.length >= MIN_CONTEXT && doc.startsWith(suf, p + quote.length)),
      );
      const at = nearest(withContext.length > 0 ? withContext : bare);
      return result(at, quote.length, "moved", CONFIDENCE_QUOTE_ONLY);
    }

    // 3. Fuzzy, near the prediction first.
    let hits: FuzzyHit[] = [];
    if (expected !== null) {
      const half = Math.ceil(doc.length * WINDOW);
      hits = fuzzyFind(nj, quote, expected - half, expected + half + quote.length, expected);
    }
    if (!(hits[0] && hits[0].score >= FUZZY_THRESHOLD)) {
      const everywhere = fuzzyFind(nj, quote, 0, doc.length, expected);
      hits = mergeHits(hits, everywhere);
    }
    const top = hits[0];
    if (top && top.score >= FUZZY_THRESHOLD) {
      return result(top.start, top.end - top.start, "changed", top.score, hits);
    }

    // 4. Context only.
    const ctx = contextPlace(doc, prefix, suffix, quote.length, expected);
    if (ctx === "cut") return missing(hits);
    if (ctx) return result(ctx.start, ctx.length, "changed", CONFIDENCE_CONTEXT, hits);
    return missing(hits);
  }

  // A positional anchor with no quote: its context is all there is.
  const ctx = contextPlace(doc, prefix, suffix, 0, expected);
  if (ctx && ctx !== "cut") return result(ctx.start, 0, "changed", CONFIDENCE_CONTEXT);
  return missing([]);
}

/**
 * Where the quote would be by its context: after the prefix / before the suffix (nearest
 * the prediction). "cut" when the prefix and suffix now meet (the quote was deleted); null
 * when neither is found.
 */
function contextPlace(
  doc: string,
  prefix: string,
  suffix: string,
  quoteLength: number,
  expected: number | null,
): { start: number; length: number } | "cut" | null {
  const pre = prefix.trim();
  const suf = suffix.trim();
  const preAt =
    pre.length >= MIN_CONTEXT ? pickNearest(occurrences(doc, pre), expected, -pre.length) : null;
  const preEnd = preAt === null ? null : skipSpace(doc, preAt + pre.length);
  const sufAt =
    suf.length >= MIN_CONTEXT
      ? pickNearest(occurrences(doc, suf), expected === null ? null : expected + quoteLength)
      : null;
  if (preEnd !== null && sufAt !== null && sufAt >= preEnd - 1) {
    const gap = sufAt - preEnd;
    const slack = Math.max(4 * quoteLength, quoteLength + 200);
    if (gap <= slack) {
      if (quoteLength > 0 && gap <= Math.max(2, Math.floor(quoteLength * 0.25))) return "cut";
      return { start: preEnd, length: Math.max(0, trimEnd(doc, preEnd, sufAt) - preEnd) };
    }
  }
  if (preEnd !== null) {
    return { start: preEnd, length: Math.min(quoteLength, doc.length - preEnd) };
  }
  if (sufAt !== null) {
    const end = trimEnd(doc, 0, sufAt);
    const start = Math.max(0, end - quoteLength);
    return { start: skipSpace(doc, start), length: end - skipSpace(doc, start) };
  }
  return null;
}

function skipSpace(doc: string, pos: number): number {
  let p = pos;
  while (p < doc.length && doc[p] === " ") p++;
  return p;
}

function trimEnd(doc: string, min: number, pos: number): number {
  let p = pos;
  while (p > min && doc[p - 1] === " ") p--;
  return p;
}

function occurrences(doc: string, needle: string): number[] {
  if (!needle) return [];
  const out: number[] = [];
  let i = doc.indexOf(needle);
  while (i >= 0 && out.length < MAX_OCCURRENCES) {
    out.push(i);
    i = doc.indexOf(needle, i + 1);
  }
  return out;
}

/** The position nearest `expected` (+ shift); the first when there's no expectation. */
function pickNearest(positions: number[], expected: number | null, shift = 0): number | null {
  if (positions.length === 0) return null;
  if (expected === null) return positions[0] as number;
  const target = expected + shift;
  let best = positions[0] as number;
  for (const p of positions) if (Math.abs(p - target) < Math.abs(best - target)) best = p;
  return best;
}

/** Hits from two searches, best first, without duplicates / overlaps. */
function mergeHits(a: FuzzyHit[], b: FuzzyHit[]): FuzzyHit[] {
  const all = [...a, ...b].sort((x, y) => y.score - x.score || x.start - y.start);
  const out: FuzzyHit[] = [];
  for (const h of all) {
    if (out.length >= 3) break;
    const inter = (o: FuzzyHit) => Math.min(o.end, h.end) - Math.max(o.start, h.start);
    if (out.some((o) => inter(o) > 0.5 * Math.min(o.end - o.start, h.end - h.start))) continue;
    out.push(h);
  }
  return out;
}
