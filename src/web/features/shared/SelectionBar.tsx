// The bar that replaces a table's toolbar while several rows are selected (DataGrid's
// `onTargetRowsChange`: a row selection, or a cell range over several rows): the count,
// one-click setters for the table's select fields ("Status ▾ → Done"), "Set field…" (the
// bulk edit dialog), Delete (the grid's own confirmation) and Clear. Escape anywhere in the
// bar clears the selection, like Escape in the grid.
import { type RefObject, useCallback, useMemo, useState } from "react";
import type { Column, DataGridHandle } from "../../components/grid/types";
import { bulkColumns } from "./BulkEdit";
import { MenuButton } from "./MenuButton";
import styles from "./TableFrame.module.css";

/** At most this many select fields get their own button; the rest are in "Set field…". */
const QUICK_MAX = 3;

/**
 * The select columns a bar offers one-click values for: settable on every target row,
 * `status` first, then in column order.
 */
export function quickSetColumns<V>(columns: readonly Column<V>[], rows: readonly V[]): Column<V>[] {
  const selects = bulkColumns(columns, rows).filter(
    (c) => c.type === "select" && (c.options?.length ?? 0) > 0,
  );
  const status = selects.filter((c) => c.key === "status");
  return [...status, ...selects.filter((c) => c.key !== "status")].slice(0, QUICK_MAX);
}

/** The grid's target rows, kept to rows that still exist. */
export function useSelectionTargets<V>(byId: ReadonlyMap<string, V>) {
  const [targets, setTargets] = useState<string[]>([]);
  const live = useMemo(() => {
    const kept = targets.filter((id) => byId.has(id));
    return kept.length === targets.length ? targets : kept;
  }, [targets, byId]);
  return { targets: live, onTargetRowsChange: setTargets };
}

export function SelectionBar<V>({
  grid,
  targets,
  rows,
  columns,
  plural,
  canEdit,
  canDelete,
  onQuickSet,
  onSetField,
}: {
  grid: RefObject<DataGridHandle | null>;
  /** Target row ids (≥ 2 for the bar to show). */
  targets: readonly string[];
  /** Their rows. */
  rows: readonly V[];
  /** Columns the bulk edit can set (all of the table's, not only the view's). */
  columns: readonly Column<V>[];
  plural: string;
  canEdit: boolean;
  canDelete: boolean;
  onQuickSet: (rowIds: string[], column: Column<V>, value: unknown) => void;
  onSetField: (rowIds: string[]) => void;
}) {
  const quick = useMemo(
    () => (canEdit ? quickSetColumns(columns, rows) : []),
    [canEdit, columns, rows],
  );
  const clear = useCallback(() => grid.current?.clearSelection(), [grid]);
  const n = targets.length;
  if (n < 2) return null;
  const ids = [...targets];
  return (
    <div
      className={styles.selectionBar}
      role="toolbar"
      aria-label={`${n} ${plural} selected`}
      data-testid="selection-bar"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented) {
          e.preventDefault();
          clear();
        }
      }}
    >
      <strong className={styles.selectionCount} data-testid="selection-count">
        {n} {plural} selected
      </strong>
      {quick.map((c) => (
        <MenuButton
          key={c.key}
          label={`Set ${c.title} for ${n} ${plural}`}
          items={[
            ...(c.options ?? []).map((o) => ({
              label: o.label ?? o.value,
              onSelect: () => onQuickSet(ids, c, o.value),
            })),
            { label: `Clear ${c.title}`, onSelect: () => onQuickSet(ids, c, null) },
          ]}
        >
          {c.title} ▾
        </MenuButton>
      ))}
      {canEdit && (
        <button
          type="button"
          className={styles.toolButton}
          onClick={() => onSetField(ids)}
          title={`Set any field on the selected ${plural}`}
        >
          Set field…
        </button>
      )}
      {canDelete && (
        <button
          type="button"
          className={`${styles.toolButton} ${styles.dangerButton}`}
          onClick={() => grid.current?.deleteRows(ids)}
        >
          Delete {n} {plural}
        </button>
      )}
      <button
        type="button"
        className={styles.toolButton}
        onClick={clear}
        aria-label="Clear selection"
        title="Clear selection (Esc)"
      >
        ✕ Clear
      </button>
    </div>
  );
}
