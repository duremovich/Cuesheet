// The original PDF's pages for the page view: sizes, text items (for the text layer and
// the glyph geometry), and the glyph map of a version's blocks. No DOM; the pdfjs
// document is passed in (the browser's legacy build, or the Node build in tests).
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { TextContent } from "pdfjs-dist/types/src/display/api";
import type { ScriptText } from "../contract";
import { layoutPdfTraced, type PdfPageItems, pdfItemsOf } from "../extract/pdf";
import { alignBlocks, type GlyphItem, type GlyphMap, type PageGeom } from "./pdfMap";

export interface PdfPageData {
  /** 1-based, the physical page (`ScriptBlock.page`). */
  page: number;
  /** Size in points (the page's view box). */
  width: number;
  height: number;
  geom: PageGeom;
  /** Layout input (PDF user space). */
  items: PdfPageItems;
  /** What pdf.js's TextLayer renders (the same items, so `textDivs[ref]` ↔ `geom.items[ref]`). */
  content: TextContent;
}

/** Every page's size and text (one getTextContent per page; no rendering, no fonts). */
export async function readPdfPages(doc: PDFDocumentProxy): Promise<PdfPageData[]> {
  const out: PdfPageData[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const [x0, y0, x1, y1] = page.view as [number, number, number, number];
    const content = await page.getTextContent();
    const glyphs: (GlyphItem | null)[] = [];
    for (const it of content.items) {
      if (!("str" in it)) continue;
      const [a, b, , , e, f] = it.transform as number[];
      glyphs.push(
        it.str
          ? {
              str: it.str,
              x: (e ?? 0) - x0,
              y: y1 - (f ?? 0),
              w: it.width,
              size: Math.hypot(a ?? 0, b ?? 0) || it.height || 10,
              font: content.styles[it.fontName]?.fontFamily ?? "sans-serif",
            }
          : null,
      );
    }
    const width = x1 - x0;
    const height = y1 - y0;
    out.push({
      page: n,
      width,
      height,
      geom: { page: n, width, height, items: glyphs },
      items: { width, height, items: pdfItemsOf(content.items, { x0, y0 }) },
      content,
    });
  }
  return out;
}

/**
 * The version's blocks → glyphs on these pages (the extraction's layout re-run with
 * tracing, aligned with the stored blocks). A PDF without a text layer maps nothing.
 */
export function buildGlyphMap(pages: readonly PdfPageData[], stored: ScriptText): GlyphMap {
  try {
    return alignBlocks(stored, layoutPdfTraced(pages.map((p) => p.items)));
  } catch {
    return stored.blocks.map(() => null);
  }
}
