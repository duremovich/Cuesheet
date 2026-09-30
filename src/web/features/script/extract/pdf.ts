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
import type { ScriptText } from "../../../../shared/script";
import {
  classifyBlocks,
  isCharacterCue,
  isHeading,
  pageInfos,
  pageLabelOf,
  type RawBlock,
} from "./classify";
import { ScriptExtractError } from "./errors";

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
}

export interface PdfPageItems {
  width: number;
  height: number;
  items: PdfItem[];
}

interface Line {
  text: string;
  x: number;
  y: number;
  size: number;
  italic: number;
}

const MARGIN = 0.08;
/** A horizontal gap wider than this many font sizes splits a baseline into two lines. */
const COLUMN_GAP = 4;

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
    let italicChars = 0;
    let chars = 0;
    let end = Number.NEGATIVE_INFINITY;
    for (const it of g) {
      const gap = it.x - end;
      if (text && gap > 0.12 * it.size && !/\s$/.test(text) && !/^\s/.test(it.str)) text += " ";
      text += it.str;
      end = it.x + it.w;
      const n = it.str.replace(/\s/g, "").length;
      chars += n;
      if (it.italic) italicChars += n;
    }
    return {
      text: text.replace(/\s+/g, " ").trim(),
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

/** Pages of positioned text → ScriptText (pure; `extractPdf` feeds it from pdfjs). */
export function layoutPdf(pages: PdfPageItems[]): ScriptText {
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

  // Margins: page labels, and running headers/footers repeated across pages.
  const inMargin = (l: Line, p: PdfPageItems) =>
    l.y > p.height * (1 - MARGIN) || l.y < p.height * MARGIN;
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
  const runningHeader = (l: Line) => {
    const n = repeated.get(l.text.replace(/\d+/g, "#").toLowerCase()) ?? 0;
    return pages.length >= 3 && n >= pages.length / 2;
  };
  const labels = new Map<number, string>();
  const body: Line[][] = lines.map((ls, i) => {
    const page = pages[i] as PdfPageItems;
    return ls.filter((l) => {
      if (!inMargin(l, page)) return true;
      const label = pageLabelOf(l.text);
      if (label !== null && label.length <= 12) {
        if (!labels.has(i + 1)) labels.set(i + 1, label);
        return false;
      }
      return !runningHeader(l);
    });
  });

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
  body.forEach((ls, i) => {
    let cur: { lines: Line[]; continues: boolean } | null = null;
    const flush = () => {
      if (!cur) return;
      const text = cur.lines.reduce((acc, l) => {
        if (!acc) return l.text;
        return /\p{L}-$/u.test(acc) && /^\p{Ll}/u.test(l.text) ? acc + l.text : `${acc} ${l.text}`;
      }, "");
      const n = cur.lines.reduce((s, l) => s + l.text.length, 0);
      const italic = n ? cur.lines.reduce((s, l) => s + l.italic * l.text.length, 0) / n : 0;
      raw.push({ text, page: i + 1, italic, continues: cur.continues });
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
  return {
    blocks,
    pages: pageInfos(used, labels),
    source: "pdf",
    confidence: Math.round((withText / pages.length) * 100) / 100,
  };
}

/** The part of pdfjs-dist's API used here (its browser and Node builds both fit). */
export type Pdfjs = typeof import("pdfjs-dist");

/** Text items of every page through pdfjs, then `layoutPdf`. */
export async function extractPdf(
  data: ArrayBuffer | Uint8Array,
  pdfjs: Pdfjs,
): Promise<ScriptText> {
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
      const items: PdfItem[] = [];
      for (const it of content.items) {
        if (!("str" in it) || !it.str) continue;
        const [a, b, , , e, f] = it.transform as number[];
        items.push({
          str: it.str,
          x: (e ?? 0) - x0,
          y: (f ?? 0) - y0,
          w: it.width,
          size: Math.hypot(a ?? 0, b ?? 0) || it.height || 10,
          italic: italic.get(it.fontName) ?? false,
        });
      }
      pages.push({ width: x1 - x0, height: y1 - y0, items });
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  return layoutPdf(pages);
}
