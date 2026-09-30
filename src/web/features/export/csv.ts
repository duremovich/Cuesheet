// A CSV writer (RFC 4180, R26): fields with a comma, quote, CR or LF are quoted and quotes
// doubled; rows end in CRLF; an optional UTF-8 byte order mark so Excel reads accents and
// emoji correctly. Pure; see csv.test.ts.

export interface CsvOptions {
  /** Start with a UTF-8 BOM (U+FEFF) for Excel. */
  bom?: boolean;
  /**
   * Excel-safe: a cell starting with `=`, `+`, `-` or `@` gets a leading `'` so a
   * spreadsheet shows it as text instead of running it as a formula (CSV injection).
   */
  excelSafe?: boolean;
}

/**
 * `'` before a cell a spreadsheet would read as a formula (`=`, `+`, `-`, `@`); plain
 * numbers ("-2.5", measurements below zero) stay numbers.
 */
export function excelSafe(value: string): string {
  if (/^-?\d+(\.\d+)?$/.test(value)) return value;
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

/** One field, quoted when it needs to be. */
export function csvField(value: string): string {
  return /[",\r\n]/.test(value) || /^\s|\s$/.test(value)
    ? `"${value.replaceAll('"', '""')}"`
    : value;
}

/** Rows of text → CSV text (every row CRLF-terminated). */
export function toCsv(rows: readonly (readonly string[])[], opts: CsvOptions = {}): string {
  const cell = opts.excelSafe ? (v: string) => csvField(excelSafe(v)) : csvField;
  const body = rows.map((r) => `${r.map(cell).join(",")}\r\n`).join("");
  return (opts.bom ? "﻿" : "") + body;
}

/** A file name from a title: "Cues – All cues" → "Cues - All cues.csv". */
export function csvFileName(...parts: (string | null | undefined)[]): string {
  const base = parts
    .filter((p): p is string => !!p?.trim())
    .join(" - ")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strip control characters from file names
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return `${base || "export"}.csv`;
}

/** Start a download of `text` as a file (browser only). */
export function downloadText(text: string, fileName: string, type = "text/csv;charset=utf-8") {
  const blob = new Blob([text], { type });
  downloadBlob(blob, fileName);
}

export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.style.display = "none";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
