// The show workspace's tabs (routes /shows/:id/<tab>) and their URL row parameter.
import type { TableName } from "../../../shared/tables";

export const TABS = [
  { key: "cues", label: "Cues", table: "cues", param: "cue", noun: "cue" },
  { key: "scenes", label: "Scenes", table: "scenes", param: "scene", noun: "scene" },
  { key: "content", label: "Content", table: "content", param: "content", noun: "content item" },
  { key: "surfaces", label: "Surfaces", table: "surfaces", param: "surface", noun: "surface" },
  { key: "notes", label: "Notes", table: "notes", param: "note", noun: "note" },
  { key: "people", label: "People", table: "persons", param: "person", noun: "person" },
] as const satisfies readonly {
  key: string;
  label: string;
  table: TableName;
  param: string;
  noun: string;
}[];

export type TabKey = (typeof TABS)[number]["key"];

export function tabInfo(key: TabKey) {
  return TABS.find((t) => t.key === key) as (typeof TABS)[number];
}

/** `/shows/<id>/<tab>?<param>=<rowId>`: the URL that shows (and focuses) a row. */
export function rowUrl(showId: string, tab: TabKey, rowId?: string | null): string {
  const base = `/shows/${encodeURIComponent(showId)}/${tab}`;
  return rowId ? `${base}?${tabInfo(tab).param}=${encodeURIComponent(rowId)}` : base;
}
