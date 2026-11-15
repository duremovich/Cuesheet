// Building the merged PDF for "Add pages": the current version's original with pages
// replaced, inserted and removed (`mergeOrder` in ./plan), pages copied as they are
// (pdf-lib `copyPages`: text layer, fonts and all). pdf-lib is imported on demand, so it's
// its own chunk and only loads when someone adds pages.
import type { PageRef } from "./plan";

/** Why a merge can't happen, in words for the user. */
export class MergeError extends Error {
  override name = "MergeError";
}

type PdfLib = typeof import("pdf-lib");

let pdfLib: Promise<PdfLib> | null = null;

/** pdf-lib, loaded once (a lazy chunk). */
export function loadPdfLib(): Promise<PdfLib> {
  pdfLib ??= import("pdf-lib");
  pdfLib.catch(() => {
    pdfLib = null;
  });
  return pdfLib;
}

/**
 * Opens a PDF for copying pages from. Refuses encrypted files (pdf-lib can't copy their
 * pages intact, even when they open without a password) and unreadable ones.
 */
async function open(lib: PdfLib, bytes: Uint8Array, name: string) {
  let doc: Awaited<ReturnType<PdfLib["PDFDocument"]["load"]>>;
  try {
    doc = await lib.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  } catch {
    throw new MergeError(`${name} isn't a readable PDF.`);
  }
  if (doc.isEncrypted) {
    throw new MergeError(
      `${name} is protected (encrypted), so its pages can't be copied. Save an unprotected copy (e.g. print it to PDF) and try again.`,
    );
  }
  return doc;
}

/** Page count of a PDF pages will be copied from (refusing encrypted or unreadable files). */
export async function pdfPageCount(bytes: Uint8Array, name: string): Promise<number> {
  const doc = await open(await loadPdfLib(), bytes, name);
  return doc.getPageCount();
}

/**
 * The merged PDF: `order` pages from `base` (`src: "base"`) and the incoming files
 * (`src: "in"`, by file index), copied in that order. `order` may be a function of the
 * base's page count (`mergeOrder`). Only the files it uses are opened.
 */
export async function mergePdf(
  base: { bytes: Uint8Array; name: string },
  incoming: readonly { bytes: Uint8Array; name: string }[],
  orderOf: readonly PageRef[] | ((baseCount: number) => readonly PageRef[]),
): Promise<Uint8Array> {
  const lib = await loadPdfLib();
  const src = await open(lib, base.bytes, base.name);
  const order = typeof orderOf === "function" ? orderOf(src.getPageCount()) : orderOf;
  const files = new Map<number, Awaited<ReturnType<typeof open>>>();
  for (const r of order) {
    if (r.src !== "in" || files.has(r.file)) continue;
    const f = incoming[r.file];
    if (!f) throw new MergeError("An incoming file is missing.");
    files.set(r.file, await open(lib, f.bytes, f.name));
  }
  const out = await lib.PDFDocument.create();
  const title = src.getTitle();
  if (title) out.setTitle(title);
  // Copy each source's pages in one call (shared resources copied once), then place them.
  const wanted = new Map<string, Set<number>>();
  const keyOf = (r: PageRef) => (r.src === "base" ? "base" : `in:${r.file}`);
  for (const r of order) {
    const set = wanted.get(keyOf(r)) ?? new Set<number>();
    set.add(r.index);
    wanted.set(keyOf(r), set);
  }
  const copied = new Map<string, Map<number, Awaited<ReturnType<typeof out.copyPages>>[number]>>();
  for (const [key, set] of wanted) {
    const doc = key === "base" ? src : files.get(Number(key.slice(3)));
    if (!doc) throw new MergeError("An incoming file is missing.");
    const indexes = [...set].sort((a, b) => a - b);
    const count = doc.getPageCount();
    if (indexes.some((i) => i < 0 || i >= count)) {
      throw new MergeError(
        key === "base"
          ? "The current version's PDF has fewer pages than its text: re-import the full script instead."
          : "An incoming file has fewer pages than expected.",
      );
    }
    const pages = await out.copyPages(doc, indexes);
    copied.set(key, new Map(indexes.map((i, k) => [i, pages[k] as (typeof pages)[number]])));
  }
  for (const r of order) {
    const page = copied.get(keyOf(r))?.get(r.index);
    if (!page) throw new MergeError("A page couldn't be copied.");
    out.addPage(page);
  }
  return out.save();
}
