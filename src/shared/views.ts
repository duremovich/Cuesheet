// Saved views (R16, R17): the config a `views` row stores, its validation (server) and
// normalisation (client), and the default view each data table starts with.
// Filters, sorts, grouping and color rules are evaluated on the client, over the grid's
// columns (src/web/features/views/). See CLAUDE.md "Saved views".
import { type CustomFieldDef, customColumnKey, customFieldKind } from "./custom-fields";
import { type DataTableName, isDataTable, OPTION_COLORS, type ViewTable } from "./tables";
import { isUnit, UNITS, type Unit } from "./units";

export type OptionColor = (typeof OPTION_COLORS)[number];

export const FILTER_OPS = [
  "is",
  "isNot",
  "contains",
  "notContains",
  "isEmpty",
  "isNotEmpty",
  "gt",
  "lt",
  "gte",
  "lte",
  "before",
  "after",
  "anyOf",
  "noneOf",
  "isTrue",
  "isFalse",
] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

/** Ops that take no value. */
export const VALUELESS_OPS: ReadonlySet<FilterOp> = new Set([
  "isEmpty",
  "isNotEmpty",
  "isTrue",
  "isFalse",
]);
/** Ops whose value is a list of strings. */
export const LIST_OPS: ReadonlySet<FilterOp> = new Set(["anyOf", "noneOf"]);

export interface Filter {
  /** A column key of the table's grid (or one of its extra filter fields). */
  key: string;
  op: FilterOp;
  /**
   * string (text, select value, date `YYYY-MM-DD`, a linked record's **id** for link
   * fields; `contains` on a link matches its label), number, or string[] (ids for links).
   */
  value?: unknown;
  /** Link filters: record id → label when picked, for display (the id does the matching). */
  labels?: Record<string, string>;
}

export type MatchMode = "and" | "or";

export interface ColorRule {
  when: Filter[];
  mode: MatchMode;
  target: "row" | { cell: string };
  color: OptionColor;
}

export interface ViewSort {
  key: string;
  dir: "asc" | "desc";
}

export interface ViewField {
  key: string;
  width?: number;
  hidden?: boolean;
}

export type RowHeightName = "compact" | "normal" | "tall";

export interface ViewConfig {
  filters: Filter[];
  filterMode: MatchMode;
  sorts: ViewSort[];
  /** `live`: the grid keeps rows sorted by `sorts` (R2); `none`: show order. */
  sortMode: "live" | "none";
  /** A select/link column key, or null for no grouping. */
  group: { key: string | null; collapsedByDefault?: boolean };
  /**
   * Column order, widths and hidden flags. Columns not listed keep their default place
   * (after the listed ones) and are shown, so new fields appear in old views.
   */
  fields: ViewField[];
  rowHeight: RowHeightName;
  /** The first N visible columns stay put on horizontal scroll. */
  frozenCount: number;
  /** In order: the first matching row rule wins; cell rules stack. */
  colorRules: ColorRule[];
  /**
   * A viewer's/commenter's personal copy of a shared view: that view's id, so further
   * changes reuse the copy instead of making another.
   */
  forkedFrom?: string;
  /** How rows are shown (R19): the grid (default, stored as absent) or gallery cards. */
  layout?: ViewLayout;
  /**
   * The view's unit override for measurement columns (set only in Fields → Unit override;
   * the toolbar toggle sets the user's own unit). Unset: the user's unit, else the show's default (R11).
   */
  unit?: Unit;
}

export type ViewLayout = "grid" | "gallery";

export const MAX_FILTERS = 50;
export const MAX_COLOR_RULES = 50;
export const MAX_FIELDS = 200;
/** Personal views per user and table (the server refuses more). */
export const MAX_PERSONAL_VIEWS = 50;
const MAX_KEY = 64;
const MAX_VALUE_CHARS = 1000;
const MAX_LIST = 200;
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isKey = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= MAX_KEY;
const isColor = (v: unknown): v is OptionColor =>
  typeof v === "string" && (OPTION_COLORS as readonly string[]).includes(v);
const isMode = (v: unknown): v is MatchMode => v === "and" || v === "or";

