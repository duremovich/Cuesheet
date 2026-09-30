// Script text extraction, in the browser (decision 0007): a PDF, DOCX, TXT or Markdown file
// → a ScriptText to POST to /api/shows/:id/script/versions (`api.createScriptVersion`).
// No UI here: M4b's import dialog calls `extractScript` and shows `warnings`, the source
// and confidence, and `ScriptExtractError` messages (`code` "no-text-layer" = a scan).
// pdfjs-dist is loaded lazily, only for PDFs.
import { DOCX_TYPE } from "../../../../shared/attachments";
import type { ScriptText } from "../../../../shared/script";
import { extractDocx } from "./docx";
import { ScriptExtractError } from "./errors";
import { extractPdf, type Pdfjs } from "./pdf";
import { extractPlainText } from "./text";

export { extractDocx } from "./docx";
export { ScriptExtractError, type ScriptExtractErrorCode } from "./errors";
export { extractPdf, layoutPdf } from "./pdf";
export { extractPlainText } from "./text";

export type ScriptFileKind = "pdf" | "docx" | "txt" | "md";

/** What kind of script a file is, by type then extension; null if unsupported. */
export function scriptFileKind(file: { name: string; type: string }): ScriptFileKind | null {
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  const type = file.type.toLowerCase();
  if (type === "application/pdf" || ext === "pdf") return "pdf";
  if (type === DOCX_TYPE || ext === "docx") return "docx";
  if (type === "text/markdown" || ext === "md" || ext === "markdown") return "md";
  if (type === "text/plain" || ext === "txt") return "txt";
  return null;
}

/** File types the import dialog's `<input accept>` should offer. */
export const SCRIPT_ACCEPT = `.pdf,.docx,.txt,.md,application/pdf,${DOCX_TYPE},text/plain,text/markdown`;

let pdfjsPromise: Promise<Pdfjs> | null = null;

/**
 * pdfjs-dist with its worker (a separate chunk each; loaded on the first PDF). The
 * *legacy* build: the modern one failed in the M4a review's in-browser run, and the legacy
 * one supports a wider range of browsers. e2e/script-extract.spec.ts runs this path in
 * Chromium.
 */
function loadPdfjs(): Promise<Pdfjs> {
  pdfjsPromise ??= (async () => {
    const [pdfjs, worker] = await Promise.all([
      import("pdfjs-dist/legacy/build/pdf.mjs"),
      import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"),
    ]);
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    return pdfjs as unknown as Pdfjs;
  })();
  return pdfjsPromise;
}

/**
 * Extract a script file's text. Throws ScriptExtractError with a message for the user
 * (unsupported type, unreadable file, a scan without a text layer, no text).
 */
export async function extractScript(
  file: Blob & { name: string },
  opts: { pdfjs?: () => Promise<Pdfjs> } = {},
): Promise<ScriptText> {
  const kind = scriptFileKind(file);
  if (!kind) {
    throw new ScriptExtractError(
      "unsupported",
      "Scripts can be imported from PDF, Word (.docx), text or Markdown files. For a Google Doc, use File → Download → PDF or .docx.",
    );
  }
  let text: ScriptText;
  if (kind === "pdf") {
    text = await extractPdf(await file.arrayBuffer(), await (opts.pdfjs ?? loadPdfjs)());
  } else if (kind === "docx") {
    text = await extractDocx(await file.arrayBuffer());
  } else {
    text = extractPlainText(await file.text(), { markdown: kind === "md" });
  }
  if (text.blocks.length === 0) throw new ScriptExtractError("empty", "The file has no text.");
  return text;
}
