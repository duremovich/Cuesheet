// The People tab: everyone on the show's contact sheet (Personnel), oldest first.
import { useMemo } from "react";
import type { PersonRow } from "../../../shared/tables";
import { useOrderedRows, useShowStore } from "../../lib/show-store";
import { TableGrid } from "../shared/TableGrid";
import { useWorkspace } from "../show/workspace";
import { personColumns, personEditOps } from "./columns";

const CUSTOM = { fieldTable: "persons", rowOf: (p: PersonRow) => p };

export function PeopleGrid() {
  const { canEdit } = useWorkspace();
  const rows = useOrderedRows("persons");
  const fieldOptions = useShowStore((s) => s.fieldOptions);
  const columns = useMemo(() => personColumns(fieldOptions, canEdit), [fieldOptions, canEdit]);
  return (
    <TableGrid<PersonRow>
      tab="people"
      custom={CUSTOM}
      title="People"
      label="People"
      noun="person"
      plural="people"
      testId="people-list"
      columns={columns}
      rowId={(p) => p.id}
      rows={rows}
      editOps={personEditOps}
      {...(canEdit
        ? {
            createOps: (id) => [{ op: "create", table: "persons", id, fields: {} }],
            deleteOps: (ps) => ps.map((p) => ({ op: "delete", table: "persons", id: p.id })),
          }
        : {})}
      panelTitle={(p) => p.name || "Person"}
      empty={<p className="muted">No people yet.</p>}
    />
  );
}
