// Anchors ↔ glyphs on the original PDF's pages (the PDF page view). Pure.
//
// Anchors are positions in a version's extracted block text. The page view re-runs the
// extraction's layout on the same PDF with tracing (`layoutPdfTraced`), which says which
// text item and character produced every character of every block, then aligns those
// blocks with the version's stored ones (`alignBlocks`: identical lists match by index;
// otherwise each stored block is searched in its page's traced text). From there:
//   - `anchorGeom`: an anchor's quote → underline segments per line, and its start glyph;
//   - `pageGlyphIndex` + `selectionSpan`: a selection in pdf.js's text layer (item, char)
//     → a block/offset span for `spanAnchor`, snapping off glyphs that aren't block text
//     (page numbers, running headers);
//   - `pageLines` + `lineAt`: the text lines of a page, for placing a positional cue at a
//     clicked height.
// Geometry is in PDF points from the page's top-left corner (y down), item origins on the
// baseline. Characters inside an item are placed by `measure` (the same canvas measurement
// pdf.js's text layer uses to stretch its spans, so underlines meet the selectable text);
// the default is proportional to the character count.
import type { Anchor, ScriptText } from "../contract";
import { anchorPosition } from "../contract";
import type { BlockTrace } from "../extract/pdf";
import type { Span } from "../placement";

/** Where each character of a stored block is on the PDF: `item` / `ch` per character (-1: none). */
export interface BlockGlyphs {
  page: number;
  item: Int32Array;
  ch: Int32Array;
}

/** Stored block index → its glyphs, or null when the block couldn't be found in the PDF. */
export type GlyphMap = readonly (BlockGlyphs | null)[];

/**
 * Stored blocks → glyphs. When the re-extraction produced the same blocks (the usual case:
 * the same file, the same extractor) they match by index; otherwise each stored block is
 * looked up in its page's traced text (blocks joined by a space), in order, so a block
 * split or joined differently by another extractor version still lands on its glyphs.
 */
export function alignBlocks(
  stored: ScriptText,
  traced: { text: ScriptText; trace: readonly BlockTrace[] },
): (BlockGlyphs | null)[] {
  const same =
    stored.blocks.length === traced.text.blocks.length &&
    stored.blocks.every((b, i) => {
      const t = traced.text.blocks[i];
      return !!t && t.text === b.text && t.page === b.page;
    });
  if (same) return traced.trace.map((t) => ({ page: t.page, item: t.item, ch: t.ch }));

  // Per page: the traced blocks' text joined by spaces, with glyphs (-1 for the joins).
  const pages = new Map<number, { text: string; item: number[]; ch: number[] }>();
  traced.text.blocks.forEach((b, i) => {
    const t = traced.trace[i];
    if (!t) return;
    let p = pages.get(b.page);
    if (!p) {
      p = { text: "", item: [], ch: [] };
      pages.set(b.page, p);
    } else {
      p.text += " ";
      p.item.push(-1);
      p.ch.push(-1);
    }
    p.text += b.text;
    for (let k = 0; k < b.text.length; k++) {
      p.item.push(t.item[k] ?? -1);
      p.ch.push(t.ch[k] ?? -1);
    }
  });
  const cursor = new Map<number, number>();
  return stored.blocks.map((b) => {
    const p = pages.get(b.page);
    if (!p || !b.text) return null;
    const from = cursor.get(b.page) ?? 0;
    let at = p.text.indexOf(b.text, from);
    if (at < 0) at = p.text.indexOf(b.text);
    if (at < 0) return null;
    cursor.set(b.page, at + b.text.length);
    return {
      page: b.page,
      item: Int32Array.from(p.item.slice(at, at + b.text.length)),
      ch: Int32Array.from(p.ch.slice(at, at + b.text.length)),
    };
  });
}

// ---- page geometry ----

/** One text item, in points from the page's top-left (`y` = baseline). */
export interface GlyphItem {
  str: string;
  x: number;
  y: number;
  /** Advance width. */
  w: number;
  size: number;
  /** CSS font family pdf.js's text layer uses for it (for `measure`). */
  font: string;
}

/** A page's text items by `ref` (null: an item with no text). */
export interface PageGeom {
  page: number;
  width: number;
  height: number;
  items: readonly (GlyphItem | null)[];
}

/** Width of `text` in `font` (any unit; only ratios are used). */
export type Measure = (text: string, font: string) => number;
export const proportional: Measure = (t) => t.length;

/** A horizontal piece of text on one line: underline from x0 to x1 at the baseline y. */
export interface Seg {
  x0: number;
  x1: number;
  y: number;
  size: number;
}

function charX(it: GlyphItem, k: number, measure: Measure): number {
  if (k <= 0 || !it.str) return it.x;
  if (k >= it.str.length) return it.x + it.w;
  const full = measure(it.str, it.font);
  const part = measure(it.str.slice(0, k), it.font);
  return it.x + (full > 0 ? (it.w * part) / full : (it.w * k) / it.str.length);
}

