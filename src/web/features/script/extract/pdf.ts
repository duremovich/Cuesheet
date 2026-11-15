// PDF scripts through pdfjs-dist's text layer (runs in the browser; the pdfjs module is
// passed in so tests can use its Node build). Layout → blocks:
//   1. text items → lines (same baseline within 0.35 × font size), words spaced by gaps;
//   2. margin lines (top/bottom 8% of the page) that read as a page number become the
//      page's label ("14", "14a", "- 14 -", "Page 14", "I-3-14"); margin lines repeated on
//      half the pages or more (running headers/footers) are dropped;
//   3. lines → blocks: a new block on a vertical gap over 1.45 × the usual line spacing, a
//      change of indent, and around headings, character names and parentheticals;
//   4. kinds by classifyBlocks (italic share from the font names).
// No text layer (a scan) → ScriptExtractError "no-text-layer". Confidence = the share of
// pages with text.
//
// `layoutPdfTraced` runs the same layout and also records, for every character of every
// block, the text item and character it came from (the PDF page view maps anchors to glyphs
// with it). Kinds don't change a block's text, so the trace needs no font names.
import { normalizeTextTraced, type ScriptText } from "../../../../shared/script";
import {
  classifyBlocks,
  isCharacterCue,
  isHeading,
  pageInfos,
  pageLabelOf,
  type RawBlock,
} from "./classify";
import { ScriptExtractError } from "./errors";
import { chooseLabels } from "./labels";

export interface PdfItem {
  str: string;
  /** Baseline origin, PDF user space (y up). */
  x: number;
  y: number;
  /** Advance width. */
  w: number;
  /** Font size. */
  size: number;
  italic: boolean;
  /**
   * The item's index among the page's text items (pdf.js `getTextContent().items` that
   * have a `str`: the TextLayer's `textDivs` index). Traces report glyphs by it.
   */
  ref?: number;
}

export interface PdfPageItems {
  width: number;
  height: number;
  items: PdfItem[];
}

interface Line {
  text: string;
  /** Per character of `text`: its source glyph (`glyph(ref, ch)`), or -1 (an inserted space). */
  src: number[];
  x: number;
  y: number;
  size: number;
  italic: number;
}

const MARGIN = 0.08;
/** A horizontal gap wider than this many font sizes splits a baseline into two lines. */
const COLUMN_GAP = 4;

/** Glyph code: text item `ref`, character `ch` of its `str`. */
const CH_SPAN = 2 ** 20;
const glyph = (ref: number, ch: number) => ref * CH_SPAN + Math.min(ch, CH_SPAN - 1);

/** `text.replace(/\s+/g, " ").trim()` with `src` kept aligned (a run keeps its first source). */
function collapse(text: string, src: readonly number[]): { text: string; src: number[] } {
  let out = "";
  const os: number[] = [];
  let space = -1;
  let pending = false;
  for (let k = 0; k < text.length; k++) {
    const c = text[k] as string;
    if (/\s/.test(c)) {
      if (!pending) space = src[k] ?? -1;
      pending = true;
      continue;
    }
    if (pending && out) {
      out += " ";
      os.push(space);
    }
    pending = false;
    out += c;
    os.push(src[k] ?? -1);
  }
  return { text: out, src: os };
}

