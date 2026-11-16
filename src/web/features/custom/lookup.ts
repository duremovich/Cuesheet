// Lookup custom fields on the client (R9, R12; data-model.md §Field types; the server side
// is src/shared/lookup.ts). A lookup shows a field of the records linked through one of the
// row's link fields: a note's "Content (from cues)" is each linked cue's Content, as chips.
//
// Any tab's lookup can read any table, so it can't use the other tabs' columns (they're
// built over each tab's own view objects). Instead every table has *record columns* here:
// grid columns over its raw rows, with the same keys, titles, types and value shapes as its
// tab (`lookup.test.ts` keeps them in step), plus its custom fields through the same
// `customColumns` the tabs use (so a lookup of a formula or of another lookup computes the
// way the tab does). They are built once per store state (a WeakMap on the state object).
//
// A lookup's column type follows its kind (`resolveLookup`): links → read-only multilink
// chips (the pickers' items), select choices → a read-only multiselect with the field's
// colors, anything else → a formula-type column holding the value (one linked value) or the
// list. Values are deduplicated and in link order. A misconfigured lookup (its link or
// field gone) is a #NAME value, a cycle (lookups and formulas reading each other) #ERROR,
// a sensitive field #HIDDEN: the same error values formulas use.
import { customTableId } from "../../../shared/custom-fields";
import { type FormulaError, isFormulaError, type Value } from "../../../shared/formula";
import { type LookupResolution, linkTargetOf, resolveLookup } from "../../../shared/lookup";
import type { AnyRow, CustomFieldRow, CustomValues, TableName } from "../../../shared/tables";
import { coreViewFields } from "../../../shared/views";
import type { Column, PickerItem } from "../../components/grid/types";
import { reverseJoin } from "../../lib/show-selectors";
import type { ShowData } from "../../lib/show-state";
import type { ShowStore } from "../../lib/show-store";
import { currentVersionLabel } from "../content/versions";
import { selectOptions } from "../cues/columns";
import { contentItem, cueItem, personItem, sceneItem, surfaceItem } from "../shared/pickers";
import {
  computeSurface,
  SURFACE_FORMULAS,
  type SurfaceFormulaKey,
  surfaceRecord,
} from "../surfaces/formulas";
import { customColumns } from "./columns";
import { columnValue } from "./formula";
import { fieldsFor, recordTableOf, targetLabel } from "./model";

/** A raw row of any table, as record columns read it. */
export type RawRecord = { id: string; custom: CustomValues } & Record<string, unknown>;
type Col = Column<RawRecord>;

const NONE: readonly string[] = [];

/** The picker item for a record of a link target (the chips the tabs' link columns show). */
export function recordItem(data: ShowData, target: string, id: string): PickerItem | null {
  const t = data.tables;
  switch (target) {
    case "cues": {
      const c = t.cues.get(id);
      return c ? cueItem(c) : null;
    }
    case "content": {
      const c = t.content.get(id);
      return c ? contentItem(c, t.scenes) : null;
    }
    case "persons": {
      const p = t.persons.get(id);
      return p ? personItem(p) : null;
    }
    case "scenes": {
      const s = t.scenes.get(id);
      return s ? sceneItem(s) : null;
    }
    case "surfaces": {
      const s = t.surfaces.get(id);
      return s ? surfaceItem(s) : null;
    }
    default: {
      const label = targetLabel(data, target, id);
      return label === null ? null : { id, label };
    }
  }
}

/** A row of a field table (`cues`, `custom:<id>`) by id, or null. */
export function recordOf(data: ShowData, fieldTable: string, id: string): RawRecord | null {
  const ct = customTableId(fieldTable);
  if (ct) {
    const r = data.tables.custom_rows.get(id);
    return r && r.table_id === ct ? (r as unknown as RawRecord) : null;
  }
  const map = (data.tables as Record<string, Map<string, AnyRow> | undefined>)[fieldTable];
  return (map?.get(id) as unknown as RawRecord | undefined) ?? null;
}

