// The core show tables as both sides see them: field specs (runtime, used for validation on
// the server and optimistic application on the client) and row types.
// Field names are the storage names (snake_case), as in docs/spec/data-model.md.
// Adding a field: see "Adding a field to a core table" in CLAUDE.md.

export const TABLE_NAMES = ["scenes", "cues", "content", "notes", "persons", "views"] as const;
export type TableName = (typeof TABLE_NAMES)[number];

/**
 * The show's data tables: every table but `views` (which holds saved view definitions for
 * them). What import checks for emptiness and what a saved view can be for.
 */
export const DATA_TABLES = ["scenes", "cues", "content", "notes", "persons"] as const;
export type DataTableName = (typeof DATA_TABLES)[number];

export function isDataTable(t: unknown): t is DataTableName {
  return typeof t === "string" && (DATA_TABLES as readonly string[]).includes(t);
}

export const ORDERED_TABLES = ["scenes", "cues", "content"] as const;
export type OrderedTableName = (typeof ORDERED_TABLES)[number];

/** `json`: any JSON value stored as text, validated per field by the op engine. */
export type FieldType = "text" | "number" | "bool" | "select" | "multiselect" | "ref" | "json";

export interface FieldSpec {
  type: FieldType;
  /** For `ref`: the table the id points into. */
  ref?: TableName;
  /** Maintained by the server; clients can't write it. */
  auto?: boolean;
  /** Settable on create only (a view's table and owner). */
  immutable?: boolean;
}

const text: FieldSpec = { type: "text" };
const number: FieldSpec = { type: "number" };
const bool: FieldSpec = { type: "bool" };
const select: FieldSpec = { type: "select" };
const multiselect: FieldSpec = { type: "multiselect" };
const ref = (table: TableName): FieldSpec => ({ type: "ref", ref: table });

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

export interface ViewRow extends CommonRow {
  table: DataTableName;
  name: string | null;
  owner_user_id: string | null;
  is_default: boolean;
  position: number | null;
  /** A ViewConfig (src/shared/views.ts); read it through `normalizeViewConfig`. */
  config: Json;
}

export interface RowTypes {
  scenes: SceneRow;
  cues: CueRow;
  content: ContentRow;
  notes: NoteRow;
  persons: PersonRow;
  views: ViewRow;
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