function toLines(page: PdfPageItems): Line[] {
  const items = page.items
    .filter((it) => it.str.trim() !== "")
    .sort((a, b) => b.y - a.y || a.x - b.x);
  const groups: PdfItem[][] = [];
  for (const it of items) {
    const g = groups.at(-1);
    const first = g?.[0];
    if (g && first && Math.abs(first.y - it.y) <= 0.35 * Math.max(first.size, it.size, 1)) {
      g.push(it);
    } else groups.push([it]);
  }
  // Text far apart on one baseline is separate lines (a running header and the page
  // number at the other end of it).
  const split = groups.flatMap((g) => {
    g.sort((a, b) => a.x - b.x);
    const parts: PdfItem[][] = [];
    let end = Number.NEGATIVE_INFINITY;
    for (const it of g) {
      const part = parts.at(-1);
      if (part && it.x - end <= COLUMN_GAP * it.size) part.push(it);
      else parts.push([it]);
      end = Math.max(end, it.x + it.w);
    }
    return parts;
  });
  return split.map((g) => {
    g.sort((a, b) => a.x - b.x);
    let text = "";
    const src: number[] = [];
    let italicChars = 0;
    let chars = 0;
    let end = Number.NEGATIVE_INFINITY;
    for (const it of g) {
      const gap = it.x - end;
      if (text && gap > 0.12 * it.size && !/\s$/.test(text) && !/^\s/.test(it.str)) {
        text += " ";
        src.push(-1);
      }
      text += it.str;
      for (let k = 0; k < it.str.length; k++) {
        src.push(it.ref === undefined ? -1 : glyph(it.ref, k));
      }
      end = it.x + it.w;
      const n = it.str.replace(/\s/g, "").length;
      chars += n;
      if (it.italic) italicChars += n;
    }
    const line = collapse(text, src);
    return {
      text: line.text,
      src: line.src,
      x: (g[0] as PdfItem).x,
      y: (g[0] as PdfItem).y,
      size: Math.max(...g.map((it) => it.size)),
      italic: chars ? italicChars / chars : 0,
    };
  });
}

const median = (xs: number[]) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] as number;
};

const inMargin = (l: Line, p: PdfPageItems) =>
  l.y > p.height * (1 - MARGIN) || l.y < p.height * MARGIN;

/**
 * Margins: each page's printed label, and running headers/footers repeated across pages.
 * Every margin line that reads as a page number is a candidate; `chooseLabels` picks the
 * real one (the form the labels share, fitting between its neighbours': "34" over a date
 * "11.1.26" beside it). A losing candidate on the label's own baseline is header matter and
 * dropped; others stay text ("I", "3" as dialogue near the bottom). → labels by physical
 * page (1-based) and each page's remaining lines.
 */
function margins(
  pages: PdfPageItems[],
  lines: Line[][],
  preferShape?: string | null,
): { labels: Map<number, string>; body: Line[][] } {
  const repeated = new Map<string, number>();
  lines.forEach((ls, i) => {
    const seen = new Set<string>();
    for (const l of ls) {
      if (!inMargin(l, pages[i] as PdfPageItems)) continue;
      const key = l.text.replace(/\d+/g, "#").toLowerCase();
      if (!seen.has(key)) repeated.set(key, (repeated.get(key) ?? 0) + 1);
      seen.add(key);
    }
  });
  const keyOf = (l: Line) => l.text.replace(/\d+/g, "#").toLowerCase();
  const isRunning = (key: string) =>
    pages.length >= 3 && (repeated.get(key) ?? 0) >= pages.length / 2;
  // Variants of a running header ("WG 10.21.26 (ALH new page)", "WG 11.6.26 pm" beside the
  // usual "WG 11.9.26"): a margin line in the same band (top / bottom) that starts with a
  // running header and a space. Only headers with letters and ≥ 4 characters count, so a
  // bare repeated number never swallows a line of dialogue near the bottom.
  const bandOf = (l: Line, p: PdfPageItems) => (l.y > p.height / 2 ? "top" : "bottom");
  const headerBands = new Map<string, Set<string>>();
  lines.forEach((ls, i) => {
    const page = pages[i] as PdfPageItems;
    for (const l of ls) {
      const key = keyOf(l);
      if (!inMargin(l, page) || !isRunning(key) || key.length < 4 || !/\p{L}/u.test(key)) continue;
      const bands = headerBands.get(key) ?? new Set<string>();
      bands.add(bandOf(l, page));
      headerBands.set(key, bands);
    }
  });
  const runningHeader = (l: Line, p: PdfPageItems) => {
    const key = keyOf(l);
    if (isRunning(key)) return true;
    for (const [h, bands] of headerBands) {
      if (key.startsWith(`${h} `) && bands.has(bandOf(l, p))) return true;
    }
    return false;
  };
  const candidates = lines.map((ls, i) =>
    ls.flatMap((line) => {
      if (!inMargin(line, pages[i] as PdfPageItems)) return [];
      const label = pageLabelOf(line.text);
      return label !== null && label.length <= 12 ? [{ line, label }] : [];
    }),
  );
  const pick = chooseLabels(
    candidates.map((cs) => cs.map((c) => c.label)),
    preferShape,
  );
  const labels = new Map<number, string>();
  const body = lines.map((ls, i) => {
    const cs = candidates[i] ?? [];
    const won = cs[pick[i] ?? -1];
    if (won) labels.set(i + 1, won.label);
    const losers = new Set(cs.map((c) => c.line));
    const sameBaseline = (l: Line, w: Line) =>
      Math.abs(l.y - w.y) <= 0.35 * Math.max(l.size, w.size, 1);
    return ls.filter((l) => {
      if (won && l === won.line) return false;
      if (won && losers.has(l) && sameBaseline(l, won.line)) return false;
      const page = pages[i] as PdfPageItems;
      return !inMargin(l, page) || !runningHeader(l, page);
    });
  });
  return { labels, body };
}

