// The core show tables as both sides see them: field specs (runtime, used for validation on
// the server and optimistic application on the client) and row types.
// Field names are the storage names (snake_case), as in docs/spec/data-model.md.
// Adding a field: see "Adding a field to a core table" in CLAUDE.md.

import type { AnchorState, AnchorStats, PageMapEntry, ScriptSource } from "./script";
import { MAX_LENGTH_M, MAX_LENS_RATIO, MAX_PIXELS } from "./units";

export const TABLE_NAMES = [
  "scenes",
  "cues",
  "content",
  "notes",
  "persons",
  "surfaces",
  "views",
  "content_versions",
  "attachments",
  "scripts",
  "script_versions",
  "cue_anchors",
] as const;
export type TableName = (typeof TABLE_NAMES)[number];

/**
 * The show's data tables: every table but `views` (which holds saved view definitions for
 * them). What import checks for emptiness and what a saved view can be for.
 */
export const DATA_TABLES = ["scenes", "cues", "content", "notes", "persons", "surfaces"] as const;
export type DataTableName = (typeof DATA_TABLES)[number];

export function isDataTable(t: unknown): t is DataTableName {
  return typeof t === "string" && (DATA_TABLES as readonly string[]).includes(t);
}

export const ORDERED_TABLES = ["scenes", "cues", "content", "surfaces"] as const;
export type OrderedTableName = (typeof ORDERED_TABLES)[number];

/**
 * `json`: any JSON value stored as text, validated per field by the op engine.
 * `attachment`: files in R2, one `attachments` row each (not a column; see ATTACHMENT_FIELDS).
 * `measurement`: a length in meters (REAL, ≥ 0; displayed in the active unit, see
 * ./units.ts). `pixel_size`: `{w, h}` positive whole pixels, stored as JSON text.
 */
export type FieldType =
  | "text"
  | "number"
  | "bool"
  | "select"
  | "multiselect"
  | "ref"
  | "json"
  | "attachment"
  | "measurement"
  | "pixel_size";

export interface FieldSpec {
  type: FieldType;
  /** For `ref`: the table the id points into. */
  ref?: TableName;
  /** For `ref`: deleting the target deletes this row (instead of clearing the reference). */
  cascade?: boolean;
  /** Maintained by the server; clients can't write it. */
  auto?: boolean;
  /** Settable on create only (a view's table and owner). */
  immutable?: boolean;
  /** number / measurement: allowed range (the engine refuses values outside it). */
  min?: number;
  /** `min` itself is not allowed (e.g. a lens ratio must be > 0). */
  minExclusive?: boolean;
  max?: number;
  /** number: whole numbers only. */
  integer?: boolean;
}

const text: FieldSpec = { type: "text" };
const number: FieldSpec = { type: "number" };
const bool: FieldSpec = { type: "bool" };
const select: FieldSpec = { type: "select" };
const multiselect: FieldSpec = { type: "multiselect" };
const ref = (table: TableName): FieldSpec => ({ type: "ref", ref: table });
/** Meters, 0–1 km. */
const measurement: FieldSpec = { type: "measurement", min: 0, max: MAX_LENGTH_M };
/** Whole pixels, 1–MAX_PIXELS. */
const pixels: FieldSpec = { type: "number", integer: true, min: 1, max: MAX_PIXELS };