function filterError(f: unknown, where: string): string | null {
  if (!isObject(f)) return `${where} must be an object`;
  if (!isKey(f.key)) return `${where}.key must be a field key`;
  if (!(FILTER_OPS as readonly string[]).includes(f.op as string)) {
    return `${where}.op is not a filter operator`;
  }
  if (f.labels !== undefined) {
    if (!isObject(f.labels)) return `${where}.labels must be an object`;
    const entries = Object.entries(f.labels);
    if (entries.length > MAX_LIST) return `${where}.labels has too many entries`;
    for (const [k, l] of entries) {
      if (
        RESERVED_KEYS.has(k) ||
        k.length > MAX_KEY ||
        typeof l !== "string" ||
        l.length > MAX_VALUE_CHARS
      ) {
        return `${where}.labels must map ids to text`;
      }
    }
  }
  const v = f.value;
  if (v === undefined || v === null) return null;
  if (typeof v === "string")
    return v.length <= MAX_VALUE_CHARS ? null : `${where}.value is too long`;
  if (typeof v === "number") return Number.isFinite(v) ? null : `${where}.value must be finite`;
  if (typeof v === "boolean") return null;
  if (Array.isArray(v)) {
    if (v.length > MAX_LIST) return `${where}.value has too many entries`;
    return v.every((x) => typeof x === "string" && x.length <= MAX_VALUE_CHARS)
      ? null
      : `${where}.value must be a list of text`;
  }
  return `${where}.value must be text, a number or a list`;
}

/** Strict check for the server: null when `raw` is a valid ViewConfig, else the reason. */
export function viewConfigError(raw: unknown): string | null {
  if (!isObject(raw)) return "config must be an object";
  const c = raw;
  if (!Array.isArray(c.filters) || c.filters.length > MAX_FILTERS) {
    return `config.filters must be a list of at most ${MAX_FILTERS}`;
  }
  for (const [i, f] of c.filters.entries()) {
    const e = filterError(f, `config.filters[${i}]`);
    if (e) return e;
  }
  if (!isMode(c.filterMode)) return 'config.filterMode must be "and" or "or"';
  if (!Array.isArray(c.sorts) || c.sorts.length > 20) return "config.sorts must be a short list";
  for (const s of c.sorts) {
    if (!isObject(s) || !isKey(s.key) || (s.dir !== "asc" && s.dir !== "desc")) {
      return "config.sorts entries need a key and a dir (asc/desc)";
    }
  }
  if (c.sortMode !== "live" && c.sortMode !== "none") {
    return 'config.sortMode must be "live" or "none"';
  }
  if (!isObject(c.group) || !(c.group.key === null || isKey(c.group.key))) {
    return "config.group.key must be a field key or null";
  }
  if (c.group.collapsedByDefault !== undefined && typeof c.group.collapsedByDefault !== "boolean") {
    return "config.group.collapsedByDefault must be true or false";
  }
  if (!Array.isArray(c.fields) || c.fields.length > MAX_FIELDS) {
    return `config.fields must be a list of at most ${MAX_FIELDS}`;
  }
  const seen = new Set<string>();
  for (const f of c.fields) {
    if (!isObject(f) || !isKey(f.key)) return "config.fields entries need a key";
    if (seen.has(f.key)) return `config.fields lists ${f.key} twice`;
    seen.add(f.key);
    if (
      f.width !== undefined &&
      !(typeof f.width === "number" && Number.isFinite(f.width) && f.width > 0 && f.width < 5000)
    ) {
      return "config.fields width must be a positive number";
    }
    if (f.hidden !== undefined && typeof f.hidden !== "boolean") {
      return "config.fields hidden must be true or false";
    }
  }
  if (c.rowHeight !== "compact" && c.rowHeight !== "normal" && c.rowHeight !== "tall") {
    return "config.rowHeight must be compact, normal or tall";
  }
  if (
    !(typeof c.frozenCount === "number" && Number.isInteger(c.frozenCount)) ||
    c.frozenCount < 0 ||
    c.frozenCount > 10
  ) {
    return "config.frozenCount must be an integer from 0 to 10";
  }
  if (!Array.isArray(c.colorRules) || c.colorRules.length > MAX_COLOR_RULES) {
    return `config.colorRules must be a list of at most ${MAX_COLOR_RULES}`;
  }
  for (const [i, r] of c.colorRules.entries()) {
    const where = `config.colorRules[${i}]`;
    if (!isObject(r)) return `${where} must be an object`;
    if (!Array.isArray(r.when) || r.when.length > MAX_FILTERS)
      return `${where}.when must be a list`;
    for (const [j, f] of r.when.entries()) {
      const e = filterError(f, `${where}.when[${j}]`);
      if (e) return e;
    }
    if (!isMode(r.mode)) return `${where}.mode must be "and" or "or"`;
    if (!(r.target === "row" || (isObject(r.target) && isKey(r.target.cell)))) {
      return `${where}.target must be "row" or {cell: key}`;
    }
    if (!isColor(r.color)) return `${where}.color must be an option color`;
  }
  if (c.forkedFrom !== undefined && !isKey(c.forkedFrom)) {
    return "config.forkedFrom must be a view id";
  }
  if (c.layout !== undefined && c.layout !== "grid" && c.layout !== "gallery") {
    return 'config.layout must be "grid" or "gallery"';
  }
  if (c.unit !== undefined && !isUnit(c.unit)) {
    return `config.unit must be one of ${UNITS.join(", ")}`;
  }
  return null;
}

