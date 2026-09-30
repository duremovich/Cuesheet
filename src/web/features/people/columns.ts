// People columns (data-model.md §Person) and edit → ops.

import type { Op } from "../../../shared/ops";
import type { FieldOptions, PersonRow } from "../../../shared/tables";
import type { Column } from "../../components/grid/types";
import { selectOptions } from "../cues/columns";
import { textField } from "../shared/ops";

const TEXT = ["name", "role", "email", "phone", "organization"] as const;

export function personColumns(fieldOptions: FieldOptions, editable: boolean): Column<PersonRow>[] {
  const text = (key: (typeof TEXT)[number]) => (p: PersonRow) => p[key] ?? "";
  const cols: Column<PersonRow>[] = [
    { key: "name", title: "Name", type: "text", width: 200, frozen: true, getValue: text("name") },
    { key: "role", title: "Role", type: "text", width: 200, getValue: text("role") },
    {
      key: "group",
      title: "Group",
      type: "select",
      width: 140,
      options: selectOptions(fieldOptions, "persons.group"),
      getValue: (p) => p.group,
    },
    { key: "email", title: "Email", type: "text", width: 220, getValue: text("email") },
    { key: "phone", title: "Phone", type: "text", width: 140, getValue: text("phone") },
    {
      key: "organization",
      title: "Organization",
      type: "text",
      width: 200,
      getValue: text("organization"),
    },
  ];
  return editable ? cols : cols.map((c) => ({ ...c, editable: false }));
}

export function personEditOps(p: PersonRow, key: string, value: unknown): Op[] {
  if ((TEXT as readonly string[]).includes(key)) {
    return [{ op: "update", table: "persons", id: p.id, fields: { [key]: textField(value) } }];
  }
  if (key === "group") {
    return [
      {
        op: "update",
        table: "persons",
        id: p.id,
        fields: { group: (value as string | null) ?? null },
      },
    ];
  }
  return [];
}