/** Writable (and auto) data fields per table. Excludes the common columns below. */
export const FIELDS = {
  scenes: {
    number: text,
    name: text,
    act: select,
    location: text,
    time_of_day: text,
    song: text,
    stage_direction: text,
    description: text,
    video_overview: text,
  },
  cues: {
    scene_id: ref("scenes"),
    number: text,
    description: text,
    trigger_type: select,
    trigger_value: text,
    sm_call: text,
    lx_cue: text,
    sq_cue: text,
    timecode: text,
    ae_time: text,
    measure: text,
    page: text,
    status: select,
    is_section: bool,
  },
  content: {
    scene_id: ref("scenes"),
    name: text,
    description: text,
    creator_id: ref("persons"),
    status: select,
    loop_in: text,
    loop_out: text,
    duration: text,
    resolution: text,
    frame_rate: number,
    file_path: text,
  },
  notes: {
    body: text,
    type: multiselect,
    priority: select,
    status: select,
    content_id: ref("content"),
    scene_id: ref("scenes"),
    session: text,
    completed_by: { type: "text", auto: true },
    completed_at: { type: "number", auto: true },
  },
  persons: {
    name: text,
    role: text,
    group: select,
    email: text,
    phone: text,
    organization: text,
    user_id: text,
  },
  /**
   * data-model.md §Surface. PPI, pixel pitch, aspect and throw width are computed columns
   * (formulas on the client). `images` (set photos / renders) is an attachment field
   * (ATTACHMENT_FIELDS); the first image is the gallery card's picture.
   */
  surfaces: {
    name: text,
    channel: text,
    /** A surface this one is a region of; the op engine refuses cycles. */
    parent_id: ref("surfaces"),
    width: measurement,
    height: measurement,
    pixel_width: pixels,
    pixel_height: pixels,
    throw_distance: measurement,
    /** Throw ratio (distance ÷ image width): > 0, ≤ 100. */
    lens_ratio: { type: "number", min: 0, minExclusive: true, max: MAX_LENS_RATIO },
    description: text,
  },
  /** Saved views (R16): src/shared/views.ts, CLAUDE.md "Saved views". */
  views: {
    /** The data table the view is for (a DataTableName). */
    table: { type: "text", immutable: true },
    name: text,
    /** null = shared with the show; else the owner's user id (a personal view). */
    owner_user_id: { type: "text", immutable: true },
    /** At most one shared view per table; setting it clears the others (server-side). */
    is_default: bool,
    position: number,
    /** A ViewConfig (JSON). */
    config: { type: "json" },
  },
  /** Content versions (R10). Setting `is_current` clears it on the content's other versions. */
  content_versions: {
    content_id: { type: "ref", ref: "content", cascade: true, immutable: true },
    version: text,
    /** `YYYY-MM-DD`. */
    date: text,
    rendered_by: ref("persons"),
    changes: text,
    file_path: text,
    is_current: bool,
    status: select,
    position: number,
  },
  /**
   * Files in R2 (R13). Created only by the upload route (PUT /attachments/:id); clients may
   * reorder (`position`) and delete. `table`.`field` is one of ATTACHMENT_FIELDS.
   */
  attachments: {
    table: { type: "text", immutable: true },
    record_id: { type: "text", immutable: true },
    field: { type: "text", immutable: true },
    filename: { type: "text", auto: true },
    content_type: { type: "text", auto: true },
    size: { type: "number", auto: true },
    r2_key: { type: "text", auto: true },
    width: { type: "number", auto: true },
    height: { type: "number", auto: true },
    thumb_key: { type: "text", auto: true },
    position: number,
  },
  /**
   * The show's script (R20; one per show). src/shared/script.ts, CLAUDE.md "Script".
   * Changing `current_version_id` updates Cue.page from that version's anchors.
   */
  scripts: {
    title: text,
    current_version_id: ref("script_versions"),
  },
  /**
   * Created only by POST /script/versions (text in R2 at `text_key`); clients may rename
   * (`label`), reorder, set `attachment_id` (the version's own `source_file` upload) and
   * delete. Deleting one deletes its anchors, its file and (after a day) its text.
   */
  script_versions: {
    script_id: { type: "ref", ref: "scripts", cascade: true, immutable: true },
    label: text,
    attachment_id: ref("attachments"),
    imported_at: { type: "number", auto: true },
    source: { type: "text", auto: true },
    confidence: { type: "number", auto: true },
    text_key: { type: "text", auto: true },
    text_bytes: { type: "number", auto: true },
    block_count: { type: "number", auto: true },
    page_count: { type: "number", auto: true },
    /** PageMapEntry[] (src/shared/script.ts). */
    page_map: { type: "json", auto: true },
    /** AnchorStats after re-anchoring. */
    stats: { type: "json", auto: true },
    position: number,
  },
  /**
   * A cue's place in one script version (decision 0004). `page` is derived from `block`
   * by the engine (whatever the client sends is replaced). Block/offset/length may be null
   * only when `state` is "missing". One per cue and version.
   */
  cue_anchors: {
    cue_id: { type: "ref", ref: "cues", cascade: true, immutable: true },
    script_version_id: { type: "ref", ref: "script_versions", cascade: true, immutable: true },
    block: { type: "number", integer: true, min: 0 },
    offset: { type: "number", integer: true, min: 0 },
    length: { type: "number", integer: true, min: 0 },
    quote: text,
    prefix: text,
    suffix: text,
    page: { type: "number", integer: true, min: 1 },
    state: select,
    confidence: { type: "number", min: 0, max: 1 },
  },
} as const satisfies Record<TableName, Record<string, FieldSpec>>;

