// ShowDO SQLite: one database per show, living inside that show's Durable Object.
// After editing, run `pnpm db:generate`; migrations are applied in the DO constructor.
// Column names are the storage names from docs/spec/data-model.md and match the field specs
// in src/shared/tables.ts (keep the two in step; see CLAUDE.md "Adding a field").
// Writes go through the op engine (src/worker/do/ops-engine.ts), not Drizzle.
import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Single row (id = 1) describing the show this object holds. */
export const meta = sqliteTable("meta", {
  id: integer("id").primaryKey(),
  showId: text("show_id").notNull(),
  name: text("name").notNull(),
  createdAt: integer("created_at").notNull(),
  /**
   * Display unit for measurement fields when neither the view nor the user picks one
   * (a Unit from src/shared/units.ts; null = meters). Written by the `meta` op.
   */
  default_unit: text("default_unit"),
});

/** Columns on every core table. `custom` is a JSON object of custom field values. */
const common = () => ({
  id: text("id").primaryKey(),
  custom: text("custom").notNull().default("{}"),
  created_at: integer("created_at").notNull(),
  created_by: text("created_by").notNull(),
  updated_at: integer("updated_at").notNull(),
  updated_by: text("updated_by").notNull(),
});

export const scenes = sqliteTable(
  "scenes",
  {
    ...common(),
    order_key: text("order_key").notNull(),
    number: text("number"),
    name: text("name"),
    act: text("act"),
    location: text("location"),
    time_of_day: text("time_of_day"),
    song: text("song"),
    stage_direction: text("stage_direction"),
    description: text("description"),
    video_overview: text("video_overview"),
  },
  (t) => [index("scenes_order_idx").on(t.order_key)],
);

export const persons = sqliteTable("persons", {
  ...common(),
  name: text("name"),
  role: text("role"),
  group: text("group"),
  email: text("email"),
  phone: text("phone"),
  organization: text("organization"),
  /** D1 users.id when this person has an account. */
  user_id: text("user_id"),
});

export const cues = sqliteTable(
  "cues",
  {
    ...common(),
    order_key: text("order_key").notNull(),
    scene_id: text("scene_id").references(() => scenes.id, { onDelete: "set null" }),
    /** Text, not a number: "0.10", "8.5A" must survive. */
    number: text("number"),
    description: text("description"),
    trigger_type: text("trigger_type"),
    trigger_value: text("trigger_value"),
    sm_call: text("sm_call"),
    lx_cue: text("lx_cue"),
    sq_cue: text("sq_cue"),
    timecode: text("timecode"),
    ae_time: text("ae_time"),
    measure: text("measure"),
    page: text("page"),
    status: text("status"),
    is_section: integer("is_section").notNull().default(0),
  },
  (t) => [index("cues_order_idx").on(t.order_key), index("cues_scene_idx").on(t.scene_id)],
);

export const content = sqliteTable(
  "content",
  {
    ...common(),
    order_key: text("order_key").notNull(),
    scene_id: text("scene_id").references(() => scenes.id, { onDelete: "set null" }),
    name: text("name"),
    description: text("description"),
    creator_id: text("creator_id").references(() => persons.id, { onDelete: "set null" }),
    status: text("status"),
    loop_in: text("loop_in"),
    loop_out: text("loop_out"),
    duration: text("duration"),
    resolution: text("resolution"),
    frame_rate: real("frame_rate"),
    file_path: text("file_path"),
  },
  (t) => [index("content_order_idx").on(t.order_key), index("content_scene_idx").on(t.scene_id)],
);

export const notes = sqliteTable(
  "notes",
  {
    ...common(),
    body: text("body"),
    /** Multi-select: JSON array of option values. */
    type: text("type").notNull().default("[]"),
    priority: text("priority"),
    status: text("status"),
    content_id: text("content_id").references(() => content.id, { onDelete: "set null" }),
    scene_id: text("scene_id").references(() => scenes.id, { onDelete: "set null" }),
    session: text("session"),
    completed_by: text("completed_by"),
    completed_at: integer("completed_at"),
  },
  (t) => [index("notes_created_idx").on(t.created_at)],
);

/**
 * Projection surfaces, LED walls and regions of them (data-model.md §Surface). Lengths are
 * meters (measurement fields); PPI, pixel pitch, aspect and throw width are computed on the
 * client (src/web/features/surfaces/formulas.ts). `images` (attachments) arrive with M3a.
 */
