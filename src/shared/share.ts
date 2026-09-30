// Read-only share links (R23): what a link shows and which of the show's data it may see.
// The Worker enforces the scope (snapshot, WebSocket ops, attachments); the web client
// renders `/s/<token>` from the link's target. Pure: used by both sides.
import { DATA_TABLES, type DataTableName, type TableName } from "./tables";

export type ShareKind = "view" | "print";

/**
 * Built-in layouts a link can show instead of a saved view (`print` links). The table is
 * the one the layout reads first.
 */
export const SHARE_PRESETS = {
  "calling-script": { table: "cues", label: "Calling script" },
  cuesheet: { table: "cues", label: "SM cue sheet" },
  "by-person": { table: "notes", label: "Notes by person" },
  "by-cue": { table: "notes", label: "Notes by cue" },
  content: { table: "content", label: "Content list" },
  surfaces: { table: "surfaces", label: "Surface sheet" },
} as const satisfies Record<string, { table: DataTableName; label: string }>;

export type SharePreset = keyof typeof SHARE_PRESETS;

export function isSharePreset(v: unknown): v is SharePreset {
  return typeof v === "string" && Object.hasOwn(SHARE_PRESETS, v);
}

/** Preset options kept with a link (the print page's query parameters). */
export interface ShareOptions {
  session?: string;
  orient?: "landscape" | "portrait";
}

export interface ShareLinkDTO {
  id: string;
  kind: ShareKind;
  table: DataTableName;
  viewId: string | null;
  preset: SharePreset | null;
  options: ShareOptions;
  label: string | null;
  createdBy: string;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  lastUsedAt: number | null;
}

/** POST /api/shows/:id/share-links (owner). */
export interface CreateShareLinkRequest {
  kind: ShareKind;
  table: DataTableName;
  viewId?: string | null;
  preset?: SharePreset | null;
  options?: ShareOptions;
  label?: string | null;
  /** Epoch ms; null/absent: no expiry. */
  expiresAt?: number | null;
}

export interface CreateShareLinkResponse {
  link: ShareLinkDTO;
  /** `/s/<token>`: shown once (only the token's hash is stored). */
  path: string;
}

export interface ShareLinksResponse {
  links: ShareLinkDTO[];
}

/** GET /api/share/:token: what the link shows (and a cookie for the show's data routes). */
export interface ShareInfoResponse {
  link: Pick<ShareLinkDTO, "id" | "kind" | "table" | "viewId" | "preset" | "options" | "label">;
  show: { id: string; name: string; currentSession: string | null };
}

export const MAX_SHARE_LABEL = 200;

/** Tables a grid of `table` reads to label its links (scene names, content chips, …). */
const RELATED: Record<DataTableName, readonly TableName[]> = {
  cues: ["scenes", "content", "content_versions", "persons"],
  scenes: ["surfaces", "content", "cues"],
  content: ["scenes", "content_versions", "cues", "persons", "surfaces"],
  notes: ["cues", "scenes", "content", "persons"],
  persons: [],
  surfaces: ["scenes", "content", "cues"],
};

const PRESET_TABLES: Record<SharePreset, readonly TableName[]> = {
  "calling-script": ["cues", "scenes", "persons", "scripts", "script_versions", "cue_anchors"],
  cuesheet: ["cues", "scenes"],
  "by-person": ["notes", "persons", "cues", "scenes", "content"],
  "by-cue": ["notes", "persons", "cues", "scenes", "content"],
  content: ["content", "content_versions", "scenes", "cues", "surfaces", "attachments"],
  surfaces: ["surfaces", "attachments"],
};

/** What one share link may read. Computed from the link; carried by its sockets. */
export interface ShareScope {
  linkId: string;
  showId: string;
  /** Tables whose rows the link sees (everything else is empty). */
  tables: TableName[];
  /** Attachments are visible only when they belong to rows of these tables. */
  attachmentTables: TableName[];
  /**
   * Views visible: this view id, or (null) the shared default views of `viewTable`. No
   * views for presets.
   */
  viewId: string | null;
  viewTable: DataTableName | null;
}

export function shareScope(link: {
  id: string;
  showId: string;
  table: string;
  viewId: string | null;
  preset: string | null;
}): ShareScope {
  const table = (DATA_TABLES as readonly string[]).includes(link.table)
    ? (link.table as DataTableName)
    : null;
  if (isSharePreset(link.preset)) {
    const tables = [...PRESET_TABLES[link.preset]];
    const main = SHARE_PRESETS[link.preset].table;
    return {
      linkId: link.id,
      showId: link.showId,
      tables,
      attachmentTables: tables.includes("attachments") ? [main] : [],
      viewId: null,
      viewTable: null,
    };
  }
  if (!table) {
    return {
      linkId: link.id,
      showId: link.showId,
      tables: [],
      attachmentTables: [],
      viewId: null,
      viewTable: null,
    };
  }
  return {
    linkId: link.id,
    showId: link.showId,
    tables: [table, ...RELATED[table], "views", "attachments"],
    attachmentTables: [table],
    viewId: link.viewId,
    viewTable: table,
  };
}

/** `/s/<token>`. */
export function sharePath(token: string): string {
  return `/s/${encodeURIComponent(token)}`;
}