export type FieldName<T extends TableName> = keyof (typeof FIELDS)[T] & string;

/** Columns every core row has, maintained by the server. */
export const COMMON_COLUMNS = [
  "id",
  "custom",
  "created_at",
  "created_by",
  "updated_at",
  "updated_by",
] as const;

export function isOrderedTable(t: string): t is OrderedTableName {
  return (ORDERED_TABLES as readonly string[]).includes(t);
}

export function isTableName(t: unknown): t is TableName {
  return typeof t === "string" && (TABLE_NAMES as readonly string[]).includes(t);
}

export function fieldSpec(table: TableName, field: string): FieldSpec | undefined {
  return Object.hasOwn(FIELDS[table], field)
    ? (FIELDS[table] as Record<string, FieldSpec>)[field]
    : undefined;
}

/** Custom field values: a JSON object keyed by custom field id. */
export type CustomValues = Record<string, Json>;

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

interface CommonRow {
  id: string;
  custom: CustomValues;
  created_at: number;
  created_by: string;
  updated_at: number;
  updated_by: string;
}

interface Ordered {
  order_key: string;
}

export interface SceneRow extends CommonRow, Ordered {
  number: string | null;
  name: string | null;
  act: string | null;
  location: string | null;
  time_of_day: string | null;
  song: string | null;
  stage_direction: string | null;
  description: string | null;
  video_overview: string | null;
}

export interface CueRow extends CommonRow, Ordered {
  scene_id: string | null;
  number: string | null;
  description: string | null;
  trigger_type: string | null;
  trigger_value: string | null;
  sm_call: string | null;
  lx_cue: string | null;
  sq_cue: string | null;
  timecode: string | null;
  ae_time: string | null;
  measure: string | null;
  page: string | null;
  status: string | null;
  is_section: boolean;
}

export interface ContentRow extends CommonRow, Ordered {
  scene_id: string | null;
  name: string | null;
  description: string | null;
  creator_id: string | null;
  status: string | null;
  loop_in: string | null;
  loop_out: string | null;
  duration: string | null;
  resolution: string | null;
  frame_rate: number | null;
  file_path: string | null;
}

export interface NoteRow extends CommonRow {
  body: string | null;
  /** Multi-select: option values, in the order chosen. */
  type: string[];
  priority: string | null;
  status: string | null;
  content_id: string | null;
  scene_id: string | null;
  session: string | null;
  completed_by: string | null;
  completed_at: number | null;
}

export interface PersonRow extends CommonRow {
  name: string | null;
  role: string | null;
  group: string | null;
  email: string | null;
  phone: string | null;
  organization: string | null;
  user_id: string | null;
}

export interface SurfaceRow extends CommonRow, Ordered {
  name: string | null;
  channel: string | null;
  parent_id: string | null;
  /** Meters. */
  width: number | null;
  /** Meters. */
  height: number | null;
  pixel_width: number | null;
  pixel_height: number | null;
  /** Meters. */
  throw_distance: number | null;
  /** Throw ratio: distance ÷ image width. */
  lens_ratio: number | null;
  description: string | null;
}

export interface ViewRow extends CommonRow {
  table: DataTableName;
  name: string | null;
  owner_user_id: string | null;
  is_default: boolean;
  position: number | null;
  /** A ViewConfig (src/shared/views.ts); read it through `normalizeViewConfig`. */
  config: Json;
}

export interface ContentVersionRow extends CommonRow {
  content_id: string;
  version: string | null;
  date: string | null;
  rendered_by: string | null;
  changes: string | null;
  file_path: string | null;
  is_current: boolean;
  status: string | null;
  position: number | null;
}

export interface AttachmentRow extends CommonRow {
  table: string;
  record_id: string;
  field: string;
  filename: string;
  content_type: string;
  size: number;
  r2_key: string;
  width: number | null;
  height: number | null;
  thumb_key: string | null;
  position: number | null;
}

export interface ScriptRow extends CommonRow {
  title: string | null;
  current_version_id: string | null;
}

