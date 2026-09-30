// How the row panel's field editors turn input into a grid-shaped value, and whether it's
// worth sending. The value then goes through the same `<table>EditOps` as a grid edit, so
// the panel and the grid write identical ops.
import type { Column } from "../../components/grid/types";
import { editTextOf, NOT_PARSED, parseText, valuesEqual } from "../../components/grid/values";

/** Can `row`'s `col` be edited (readonly columns never; `editable` may be per row)? */
export function isFieldEditable<Row>(col: Column<Row>, row: Row): boolean {
  if (col.type === "readonly" || col.type === "formula") return false;
  const e = col.editable;
  return typeof e === "function" ? e(row) : e !== false;
}

/** Text typed into a text/longtext/number editor → the column's value (or NOT_PARSED). */
export function valueFromText<Row>(col: Column<Row>, text: string): unknown {
  return parseText(col, text);
}

/**
 * The value to commit for `next`, or `undefined` when there's nothing to send: the field
 * isn't editable, the text didn't parse (e.g. "abc" in a number), or nothing changed.
 */
export function panelCommit<Row>(col: Column<Row>, row: Row, next: unknown): unknown {
  if (!isFieldEditable(col, row)) return undefined;
  if (next === NOT_PARSED) return undefined;
  if (valuesEqual(col.getValue(row), next, col.type)) return undefined;
  return next;
}

/** An editor's display text for the current value (text-like columns). */
export function textOf(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v);
}

/** The editor text for a column's value (lengths precise, in the column's unit). */
export function editorText<Row>(col: Column<Row>, v: unknown): string {
  return col.type === "measurement" || col.type === "pixelsize" ? editTextOf(col, v) : textOf(v);
}
