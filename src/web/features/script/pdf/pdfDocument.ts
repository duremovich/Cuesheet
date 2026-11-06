// Loading a version's original PDF for the page view (browser). The file comes from the
// attachments route (immutable, so the HTTP cache keeps it); the parsed document, its
// pages' text and the glyph maps stay in memory for the last few files, so switching
// between the text and PDF views or coming back to the Script tab doesn't re-parse.
import type { PDFDocumentProxy } from "pdfjs-dist";
import { useEffect, useState } from "react";
import type { ScriptText } from "../contract";
import type { Pdfjs } from "../extract/pdf";
import { loadPdfjs } from "./pdfjs";
import { type GlyphMap, type Measure, proportional } from "./pdfMap";
import { buildGlyphMap, type PdfPageData, readPdfPages } from "./pdfPages";

export interface LoadedPdf {
  url: string;
  pdfjs: Pdfjs;
  doc: PDFDocumentProxy;
  pages: PdfPageData[];
  /** Glyph maps per stored text (one per version shown). */
  maps: WeakMap<ScriptText, GlyphMap>;
}

/** Parsed documents kept, most recent last. */
const KEEP = 3;
const cache = new Map<string, Promise<LoadedPdf>>();

export function loadPdf(url: string): Promise<LoadedPdf> {
  const hit = cache.get(url);
  if (hit) {
    cache.delete(url);
    cache.set(url, hit);
    return hit;
  }
  const p = (async () => {
    const [pdfjs, res] = await Promise.all([
      loadPdfjs(),
      fetch(url, { credentials: "same-origin" }),
    ]);
    if (!res.ok) throw new Error(`The original file couldn't be loaded (${res.status}).`);
    const data = new Uint8Array(await res.arrayBuffer());
    let doc: PDFDocumentProxy;
    try {
      doc = await pdfjs.getDocument({
        data,
        verbosity: pdfjs.VerbosityLevel.ERRORS,
      }).promise;
    } catch {
      throw new Error("The original file isn't a readable PDF.");
    }
    const pages = await readPdfPages(doc);
    return { url, pdfjs, doc, pages, maps: new WeakMap() };
  })();
  cache.set(url, p);
  p.catch(() => cache.delete(url));
  while (cache.size > KEEP) {
    const [oldest, old] = cache.entries().next().value as [string, Promise<LoadedPdf>];
    cache.delete(oldest);
    old.then((d) => d.doc.loadingTask.destroy()).catch(() => undefined);
  }
  return p;
}

/** The glyph map of `text` on this PDF (computed once per text). */
export function glyphMapOf(pdf: LoadedPdf, text: ScriptText): GlyphMap {
  let m = pdf.maps.get(text);
  if (!m) {
    m = buildGlyphMap(pdf.pages, text);
    pdf.maps.set(text, m);
  }
  return m;
}

export function usePdf(url: string | null): { pdf: LoadedPdf | null; error: string | null } {
  const [state, setState] = useState<{
    url: string | null;
    pdf: LoadedPdf | null;
    error: string | null;
  }>({ url: null, pdf: null, error: null });
  useEffect(() => {
    if (!url) return;
    let live = true;
    loadPdf(url).then(
      (pdf) => live && setState({ url, pdf, error: null }),
      (e: unknown) =>
        live && setState({ url, pdf: null, error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, [url]);
  return state.url === url ? { pdf: state.pdf, error: state.error } : { pdf: null, error: null };
}

let ctx: CanvasRenderingContext2D | null | undefined;
const widths = new Map<string, number>();

/**
 * Text widths the way pdf.js's text layer measures them (a canvas in the item's CSS font
 * family), so underlines meet the selectable text. Proportional without a canvas (jsdom).
 */
export const canvasMeasure: Measure = (text, font) => {
  if (ctx === undefined) {
    try {
      ctx = document.createElement("canvas").getContext("2d");
    } catch {
      ctx = null;
    }
  }
  if (!ctx) return proportional(text, font);
  const key = `${font}\u0000${text}`;
  let w = widths.get(key);
  if (w === undefined) {
    ctx.font = `100px ${font}`;
    w = ctx.measureText(text).width;
    if (widths.size > 20_000) widths.clear();
    widths.set(key, w);
  }
  return w;
};
