// Custom fields and tables on the client (R9): which fields a table has, record labels for
// link targets (core tables and custom tables), picker search over a target, and the ops
// that make a new custom table. Pure (reads ShowData); see model.test.ts.
import {
  CUSTOM_FIELD_CORE_TABLES,
  type CustomFieldType,
  customTableId,
  customTableRef,
  slugify,
} from "../../../shared/custom-fields";
import { newId } from "../../../shared/ids";
import type { Op } from "../../../shared/ops";
import type {
  CustomFieldRow,
  CustomRowRow,
  CustomTableRow,
  CustomValues,
  TableName,
} from "../../../shared/tables";
import type { PickerItem } from "../../components/grid/types";
import { sceneTitle } from "../../lib/show-selectors";
import type { ShowData } from "../../lib/show-state";

const byPosition = (a: CustomFieldRow, b: CustomFieldRow) =>
  (a.position ?? 0) - (b.position ?? 0) ||
  a.created_at - b.created_at ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const fieldCache = new WeakMap<Map<string, CustomFieldRow>, Map<string, CustomFieldRow[]>>();
const NO_FIELDS: CustomFieldRow[] = [];

/**
 * The custom fields of a field table (`cues`, `custom:<id>`) in position order. Cached per
 * `custom_fields` map, so the list keeps its identity until a field changes.
 */
export function fieldsFor(
  fields: Map<string, CustomFieldRow>,
  fieldTable: string,
): CustomFieldRow[] {
  let byTable = fieldCache.get(fields);
  if (!byTable) {
    byTable = new Map();
    for (const f of fields.values()) {
      const list = byTable.get(f.table) ?? [];
      list.push(f);
      byTable.set(f.table, list);
    }
    for (const list of byTable.values()) list.sort(byPosition);
    fieldCache.set(fields, byTable);
  }
  return byTable.get(fieldTable) ?? NO_FIELDS;
}

/** Custom tables in tab order. */
export function customTablesInOrder(tables: Map<string, CustomTableRow>): CustomTableRow[] {
  return [...tables.values()].sort(
    (a, b) =>
      (a.position ?? 0) - (b.position ?? 0) ||
      a.created_at - b.created_at ||
      (a.id < b.id ? -1 : 1),
  );
}

/** The value of a custom row's primary field (else its first text value) as its name. */
export function customRowLabel(data: ShowData, row: CustomRowRow): string {
  const table = data.tables.custom_tables.get(row.table_id);
  const key = table?.primary_field_key;
  const primary = key ? row.custom[key] : undefined;
  if (typeof primary === "string" && primary.trim()) return primary;
  if (typeof primary === "number") return String(primary);
  for (const f of fieldsFor(data.tables.custom_fields, customTableRef(row.table_id))) {
    const v = row.custom[f.key];
    if (typeof v === "string" && v.trim() && !f.options.sensitive) return v;
  }
  return "Untitled";
}

/** A record's name in a link target (a core table or `custom:<id>`), or null if gone. */
export function targetLabel(data: ShowData, target: string, id: string): string | null {
  const ct = customTableId(target);
  if (ct) {
    const row = data.tables.custom_rows.get(id);
    return row && row.table_id === ct ? customRowLabel(data, row) : null;
  }
  switch (target) {
    case "cues": {
      const c = data.tables.cues.get(id);
      if (!c) return null;
      return c.number ? `Cue ${c.number}` : c.description?.slice(0, 40) || "(unnumbered cue)";
    }
    case "scenes": {
      const s = data.tables.scenes.get(id);
      return s ? sceneTitle(s) : null;
    }
    case "content":
      return data.tables.content.get(id) ? data.tables.content.get(id)?.name || "Untitled" : null;
    case "persons":
      return data.tables.persons.get(id) ? data.tables.persons.get(id)?.name || "Unnamed" : null;
    case "surfaces":
      return data.tables.surfaces.get(id) ? data.tables.surfaces.get(id)?.name || "Untitled" : null;
    case "notes": {
      const n = data.tables.notes.get(id);
      return n ? n.body?.slice(0, 40) || "(note)" : null;
    }
    case "shots": {
      const s = data.tables.shots.get(id);
      return s ? (s.number ? `Shot ${s.number}` : s.description?.slice(0, 40) || "(shot)") : null;
    }
    default:
      return null;
  }
}

/** Ids of every record in a link target, in the target's order. */
export function targetIds(data: ShowData, target: string): string[] {
  const ct = customTableId(target);
  if (ct) {
    return data.order.custom_rows.filter((id) => data.tables.custom_rows.get(id)?.table_id === ct);
  }
  switch (target) {
    case "cues":
    case "scenes":
    case "content":
    case "surfaces":
    case "shots":
      return data.order[target];
    case "persons":
    case "notes":
      return [...data.tables[target].keys()];
    default:
      return [];
  }
}

/** Picker items for a link target: label matches first (prefix before substring), ≤ 50. */
export function searchTarget(data: ShowData, target: string, query: string): PickerItem[] {
  const q = query.trim().toLocaleLowerCase();
  const out: { item: PickerItem; rank: number }[] = [];
  for (const id of targetIds(data, target)) {
    const label = targetLabel(data, target, id);
    if (label === null) continue;
    const l = label.toLocaleLowerCase();
    const rank = !q ? 1 : l.startsWith(q) ? 0 : l.includes(q) ? 1 : -1;
    if (rank >= 0) out.push({ item: { id, label }, rank });
  }
  return out
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 50)
    .map((x) => x.item);
}

