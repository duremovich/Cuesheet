// Exporting the current view as CSV (R26): the view's visible columns in view order, its
// filtered / sorted / grouped rows (a leading group column when grouped), values as the
// grid shows them: links as labels joined by ", ", measurements in the active unit, dates
// ISO, formulas as displayed. Sensitive columns (passwords) are left out unless asked for.
// Pure apart from `sortRows`; see exportView.test.ts.

import { fromMeters } from "../../../shared/units";
import { sortRows } from "../../components/grid/ordering";
import type { Column, Group, SortSpec } from "../../components/grid/types";
import { formatValue } from "../../components/grid/values";

export interface ExportInput<V> {
  /** The view's visible columns, in order (units applied). */
  columns: readonly Column<V>[];
  rows?: readonly V[];
  groups?: readonly Group<V>[];
  /** The live sort (rows are sorted within groups as on screen); omit for show order. */
  sort?: readonly SortSpec[] | undefined;
  sortColumns?: readonly Column<V>[];
  /** The grouping field's title (the group column's header). */
  groupTitle?: string;
  /** Section rows (cue list dividers) are left out. */
  isSection?: (v: V) => boolean;
  /** The grouping field's key: no separate group column when it's a visible column. */
  groupKey?: string;
}

export interface ExportOptions {
  /** Include masked (sensitive) columns. Owners only, in the UI. */
  includeSensitive?: boolean;
}

/** One exported cell: the grid's display text (`formatValue`), attachments as file names. */
export function exportCell<V>(col: Column<V>, v: V): string {
  const value = col.getValue(v);
  if (col.type === "checkbox") return value ? "true" : "false";
  if (col.type === "measurement") {
    // A number in the active unit (the header names it), for spreadsheets to compute with.
    if (typeof value !== "number") return "";
    return String(Number(fromMeters(value, col.unit ?? "m").toFixed(4)));
  }
  return formatValue(col, value);
}

/** A column's export header: measurements carry their unit ("Width (m)"; ft-in as ft). */
export function exportHeader<V>(col: Column<V>): string {
  if (col.type !== "measurement") return col.title;
  const unit = col.unit ?? "m";
  return `${col.title} (${unit === "ft-in" ? "ft" : unit})`;
}

/** The header row and data rows of a view export. */
export function exportRows<V>(input: ExportInput<V>, opts: ExportOptions = {}): string[][] {
  const cols = input.columns.filter((c) => opts.includeSensitive || !c.masked);
  const grouped = !!input.groups && !(input.groupKey && cols.some((c) => c.key === input.groupKey));
  const header = [
    ...(grouped ? [input.groupTitle || "Group"] : []),
    ...cols.map((c) => exportHeader(c)),
  ];
  const out: string[][] = [header];
  const sorted = (rows: readonly V[]) =>
    input.sort?.length
      ? sortRows(rows, [...input.sort], [...(input.sortColumns ?? input.columns)])
      : rows;
  const emit = (rows: readonly V[], group?: string) => {
    for (const r of sorted(rows)) {
      if (input.isSection?.(r)) continue;
      out.push([
        ...(grouped && group !== undefined ? [group] : []),
        ...cols.map((c) => exportCell(c, r)),
      ]);
    }
  };
  if (input.groups) for (const g of input.groups) emit(g.rows, g.title);
  else emit(input.rows ?? []);
  return out;
}