export interface ScriptVersionRow extends CommonRow {
  script_id: string;
  label: string | null;
  /** The original file (an attachment on this version's `source_file` field). */
  attachment_id: string | null;
  imported_at: number | null;
  source: ScriptSource | null;
  confidence: number | null;
  /** R2 key of the gzipped ScriptText; fetch it via `scriptTextUrl`. */
  text_key: string | null;
  text_bytes: number | null;
  block_count: number | null;
  page_count: number | null;
  page_map: PageMapEntry[];
  /** Counts by state after re-anchoring ({} for the first version). */
  stats: Partial<AnchorStats>;
  position: number | null;
}

export interface CueAnchorRow extends CommonRow {
  cue_id: string;
  script_version_id: string;
  block: number | null;
  offset: number | null;
  length: number | null;
  quote: string | null;
  prefix: string | null;
  suffix: string | null;
  /** Physical page (1-based), derived from `block`; its label is in the version's page_map. */
  page: number | null;
  state: AnchorState | null;
  confidence: number | null;
}

export interface RowTypes {
  scenes: SceneRow;
  cues: CueRow;
  content: ContentRow;
  notes: NoteRow;
  persons: PersonRow;
  surfaces: SurfaceRow;
  views: ViewRow;
  content_versions: ContentVersionRow;
  attachments: AttachmentRow;
  scripts: ScriptRow;
  script_versions: ScriptVersionRow;
  cue_anchors: CueAnchorRow;
}

/**
 * Attachment fields per table (`attachments.table` → field names → spec). Files live in the
 * `attachments` table (one row per file, `field` naming which of these it belongs to);
 * deleting the record deletes them. Adding one: CLAUDE.md "Attachments".
 */
export const ATTACHMENT_FIELDS: Partial<Record<TableName, Record<string, FieldSpec>>> = {
  content: { attachments: { type: "attachment" } },
  notes: { attachments: { type: "attachment" } },
  surfaces: { images: { type: "attachment" } },
  /** The script file as received (PDF / DOCX / text), kept for reference and print. */
  script_versions: { source_file: { type: "attachment" } },
};

export function isAttachmentField(table: string, field: string): boolean {
  const fields = Object.hasOwn(ATTACHMENT_FIELDS, table)
    ? ATTACHMENT_FIELDS[table as TableName]
    : undefined;
  return !!fields && Object.hasOwn(fields, field);
}

export type Row<T extends TableName> = RowTypes[T];
export type AnyRow = RowTypes[TableName];

/** Many-to-many link fields: `<table>.<field>` → join table. Chip order is `position`. */
export const LINKS = {
  "cues.content": {
    join: "cue_content",
    from: "cues",
    fromCol: "cue_id",
    to: "content",
    toCol: "content_id",
    key: "cueContent",
  },
  "cues.assignees": {
    join: "cue_assignees",
    from: "cues",
    fromCol: "cue_id",
    to: "persons",
    toCol: "person_id",
    key: "cueAssignees",
  },
  "notes.cues": {
    join: "note_cues",
    from: "notes",
    fromCol: "note_id",
    to: "cues",
    toCol: "cue_id",
    key: "noteCues",
  },
  "notes.assignees": {
    join: "note_assignees",
    from: "notes",
    fromCol: "note_id",
    to: "persons",
    toCol: "person_id",
    key: "noteAssignees",
  },
  "scenes.surfaces": {
    join: "scene_surfaces",
    from: "scenes",
    fromCol: "scene_id",
    to: "surfaces",
    toCol: "surface_id",
    key: "sceneSurfaces",
  },
  "content.surfaces": {
    join: "content_surfaces",
    from: "content",
    fromCol: "content_id",
    to: "surfaces",
    toCol: "surface_id",
    key: "contentSurfaces",
  },
} as const satisfies Record<
  string,
  {
    join: string;
    from: TableName;
    fromCol: string;
    to: TableName;
    toCol: string;
    key: string;
  }
>;

export type LinkName = keyof typeof LINKS;
export type LinkSpec = (typeof LINKS)[LinkName];
export type JoinKey = LinkSpec["key"];

export function linkSpec(table: string, field: string): LinkSpec | undefined {
  const name = `${table}.${field}`;
  return Object.hasOwn(LINKS, name) ? LINKS[name as LinkName] : undefined;
}

/** Select options per `<table>.<field>`, in display order. `color` is an --option-* name. */
export interface FieldOption {
  value: string;
  color: string;
}
export type FieldOptions = Record<`${TableName}.${string}`, FieldOption[]>;

export const OPTION_COLORS = [
  "gray",
  "red",
  "orange",
  "yellow",
  "green",
  "teal",
  "blue",
  "purple",
  "pink",
] as const;