export function emptyViewConfig(): ViewConfig {
  return {
    filters: [],
    filterMode: "and",
    sorts: [],
    sortMode: "none",
    group: { key: null },
    fields: [],
    rowHeight: "normal",
    frozenCount: 1,
    colorRules: [],
  };
}

/**
 * A usable config from whatever is stored (client side): invalid parts fall back to the
 * defaults instead of failing, so an old or damaged view still opens.
 */
export function normalizeViewConfig(raw: unknown, table?: ViewTable): ViewConfig {
  const base = table ? defaultViewConfig(table) : emptyViewConfig();
  if (!isObject(raw)) return base;
  const pick = <K extends keyof ViewConfig>(key: K, ok: (v: unknown) => boolean): ViewConfig[K] =>
    ok(raw[key]) ? (raw[key] as ViewConfig[K]) : base[key];
  const filtersOk = (v: unknown) =>
    Array.isArray(v) && v.every((f, i) => filterError(f, `f${i}`) === null);
  return {
    filters: pick("filters", filtersOk),
    filterMode: pick("filterMode", isMode),
    sorts: pick(
      "sorts",
      (v) =>
        Array.isArray(v) &&
        v.every((s) => isObject(s) && isKey(s.key) && (s.dir === "asc" || s.dir === "desc")),
    ),
    sortMode: pick("sortMode", (v) => v === "live" || v === "none"),
    group: pick("group", (v) => isObject(v) && (v.key === null || isKey(v.key))),
    fields: pick("fields", (v) => Array.isArray(v) && v.every((f) => isObject(f) && isKey(f.key))),
    rowHeight: pick("rowHeight", (v) => v === "compact" || v === "normal" || v === "tall"),
    frozenCount: pick(
      "frozenCount",
      (v) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 10,
    ),
    colorRules: pick(
      "colorRules",
      (v) =>
        Array.isArray(v) &&
        v.every(
          (r) =>
            isObject(r) &&
            filtersOk(r.when) &&
            isMode(r.mode) &&
            (r.target === "row" || (isObject(r.target) && isKey(r.target.cell))) &&
            isColor(r.color),
        ),
    ),
    ...(isKey(raw.forkedFrom) ? { forkedFrom: raw.forkedFrom } : {}),
    ...(raw.layout === "gallery" ? { layout: "gallery" as const } : {}),
    ...(isUnit(raw.unit) ? { unit: raw.unit } : {}),
  };
}

/** The config of a table's built-in default view (also the fallback when it has none). */
export function defaultViewConfig(table: ViewTable): ViewConfig {
  const c = emptyViewConfig();
  if (!isDataTable(table)) return c; // a custom table: show order, ungrouped
  switch (table) {
    case "cues":
    case "content":
      c.group = { key: "scene" };
      break;
    case "notes":
      c.group = { key: "status" };
      c.frozenCount = 0;
      break;
    case "shots":
      c.group = { key: "group" };
      break;
    case "scenes":
    case "persons":
    case "surfaces":
      break;
  }
  return c;
}

