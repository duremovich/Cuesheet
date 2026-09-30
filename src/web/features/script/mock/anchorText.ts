// Stand-ins for M4a's anchoring engine (src/shared/script-anchor): `makeAnchor` and a
// simple re-anchoring pass for the mock source. Used only until M4a lands; see
// ../contract.ts. The real engine matches exact quote + context → exact quote → fuzzy
// quote → context only (decision 0004); this one does the same, crudely.
import type { Anchor, ReanchorResult, ScriptText } from "../contract";

/** Characters of context kept before and after a quote. */
export const CONTEXT = 32;

function blockText(text: ScriptText, i: number): string {
  return text.blocks[i]?.text ?? "";
}

/** The anchor for `length` characters at `offset` in block `block` (0 = a position). */
export function makeAnchor(
  text: ScriptText,
  block: number,
  offset: number,
  length: number,
): Anchor {
  const t = blockText(text, block);
  const start = Math.max(0, Math.min(offset, t.length));
  const end = Math.max(start, Math.min(start + length, t.length));
  const before = `${blockText(text, block - 1)}\n${t.slice(0, start)}`;
  const after = `${t.slice(end)}\n${blockText(text, block + 1)}`;
  return {
    block,
    offset: start,
    length: end - start,
    quote: t.slice(start, end),
    prefix: before.slice(-CONTEXT),
    suffix: after.slice(0, CONTEXT),
  };
}

export function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
}

function words(s: string): string[] {
  return normalizeText(s)
    .split(/[^a-z0-9']+/)
    .filter(Boolean);
}

/** Dice coefficient over word bigrams (words for short texts): 0–1. */
export function similarity(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  if (wa.length === 0 || wb.length === 0) return 0;
  const grams = (w: string[]) =>
    w.length < 2 ? w : w.slice(1).map((x, i) => `${w[i] as string} ${x}`);
  const ga = grams(wa);
  const gb = grams(wb);
  const counts = new Map<string, number>();
  for (const g of gb) counts.set(g, (counts.get(g) ?? 0) + 1);
  let hits = 0;
  for (const g of ga) {
    const n = counts.get(g) ?? 0;
    if (n > 0) {
      hits++;
      counts.set(g, n - 1);
    }
  }
  return (2 * hits) / (ga.length + gb.length);
}

const FUZZY_THRESHOLD = 0.5;

/**
 * The stretch of `text` (whole words, about as many as `needle` has) most similar to
 * `needle`: its character range and score.
 */
export function bestWindow(
  needle: string,
  text: string,
): { start: number; end: number; score: number } {
  const tokens = [...text.matchAll(/[\p{L}\p{N}']+/gu)].map((m) => ({
    start: m.index ?? 0,
    end: (m.index ?? 0) + m[0].length,
  }));
  const n = words(needle).length;
  let best = { start: 0, end: text.length, score: similarity(needle, text) };
  if (n === 0 || tokens.length === 0) return best;
  for (let size = Math.max(1, n - 2); size <= n + 2; size++) {
    for (let i = 0; i + size <= tokens.length; i++) {
      const start = (tokens[i] as { start: number }).start;
      const end = (tokens[i + size - 1] as { end: number }).end;
      const score = similarity(needle, text.slice(start, end));
      if (score > best.score) best = { start, end, score };
    }
    if (size >= tokens.length) break;
  }
  return best;
}

/** Re-anchor `anchors` (made on `from`) in `to`. */
export function reanchor(
  from: ScriptText,
  to: ScriptText,
  anchors: readonly { cueId: string; anchor: Anchor }[],
): ReanchorResult[] {
  const pageOf = (t: ScriptText, b: number) => t.blocks[b]?.page ?? 0;
  return anchors.map(({ cueId, anchor }) => {
    const oldPage = pageOf(from, anchor.block);
    // What to look for: the quote, or for a position the text it sits at.
    const needle = anchor.length > 0 ? anchor.quote : blockText(from, anchor.block);
    const exact: Anchor[] = [];
    if (needle.trim()) {
      for (const b of to.blocks) {
        if (anchor.length > 0) {
          let at = b.text.indexOf(needle);
          while (at >= 0) {
            exact.push(makeAnchor(to, b.i, at, needle.length));
            at = b.text.indexOf(needle, at + 1);
          }
        } else if (normalizeText(b.text) === normalizeText(needle)) {
          exact.push(makeAnchor(to, b.i, 0, 0));
        }
      }
    }
    if (exact.length > 0) {
      const withContext =
        exact.find((a) => a.prefix === anchor.prefix && a.suffix === anchor.suffix) ??
        exact.find((a) => a.prefix === anchor.prefix || a.suffix === anchor.suffix) ??
        exact[0];
      const best = withContext as Anchor;
      const moved = pageOf(to, best.block) !== oldPage;
      return {
        cueId,
        from: anchor,
        to: best,
        state: moved ? "moved" : "matched",
        confidence: 1,
        candidates: [{ anchor: best, score: 1 }],
      };
    }
    // Fuzzy: the most similar stretch of each block (quotes), or block (positions).
    const scored = to.blocks
      .map((b) => {
        if (anchor.length === 0) return { b, score: similarity(needle, b.text), at: 0, len: 0 };
        const w = bestWindow(needle, b.text);
        return { b, score: w.score, at: w.start, len: w.end - w.start };
      })
      .filter((x) => x.score >= 0.2)
      .sort((x, y) => y.score - x.score)
      .slice(0, 3)
      .map((x) => ({
        anchor: makeAnchor(to, x.b.i, x.at, x.len),
        score: Math.round(x.score * 100) / 100,
      }));
    const top = scored[0];
    if (top && top.score >= FUZZY_THRESHOLD) {
      return {
        cueId,
        from: anchor,
        to: top.anchor,
        state: "changed",
        confidence: top.score,
        candidates: scored,
      };
    }
    return { cueId, from: anchor, to: null, state: "missing", confidence: 0, candidates: scored };
  });
}
