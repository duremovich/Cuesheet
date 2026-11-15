// Printed page labels as things that sort: "13" < "13a" < "13b" < "14", "68-69" covers 68
// and 69, "I-3-14" compares part by part. Used by the PDF extractor to pick the real label
// when a page's margin has several label-looking lines (a date "11.1.26" next to "34"), and
// by "Add pages" to place incoming pages among the current version's. Pure, no imports, so
// the add-pages plan can use it without loading the extractor.

interface Part {
  n: number;
  /** Letter suffix ("a" of "13a"), lowercase. */
  s: string;
  roman: boolean;
}

const ROMAN: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100 };

function romanValue(s: string): number {
  let total = 0;
  for (let k = 0; k < s.length; k++) {
    const v = ROMAN[s[k] as string] ?? 0;
    const next = ROMAN[s[k + 1] as string] ?? 0;
    total += v < next ? -v : v;
  }
  return total;
}

/** "14a" → [{14, "a"}], "I-3-14" → [{1}, {3}, {14}]; null when it isn't label-like. */
function partsOf(label: string): Part[] | null {
  const tokens = label.trim().toLowerCase().split(/[-.]/);
  const out: Part[] = [];
  for (const t of tokens) {
    const num = /^(\d{1,5})([a-z]{0,2})$/.exec(t);
    if (num) {
      out.push({ n: Number(num[1]), s: num[2] ?? "", roman: false });
      continue;
    }
    if (/^[ivxlc]{1,7}$/.test(t)) {
      out.push({ n: romanValue(t), s: "", roman: true });
      continue;
    }
    return null;
  }
  return out.length ? out : null;
}

/** Same label, ignoring case and surrounding space ("13A" is "13a"). */
export function sameLabel(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Natural order of two labels: part by part, numbers numerically, then the letter suffix
 * ("139" < "139a" < "139b" < "140"); a label that is a prefix of the other sorts first
 * ("68" < "68-69"). Labels that don't parse sort after those that do, by plain text.
 */
export function compareLabels(a: string, b: string): number {
  const pa = partsOf(a);
  const pb = partsOf(b);
  if (!pa || !pb) {
    if (pa) return -1;
    if (pb) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  for (let k = 0; k < Math.min(pa.length, pb.length); k++) {
    const x = pa[k] as Part;
    const y = pb[k] as Part;
    if (x.n !== y.n) return x.n - y.n;
    if (x.s !== y.s) return x.s < y.s ? -1 : 1;
  }
  return pa.length - pb.length;
}

/**
 * A label's form, for telling page numbers from other numbers in a margin: digits (with a
 * letter suffix) → "#", roman numerals → "r", separators kept: "14a" → "#", "I-3-14" →
 * "r-#-#", "11.1.26" → "#.#.#", "68-69" → "#-#".
 */
export function labelShape(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .split(/([-.])/)
    .map((t) => (t === "-" || t === "." ? t : /^\d/.test(t) ? "#" : /^[ivxlc]+$/.test(t) ? "r" : t))
    .join("");
}

/**
 * The pages a combined label covers: "68-69" → [68, 69] (two numbers, the second larger by at
 * most 4); null for anything else ("14", "14a", "I-3-14").
 */
export function labelRange(label: string): number[] | null {
  const m = /^(\d{1,5})-(\d{1,5})$/.exec(label.trim());
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (b <= a || b - a > 4) return null;
  const out: number[] = [];
  for (let n = a; n <= b; n++) out.push(n);
  return out;
}

/** The plain page numbers a label stands for: "45" → [45], "68-69" → [68, 69], else []. */
export function labelNumbers(label: string): number[] {
  const t = label.trim();
  if (/^\d{1,5}$/.test(t)) return [Number(t)];
  return labelRange(t) ?? [];
}

/**
 * Which of each page's label-looking margin lines is its printed label. `candidates[i]` are
 * page i's candidates in reading order (top to bottom, left to right); → the chosen index
 * per page, -1 for a page without candidates.
 *
 * The labels of a script share one form and run in order, while other numbers in a margin
 * (a revision date "11.1.26", a line of dialogue "3") don't. So: the dominant form is the
 * one found on the most pages, weighted by how often its values increase from page to page
 * (`preferShape` overrides it: a single page has no sequence, so the caller passes the
 * form of the labels it will sit among). On each page, a candidate of that form wins; among
 * several (or none), the one that fits between its neighbours' labels; else the first.
 */
export function chooseLabels(
  candidates: readonly (readonly string[])[],
  preferShape?: string | null,
): number[] {
  let dominant = preferShape ?? null;
  if (!dominant) {
    const shapes = new Set(candidates.flat().map(labelShape));
    let best = -1;
    for (const shape of shapes) {
      const seq: string[] = [];
      for (const cs of candidates) {
        const c = cs.find((x) => labelShape(x) === shape);
        if (c !== undefined) seq.push(c);
      }
      let up = 0;
      for (let k = 1; k < seq.length; k++) {
        if (compareLabels(seq[k - 1] as string, seq[k] as string) < 0) up++;
      }
      const fit = seq.length > 1 ? up / (seq.length - 1) : 1;
      const score = seq.length * (0.5 + 0.5 * fit);
      if (score > best) {
        best = score;
        dominant = shape;
      }
    }
  }
  // A neighbour's label: its first candidate of the dominant form, else its first.
  const provisional = candidates.map((cs) => {
    const k = cs.findIndex((x) => labelShape(x) === dominant);
    return cs[k >= 0 ? k : 0] ?? null;
  });
  const near = (i: number, step: number): string | null => {
    for (let k = i + step; k >= 0 && k < candidates.length; k += step) {
      const p = provisional[k];
      if (p != null) return p;
    }
    return null;
  };
  return candidates.map((cs, i) => {
    if (cs.length === 0) return -1;
    if (cs.length === 1) return 0;
    const prev = near(i, -1);
    const next = near(i, 1);
    const fits = (c: string) =>
      (prev !== null || next !== null) &&
      (prev === null || compareLabels(prev, c) < 0) &&
      (next === null || compareLabels(c, next) < 0);
    const ofShape = cs.map((_, k) => k).filter((k) => labelShape(cs[k] as string) === dominant);
    const pool = ofShape.length ? ofShape : cs.map((_, k) => k);
    return pool.find((k) => fits(cs[k] as string)) ?? (pool[0] as number);
  });
}