/** Name of the shared default view each data table gets. */
export const DEFAULT_VIEW_NAMES: Record<DataTableName, string> = {
  cues: "All cues",
  scenes: "All scenes",
  content: "All content",
  notes: "All notes",
  persons: "Everyone",
  surfaces: "All surfaces",
  shots: "All shots",
};

/** The default view's name for any view table ("All rows" for a custom table). */
export function defaultViewName(table: ViewTable): string {
  return isDataTable(table) ? DEFAULT_VIEW_NAMES[table] : "All rows";
}

// ---- Per-table fields (what a view may name), shared by server validation and client ----

/**
 * How a field filters and groups (a grid column's type, coarsened). `measurement`: a length
 * in meters; filter values are parsed with units ("4 m", "14'", or a bare number in the
 * view's active unit) and compared in meters.
 */
export type FieldKind =
  | "text"
  | "number"
  | "measurement"
  | "checkbox"
  | "select"
  | "multi"
  | "link"
  | "date";

export const OPS_BY_KIND: Record<FieldKind, readonly FilterOp[]> = {
  text: [
    "contains",
    "notContains",
    "is",
    "isNot",
    "isEmpty",
    "isNotEmpty",
    "gt",
    "gte",
    "lt",
    "lte",
  ],
  number: ["is", "isNot", "gt", "gte", "lt", "lte", "isEmpty", "isNotEmpty"],
  measurement: ["gt", "gte", "lt", "lte", "is", "isNot", "isEmpty", "isNotEmpty"],
  checkbox: ["isTrue", "isFalse"],
  select: ["is", "isNot", "anyOf", "noneOf", "isEmpty", "isNotEmpty"],
  multi: ["is", "isNot", "anyOf", "noneOf", "isEmpty", "isNotEmpty"],
  link: ["is", "isNot", "contains", "notContains", "anyOf", "noneOf", "isEmpty", "isNotEmpty"],
  date: ["before", "after", "isEmpty", "isNotEmpty"],
};

export const GROUPABLE_KINDS: ReadonlySet<FieldKind> = new Set(["select", "multi", "link"]);

/**
 * The fields a view of each table can use: the grid's column keys (in the tabs'
 * `columns.ts`; `views/viewFields.test.ts` keeps the two in step) with their kind, and
 * `extra` fields that aren't columns (filter/color only).
 */
export interface ViewFieldSpec {
  kind: FieldKind;
  /** Not a column: filter / color only. */
  extra?: true;
  /** A text column a view may group by anyway (the shots tab's `group`). */
  groupable?: true;
}

export const VIEW_FIELDS: Record<DataTableName, Record<string, ViewFieldSpec>> = {
  cues: {
    number: { kind: "text" },
    description: { kind: "text" },
    trigger_type: { kind: "select" },
    trigger_value: { kind: "text" },
    sm_call: { kind: "text" },
    lx_cue: { kind: "text" },
    sq_cue: { kind: "text" },
    timecode: { kind: "text" },
    ae_time: { kind: "text" },
    measure: { kind: "text" },
    page: { kind: "text" },
    status: { kind: "select" },
    assignees: { kind: "link" },
    content: { kind: "link" },
    scene: { kind: "link" },
    open_notes: { kind: "number", extra: true },
  },
  notes: {
    body: { kind: "text" },
    attachments: { kind: "text" },
    type: { kind: "multi" },
    priority: { kind: "select" },
    status: { kind: "select" },
    assignees: { kind: "link" },
    cues: { kind: "link" },
    content: { kind: "link" },
    scene: { kind: "link" },
    session: { kind: "text" },
    created_by: { kind: "text" },
    created_at: { kind: "date" },
  },
  content: {
    name: { kind: "text" },
    version: { kind: "text" },
    attachments: { kind: "text" },
    scene: { kind: "link" },
    status: { kind: "select" },
    creator: { kind: "link" },
    description: { kind: "text" },
    loop_in: { kind: "text" },
    loop_out: { kind: "text" },
    cues: { kind: "link" },
    notes: { kind: "text" },
    surfaces: { kind: "link" },
  },
  scenes: {
    number: { kind: "text" },
    name: { kind: "text" },
    act: { kind: "select" },
    location: { kind: "text" },
    time_of_day: { kind: "text" },
    song: { kind: "text" },
    description: { kind: "text" },
    video_overview: { kind: "text" },
    cues: { kind: "text" },
    content_count: { kind: "text" },
    surfaces: { kind: "link" },
  },
  persons: {
    name: { kind: "text" },
    role: { kind: "text" },
    group: { kind: "select" },
    email: { kind: "text" },
    phone: { kind: "text" },
    organization: { kind: "text" },
  },
  surfaces: {
    name: { kind: "text" },
    channel: { kind: "text" },
    images: { kind: "text" },
    parent: { kind: "link" },
    width: { kind: "measurement" },
    height: { kind: "measurement" },
    pixels: { kind: "text" },
    ppi: { kind: "number" },
    pixel_pitch: { kind: "number" },
    aspect_ratio: { kind: "text" },
    throw_distance: { kind: "measurement" },
    lens_ratio: { kind: "number" },
    throw_width: { kind: "measurement" },
    description: { kind: "text" },
    scenes: { kind: "link" },
    content: { kind: "link" },
  },
  shots: {
    number: { kind: "text" },
    group: { kind: "text", groupable: true },
    description: { kind: "text" },
    reference: { kind: "text" },
    framing: { kind: "select" },
    camera: { kind: "text" },
    lens: { kind: "text" },
    resolution: { kind: "text" },
    frame_rate: { kind: "number" },
    duration: { kind: "text" },
    status: { kind: "select" },
    talent: { kind: "link" },
    content: { kind: "link" },
  },
};

