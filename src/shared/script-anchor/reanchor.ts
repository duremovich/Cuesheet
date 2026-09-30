// Re-anchoring (decision 0004, ux.md §New script version). Each anchor of the old version
// is looked for in the new one; the old block's place is first *predicted* through a
// patience diff of the two versions' blocks (./diff.ts), interpolated between unchanged
// blocks. Then, in order:
//
//   1. prefix + quote + suffix found exactly → matched (same printed page label and
//      ≤ NEAR_BLOCKS from the prediction) or moved; confidence 1.
//   2. Cut check: the anchored text was deleted when its old blocks map to nothing and the
//      text between their unchanged neighbours is now empty, or when prefix and suffix now
//      meet at the predicted place (or sit in one block that no longer holds the quote).
//      → missing, unless the quote (≥ MIN_MOVE_WORDS words) occurs exactly once elsewhere:
//      then it moved (matched/moved by place, 0.9).
//   3. Quote alone, exactly: accepted (matched/moved by place, 0.9) when one side of the
//      context still matches there, or it's within NEAR_BLOCKS of the prediction, or it's
//      the only occurrence and has ≥ MIN_MOVE_WORDS words (and no fuzzy match ≥ threshold
//      sits near the prediction: an edited original beats an exact copy far away).
//      Otherwise → changed, CONFIDENCE_AMBIGUOUS, with the occurrences as candidates.
//   4. Both prefix and suffix found around a plausible span: that span wins → changed,
//      confidence = its bigram Dice when ≥ FUZZY_THRESHOLD, else CONFIDENCE_CONTEXT.
//   5. Fuzzy: bigram Dice, searched ±WINDOW of the document around the prediction, then
//      everywhere; ranked by score × (1 − 0.1·min(1, distance / window)); accepted when
//      that is ≥ FUZZY_THRESHOLD → changed, confidence = the raw score.
//   6. One side of the context found (the one nearer the prediction) → changed,
//      CONFIDENCE_CONTEXT.
//   7. missing (to = null; candidates = the best fuzzy spans even below the threshold).
//
// A span lying only in new blocks that the diff pairs with *other* unchanged old blocks is
// someone else's line ("foreign"): never accepted as an exact or fuzzy match (it can still
// be listed as a candidate). Where several places qualify, the one nearest the prediction
// wins. Pure and deterministic.
import type { Anchor, AnchorStats, ReanchorCandidate, ReanchorResult, ScriptText } from "../script";
import { ANCHOR_STATES, normalizeText } from "../script";
import { mapBlocks } from "./diff";
import { diceSimilarity, type FuzzyHit, fuzzyFind, overlaps } from "./fuzzy";
import { anchorAt, anchorStart, blockAt, type Joined, joinBlocks, pageLabel } from "./text";

/** Bigram Dice at or above which a fuzzy match is accepted (`changed`). */
export const FUZZY_THRESHOLD = 0.8;
/** Share of the document searched around the predicted position before the whole of it. */
export const WINDOW = 0.15;
/** An exact match this many blocks or fewer from the prediction (same page) is `matched`. */
export const NEAR_BLOCKS = 3;
/** A quote needs this many words for a lone exact occurrence far away to count as a move. */
export const MIN_MOVE_WORDS = 4;
export const CONFIDENCE_EXACT = 1;
export const CONFIDENCE_QUOTE_ONLY = 0.9;
/** An exact quote found only in places that don't qualify (e.g. "Go." elsewhere). */
export const CONFIDENCE_AMBIGUOUS = 0.6;
export const CONFIDENCE_CONTEXT = 0.5;
/** Context shorter than this (after trimming) isn't trusted on its own. */
const MIN_CONTEXT = 8;
/** Occurrences of a quote examined at most (a one-word quote in a long script). */
const MAX_OCCURRENCES = 2000;
/** Exact occurrences listed as candidates for an ambiguous quote. */
const MAX_OCCURRENCE_CANDIDATES = 10;

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
  const d = new DiffInfo(joinBlocks(oldText), joinBlocks(newText), mapBlocks(oldText, newText));
  return anchors.map(({ cueId, anchor }) => reanchorOne(d, cueId, anchor));
}

/** Counts by state. */
export function anchorStats(results: readonly { state: ReanchorResult["state"] }[]): AnchorStats {
  const out = Object.fromEntries(ANCHOR_STATES.map((s) => [s, 0])) as AnchorStats;
  for (const r of results) out[r.state]++;
  return out;
}

