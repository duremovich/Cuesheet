// A custom table's tab (R9), /shows/:id/tables/<customTableId>: its rows in show order
// (insert, drag, delete), every column a custom field (the Fields popover manages them),
// saved views, the row panel, CSV export. Rename / delete the table here or in Show settings.
import { useCallback, useMemo } from "react";
import { Link, useParams } from "react-router";
import { customTableRef } from "../../../shared/custom-fields";
import type { Op } from "../../../shared/ops";
import type { CustomRowRow } from "../../../shared/tables";
import type { InsertPosition } from "../../components/grid/types";
import { useShowStore, useShowStoreInstance } from "../../lib/show-store";
import { placementFor } from "../shared/ops";
import frame from "../shared/TableFrame.module.css";
import { TableGrid } from "../shared/TableGrid";
import { customTabKey } from "../show/tabs";
import { useWorkspace } from "../show/workspace";
import { customRowLabel, fieldsFor } from "./model";

const NO_COLUMNS: never[] = [];
const rowOf = (r: CustomRowRow) => r;

export function CustomTableGrid() {
  const { tableId = "" } = useParams();
  const ws = useWorkspace();
  const store = useShowStoreInstance();
  const table = useShowStore((s) => s.tables.custom_tables.get(tableId));
  const status = useShowStore((s) => s.status);
  const rowsMap = useShowStore((s) => s.tables.custom_rows);
  const order = useShowStore((s) => s.order.custom_rows);
  const fieldCount = useShowStore(
    (s) => fieldsFor(s.tables.custom_fields, customTableRef(tableId)).length,
  );
  const rows = useMemo(
    () =>
      order.flatMap((id) => {
        const r = rowsMap.get(id);
        return r && r.table_id === tableId ? [r] : [];
      }),
    [order, rowsMap, tableId],
  );
  const custom = useMemo(() => ({ fieldTable: customTableRef(tableId), rowOf }), [tableId]);
  const createOps = useCallback(
    (id: string, pos: InsertPosition): Op[] => [
      {
        op: "create",
        table: "custom_rows",
        id,
        fields: { table_id: tableId },
        ...placementFor(pos),
      },
    ],
    [tableId],
  );
  const moveOps = useCallback(
    (r: CustomRowRow, pos: InsertPosition): Op[] => [
      { op: "move", table: "custom_rows", id: r.id, ...placementFor(pos, undefined, r.id) },
    ],
    [],
  );

  if (!table) {
    if (status !== "ready") return <p className="muted">Loading…</p>;
    return (
      <p className={frame.empty} data-testid="custom-table-missing">
        This table no longer exists.{" "}
        <Link to={`/shows/${encodeURIComponent(ws.showId)}/cues`}>Back to the cue list</Link>
      </p>
    );
  }
  const title = table.label || "Untitled table";
  const rename = () => {
    const label = window.prompt("Rename the table", title)?.trim();
    if (!label || label === table.label) return;
    store
      .mutate([{ op: "update", table: "custom_tables", id: table.id, fields: { label } }])
      .catch((e: unknown) => ws.reportError(e, "rename the table"));
  };
  return (
    <TableGrid<CustomRowRow>
      key={tableId}
      tab={customTabKey(tableId)}
      title={title}
      label={title}
      noun="row"
      testId="custom-table"
      columns={NO_COLUMNS}
      rowId={(r) => r.id}
      rows={rows}
      editOps={noEdit}
      custom={custom}
      {...(ws.canEdit
        ? {
            createOps,
            moveOps,
            deleteOps: (rs: CustomRowRow[]) =>
              rs.map((r): Op => ({ op: "delete", table: "custom_rows", id: r.id })),
            toolbar: (
              <button type="button" className={frame.toolButton} onClick={rename}>
                Rename table
              </button>
            ),
          }
        : {})}
      panelTitle={(r) => customRowLabel(store.getState(), r)}
      empty={
        <p className={frame.empty}>
          {fieldCount === 0
            ? "This table has no fields yet. Add one under Fields."
            : ws.canEdit
              ? "No rows yet. Add one with + Add row."
              : "No rows yet."}
        </p>
      }
    />
  );
}

const noEdit = (): Op[] => [];
