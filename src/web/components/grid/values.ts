// Value helpers for the DataGrid: empty values per type, display text, parsing typed or
// pasted text, TSV (clipboard) encoding, and the grid's undo stack.

import { formatFormulaValue } from "../../../shared/formula";
import {
  editLength,
  formatLength,
  formatPixelSize,
  isPixelSize,
  lengthsEqual,
  parseLength,
  parsePixelSize,
} from "../../../shared/units";
import type { Column, ColumnType, PickerItem } from "./types";

export function emptyValue(type: ColumnType): unknown {
  switch (type) {
    case "text":
    case "longtext":
      return "";
    case "checkbox":
      return false;
    case "multiselect":
    case "multilink":
      return [];
    default:
      return null;
  }
}

export function optionLabel<Row>(col: Column<Row>, value: string): string {
  const o = col.options?.find((x) => x.value === value);
  return o?.label ?? value;
}

/** Plain-text form of a cell value, used for display of text-like cells and for copy. */
export function formatValue<Row>(col: Column<Row>, v: unknown): string {
  if (col.format) return col.format(v);
  if (v === null || v === undefined) return "";
  switch (col.type) {
    case "checkbox":
      return v ? "checked" : "";
    case "select":
      return optionLabel(col, String(v));
    case "multiselect":
      return (v as string[]).map((x) => optionLabel(col, x)).join(", ");
    case "link":
      return (v as PickerItem).label;
    case "multilink":
      return (v as PickerItem[]).map((x) => x.label).join(", ");
    case "measurement":
      return typeof v === "number" ? formatLength(v, col.unit ?? "m") : "";
    case "pixelsize":
      return isPixelSize(v) ? formatPixelSize(v) : "";
    case "formula":
      return formatFormulaValue(v as never, col.unit ?? "m");
    default:
      return Array.isArray(v) ? v.join(", ") : String(v);
  }
}

/**
 * The text an editor starts with for a value: numbers as typed, lengths precise (so an
 * unchanged commit is a no-op) in the column's unit, the rest as displayed.
 */
export function editTextOf<Row>(col: Column<Row>, v: unknown): string {
  if (v === null || v === undefined) return "";
  if (col.type === "number") return String(v);
  if (col.type === "measurement" && typeof v === "number") return editLength(v, col.unit ?? "m");
  return formatValue(col, v);
}

export const NOT_PARSED: unique symbol = Symbol("not parsed");

/**
 * Parses typed or pasted text into a cell value. Returns NOT_PARSED when the text can't be
 * a value of this column (e.g. an unknown select option or a non-number).
 */
export function parseText<Row>(col: Column<Row>, text: string): unknown {
  switch (col.type) {
    case "text":
      return text;
    case "longtext":
      return text;
    case "number": {
      const t = text.trim().replace(/,/g, "");
      if (t === "") return null;
      const n = Number(t);
      return Number.isFinite(n) ? n : NOT_PARSED;
    }
    case "measurement": {
      const r = parseLength(text, col.unit ?? "m");
      if (r === null) return null;
      return "m" in r ? r.m : NOT_PARSED;
    }
    case "pixelsize": {
      const r = parsePixelSize(text);
      if (r === null) return null;
      return "error" in r ? NOT_PARSED : r;
    }
    case "select": {
      const t = text.trim().toLowerCase();
      if (t === "") return null;
      const o = col.options?.find(
        (x) => x.value.toLowerCase() === t || (x.label ?? "").toLowerCase() === t,
      );
      return o ? o.value : NOT_PARSED;
    }
    default:
      return NOT_PARSED;
  }
}

/**
 * Cell values equal for undo and "did this edit change anything". With `type`
 * "measurement", lengths within LENGTH_EPSILON are equal.
 */
export function valuesEqual(a: unknown, b: unknown, type?: ColumnType): boolean {
  if (a === b) return true;
  if (type === "measurement" && typeof a === "number" && typeof b === "number") {
    return lengthsEqual(a, b);
  }
  if (isPixelSize(a) && isPixelSize(b)) return a.w === b.w && a.h === b.h;
  if ((a === null || a === undefined || a === "") && (b === null || b === undefined || b === ""))
    return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => valuesEqual(x, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object" && "id" in a && "id" in b) {
    return (a as PickerItem).id === (b as PickerItem).id;
  }
  return false;
}

// --- TSV (what spreadsheets put on the clipboard) ---

function tsvField(s: string): string {
  return /["\t\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toTsv(rows: string[][]): string {
  return rows.map((r) => r.map(tsvField).join("\t")).join("\n");
}

/** Parses TSV with spreadsheet-style quoting ("a\tb" fields, "" escapes, quoted newlines). */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  let quoted = false;
  const src = text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  while (i < src.length) {
    const ch = src[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === "") {
      quoted = true;
      i++;
    } else if (ch === "\t") {
      row.push(field);
      field = "";
      i++;
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
    } else {
      field += ch;
      i++;
    }
  }
  row.push(field);
  rows.push(row);
  return rows;
}

// --- Undo ---

export interface EditRecord {
  rowId: string;
  key: string;
  before: unknown;
  after: unknown;
}

/** One cell change to replay: set `value` if the cell still holds `expect`. */
export interface Replay {
  rowId: string;
  key: string;
  value: unknown;
  expect: unknown;
}

/** Undo/redo of batches of edits (one batch per user action, e.g. a paste). */
export class UndoStack {
  private done: EditRecord[][] = [];
  private undone: EditRecord[][] = [];
  constructor(private readonly limit = 200) {}

  push(batch: EditRecord[]): void {
    if (batch.length === 0) return;
    this.done.push(batch);
    if (this.done.length > this.limit) this.done.shift();
    this.undone = [];
  }

  /** The edits to apply to undo the last batch (inverse values), or null. */
  undo(): Replay[] | null {
    const b = this.done.pop();
    if (!b) return null;
    this.undone.push(b);
    return [...b]
      .reverse()
      .map((e) => ({ rowId: e.rowId, key: e.key, value: e.before, expect: e.after }));
  }

  redo(): Replay[] | null {
    const b = this.undone.pop();
    if (!b) return null;
    this.done.push(b);
    return b.map((e) => ({ rowId: e.rowId, key: e.key, value: e.after, expect: e.before }));
  }

  get canUndo(): boolean {
    return this.done.length > 0;
  }

  get canRedo(): boolean {
    return this.undone.length > 0;
  }
}