/**
 * The fields a view of `table` can name: the table's static VIEW_FIELDS (none for a custom
 * table) plus one `custom.<key>` column per custom field on it (kind by field type).
 */
export function viewFieldsFor(
  table: ViewTable,
  customFields: readonly Pick<CustomFieldDef, "key" | "type">[],
): Record<string, ViewFieldSpec> {
  const out: Record<string, ViewFieldSpec> = isDataTable(table) ? { ...VIEW_FIELDS[table] } : {};
  for (const f of customFields) out[customColumnKey(f.key)] = { kind: customFieldKind(f.type) };
  return out;
}

const NUMERIC_OPS: ReadonlySet<FilterOp> = new Set(["gt", "gte", "lt", "lte"]);
const DATE_OPS: ReadonlySet<FilterOp> = new Set(["before", "after"]);

/**
 * The server's check of a view config for `table`: structurally valid (`viewConfigError`),
 * then every field key known to the table, operators allowed for the field's kind, values
 * shaped for their operator, groupable group fields, no duplicate sort keys, frozenCount
 * within the columns. Returns a config rebuilt from the known keys only (anything else is
 * dropped), or the first error.
 */
export function sanitizeViewConfig(
  table: ViewTable,
  raw: unknown,
  known: Record<string, ViewFieldSpec> = isDataTable(table) ? VIEW_FIELDS[table] : {},
): { config: ViewConfig } | { error: string } {
  const structural = viewConfigError(raw);
  if (structural) return { error: structural };
  const c = dropDeletedCustomFields(raw as ViewConfig, known);
  const kindOf = (key: string) => (Object.hasOwn(known, key) ? known[key]?.kind : undefined);
  const isColumn = (key: string) => Object.hasOwn(known, key) && !known[key]?.extra;
  const columnCount = Object.values(known).filter((f) => !f.extra).length;

  const filter = (f: Filter, where: string): Filter | string => {
    const kind = kindOf(f.key);
    if (!kind) return `${where}: ${table} has no field "${f.key}"`;
    if (!OPS_BY_KIND[kind].includes(f.op)) return `${where}: "${f.op}" doesn't apply to ${f.key}`;
    const v = f.value ?? undefined;
    if (VALUELESS_OPS.has(f.op)) {
      if (v !== undefined) return `${where}: "${f.op}" takes no value`;
    } else if (LIST_OPS.has(f.op)) {
      if (v !== undefined && !Array.isArray(v)) return `${where}: "${f.op}" takes a list`;
    } else if (NUMERIC_OPS.has(f.op)) {
      if (v !== undefined && typeof v !== "number" && typeof v !== "string") {
        return `${where}: "${f.op}" takes a number or text`;
      }
    } else if (DATE_OPS.has(f.op)) {
      if (v !== undefined && typeof v !== "string") return `${where}: "${f.op}" takes a date`;
    } else if (v !== undefined && typeof v !== "string" && typeof v !== "number") {
      return `${where}: "${f.op}" takes one value`;
    }
    return {
      key: f.key,
      op: f.op,
      ...(v !== undefined ? { value: v } : {}),
      ...(kind === "link" && f.labels ? { labels: { ...f.labels } } : {}),
    };
  };

  const filters: Filter[] = [];
  for (const [i, f] of c.filters.entries()) {
    const r = filter(f, `config.filters[${i}]`);
    if (typeof r === "string") return { error: r };
    filters.push(r);
  }
  const sortKeys = new Set<string>();
  for (const s of c.sorts) {
    if (!isColumn(s.key)) return { error: `config.sorts: ${table} has no column "${s.key}"` };
    if (sortKeys.has(s.key)) return { error: `config.sorts lists ${s.key} twice` };
    sortKeys.add(s.key);
  }
  const groupKey = c.group.key;
  if (groupKey !== null) {
    const kind = kindOf(groupKey);
    if (!kind || !isColumn(groupKey)) return { error: `config.group: no column "${groupKey}"` };
    if (!GROUPABLE_KINDS.has(kind) && !known[groupKey]?.groupable) {
      return { error: `config.group: can't group by ${groupKey}` };
    }
  }
  for (const f of c.fields) {
    if (!isColumn(f.key)) return { error: `config.fields: ${table} has no column "${f.key}"` };
  }
  if (c.frozenCount > Math.max(columnCount, 1)) {
    return { error: `config.frozenCount is more than the ${columnCount} columns` };
  }
  const colorRules: ColorRule[] = [];
  for (const [i, r] of c.colorRules.entries()) {
    const when: Filter[] = [];
    for (const [j, f] of r.when.entries()) {
      const x = filter(f, `config.colorRules[${i}].when[${j}]`);
      if (typeof x === "string") return { error: x };
      when.push(x);
    }
    if (r.target !== "row" && !isColumn(r.target.cell)) {
      return { error: `config.colorRules[${i}]: no column "${r.target.cell}"` };
    }
    colorRules.push({
      when,
      mode: r.mode,
      target: r.target === "row" ? "row" : { cell: r.target.cell },
      color: r.color,
    });
  }
  return {
    config: {
      filters,
      filterMode: c.filterMode,
      sorts: c.sorts.map((s) => ({ key: s.key, dir: s.dir })),
      sortMode: c.sortMode,
      group: {
        key: groupKey,
        ...(c.group.collapsedByDefault !== undefined
          ? { collapsedByDefault: c.group.collapsedByDefault }
          : {}),
      },
      fields: c.fields.map((f) => ({
        key: f.key,
        ...(f.width !== undefined ? { width: f.width } : {}),
        ...(f.hidden !== undefined ? { hidden: f.hidden } : {}),
      })),
      rowHeight: c.rowHeight,
      frozenCount: c.frozenCount,
      colorRules,
      ...(c.forkedFrom !== undefined ? { forkedFrom: c.forkedFrom } : {}),
      ...(c.layout === "gallery" ? { layout: "gallery" as const } : {}),
      ...(c.unit !== undefined ? { unit: c.unit } : {}),
    },
  };
}

/**
 * A config without references to custom fields that no longer exist (`custom.<key>` keys
 * the table doesn't have): a deleted field silently leaves the views that used it, instead
 * of making them unsavable. Other unknown keys stay (and are refused).
 */
function dropDeletedCustomFields(c: ViewConfig, known: Record<string, ViewFieldSpec>): ViewConfig {
  const gone = (key: string) => key.startsWith("custom.") && !Object.hasOwn(known, key);
  const keepFilter = (f: Filter) => !gone(f.key);
  return {
    ...c,
    filters: c.filters.filter(keepFilter),
    sorts: c.sorts.filter((s) => !gone(s.key)),
    group: c.group.key !== null && gone(c.group.key) ? { key: null } : c.group,
    fields: c.fields.filter((f) => !gone(f.key)),
    colorRules: c.colorRules.flatMap((r) => {
      if (r.target !== "row" && gone(r.target.cell)) return [];
      const when = r.when.filter(keepFilter);
      // A rule whose every condition named a deleted field goes with it.
      return when.length === 0 && r.when.length > 0 ? [] : [{ ...r, when }];
    }),
  };
}