/** What "Add pages" needs to know about an incoming page. */
export interface PdfPageSummary {
  /** Its printed label, or null when its margins have none. */
  label: string | null;
  /**
   * The first line of text outside the margins, with the next one when it's short (a
   * character name: "JOE · We take the midnight bus…"), to tell pages apart; "" if none.
   */
  firstLine: string;
}

/**
 * Each page's printed label and first body line, by the extractor's own label logic.
 * `preferShape`: the form of the labels these pages will sit among (`labelShape` of the
 * current version's labels), since a page or two on their own have no sequence to go by.
 */
export function pdfPageSummaries(
  pages: PdfPageItems[],
  preferShape?: string | null,
): PdfPageSummary[] {
  const lines = pages.map(toLines);
  const { labels } = margins(pages, lines, preferShape);
  return pages.map((page, i) => {
    const body = (lines[i] ?? []).filter((l) => !inMargin(l, page) && l.text !== "");
    const [first, second] = body;
    let firstLine = first?.text ?? "";
    if (second && firstLine.length < 24) firstLine = `${firstLine} · ${second.text}`;
    return { label: labels.get(i + 1) ?? null, firstLine };
  });
}

/** Pages of positioned text → ScriptText (pure; `extractPdf` feeds it from pdfjs). */
export function layoutPdf(pages: PdfPageItems[]): ScriptText {
  return layout(pages, false).text;
}

/**
 * Where each character of a block came from: `item[k]` / `ch[k]` are the text item
 * (`PdfItem.ref`) and the character of its `str` that produced `block.text[k]`; -1 for
 * characters the layout inserted (the space between two lines, or between two items).
 */
export interface BlockTrace {
  page: number;
  item: Int32Array;
  ch: Int32Array;
}

/**
 * `layoutPdf`, plus one trace per block (in `text.blocks` order) for the PDF page view:
 * an anchor's block/offset → glyphs on its page. Items need their `ref`s.
 */
export function layoutPdfTraced(pages: PdfPageItems[]): { text: ScriptText; trace: BlockTrace[] } {
  return layout(pages, true);
}