/**
 * Segments covering characters [from, to) of a block, one per line (glyph runs on one
 * baseline that nearly touch are merged), in reading order.
 */
export function blockSegs(
  g: BlockGlyphs,
  from: number,
  to: number,
  geom: PageGeom,
  measure: Measure = proportional,
): Seg[] {
  // Runs: consecutive characters of one item.
  const runs: { item: number; a: number; b: number }[] = [];
  for (let k = Math.max(0, from); k < Math.min(to, g.item.length); k++) {
    const item = g.item[k] as number;
    const ch = g.ch[k] as number;
    if (item < 0 || !geom.items[item]) continue;
    const last = runs.at(-1);
    if (last && last.item === item && ch >= last.b) last.b = ch + 1;
    else runs.push({ item, a: ch, b: ch + 1 });
  }
  const segs: Seg[] = [];
  for (const r of runs) {
    const it = geom.items[r.item] as GlyphItem;
    const x0 = charX(it, r.a, measure);
    const x1 = charX(it, r.b, measure);
    const last = segs.at(-1);
    const sameLine = last && Math.abs(last.y - it.y) <= 0.35 * Math.max(last.size, it.size);
    if (last && sameLine && x0 - last.x1 <= 1.5 * it.size && x0 >= last.x0 - 0.5) {
      last.x1 = Math.max(last.x1, x1);
      last.size = Math.max(last.size, it.size);
    } else segs.push({ x0, x1, y: it.y, size: it.size });
  }
  return segs;
}

/** The first glyph at or after `offset` in a block (else the last one before it). */
function glyphAt(g: BlockGlyphs, offset: number): { item: number; ch: number } | null {
  for (let k = Math.max(0, offset); k < g.item.length; k++) {
    if ((g.item[k] as number) >= 0) return { item: g.item[k] as number, ch: g.ch[k] as number };
  }
  for (let k = Math.min(offset, g.item.length) - 1; k >= 0; k--) {
    if ((g.item[k] as number) >= 0) return { item: g.item[k] as number, ch: g.ch[k] as number };
  }
  return null;
}

export interface AnchorGeom {
  page: number;
  /** The quote's segments on `page` (first = where it starts); empty for an empty quote. */
  segs: Seg[];
  /** The start glyph: its left edge, baseline and size. */
  start: { x: number; y: number; size: number };
  /** The text no longer equals the anchor's quote (shown, flagged). */
  stale: boolean;
}

/**
 * Where an anchor is on the PDF: null when its block has no position in the text, or
 * the block couldn't be found in the PDF. Quotes that run onto the next lines give one
 * segment per line (segments on a following page are dropped: the mark lives where the
 * quote starts).
 */
export function anchorGeom(
  map: GlyphMap,
  text: ScriptText,
  anchor: Pick<Anchor, "block" | "offset" | "length" | "quote" | "prefix" | "suffix">,
  geomOf: (page: number) => PageGeom | undefined,
  measure: Measure = proportional,
): AnchorGeom | null {
  if (anchor.block < 0) return null;
  const g = map[anchor.block];
  if (!g) return null;
  const geom = geomOf(g.page);
  if (!geom) return null;
  const pos = anchorPosition(text, anchor);
  if (!pos) return null;
  const start = glyphAt(g, anchor.offset);
  const startItem = start ? geom.items[start.item] : null;
  if (!start || !startItem) return null;
  const segs: Seg[] = [];
  for (const s of pos.segments) {
    const bg = map[s.block];
    if (!bg || bg.page !== g.page || s.end <= s.start) continue;
    segs.push(...blockSegs(bg, s.start, s.end, geom, measure));
  }
  return {
    page: g.page,
    segs,
    start: {
      x: charX(startItem, start.ch, measure),
      y: startItem.y,
      size: startItem.size,
    },
    stale: !pos.exact,
  };
}

// ---- selections (text layer → block span) ----

/** Per item `ref` on a page: the block and offset of each of its characters (-1: none). */
export type PageGlyphIndex = Map<number, { block: Int32Array; offset: Int32Array }>;

export function pageGlyphIndex(map: GlyphMap, page: number, geom: PageGeom): PageGlyphIndex {
  const out: PageGlyphIndex = new Map();
  map.forEach((g, block) => {
    if (!g || g.page !== page) return;
    for (let k = 0; k < g.item.length; k++) {
      const item = g.item[k] as number;
      const ch = g.ch[k] as number;
      if (item < 0) continue;
      let e = out.get(item);
      if (!e) {
        const n = Math.max(geom.items[item]?.str.length ?? 0, ch + 1);
        e = { block: new Int32Array(n).fill(-1), offset: new Int32Array(n).fill(-1) };
        out.set(item, e);
      }
      if (ch < e.block.length && (e.block[ch] as number) < 0) {
        e.block[ch] = block;
        e.offset[ch] = k;
      }
    }
  });
  return out;
}