/** The record columns of a core table (the tab's own columns, over raw rows). */
function coreColumns(data: ShowData, table: string): Col[] {
  const opts = data.fieldOptions;
  const str = (key: string) => (r: RawRecord) => (typeof r[key] === "string" ? r[key] : "");
  const text = (key: string, title: string, type: "text" | "longtext" = "text"): Col => ({
    key,
    title,
    type,
    getValue: str(key),
  });
  const select = (key: string, title: string): Col => ({
    key,
    title,
    type: "select",
    options: selectOptions(opts, `${table}.${key}`),
    getValue: (r) => (typeof r[key] === "string" ? r[key] : null),
  });
  const items = (target: string, ids: readonly string[]) =>
    ids.flatMap((id) => {
      const it = recordItem(data, target, id);
      return it ? [it] : [];
    });
  const many = (
    key: string,
    title: string,
    target: string,
    ids: (r: RawRecord) => readonly string[],
  ): Col => ({
    key,
    title,
    type: "multilink",
    getValue: (r) => items(target, ids(r)),
  });
  const one = (key: string, title: string, target: string, ref: string): Col => ({
    key,
    title,
    type: "link",
    getValue: (r) =>
      typeof r[ref] === "string" ? (items(target, [r[ref] as string])[0] ?? null) : null,
  });
  const joined = (join: Map<string, string[]>) => (r: RawRecord) => join.get(r.id) ?? NONE;
  const num = (key: string, title: string, type: "number" | "measurement" = "number"): Col => ({
    key,
    title,
    type,
    getValue: (r) => (typeof r[key] === "number" ? r[key] : null),
  });
  const j = data.joins;
  switch (table) {
    case "cues":
      return [
        text("number", "Cue"),
        text("description", "Description", "longtext"),
        select("trigger_type", "Trigger"),
        text("trigger_value", "Trigger value"),
        text("sm_call", "SM call", "longtext"),
        text("lx_cue", "LX"),
        text("sq_cue", "SQ"),
        text("timecode", "Timecode"),
        text("ae_time", "AE time"),
        text("measure", "MSR"),
        text("page", "Page"),
        select("status", "Status"),
        many("assignees", "Assignees", "persons", joined(j.cueAssignees)),
        many("content", "Content", "content", joined(j.cueContent)),
        one("scene", "Scene", "scenes", "scene_id"),
      ];
    case "notes":
      return [
        text("body", "Note", "longtext"),
        {
          key: "type",
          title: "Type",
          type: "multiselect",
          options: selectOptions(opts, "notes.type"),
          getValue: (r) => (Array.isArray(r.type) ? r.type : []),
        },
        select("priority", "Priority"),
        select("status", "Status"),
        many("assignees", "Assignees", "persons", joined(j.noteAssignees)),
        many("cues", "Cues", "cues", joined(j.noteCues)),
        many("content", "Content", "content", joined(j.noteContent)),
        one("scene", "Scene", "scenes", "scene_id"),
        text("session", "Session"),
      ];
    case "content": {
      const cuesOf = reverseJoin(j.cueContent);
      return [
        text("name", "Name"),
        {
          key: "version",
          title: "Version",
          type: "readonly",
          getValue: (r) => currentVersionLabel(data.tables.content_versions, r.id) ?? "",
        },
        one("scene", "Scene", "scenes", "scene_id"),
        select("status", "Status"),
        one("creator", "Creator", "persons", "creator_id"),
        text("description", "Description", "longtext"),
        text("loop_in", "Loop in"),
        text("loop_out", "Loop out"),
        many("cues", "Cues", "cues", joined(cuesOf)),
        many("surfaces", "Surfaces", "surfaces", joined(j.contentSurfaces)),
      ];
    }
    case "scenes":
      return [
        text("number", "No."),
        text("name", "Name"),
        select("act", "Act"),
        text("location", "Location"),
        text("time_of_day", "Time of day"),
        text("song", "Song"),
        text("description", "Description", "longtext"),
        text("video_overview", "Video overview", "longtext"),
        many("surfaces", "Surfaces", "surfaces", joined(j.sceneSurfaces)),
      ];
    case "persons":
      return [
        text("name", "Name"),
        text("role", "Role"),
        select("group", "Group"),
        text("email", "Email"),
        text("phone", "Phone"),
        text("organization", "Organization"),
      ];
    case "surfaces": {
      const computed = (key: SurfaceFormulaKey): Col => ({
        key,
        title: SURFACE_FORMULAS[key].title,
        type: "formula",
        resultType: SURFACE_FORMULAS[key].resultType,
        getValue: (r) => {
          const s = data.tables.surfaces.get(r.id);
          return s ? computeSurface(data, s)[key] : null;
        },
      });
      return [
        text("name", "Name"),
        text("channel", "Channel"),
        one("parent", "Region of", "surfaces", "parent_id"),
        num("width", "Width", "measurement"),
        num("height", "Height", "measurement"),
        {
          key: "pixels",
          title: "Pixels",
          type: "pixelsize",
          getValue: (r) =>
            typeof r.pixel_width === "number" && typeof r.pixel_height === "number"
              ? { w: r.pixel_width, h: r.pixel_height }
              : null,
        },
        computed("ppi"),
        computed("pixel_pitch"),
        computed("aspect_ratio"),
        num("throw_distance", "Throw", "measurement"),
        num("lens_ratio", "Lens ratio"),
        computed("throw_width"),
        text("description", "Description", "longtext"),
        many("scenes", "Scenes", "scenes", joined(reverseJoin(j.sceneSurfaces))),
        many("content", "Content", "content", joined(reverseJoin(j.contentSurfaces))),
      ];
    }
    case "shots":
      return [
        text("number", "Shot"),
        text("group", "Group"),
        text("description", "Description", "longtext"),
        select("framing", "Framing"),
        text("camera", "Camera"),
        text("lens", "Lens"),
        {
          key: "resolution",
          title: "Resolution",
          type: "pixelsize",
          getValue: (r) => (r.resolution as { w: number; h: number } | null) ?? null,
        },
        num("frame_rate", "fps"),
        text("duration", "Duration"),
        select("status", "Status"),
        many("talent", "Talent", "persons", joined(j.shotTalent)),
        many("content", "Content", "content", joined(j.shotContent)),
      ];
    default:
      return [];
  }
}

