// pdfjs-dist with its worker, loaded on first use (separate chunks): the import's
// extraction and the PDF page view share one copy. The *legacy* build: the modern one
// failed in the M4a review's in-browser run, and the legacy one supports more browsers.
// e2e/script-extract.spec.ts and e2e/script-pdf.spec.ts run it in Chromium.
import type { Pdfjs } from "../extract/pdf";

let pdfjsPromise: Promise<Pdfjs> | null = null;

export function loadPdfjs(): Promise<Pdfjs> {
  pdfjsPromise ??= (async () => {
    const [pdfjs, worker] = await Promise.all([
      import("pdfjs-dist/legacy/build/pdf.mjs"),
      import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"),
    ]);
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    return pdfjs as unknown as Pdfjs;
  })();
  pdfjsPromise.catch(() => {
    pdfjsPromise = null;
  });
  return pdfjsPromise;
}