/**
 * The block text at (item, ch) of the text layer, or the nearest one in `dir` (items in
 * text-layer order): selections that start or end on a page number, a running header or
 * between items snap onto the script text.
 */
export function glyphToText(
  index: PageGlyphIndex,
  item: number,
  ch: number,
  dir: 1 | -1,
): { block: number; offset: number } | null {
  const refs = [...index.keys()].sort((a, b) => a - b);
  const at = (r: number, c: number) => {
    const e = index.get(r);
    if (!e || c < 0 || c >= e.block.length) return null;
    const b = e.block[c] as number;
    return b < 0 ? null : { block: b, offset: e.offset[c] as number };
  };
  const e = index.get(item);
  if (e) {
    for (let c = ch; c >= 0 && c < e.block.length; c += dir) {
      const hit = at(item, c);
      if (hit) return hit;
    }
  }
  const ordered = dir === 1 ? refs.filter((r) => r > item) : refs.filter((r) => r < item).reverse();
  for (const r of ordered) {
    const n = index.get(r)?.block.length ?? 0;
    for (let c = dir === 1 ? 0 : n - 1; c >= 0 && c < n; c += dir) {
      const hit = at(r, c);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * A text-layer selection → the selected span of script text: from the glyph at `start`
 * to the one before `end` (exclusive, like a DOM range), whitespace trimmed. Null when
 * nothing of the script is selected.
 */
export function selectionSpan(
  text: ScriptText,
  index: PageGlyphIndex,
  start: { item: number; ch: number },
  end: { item: number; ch: number },
): Span | null {
  let s = glyphToText(index, start.item, start.ch, 1);
  let e =
    end.ch > 0
      ? glyphToText(index, end.item, end.ch - 1, -1)
      : glyphToText(index, end.item - 1, Number.MAX_SAFE_INTEGER, -1);
  if (!s || !e) return null;
  if (e.block < s.block || (e.block === s.block && e.offset < s.offset)) [s, e] = [e, s];
  const blockText = (b: number) => text.blocks[b]?.text ?? "";
  let { block, offset } = s;
  while (offset < blockText(block).length && /\s/.test(blockText(block)[offset] ?? "")) offset++;
  let endBlock = e.block;
  let endOffset = e.offset + 1;
  while (endOffset > 0 && /\s/.test(blockText(endBlock)[endOffset - 1] ?? "")) endOffset--;
  if (endBlock === block && endOffset <= offset) return null;
  if (endOffset === 0 && endBlock > block) {
    endBlock--;
    endOffset = blockText(endBlock).length;
  }
  return { block, offset, endBlock, endOffset };
}

// ---- lines (placing a positional cue at a height) ----

export interface PdfLine {
  block: number;
  /** Offset in the block's text where the line starts. */
  offset: number;
  x0: number;
  x1: number;
  /** Baseline, and the line's vertical extent (ascent above, descent below). */
  y: number;
  top: number;
  bottom: number;
}

/** The lines of script text on a page, top to bottom. */
export function pageLines(
  map: GlyphMap,
  page: number,
  geom: PageGeom,
  measure: Measure = proportional,
): PdfLine[] {
  const out: PdfLine[] = [];
  map.forEach((g, block) => {
    if (!g || g.page !== page) return;
    let cur: PdfLine | null = null;
    for (let k = 0; k < g.item.length; k++) {
      const item = g.item[k] as number;
      const it = item >= 0 ? geom.items[item] : null;
      if (!it) continue;
      const x0 = charX(it, g.ch[k] as number, measure);
      const x1 = charX(it, (g.ch[k] as number) + 1, measure);
      if (cur && Math.abs(cur.y - it.y) <= 0.35 * it.size) {
        cur.x0 = Math.min(cur.x0, x0);
        cur.x1 = Math.max(cur.x1, x1);
        cur.top = Math.min(cur.top, it.y - it.size * 0.9);
        cur.bottom = Math.max(cur.bottom, it.y + it.size * 0.25);
      } else {
        cur = {
          block,
          offset: k,
          x0,
          x1,
          y: it.y,
          top: it.y - it.size * 0.9,
          bottom: it.y + it.size * 0.25,
        };
        out.push(cur);
      }
    }
  });
  return out.sort((a, b) => a.y - b.y || a.x0 - b.x0);
}

/** The line at height `y` (points): the one containing it, else the nearest. */
export function lineAt(lines: readonly PdfLine[], y: number): PdfLine | null {
  let best: PdfLine | null = null;
  let dist = Number.POSITIVE_INFINITY;
  for (const l of lines) {
    const d = y < l.top ? l.top - y : y > l.bottom ? y - l.bottom : 0;
    if (d < dist || (d === dist && best && d === 0 && l.x0 < best.x0)) {
      best = l;
      dist = d;
    }
  }
  return best;
}