/** The block mapping between the versions and what's derived from it. */
class DiffInfo {
  /** New block → the old block the diff pairs with it, or -1. */
  readonly owner: Int32Array;
  private readonly prevMapped: Int32Array;
  private readonly nextMapped: Int32Array;

  constructor(
    readonly oj: Joined,
    readonly nj: Joined,
    readonly map: Int32Array,
  ) {
    const n = map.length;
    this.owner = new Int32Array(nj.starts.length).fill(-1);
    map.forEach((k, i) => {
      if (k >= 0) this.owner[k] = i;
    });
    this.prevMapped = new Int32Array(n);
    this.nextMapped = new Int32Array(n);
    let last = -1;
    for (let i = 0; i < n; i++) {
      if ((map[i] as number) >= 0) last = i;
      this.prevMapped[i] = last;
    }
    last = -1;
    for (let i = n - 1; i >= 0; i--) {
      if ((map[i] as number) >= 0) last = i;
      this.nextMapped[i] = last;
    }
  }

  /** Old blocks [first, last] an anchor covers, or null when it has no position. */
  oldBlocks(anchor: Anchor): [number, number] | null {
    const start = anchorStart(this.oj, anchor);
    if (start === null) return null;
    return [anchor.block, blockAt(this.oj, start + Math.max(0, anchor.length - 1))];
  }

  /** Old span and new span between the unchanged neighbours of old blocks [b, e]. */
  private gap(b: number, e: number): { n0: number; n1: number; o0: number; o1: number } {
    const { oj, nj, map } = this;
    const p = this.prevMapped[b] as number;
    const q = this.nextMapped[e] as number;
    return {
      o0: p >= 0 ? (oj.ends[p] as number) : 0,
      o1: q >= 0 ? (oj.starts[q] as number) : oj.text.length,
      n0: p >= 0 ? (nj.ends[map[p] as number] as number) : 0,
      n1: q >= 0 ? (nj.starts[map[q] as number] as number) : nj.text.length,
    };
  }

  /** Predicted joined position of an old anchor in the new text. */
  predict(anchor: Anchor): number | null {
    const start = anchorStart(this.oj, anchor);
    if (start === null) return null;
    const b = anchor.block;
    const mapped = this.map[b] as number;
    if (mapped >= 0) return (this.nj.starts[mapped] as number) + anchor.offset;
    if ((this.prevMapped[b] as number) < 0 && (this.nextMapped[b] as number) < 0) {
      return Math.round((start / Math.max(1, this.oj.text.length)) * this.nj.text.length);
    }
    const { o0, o1, n0, n1 } = this.gap(b, b);
    const f = o1 > o0 ? (start - o0) / (o1 - o0) : 0;
    return Math.round(n0 + f * (n1 - n0));
  }

  /**
   * The anchor's old blocks all went and nothing replaced them: their unchanged
   * neighbours are now adjacent in the new text.
   */
  deleted(anchor: Anchor): boolean {
    const blocks = this.oldBlocks(anchor);
    if (!blocks) return false;
    const [b, e] = blocks;
    for (let i = b; i <= e; i++) if ((this.map[i] as number) >= 0) return false;
    if ((this.prevMapped[b] as number) < 0 && (this.nextMapped[e] as number) < 0) return false;
    const { n0, n1 } = this.gap(b, e);
    return n1 - n0 <= 1;
  }

  /** Joined span [start, end) lies only in new blocks paired with other old blocks. */
  foreign(start: number, end: number, own: [number, number] | null): boolean {
    if (!own) return false;
    const first = blockAt(this.nj, start);
    const last = blockAt(this.nj, Math.max(start, end - 1));
    for (let k = first; k <= last; k++) {
      const o = this.owner[k] as number;
      if (o < 0 || (o >= own[0] && o <= own[1])) return false;
    }
    return true;
  }
}

type Hit = FuzzyHit & { weighted: number };

const wordCount = (s: string) => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

