/**
 * Why a file couldn't be turned into script text. `no-text-layer`: a scanned PDF (no
 * selectable text; OCR isn't built in yet: M4b shows guidance: run OCR in Acrobat /
 * Preview, or export the script as DOCX); `unsupported`: not a PDF, DOCX, TXT or MD;
 * `unreadable`: damaged or password-protected; `empty`: no text at all.
 */
export type ScriptExtractErrorCode = "no-text-layer" | "unsupported" | "unreadable" | "empty";

export class ScriptExtractError extends Error {
  constructor(
    readonly code: ScriptExtractErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ScriptExtractError";
  }
}
