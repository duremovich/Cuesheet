// Which Airtable CSV is which, and which of its columns Cuesheet maps (R25). Shared by the
// importer (src/worker/import/airtable.ts) and the import preview in the browser, which
// offers "Create custom field" for the columns listed nowhere here, and a custom table
// for a CSV that isn't one of the core tables. Pure; no CSV parsing here.
import type { CustomFieldType } from "./custom-fields";

export type ImportKind = "scenes" | "persons" | "content" | "cues" | "notes" | "surfaces";

export const IMPORT_KIND_LABELS: Record<ImportKind, string> = {
  scenes: "Breakdown → Scenes",
  persons: "Personnel → People",
  content: "Content",
  cues: "Cue List → Cues",
  notes: "Notes",
  surfaces: "Surfaces",
};

const FILENAME_PREFIXES: [string, ImportKind][] = [
  ["breakdown", "scenes"],
  ["personnel", "persons"],
  ["content", "content"],
  ["cue list", "cues"],
  ["notes", "notes"],
  ["surfaces", "surfaces"],
];

/** Columns each core import reads (data-model.md §Mapping from the Airtable base). */
export const MAPPED_COLUMNS: Record<ImportKind, readonly string[]> = {
  scenes: [
    "Scene Name",
    "Location",
    "Time of Day",
    "Song Name",
    "Top of Scene Stage Direction",
    "Scene Description",
    "Video Overview",
    "Surfaces",
  ],
  persons: ["Name", "Role", "Email", "Photo", "Theatre", "Cast"],
  content: ["Name", "Version", "Scene", "Creator", "LOOP IN", "LOOP OUT"],
  cues: [
    "Cue Number",
    "PG",
    "SM Call",
    "LX",
    "Timecode",
    "AE Time",
    "MSR",
    "Description",
    "STATUS",
    "Assignee",
    "Content",
  ],
  notes: [
    "Note",
    "Scene Name",
    "Cue #",
    "TYPE",
    "Done",
    "Priority",
    "Content",
    "In Progress",
    "Assigned To",
    "Created Time",
    "Photo",
    "created by",
  ],
  surfaces: ["Name", "Channel Name"],
};

/** Lookups / rollups / reverse links in Airtable: Cuesheet derives them, never imports them. */
export const DERIVED_COLUMNS: Record<ImportKind, readonly string[]> = {
  scenes: ["Video Content", "Notes"],
  persons: ["Scenes", "Notes"],
  content: ["Cue List", "Content Notes"],
  cues: ["Content Notes"],
  notes: [],
  surfaces: [],
};

/** Which table a CSV holds, from its file name (Airtable's `<Table>-<View>.csv`) or headers. */
export function detectKind(fileName: string, headers: readonly string[]): ImportKind | null {
  const base = (fileName.split(/[\\/]/).at(-1) ?? "").toLowerCase();
  for (const [prefix, kind] of FILENAME_PREFIXES) {
    if (base.startsWith(`${prefix}-`) || base === `${prefix}.csv`) return kind;
  }
  const h = new Set(headers);
  if (h.has("Cue Number")) return "cues";
  if (h.has("Note") && h.has("Cue #")) return "notes";
  if (h.has("Scene Name") && h.has("Location")) return "scenes";
  if (h.has("Name") && (h.has("Creator") || h.has("LOOP IN"))) return "content";
  if (h.has("Name") && h.has("Role")) return "persons";
  if (h.has("Name") && h.has("Channel Name")) return "surfaces";
  return null;
}

/** Headers of a core CSV that Cuesheet neither maps nor derives (custom field candidates). */
export function unmappedColumns(kind: ImportKind, headers: readonly string[]): string[] {
  const known = new Set([...MAPPED_COLUMNS[kind], ...DERIVED_COLUMNS[kind]]);
  return headers.filter((h) => {
    const t = h.trim();
    if (!t || known.has(t)) return false;
    // Surfaces: any "Width (…)" / "Height (…)" header is mapped.
    if (kind === "surfaces" && /^(width|height)\b/i.test(t)) return false;
    return true;
  });
}

/** A custom table's name from a CSV file name: "Network-Grid view.csv" → "Network". */
export function tableLabelFromFile(fileName: string): string {
  const base = (fileName.split(/[\\/]/).at(-1) ?? "").replace(/\.csv$/i, "");
  const dash = base.lastIndexOf("-");
  const name = (dash > 0 ? base.slice(0, dash) : base).trim();
  return name || "Imported table";
}

/**
 * What the import preview decided (the `mapping` form field of POST /import/airtable).
 * `columns`: unmapped columns of core CSVs to import as new custom fields. `tables`: per
 * other CSV, the custom table's name, field types, or skip. Anything not mentioned: core
 * columns are ignored (as before), other CSVs become custom tables with guessed types.
 */
export interface ImportMapping {
  columns?: { file: string; column: string; label?: string; type: CustomFieldType }[];
  tables?: {
    file: string;
    label?: string;
    skip?: boolean;
    /** Column → type (overrides the guess). */
    types?: Record<string, CustomFieldType>;
  }[];
}