function reanchorOne(d: DiffInfo, cueId: string, from: Anchor): ReanchorResult {
  const nj = d.nj;
  const quote = normalizeText(from.quote);
  const prefix = from.prefix;
  const suffix = from.suffix;
  const expected = d.predict(from);
  const own = d.oldBlocks(from);
  const oldLabel = own ? pageLabel(d.oj, from.block) : null;
  const doc = nj.text;
  const half = Math.ceil(doc.length * WINDOW);
  const nearest = (positions: number[]) => pickNearest(positions, expected) as number;
  const blockDistance = (pos: number) =>
    expected === null
      ? Number.POSITIVE_INFINITY
      : Math.abs(blockAt(nj, pos) - blockAt(nj, Math.min(expected, doc.length)));
  const toCandidates = (hits: FuzzyHit[]): ReanchorCandidate[] =>
    hits
      .filter((h) => h.score > 0)
      .map((h) => ({ anchor: anchorAt(nj, h.start, h.end), score: h.score }));
  const missing = (hits: FuzzyHit[]): ReanchorResult => ({
    cueId,
    from,
    to: null,
    state: "missing",
    confidence: 0,
    candidates: toCandidates(hits),
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
    candidates: toCandidates(hits),
  });
  /** matched when on the same page label and near the prediction, else moved. */
  const placeState = (start: number): "matched" | "moved" => {
    if (expected === null || oldLabel === null) return "moved";
    const near = blockDistance(start) <= NEAR_BLOCKS;
    return near && pageLabel(nj, blockAt(nj, start)) === oldLabel ? "matched" : "moved";
  };
  /** Fuzzy spans in [a, b), with their distance-weighted score. */
  const fuzzy = (a: number, b: number): Hit[] =>
    fuzzyFind(nj, quote, a, b, expected, 6).map((h) => ({
      ...h,
      weighted:
        expected === null
          ? h.score
          : h.score * (1 - 0.1 * Math.min(1, Math.abs(h.start - expected) / Math.max(1, half))),
    }));
  const acceptable = (h: FuzzyHit) => !d.foreign(h.start, h.end, own);
  const nearFuzzy = () =>
    expected === null ? [] : fuzzy(expected - half, expected + half + quote.length);
  let cached: Hit[] | null = null;
  /** Near the prediction, then everywhere unless an acceptable near one is good enough. */
  const allHits = (): Hit[] => {
    if (cached) return cached;
    const near = nearFuzzy();
    const best = near.find(acceptable);
    cached = mergeHits(
      best && best.weighted >= FUZZY_THRESHOLD ? near : [...near, ...fuzzy(0, doc.length)],
    );
    return cached;
  };

  // 1. The quote with its context.
  const full = occurrences(doc, prefix + quote + suffix).map((p) => p + prefix.length);
  if (full.length > 0) {
    const at = nearest(full);
    return result(at, quote.length, placeState(at), CONFIDENCE_EXACT);
  }

  if (quote.length === 0) {
    // A positional anchor with no quote: its context is all there is.
    const ctx = contextPlace(nj, prefix, suffix, "", expected);
    if (ctx && ctx !== "cut") return result(ctx.start, 0, "changed", CONFIDENCE_CONTEXT);
    return missing([]);
  }

  const exact = occurrences(doc, quote).filter((p) => !d.foreign(p, p + quote.length, own));
  const loneMove = exact.length === 1 && wordCount(quote) >= MIN_MOVE_WORDS;
  const ctx = contextPlace(nj, prefix, suffix, quote, expected);

  // 2. Cut: the anchored text is gone (unless it moved, whole, somewhere else).
  if (ctx === "cut" || d.deleted(from)) {
    if (loneMove) {
      const at = exact[0] as number;
      return result(at, quote.length, placeState(at), CONFIDENCE_QUOTE_ONLY);
    }
    return missing([...exactHits(exact, quote.length, expected), ...allHits()].slice(0, 3));
  }

  // 3. The quote alone, where it qualifies.
  if (exact.length > 0) {
    const pre = prefix.trimStart();
    const suf = suffix.trimEnd();
    const withContext = exact.filter(
      (p) =>
        (pre.length >= MIN_CONTEXT && doc.startsWith(pre, p - pre.length)) ||
        (suf.length >= MIN_CONTEXT && doc.startsWith(suf, p + quote.length)),
    );
    const near = exact.filter((p) => blockDistance(p) <= NEAR_BLOCKS);
    const pick = withContext.length > 0 ? withContext : near;
    if (pick.length > 0) {
      const at = nearest(pick);
      return result(at, quote.length, placeState(at), CONFIDENCE_QUOTE_ONLY);
    }
    if (loneMove) {
      // An edited original near the prediction beats an exact copy far away.
      const edited = nearFuzzy().find((h) => acceptable(h) && h.weighted >= FUZZY_THRESHOLD);
      if (!edited) {
        const at = exact[0] as number;
        return result(at, quote.length, placeState(at), CONFIDENCE_QUOTE_ONLY);
      }
      return result(edited.start, edited.end - edited.start, "changed", edited.score, [
        edited,
        ...exactHits(exact, quote.length, expected),
      ]);
    }
    const occ = exactHits(exact, quote.length, expected).slice(0, MAX_OCCURRENCE_CANDIDATES);
    return result(nearest(exact), quote.length, "changed", CONFIDENCE_AMBIGUOUS, occ);
  }

  // 4. Between prefix and suffix.
  if (ctx?.both) {
    const span = doc.slice(ctx.start, ctx.start + ctx.length);
    const score = Math.round(diceSimilarity(quote, span) * 1000) / 1000;
    const confidence = score >= FUZZY_THRESHOLD ? score : CONFIDENCE_CONTEXT;
    const own0 = { start: ctx.start, end: ctx.start + ctx.length, score };
    const others = allHits().filter((h) => !overlaps(h, own0));
    return result(ctx.start, ctx.length, "changed", confidence, [own0, ...others].slice(0, 3));
  }

  // 5. Fuzzy.
  const top = allHits().find(acceptable);
  if (top && top.weighted >= FUZZY_THRESHOLD) {
    const rest = allHits().filter((h) => h !== top);
    return result(top.start, top.end - top.start, "changed", top.score, [top, ...rest].slice(0, 3));
  }

  // 6. One side of the context.
  if (ctx)
    return result(ctx.start, ctx.length, "changed", CONFIDENCE_CONTEXT, allHits().slice(0, 3));
  return missing(allHits().slice(0, 3));
}