const columnCache = new WeakMap<object, Map<string, Map<string, Col>>>();

/**
 * Every column of a field table over its raw rows, by key: the core columns and the custom
 * fields (attachment fields left out: a lookup can't show files). Read-only.
 */
export function recordColumns(data: ShowData, fieldTable: string): Map<string, Col> {
  let byTable = columnCache.get(data);
  if (!byTable) {
    byTable = new Map();
    columnCache.set(data, byTable);
  }
  const cached = byTable.get(fieldTable);
  if (cached) return cached;
  const out = new Map<string, Col>();
  byTable.set(fieldTable, out);
  const base = customTableId(fieldTable) ? [] : coreColumns(data, fieldTable);
  const store = { getState: () => data } as unknown as ShowStore;
  const custom = customColumns<RawRecord>(fieldsFor(data.tables.custom_fields, fieldTable), {
    store,
    table: recordTableOf(fieldTable) as TableName,
    rowOf: (r) => r,
    editable: false,
    showId: "",
    baseColumns: base,
    // No sample rows: building must not compute anything (a formula reading a lookup of
    // this table would find it half built). Result types don't matter here.
    ...(fieldTable === "surfaces"
      ? {
          fallbackRecord: (r: RawRecord) => {
            const s = data.tables.surfaces.get(r.id);
            return s ? surfaceRecord(data, s) : { get: () => undefined };
          },
        }
      : {}),
  });
  for (const c of [...base, ...custom]) {
    if (c.type !== "attachment") out.set(c.key, { ...c, editable: false });
  }
  return out;
}

/** How a lookup field resolves against the show's current fields. */
export function resolveLookupField(data: ShowData, f: CustomFieldRow): LookupResolution {
  return resolveLookup(f, (t) => fieldsFor(data.tables.custom_fields, t), coreViewFields);
}

/** The link columns of a field table a lookup can go through (for the Fields manager). */
export function lookupLinkColumns(
  data: ShowData,
  fieldTable: string,
): { key: string; title: string; target: string }[] {
  const fieldsOf = (t: string) => fieldsFor(data.tables.custom_fields, t);
  return [...recordColumns(data, fieldTable).values()].flatMap((c) => {
    const target = linkTargetOf(fieldTable, c.key, fieldsOf);
    return target ? [{ key: c.key, title: c.title, target }] : [];
  });
}

/** Fields of a table a lookup can show (every record column; not files). */
export function lookupFieldColumns(
  data: ShowData,
  fieldTable: string,
): { key: string; title: string }[] {
  return [...recordColumns(data, fieldTable).values()].map((c) => ({ key: c.key, title: c.title }));
}

/** "Cues → Content" for the Fields manager's list (the link's and the field's titles). */
export function lookupSummary(data: ShowData, f: CustomFieldRow): string {
  const link = f.options.link ?? "";
  const field = f.options.field ?? "";
  const linkCol = recordColumns(data, f.table).get(link);
  const target = linkTargetOf(f.table, link, (t) => fieldsFor(data.tables.custom_fields, t));
  const fieldCol = target ? recordColumns(data, target).get(field) : undefined;
  return `${linkCol?.title ?? `${link} (gone)`} → ${fieldCol?.title ?? `${field} (gone)`}`;
}

// ---- Computing a lookup ----

/** Lookup fields being computed up the stack (a cycle through formulas → #ERROR). */
const computing = new Set<string>();

const circular: FormulaError = {
  error: "Circular reference between lookup and formula fields",
  code: "#ERROR",
};
const hidden: FormulaError = {
  error: "Sensitive fields can't be looked up",
  code: "#HIDDEN",
};

/** `compute()` unless field `id` is already being computed up the stack (then `onCycle`). */
function guard<T>(id: string, onCycle: T, compute: () => T): T {
  if (computing.has(id)) return onCycle;
  computing.add(id);
  try {
    return compute();
  } finally {
    computing.delete(id);
  }
}

