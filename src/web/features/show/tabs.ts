// The show workspace's tabs (routes /shows/:id/<tab>) and their URL row parameter. Custom
// tables (R9) are tabs too: `tables/<customTableId>` → /shows/:id/tables/<id>.
import { customTableRef } from "../../../shared/custom-fields";
import type { TableName, ViewTable } from "../../../shared/tables";

export const TABS = [
  { key: "cues", label: "Cues", table: "cues", param: "cue", noun: "cue" },
  { key: "scenes", label: "Scenes", table: "scenes", param: "scene", noun: "scene" },
  { key: "content", label: "Content", table: "content", param: "content", noun: "content item" },
  { key: "surfaces", label: "Surfaces", table: "surfaces", param: "surface", noun: "surface" },
  { key: "shots", label: "Shots", table: "shots", param: "shot", noun: "shot" },
  { key: "notes", label: "Notes", table: "notes", param: "note", noun: "note" },
  { key: "people", label: "People", table: "persons", param: "person", noun: "person" },
] as const satisfies readonly {
  key: string;
  label: string;
  table: TableName;
  param: string;
  noun: string;
}[];

/** A core table's tab. */
export type TabKey = (typeof TABS)[number]["key"];
/** A custom table's tab: `tables/<customTableId>`. */
export type CustomTabKey = `tables/${string}`;
export type AnyTabKey = TabKey | CustomTabKey;

export interface TabInfo {
  key: AnyTabKey;
  label: string;
  /** Where the rows live. */
  table: TableName;
  /** What its saved views are for. */
  viewTable: ViewTable;
  param: string;
  noun: string;
}

export const customTabKey = (id: string): CustomTabKey => `tables/${id}`;

export function isCustomTab(key: string): key is CustomTabKey {
  return key.startsWith("tables/");
}

export function tabInfo(key: TabKey): (typeof TABS)[number] & { viewTable: ViewTable };
export function tabInfo(key: AnyTabKey): TabInfo;
export function tabInfo(key: AnyTabKey): TabInfo {
  if (isCustomTab(key)) {
    return {
      key,
      label: "Table",
      table: "custom_rows",
      viewTable: customTableRef(key.slice(7)),
      param: "row",
      noun: "row",
    };
  }
  const t = TABS.find((x) => x.key === key) as (typeof TABS)[number];
  return { ...t, viewTable: t.table };
}

/** `/shows/<id>/<tab>?<param>=<rowId>`: the URL that shows (and focuses) a row. */
export function rowUrl(showId: string, tab: AnyTabKey, rowId?: string | null): string {
  const base = `/shows/${encodeURIComponent(showId)}/${tab}`;
  return rowId ? `${base}?${tabInfo(tab).param}=${encodeURIComponent(rowId)}` : base;
}