function layout(pages: PdfPageItems[], trace: boolean): { text: ScriptText; trace: BlockTrace[] } {
  const lines = pages.map(toLines);
  const withText = lines.filter((ls) => ls.some((l) => l.text.length > 0)).length;
  const chars = lines.flat().reduce((n, l) => n + l.text.length, 0);
  if (
    pages.length === 0 ||
    chars < 20 * Math.max(1, pages.length / 10) ||
    withText < pages.length * 0.1
  ) {
    throw new ScriptExtractError(
      "no-text-layer",
      "This PDF has no text layer (it looks scanned). Run OCR on it first (e.g. Acrobat's “Recognize Text” or Preview's “Export as PDF” with text), or import the script as a Word document.",
    );
  }

  const { labels, body } = margins(pages, lines);

  // The usual distance between lines (baseline to baseline) across the document.
  const gaps: number[] = [];
  for (const ls of body) {
    for (let k = 1; k < ls.length; k++) {
      const d = (ls[k - 1] as Line).y - (ls[k] as Line).y;
      if (d > 0) gaps.push(d);
    }
  }
  const spacing = median(gaps) || 14;

  const raw: RawBlock[] = [];
  const rawSrc: number[][] = [];
  body.forEach((ls, i) => {
    let cur: { lines: Line[]; continues: boolean } | null = null;
    const flush = () => {
      if (!cur) return;
      let text = "";
      const src: number[] = [];
      for (const l of cur.lines) {
        if (text) {
          // A word hyphenated at the line end joins the next line's lowercase start.
          if (/\p{L}-$/u.test(text) && /^\p{Ll}/u.test(l.text)) {
            // joined as is
          } else {
            text += " ";
            if (trace) src.push(-1);
          }
        }
        text += l.text;
        if (trace) for (const g of l.src) src.push(g);
      }
      const n = cur.lines.reduce((s, l) => s + l.text.length, 0);
      const italic = n ? cur.lines.reduce((s, l) => s + l.italic * l.text.length, 0) / n : 0;
      raw.push({ text, page: i + 1, italic, continues: cur.continues });
      rawSrc.push(src);
      cur = null;
    };
    let prev: Line | null = null;
    for (const l of ls) {
      const gap = prev ? prev.y - l.y : Number.POSITIVE_INFINITY;
      const bigGap = gap > spacing * 1.45;
      const standalone = isHeading(l.text) || isCharacterCue(l.text);
      const blockLines: Line[] = (cur as { lines: Line[] } | null)?.lines ?? [];
      const first = blockLines[0];
      const last = blockLines.at(-1);
      const startsParen = /^[([]/.test(l.text);
      const closedParen = !!first && /^[([]/.test(first.text) && !!last && /[)\]]$/.test(last.text);
      const lastStandalone = !!last && (isHeading(last.text) || isCharacterCue(last.text));
      const indentChange =
        !!last &&
        Math.abs(l.x - last.x) > 1.5 * l.size &&
        !(blockLines.length === 1 && first && l.x < first.x); // a first-line indent
      if (
        !cur ||
        bigGap ||
        standalone ||
        startsParen ||
        closedParen ||
        lastStandalone ||
        indentChange
      ) {
        const continues: boolean = !!cur && !bigGap && !standalone;
        flush();
        cur = { lines: [l], continues };
      } else cur.lines.push(l);
      prev = l;
    }
    flush();
  });

  const blocks = classifyBlocks(raw);
  const used = [...new Set(blocks.map((b) => b.page))];
  const traces: BlockTrace[] = [];
  if (trace) {
    // classifyBlocks keeps the non-empty blocks, in order, with normalizeText'd text.
    raw.forEach((r, k) => {
      const { text, map } = normalizeTextTraced(r.text);
      if (!text) return;
      const src = rawSrc[k] ?? [];
      const item = new Int32Array(text.length);
      const ch = new Int32Array(text.length);
      for (let c = 0; c < text.length; c++) {
        const g = src[map[c] as number] ?? -1;
        item[c] = g < 0 ? -1 : Math.floor(g / CH_SPAN);
        ch[c] = g < 0 ? -1 : g % CH_SPAN;
      }
      traces.push({ page: r.page, item, ch });
    });
  }
  return {
    text: {
      blocks,
      pages: pageInfos(used, labels),
      source: "pdf",
      confidence: Math.round((withText / pages.length) * 100) / 100,
    },
    trace: traces,
  };
}

/** The part of pdfjs-dist's API used here (its browser and Node builds both fit). */
export type Pdfjs = typeof import("pdfjs-dist");

/** A page's text items for the layout (`ref` = index among the items that have a `str`). */
export function pdfItemsOf(
  items: readonly unknown[],
  origin: { x0: number; y0: number },
  italicOf: (fontName: string) => boolean = () => false,
): PdfItem[] {
  const out: PdfItem[] = [];
  let ref = -1;
  for (const raw of items) {
    if (!raw || typeof raw !== "object" || !("str" in raw)) continue;
    ref++;
    const it = raw as {
      str: string;
      transform: number[];
      width: number;
      height: number;
      fontName: string;
    };
    if (!it.str) continue;
    const [a, b, , , e, f] = it.transform;
    out.push({
      str: it.str,
      x: (e ?? 0) - origin.x0,
      y: (f ?? 0) - origin.y0,
      w: it.width,
      size: Math.hypot(a ?? 0, b ?? 0) || it.height || 10,
      italic: italicOf(it.fontName),
      ref,
    });
  }
  return out;
}

/** Text items of every page through pdfjs, then `layoutPdf`. */
export async function extractPdf(
  data: ArrayBuffer | Uint8Array,
  pdfjs: Pdfjs,
): Promise<ScriptText> {
  return layoutPdf(await readPdfItems(data, pdfjs));
}

/** A pdf.js page, as `readPdfItems` hands it to `onPage`. */
export type PdfjsPage = Awaited<
  ReturnType<Awaited<ReturnType<Pdfjs["getDocument"]>["promise"]>["getPage"]>
>;

/**
 * Every page's text items through pdfjs (fonts loaded for italics). Throws
 * ScriptExtractError "unreadable" for a damaged or password-protected file. `onPage` sees
 * each page while it's open ("Add pages" draws thumbnails with it).
 */
export async function readPdfItems(
  data: ArrayBuffer | Uint8Array,
  pdfjs: Pdfjs,
  opts: { onPage?: (page: PdfjsPage, n: number) => Promise<void> } = {},
): Promise<PdfPageItems[]> {
  // pdfjs takes ownership of (detaches) the buffer it's given: pass a copy.
  const bytes = new Uint8Array(data instanceof Uint8Array ? data : new Uint8Array(data)).slice();
  const task = pdfjs.getDocument({
    data: bytes,
    disableFontFace: true,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  });
  let doc: Awaited<(typeof task)["promise"]>;
  try {
    doc = await task.promise;
  } catch (e) {
    const name = (e as { name?: string }).name;
    throw new ScriptExtractError(
      "unreadable",
      name === "PasswordException"
        ? "This PDF is password-protected: remove the password and import it again."
        : "That file isn't a readable PDF.",
    );
  }
  const pages: PdfPageItems[] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const [x0, y0, x1, y1] = page.view as [number, number, number, number];
      const content = await page.getTextContent();
      const fontNames = new Set<string>();
      for (const it of content.items) if ("str" in it) fontNames.add(it.fontName);
      // Font names ("Times-Italic") are known once the page's fonts are loaded.
      if ([...fontNames].some((f) => !page.commonObjs.has(f))) {
        await page.getOperatorList().catch(() => undefined);
      }
      const italic = new Map<string, boolean>();
      for (const f of fontNames) {
        let name = "";
        try {
          name = (page.commonObjs.get(f) as { name?: string } | undefined)?.name ?? "";
        } catch {
          // not loaded: treat as upright
        }
        italic.set(f, /italic|oblique/i.test(name));
      }
      const items = pdfItemsOf(content.items, { x0, y0 }, (f) => italic.get(f) ?? false);
      pages.push({ width: x1 - x0, height: y1 - y0, items });
      if (opts.onPage) await opts.onPage(page, n);
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  return pages;
}