export const surfaces = sqliteTable(
  "surfaces",
  {
    ...common(),
    order_key: text("order_key").notNull(),
    name: text("name"),
    /** Millumin channel/layer, "CH02.1". */
    channel: text("channel"),
    /** The surface this is a region of (no cycles; the op engine checks). */
    parent_id: text("parent_id"),
    width: real("width"),
    height: real("height"),
    pixel_width: real("pixel_width"),
    pixel_height: real("pixel_height"),
    throw_distance: real("throw_distance"),
    lens_ratio: real("lens_ratio"),
    description: text("description"),
  },
  (t) => [
    index("surfaces_order_idx").on(t.order_key),
    index("surfaces_parent_idx").on(t.parent_id),
  ],
);

// Join tables for many-to-many links. `position` keeps chip order stable.
export const cue_content = sqliteTable(
  "cue_content",
  {
    cue_id: text("cue_id")
      .notNull()
      .references(() => cues.id, { onDelete: "cascade" }),
    content_id: text("content_id")
      .notNull()
      .references(() => content.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.cue_id, t.content_id] }),
    index("cue_content_content_idx").on(t.content_id),
  ],
);

export const cue_assignees = sqliteTable(
  "cue_assignees",
  {
    cue_id: text("cue_id")
      .notNull()
      .references(() => cues.id, { onDelete: "cascade" }),
    person_id: text("person_id")
      .notNull()
      .references(() => persons.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.cue_id, t.person_id] }),
    index("cue_assignees_person_idx").on(t.person_id),
  ],
);

export const note_cues = sqliteTable(
  "note_cues",
  {
    note_id: text("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    cue_id: text("cue_id")
      .notNull()
      .references(() => cues.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
  },
  (t) => [primaryKey({ columns: [t.note_id, t.cue_id] }), index("note_cues_cue_idx").on(t.cue_id)],
);

export const note_assignees = sqliteTable(
  "note_assignees",
  {
    note_id: text("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    person_id: text("person_id")
      .notNull()
      .references(() => persons.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.note_id, t.person_id] }),
    index("note_assignees_person_idx").on(t.person_id),
  ],
);

export const scene_surfaces = sqliteTable(
  "scene_surfaces",
  {
    scene_id: text("scene_id")
      .notNull()
      .references(() => scenes.id, { onDelete: "cascade" }),
    surface_id: text("surface_id")
      .notNull()
      .references(() => surfaces.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.scene_id, t.surface_id] }),
    index("scene_surfaces_surface_idx").on(t.surface_id),
  ],
);

export const content_surfaces = sqliteTable(
  "content_surfaces",
  {
    content_id: text("content_id")
      .notNull()
      .references(() => content.id, { onDelete: "cascade" }),
    surface_id: text("surface_id")
      .notNull()
      .references(() => surfaces.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.content_id, t.surface_id] }),
    index("content_surfaces_surface_idx").on(t.surface_id),
  ],
);

/**
 * Saved views (R16/R17). `config` is a JSON ViewConfig (src/shared/views.ts). Shared views
 * have `owner_user_id` null; personal ones belong to that user. The DO gives a data table
 * with no shared view (a show created before views existed) its default view when it
 * starts; the op engine refuses to delete a table's last shared view.
 */
export const views = sqliteTable(
  "views",
  {
    ...common(),
    table: text("table").notNull(),
    name: text("name"),
    owner_user_id: text("owner_user_id"),
    is_default: integer("is_default").notNull().default(0),
    position: real("position"),
    config: text("config").notNull().default("{}"),
  },
  (t) => [index("views_table_idx").on(t.table)],
);

/** Per-show select options (`table.field` → values). Seeded by migration 0002. */
export const field_options = sqliteTable(
  "field_options",
  {
    table: text("table").notNull(),
    field: text("field").notNull(),
    value: text("value").notNull(),
    color: text("color").notNull(),
    position: integer("position").notNull(),
  },
  (t) => [primaryKey({ columns: [t.table, t.field, t.value] })],
);

/**
 * Change history: one row per changed field (create/delete: one row with field "*").
 * A batch's version is the highest `version` it wrote.
 */
export const changes = sqliteTable(
  "changes",
  {
    version: integer("version").primaryKey({ autoIncrement: true }),
    ts: integer("ts").notNull(),
    user_id: text("user_id").notNull(),
    table: text("table").notNull(),
    record_id: text("record_id").notNull(),
    field: text("field").notNull(),
    /** JSON-encoded; null = absent. */
    old: text("old"),
    new: text("new"),
    client_id: text("client_id"),
  },
  (t) => [index("changes_record_idx").on(t.table, t.record_id)],
);
