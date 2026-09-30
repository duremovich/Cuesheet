// Bulk edit (S8): "Set field for selection…" in the grid's row menu opens this dialog: pick
// a field, set a value (the row panel's editors and pickers), Apply → one batch of the
// table's own edit ops for every selected row. The toast offers Undo, which puts each row's
// previous value back (skipping nothing: it's your own change, just made).
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Op } from "../../../shared/ops";
import type { Column } from "../../components/grid/types";
import { emptyValue } from "../../components/grid/values";
import styles from "./BulkEdit.module.css";
import { FieldEditor } from "./FieldEditor";
import { isFieldEditable } from "./panelFields";

export interface BulkEditRequest {
  rowIds: string[];
  /** Start with this field picked (e.g. "scene" for "Move to scene…"). */
  field?: string;
  title?: string;
}

/** Columns a bulk edit can set: editable, stored values (no files, formulas, read-only). */
export function bulkColumns<V>(columns: readonly Column<V>[], rows: readonly V[]): Column<V>[] {
  return columns.filter(
    (c) =>
      c.type !== "attachment" &&
      c.type !== "formula" &&
      c.type !== "readonly" &&
      rows.length > 0 &&
      rows.every((r) => isFieldEditable(c, r)),
  );
}

/**
 * The ops that set `key` to `value` on every row, and the ops that undo it (each row's old
 * value, computed against the rows as they are after the change: `current(id)`).
 */
export function bulkOps<V>(opts: {
  rows: readonly V[];
  rowId: (v: V) => string;
  column: Column<V>;
  value: unknown;
  editOps: (v: V, key: string, value: unknown) => Op[];
}): { ops: Op[]; undo: (current: (id: string) => V | undefined) => Op[] } {
  const { rows, rowId, column, value, editOps } = opts;
  const before = new Map(rows.map((r) => [rowId(r), column.getValue(r)] as const));
  return {
    ops: rows.flatMap((r) => editOps(r, column.key, value)),
    undo: (current) =>
      [...before].flatMap(([id, old]) => {
        const r = current(id);
        return r === undefined ? [] : editOps(r, column.key, old);
      }),
  };
}

export function BulkEditDialog<V>({
  request,
  columns,
  rows,
  onApply,
  onClose,
}: {
  request: BulkEditRequest;
  columns: readonly Column<V>[];
  /** The selected rows. */
  rows: readonly V[];
  onApply: (column: Column<V>, value: unknown) => void;
  onClose: () => void;
}) {
  const choices = useMemo(() => bulkColumns(columns, rows), [columns, rows]);
  const [key, setKey] = useState(
    () => choices.find((c) => c.key === request.field)?.key ?? choices[0]?.key ?? "",
  );
  const column = choices.find((c) => c.key === key);
  const [value, setValue] = useState<unknown>(() => (column ? emptyValue(column.type) : null));
  const titleId = useId();
  const root = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<Element | null>(null);
  useEffect(() => {
    returnFocus.current = document.activeElement;
    root.current?.querySelector<HTMLElement>("select, input, button")?.focus();
    return () => (returnFocus.current as HTMLElement | null)?.focus?.();
  }, []);
  // The editor edits `value` through a column that reads it (pickers search with a real row).
  const draftColumn = useMemo(
    () => (column ? ({ ...column, editable: true, getValue: () => value } as Column<V>) : null),
    [column, value],
  );
  const first = rows[0];
  const n = rows.length;
  return (
    <div className={styles.backdrop} data-grid-portal="">
      <div
        ref={root}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="bulk-edit"
        onKeyDown={(e) => {
          if (e.key === "Escape" && !e.defaultPrevented) {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <h2 className={styles.title} id={titleId}>
          {request.title ?? "Set field"} for {n} {n === 1 ? "row" : "rows"}
        </h2>
        {choices.length === 0 ? (
          <p className="muted">No field can be set on all of these rows.</p>
        ) : (
          <>
            <label className={styles.field}>
              <span>Field</span>
              <select
                value={key}
                onChange={(e) => {
                  const next = choices.find((c) => c.key === e.target.value);
                  setKey(e.target.value);
                  setValue(next ? emptyValue(next.type) : null);
                }}
              >
                {choices.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.title}
                  </option>
                ))}
              </select>
            </label>
            {draftColumn && first !== undefined && (
              <div className={styles.field}>
                <span>Value</span>
                <FieldEditor col={draftColumn} row={first} canEdit onCommit={(v) => setValue(v)} />
              </div>
            )}
          </>
        )}
        <div className={styles.actions}>
          <button
            type="button"
            className="primary"
            disabled={!column}
            onClick={() => {
              if (column) onApply(column, value);
              onClose();
            }}
          >
            Apply to {n} {n === 1 ? "row" : "rows"}
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/** The selected rows' ids, or just the row the menu was opened on. */
export function rowIdsOf(ctx: { rowId: string; selectedRowIds: string[] }): string[] {
  return ctx.selectedRowIds.includes(ctx.rowId) ? ctx.selectedRowIds : [ctx.rowId];
}