/** Exact occurrences as candidates (score 1), nearest the prediction first. */
function exactHits(exact: number[], length: number, expected: number | null): FuzzyHit[] {
  const dist = (p: number) => (expected === null ? 0 : Math.abs(p - expected));
  return [...exact]
    .sort((a, b) => dist(a) - dist(b) || a - b)
    .map((start) => ({ start, end: start + length, score: 1 }));
}

type Place = { start: number; length: number; both: boolean };

/**
 * Where the quote would be by its context, nearest the prediction: between prefix and
 * suffix when both are found a plausible distance apart (`both`), else after the prefix or
 * before the suffix, whichever is nearer the prediction. "cut" when prefix and suffix now
 * meet, or sit in one block that no longer holds the quote. null when neither is found.
 */
function contextPlace(
  nj: Joined,
  prefix: string,
  suffix: string,
  quote: string,
  expected: number | null,
): Place | "cut" | null {
  const doc = nj.text;
  const quoteLength = quote.length;
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
      // The prefix's last character and the suffix's first in one block (a quote on part of
      // a line) that no longer holds the quote: the words were cut from that line.
      const block = blockAt(nj, (preAt as number) + pre.length - 1);
      if (
        quoteLength > 0 &&
        block === blockAt(nj, sufAt) &&
        !(nj.blocks[block]?.text ?? "").includes(quote)
      ) {
        return "cut";
      }
      return {
        start: preEnd,
        length: Math.max(0, trimEnd(doc, preEnd, sufAt) - preEnd),
        both: true,
      };
    }
  }
  const afterPrefix: Place | null =
    preEnd === null
      ? null
      : { start: preEnd, length: Math.min(quoteLength, doc.length - preEnd), both: false };
  let beforeSuffix: Place | null = null;
  if (sufAt !== null) {
    const end = trimEnd(doc, 0, sufAt);
    const start = skipSpace(doc, Math.max(0, end - quoteLength));
    beforeSuffix = { start, length: Math.max(0, end - start), both: false };
  }
  if (afterPrefix && beforeSuffix && expected !== null) {
    return Math.abs(beforeSuffix.start - expected) < Math.abs(afterPrefix.start - expected)
      ? beforeSuffix
      : afterPrefix;
  }
  return afterPrefix ?? beforeSuffix;
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

/** Fuzzy hits from several searches, best weighted first, without overlaps; at most 6. */
function mergeHits(all: Hit[]): Hit[] {
  const sorted = [...all].sort((x, y) => y.weighted - x.weighted || x.start - y.start);
  const out: Hit[] = [];
  for (const h of sorted) {
    if (out.length >= 6) break;
    if (out.some((o) => overlaps(o, h))) continue;
    out.push(h);
  }
  return out;
}