/** Human name of a link target table ("People", "Network"). */
export function targetTableLabel(data: ShowData, target: string): string {
  const ct = customTableId(target);
  if (ct) return data.tables.custom_tables.get(ct)?.label || "Custom table";
  return TARGET_LABELS[target] ?? target;
}

export const TARGET_LABELS: Record<string, string> = {
  cues: "Cues",
  scenes: "Scenes",
  content: "Content",
  notes: "Notes",
  persons: "People",
  surfaces: "Surfaces",
  shots: "Shots",
};

/** Every table a link field can point at, as {value, label}. */
export function linkTargets(
  customTables: Map<string, CustomTableRow>,
): { value: string; label: string }[] {
  return [
    ...Object.entries(TARGET_LABELS).map(([value, label]) => ({ value, label })),
    ...customTablesInOrder(customTables).map((t) => ({
      value: customTableRef(t.id),
      label: t.label || "Custom table",
    })),
  ];
}

/** The record table rows of a field table live in (`custom_rows` for a custom table). */
export function recordTableOf(fieldTable: string): TableName {
  if (customTableId(fieldTable)) return "custom_rows";
  return (CUSTOM_FIELD_CORE_TABLES as readonly string[]).includes(fieldTable)
    ? (fieldTable as TableName)
    : "custom_rows";
}

/** Ops for a new custom table: the table, its shared default view and a "Name" field. */
export function newCustomTableOps(data: ShowData, label: string): { id: string; ops: Op[] } {
  const id = newId();
  const position =
    Math.max(0, ...[...data.tables.custom_tables.values()].map((t) => t.position ?? 0)) + 1;
  const ops: Op[] = [
    {
      op: "create",
      table: "custom_tables",
      id,
      fields: { label, key: slugify(label), position, primary_field_key: "name" },
    },
    {
      op: "create",
      table: "custom_fields",
      id: newId(),
      fields: {
        table: customTableRef(id),
        key: "name",
        label: "Name",
        type: "text",
        options: {},
        position: 1,
        width: 200,
      },
    },
    {
      op: "create",
      table: "views",
      id: newId(),
      fields: { table: customTableRef(id), name: "All rows", is_default: true, position: 0 },
    },
  ];
  return { id, ops };
}

/** Ops for a new custom field on `fieldTable` (after the table's other fields). */
export function newFieldOps(
  data: ShowData,
  fieldTable: string,
  def: { label: string; type: CustomFieldType; options: Record<string, unknown> },
): { id: string; key: string; ops: Op[] } {
  const existing = fieldsFor(data.tables.custom_fields, fieldTable);
  const key = slugify(
    def.label,
    existing.map((f) => f.key),
  );
  const id = newId();
  const position = Math.max(0, ...existing.map((f) => f.position ?? 0)) + 1;
  return {
    id,
    key,
    ops: [
      {
        op: "create",
        table: "custom_fields",
        id,
        fields: {
          table: fieldTable,
          key,
          label: def.label,
          type: def.type,
          options: def.options,
          position,
        },
      },
    ],
  };
}

/**
 * Records that link to `id` (a record of link target `target`) through custom link fields:
 * one entry per field with the linking records' labels (the reverse side of a link).
 */
export function reverseLinks(
  data: ShowData,
  target: string,
  id: string,
): { field: CustomFieldRow; tableLabel: string; items: PickerItem[] }[] {
  const out: { field: CustomFieldRow; tableLabel: string; items: PickerItem[] }[] = [];
  for (const f of data.tables.custom_fields.values()) {
    if (f.type !== "link" || f.options.target !== target) continue;
    const items: PickerItem[] = [];
    for (const rid of targetIds(data, f.table)) {
      const custom = customOf(data, f.table, rid);
      const v = custom?.[f.key];
      if (Array.isArray(v) && v.includes(id)) {
        items.push({ id: rid, label: targetLabel(data, f.table, rid) ?? "Untitled" });
      }
    }
    if (items.length) out.push({ field: f, tableLabel: targetTableLabel(data, f.table), items });
  }
  return out;
}

function customOf(data: ShowData, fieldTable: string, id: string) {
  if (customTableId(fieldTable)) return data.tables.custom_rows.get(id)?.custom;
  const map = (data.tables as Record<string, Map<string, { custom: CustomValues }> | undefined>)[
    fieldTable
  ];
  return map?.get(id)?.custom;
}

/** How many rows of the field table have a value for `key` (the delete confirmation). */
export function valueCount(data: ShowData, fieldTable: string, key: string): number {
  const ct = customTableId(fieldTable);
  let n = 0;
  if (ct) {
    for (const r of data.tables.custom_rows.values()) {
      if (r.table_id === ct && Object.hasOwn(r.custom, key)) n++;
    }
    return n;
  }
  const map = (data.tables as Record<string, Map<string, { custom: object }> | undefined>)[
    fieldTable
  ];
  for (const r of map?.values() ?? []) if (Object.hasOwn(r.custom, key)) n++;
  return n;
}
