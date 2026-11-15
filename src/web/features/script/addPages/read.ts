// Reading the PDFs dropped on "Add pages" (browser): each page's printed label and first
// line by the extractor's own logic, plus a small thumbnail, and a check with pdf-lib that
// its pages can be copied (an encrypted file is refused here, before any plan is made).
import { ScriptExtractError } from "../extract/errors";
import { type PdfjsPage, pdfPageSummaries, readPdfItems } from "../extract/pdf";
import { loadPdfjs } from "../pdf/pdfjs";
import { MergeError, pdfPageCount } from "./merge";
import type { IncomingPage } from "./plan";

/** Thumbnail width, CSS px (drawn at 2× for sharp screens). */
const THUMB_W = 64;

async function thumbnail(page: PdfjsPage): Promise<string | undefined> {
  try {
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: (THUMB_W * 2) / base.width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    if (!canvas.getContext("2d")) return undefined; // no canvas (jsdom)
    await page.render({ canvas, viewport }).promise;
    return canvas.toDataURL("image/png");
  } catch {
    return undefined;
  }
}

export interface IncomingFile {
  name: string;
  bytes: Uint8Array;
  pages: IncomingPage[];
}

/**
 * One incoming PDF → its pages for the plan (`file` = its index among the incoming files).
 * `preferShape`: the form of the current version's labels (see `pdfPageSummaries`).
 * Throws an Error with a message for the user (not a PDF, unreadable, encrypted).
 */
export async function readIncoming(
  file: File,
  fileIndex: number,
  preferShape: string | null,
): Promise<IncomingFile> {
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  if (!isPdf) throw new Error(`${file.name} isn't a PDF: pages can only be added from PDFs.`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const thumbs: (string | undefined)[] = [];
  let items: Awaited<ReturnType<typeof readPdfItems>>;
  try {
    const [pdfjs] = await Promise.all([loadPdfjs(), pdfPageCount(bytes, file.name)]);
    items = await readPdfItems(bytes, pdfjs, {
      onPage: async (page, n) => {
        thumbs[n - 1] = await thumbnail(page);
      },
    });
  } catch (e) {
    if (e instanceof ScriptExtractError) throw new Error(`${file.name}: ${e.message}`);
    if (e instanceof MergeError) throw e;
    throw new Error(`${file.name} couldn't be read: ${e instanceof Error ? e.message : e}`);
  }
  const pages = pdfPageSummaries(items, preferShape).map(
    (s, index): IncomingPage => ({
      key: `${fileIndex}:${index}`,
      file: fileIndex,
      index,
      fileName: file.name,
      label: s.label,
      firstLine: s.firstLine,
      thumb: thumbs[index],
    }),
  );
  if (pages.length === 0) throw new Error(`${file.name} has no pages.`);
  return { name: file.name, bytes, pages };
}
