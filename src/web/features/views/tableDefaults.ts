// Per-table facts the view layer needs about each tab: which field the tab's own `groups`
// are grouped by (so a view grouping by it uses them, with their subtitles and
// Unassigned-first rule) and which readonly columns hold timestamps.
import type { DataTableName } from "../../../shared/tables";

export const NATIVE_GROUP_KEY: Partial<Record<DataTableName, string>> = {
  cues: "scene",
  content: "scene",
  notes: "status",
};

export const DATE_FIELDS: Partial<Record<DataTableName, readonly string[]>> = {
  notes: ["created_at"],
};