const asItems = (v: unknown): PickerItem[] =>
  Array.isArray(v) ? (v as PickerItem[]) : v && typeof v === "object" ? [v as PickerItem] : [];

/**
 * The values of field `r.field` on the records row `id` (of `f.table`) links to through
 * `f.options.link`, in link order: one entry per linked record that still exists.
 */
function linkedValues(
  data: ShowData,
  f: CustomFieldRow,
  r: Extract<LookupResolution, { ok: true }>,
  id: string,
): { col: Col; values: unknown[] } | FormulaError {
  const own = recordColumns(data, f.table);
  const link = own.get(f.options.link ?? "");
  const target = recordColumns(data, r.target);
  const col = target.get(r.field);
  if (!link || !col) {
    return { error: `${f.label || f.key}: a field it reads is gone`, code: "#NAME" };
  }
  if (col.masked) return hidden;
  const row = recordOf(data, f.table, id);
  if (!row) return { col, values: [] };
  const values: unknown[] = [];
  for (const item of asItems(link.getValue(row))) {
    const linked = recordOf(data, r.target, item.id);
    if (linked) values.push(col.getValue(linked));
  }
  return { col, values };
}

/** Linked-record chips, each record once, in order. */
function dedupeItems(values: readonly unknown[]): PickerItem[] {
  const seen = new Set<string>();
  const out: PickerItem[] = [];
  for (const v of values) {
    for (const it of asItems(v)) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      out.push(it);
    }
  }
  return out;
}

/** Select choices, each once, in order. */
function dedupeChoices(values: readonly unknown[]): string[] {
  const out = new Set<string>();
  for (const v of values) {
    for (const x of Array.isArray(v) ? v : [v]) if (typeof x === "string" && x) out.add(x);
  }
  return [...out];
}

/** Other values as one formula value: the single value, a list of several, or blank. */
function combineValues(col: Col, values: readonly unknown[]): Value {
  const seen = new Set<string>();
  const out: Value[] = [];
  const add = (v: Value) => {
    if (v === null || v === "") return;
    if (Array.isArray(v)) {
      for (const x of v) add(x);
      return;
    }
    const k = JSON.stringify(v);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(v);
  };
  for (const raw of values) {
    const v = columnValue(col, raw);
    if (v !== null && typeof v === "object" && "records" in v) {
      for (const rec of v.records) add(rec.label ?? null);
      continue;
    }
    if (isFormulaError(v)) return v;
    add(v);
  }
  if (out.length === 0) return null;
  return out.length === 1 ? (out[0] as Value) : out;
}

/**
 * The grid column for lookup field `f`, after the tab's `rowOf` (a row → its id). The
 * column reads the store when asked, so it shows the current links and values.
 */
export function lookupColumn<V>(
  f: CustomFieldRow,
  base: { key: string; title: string; width: number },
  store: ShowStore,
  rowOf: (v: V) => { id: string },
): Column<V> {
  const data0 = store.getState();
  const r = resolveLookupField(data0, f);
  // One computation per row object (the columns are rebuilt when the data changes).
  const cached = <T>(compute: (v: V) => T) => {
    const cache = new WeakMap<object, T>();
    return (v: V): T => {
      if (typeof v !== "object" || v === null) return compute(v);
      if (cache.has(v)) return cache.get(v) as T;
      const out = compute(v);
      cache.set(v, out);
      return out;
    };
  };
  if (!r.ok) {
    const error: FormulaError = { error: r.error, code: r.code };
    return { ...base, type: "formula", editable: false, getValue: () => error };
  }
  if (r.kind === "link") {
    return {
      ...base,
      type: "multilink",
      editable: false,
      getValue: cached((v) =>
        guard(f.id, [], () => {
          const lv = linkedValues(store.getState(), f, r, rowOf(v).id);
          return isFormulaError(lv) ? [] : dedupeItems(lv.values);
        }),
      ),
    };
  }
  if (r.kind === "multi") {
    const col = recordColumns(data0, r.target).get(r.field);
    return {
      ...base,
      type: "multiselect",
      editable: false,
      options: col?.options ?? [],
      getValue: cached((v) =>
        guard(f.id, [], () => {
          const lv = linkedValues(store.getState(), f, r, rowOf(v).id);
          return isFormulaError(lv) ? [] : dedupeChoices(lv.values);
        }),
      ),
    };
  }
  return {
    ...base,
    type: "formula",
    editable: false,
    getValue: cached((v) =>
      guard<Value>(f.id, circular, () => {
        const lv = linkedValues(store.getState(), f, r, rowOf(v).id);
        return isFormulaError(lv) ? lv : combineValues(lv.col, lv.values);
      }),
    ),
  };
}
