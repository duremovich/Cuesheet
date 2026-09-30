// "Export all tables (zip)" (R26): one CSV per table of the show (the core data tables, shot
// lists and every custom table) plus `manifest.json`. Unlike a view export these are the
// stored fields: every row, show order, an `id` column, references and links as labels
// (joined by ", "), measurements as meters, custom fields after the core ones (formulas as
// computed). Sensitive custom fields are left out unless asked for (owners). Pure except
// `downloadAll`; see exportAll.test.ts.
import { customTableRef } from "../../../shared/custom-fields";
import { formatFormulaValue, type Value } from "../../../shared/formula";
import {
  type AnyRow,
  FIELDS,
  type FieldSpec,
  LINKS,
  type LinkSpec,
  type TableName,
} from "../../../shared/tables";
import { formatPixelSize, isPixelSize } from "../../../shared/units";
import type { Column } from "../../components/grid/types";
import { formatValue } from "../../components/grid/values";
import type { ShowData } from "../../lib/show-state";
import type { ShowStore } from "../../lib/show-store";
import { customColumns } from "../custom/columns";
import { customTablesInOrder, fieldsFor, targetLabel } from "../custom/model";
import { csvFileName, downloadBlob, toCsv } from "./csv";

/** The core tables exported, with their file names. */
const CORE: { table: TableName; label: string }[] = [
  { table: "scenes", label: "Scenes" },
  { table: "cues", label: "Cues" },
  { table: "content", label: "Content" },
  { table: "content_versions", label: "Content versions" },
  { table: "surfaces", label: "Surfaces" },
  { table: "notes", label: "Notes" },
  { table: "persons", label: "People" },
  { table: "shot_lists", label: "Shot lists" },
  { table: "shots", label: "Shots" },
];

export interface ExportedTable {
  file: string;
  table: string;
  label: string;
  rows: string[][];
}

type Raw = Record<string, unknown>;

function rowsOf(data: ShowData, table: TableName): AnyRow[] {
  const map = data.tables[table] as Map<string, AnyRow>;
  const order = (data.order as Record<string, string[] | undefined>)[table];
  if (order) return order.flatMap((id) => map.get(id) ?? []);
  return [...map.values()].sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1));
}

/** A stored core value as text. */
function storedText(data: ShowData, spec: FieldSpec, v: unknown): string {
  if (v === null || v === undefined) return "";
  if (spec.type === "ref" && typeof v === "string") {
    return spec.ref ? (targetLabel(data, spec.ref, v) ?? v) : v;
  }
  if (spec.type === "bool") return v ? "true" : "false";
  if (spec.type === "multiselect" && Array.isArray(v)) return v.join(", ");
  if (spec.type === "pixel_size") return isPixelSize(v) ? formatPixelSize(v) : "";
  if (spec.type === "json") return JSON.stringify(v);
  return String(v);
}

/** One table's rows: header + data. */
export function tableRows(
  data: ShowData,
  table: TableName,
  fieldTable: string | null,
  rows: readonly AnyRow[],
  opts: { includeSensitive?: boolean } = {},
): string[][] {
  const specs = (Object.entries(FIELDS[table]) as [string, FieldSpec][]).filter(
    ([name, spec]) => table !== "custom_rows" || name !== "table_id" || spec.type !== "ref",
  );
  const links = (Object.entries(LINKS) as [string, LinkSpec][]).filter(([, l]) => l.from === table);
  const base: Column<Raw>[] = specs.map(([name, spec]) => ({
    key: name,
    title: spec.type === "measurement" ? `${name} (m)` : name,
    type: "text",
    getValue: (r) => r[name],
    format: (v) => storedText(data, spec, v),
  }));
  const linkCols: Column<Raw>[] = links.map(([name, l]) => {
    const field = name.slice(name.indexOf(".") + 1);
    return {
      key: field,
      title: field,
      type: "text",
      getValue: (r) =>
        (data.joins[l.key].get(r.id as string) ?? []).map(
          (id) => targetLabel(data, l.to, id) ?? id,
        ),
      format: (v) => (Array.isArray(v) ? v.join(", ") : ""),
    };
  });
  const defs = fieldTable ? fieldsFor(data.tables.custom_fields, fieldTable) : [];
  const store = { getState: () => data } as unknown as ShowStore;
  const custom = customColumns<Raw>(
    defs.filter((f) => opts.includeSensitive || !f.options.sensitive),
    {
      store,
      table,
      rowOf: (r) => r as unknown as { id: string; custom: Record<string, never> },
      editable: false,
      showId: "",
      baseColumns: [...base, ...linkCols],
      sampleRows: rows as unknown as Raw[],
    },
  );
  const cols = [...base.filter((c) => c.key !== "table_id"), ...linkCols, ...custom];
  const cell = (c: Column<Raw>, r: Raw): string => {
    const v = c.getValue(r);
    if (c.type === "formula") return formatFormulaValue(v as Value, "m");
    if (c.type === "measurement") return typeof v === "number" ? String(v) : "";
    if (c.type === "checkbox") return v ? "true" : "false";
    return formatValue(c, v);
  };
  return [
    ["id", ...cols.map((c) => (c.type === "measurement" ? `${c.title} (m)` : c.title))],
    ...rows.map((row) => {
      const r = row as unknown as Raw;
      return [String(r.id), ...cols.map((c) => cell(c, r))];
    }),
  ];
}

/** Every table of the show as CSV rows. */
export function exportAllTables(
  data: ShowData,
  opts: { includeSensitive?: boolean } = {},
): ExportedTable[] {
  const out: ExportedTable[] = [];
  for (const { table, label } of CORE) {
    const fieldTable = table === "content_versions" || table === "shot_lists" ? null : table;
    out.push({
      file: csvFileName(label),
      table,
      label,
      rows: tableRows(data, table, fieldTable, rowsOf(data, table), opts),
    });
  }
  const used = new Set(out.map((t) => t.file));
  for (const t of customTablesInOrder(data.tables.custom_tables)) {
    const label = t.label || "Untitled table";
    let file = csvFileName(label);
    for (let n = 2; used.has(file); n++) file = csvFileName(`${label} ${n}`);
    used.add(file);
    const rows = rowsOf(data, "custom_rows").filter(
      (r) => (r as unknown as { table_id: string }).table_id === t.id,
    );
    out.push({
      file,
      table: customTableRef(t.id),
      label,
      rows: tableRows(data, "custom_rows", customTableRef(t.id), rows, opts),
    });
  }
  return out;
}

/** The zip: one CSV per table (with a BOM, for Excel) and `manifest.json`. */
export async function exportZip(
  data: ShowData,
  showName: string,
  opts: { includeSensitive?: boolean } = {},
): Promise<Blob> {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  const tables = exportAllTables(data, opts);
  for (const t of tables) zip.file(t.file, toCsv(t.rows, { bom: true }));
  zip.file(
    "manifest.json",
    JSON.stringify(
      {
        show: showName,
        exportedAt: new Date().toISOString(),
        version: data.version,
        includesSensitive: !!opts.includeSensitive,
        tables: tables.map((t) => ({
          file: t.file,
          table: t.table,
          label: t.label,
          rows: t.rows.length - 1,
          columns: t.rows[0] ?? [],
        })),
      },
      null,
      2,
    ),
  );
  return zip.generateAsync({ type: "blob" });
}

export async function downloadAll(
  data: ShowData,
  showName: string,
  opts: { includeSensitive?: boolean } = {},
): Promise<void> {
  const blob = await exportZip(data, showName, opts);
  downloadBlob(blob, csvFileName(showName, "all tables").replace(/\.csv$/, ".zip"));
}
