// A tab's custom field columns (R9): the table's field definitions from the store turned
// into grid columns after the tab's own, plus the edit → ops for them. Columns rebuild when
// the definitions change, and, when a field shows linked records or computes a formula,
// when the show's data changes (labels and formula inputs live in other rows).
import { useCallback, useMemo, useRef } from "react";
import type { FormulaRecord } from "../../../shared/formula";
import type { Op } from "../../../shared/ops";
import type { CustomFieldRow, CustomValues, TableName } from "../../../shared/tables";
import type { Column } from "../../components/grid/types";
import { useShowStore, useShowStoreInstance } from "../../lib/show-store";
import { useWorkspace } from "../show/workspace";
import { customColumns, customEditOps } from "./columns";
import { fieldsFor } from "./model";

export interface CustomColumnsSetup<V> {
  /** `cues`, …, or `custom:<id>`. */
  fieldTable: string;
  /** Where the rows live (`custom_rows` for a custom table). */
  table: TableName;
  rowOf: (v: V) => { id: string; custom: CustomValues };
  editable: boolean | ((v: V) => boolean);
  baseColumns: Column<V>[];
  rows: readonly V[];
  fallbackRecord?: (v: V) => FormulaRecord;
}

export interface CustomColumnsState<V> {
  /** The tab's columns followed by one per custom field. */
  columns: Column<V>[];
  fields: CustomFieldRow[];
  /** Ops for an edit of a custom column; null for the tab's own columns. */
  editOps: (v: V, key: string, value: unknown) => Op[] | null;
}

export function useCustomColumns<V>(setup: CustomColumnsSetup<V>): CustomColumnsState<V> {
  const store = useShowStoreInstance();
  const { showId } = useWorkspace();
  const { fieldTable, table, editable, baseColumns } = setup;
  const fields = useShowStore((s) => fieldsFor(s.tables.custom_fields, fieldTable));
  const needsData = fields.some((f) => f.type === "link" || f.type === "formula");
  const hasFormula = fields.some((f) => f.type === "formula");
  const hasFiles = fields.some((f) => f.type === "attachment");
  // Rebuild triggers (values unused: the columns read the store at call time).
  const dataTick = useShowStore((s) => (needsData ? s.tables : null));
  const filesTick = useShowStore((s) => (hasFiles ? s.tables.attachments : null));
  const rowOfRef = useRef(setup.rowOf);
  rowOfRef.current = setup.rowOf;
  const fallbackRef = useRef(setup.fallbackRecord);
  fallbackRef.current = setup.fallbackRecord;
  const hasFallback = !!setup.fallbackRecord;
  const sampleRows = hasFormula ? setup.rows : null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: dataTick / filesTick are rebuild triggers
  const custom = useMemo(
    () =>
      fields.length === 0
        ? []
        : customColumns<V>(fields, {
            store,
            table,
            rowOf: (v) => rowOfRef.current(v),
            editable,
            showId,
            baseColumns,
            ...(hasFallback
              ? { fallbackRecord: (v: V) => (fallbackRef.current as (v: V) => FormulaRecord)(v) }
              : {}),
            ...(sampleRows ? { sampleRows } : {}),
          }),
    [
      fields,
      store,
      table,
      editable,
      showId,
      baseColumns,
      hasFallback,
      sampleRows,
      dataTick,
      filesTick,
    ],
  );
  const columns = useMemo(
    () => (custom.length ? [...baseColumns, ...custom] : baseColumns),
    [baseColumns, custom],
  );
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;
  const editOps = useCallback(
    (v: V, key: string, value: unknown) =>
      customEditOps(table, rowOfRef.current(v).id, fieldsRef.current, key, value),
    [table],
  );
  return { columns, fields, editOps };
}
