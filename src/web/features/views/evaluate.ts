// Evaluating a saved view's config on the client (R16, R17): filters, color rules and the
// field layout, all over the grid's columns (`Column.getValue` gives typed values, see the
// grid README "Value shapes"). Pure; unit-tested in evaluate.test.ts.

import { formulaScalar, type Value } from "../../../shared/formula";
import { isValidId } from "../../../shared/ids";
import { lengthsEqual, parseLength } from "../../../shared/units";
import type {
  Filter,
  FilterOp,
  MatchMode,
  ColorRule as SavedColorRule,
  ViewConfig,
} from "../../../shared/views";
import { type FieldKind, LIST_OPS, OPS_BY_KIND, VALUELESS_OPS } from "../../../shared/views";
import { compareNumericText, isEmptyValue } from "../../components/grid/ordering";
import type { ColorRule, Column, ColumnType, PickerItem } from "../../components/grid/types";
import { jsonEqual } from "../../lib/show-state";

/**
 * A field a view can filter, color or group by: a grid column, or an extra field that
 * isn't shown (e.g. a cue's open-note count). `valueType: "date"` marks a readonly
 * timestamp (ms) so it gets before/after.
 */
export type FieldDef<V> = Column<V> & {
  valueType?: "date";
  /** A text field the tab groups by itself (a view may group by it: shots' `group`). */
  groupable?: boolean;
};

// ---- Operators per field type ----

export type { FieldKind };

export function fieldKind(f: {
  type: ColumnType;
  valueType?: "date";
  resultType?: Column<unknown>["resultType"];
}): FieldKind {
  if (f.valueType === "date") return "date";
  switch (f.type) {
    case "number":
      return "number";
    case "measurement":
      return "measurement";
    case "formula":
      return f.resultType ?? "text";
    case "checkbox":
      return "checkbox";
    case "select":
      return "select";
    case "multiselect":
      return "multi";
    case "link":
    case "multilink":
      return "link";
    default:
      return "text";
  }
}

export function opsFor(f: Parameters<typeof fieldKind>[0]): readonly FilterOp[] {
  return OPS_BY_KIND[fieldKind(f)];
}

const OP_LABELS: Record<FilterOp, string> = {
  is: "is",
  isNot: "is not",
  contains: "contains",
  notContains: "does not contain",
  isEmpty: "is empty",
  isNotEmpty: "is not empty",
  gt: ">",
  lt: "<",
  gte: "≥",
  lte: "≤",
  before: "is before",
  after: "is after",
  anyOf: "is any of",
  noneOf: "is none of",
  isTrue: "is checked",
  isFalse: "is not checked",
};

export function opLabel(op: FilterOp, f?: { type: ColumnType }): string {
  if (f && (f.type === "multiselect" || f.type === "multilink")) {
    if (op === "is") return "has";
    if (op === "isNot") return "does not have";
    if (op === "anyOf") return "has any of";
    if (op === "noneOf") return "has none of";
  }
  return OP_LABELS[op];
}

/** A filter is complete when its op needs no value or it has one. Incomplete ones are skipped. */
export function isComplete(f: Filter): boolean {
  if (VALUELESS_OPS.has(f.op)) return true;
  if (LIST_OPS.has(f.op)) return Array.isArray(f.value) && f.value.length > 0;
  if (typeof f.value === "number") return Number.isFinite(f.value);
  return typeof f.value === "string" && f.value.trim() !== "";
}

// ---- Values ----

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const norm = (s: string) => s.trim().toLocaleLowerCase();

/**
 * Compare two scalars: numbers numerically, cue-number-like strings by the grid's
 * `compareNumericText` (14.2 = 14.20 < 14.25 < 14.3A), other strings by natural collation.
 */
export function compareScalar(a: string | number, b: string | number): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const sa = String(a);
  const sb = String(b);
  return compareNumericText(sa, sb) ?? collator.compare(sa.trim(), sb.trim());
}

/** The items of a select/multiselect/link/multilink value as comparable strings. */
function items(f: FieldDef<unknown>, v: unknown): string[] {
  if (isEmptyValue(v)) return [];
  switch (f.type) {
    case "select":
      return [String(v)];
    case "multiselect":
      return (v as string[]).map(String);
    case "link":
      return [(v as PickerItem).label];
    case "multilink":
      return (v as PickerItem[]).map((p) => p.label);
    default:
      return [String(v)];
  }
}

/** A link/multilink value as a list of picker items. */
export function linkItems(v: unknown): PickerItem[] {
  if (Array.isArray(v)) return v as PickerItem[];
  return v ? [v as PickerItem] : [];
}

/** A link filter value (an id; or, not yet resolved, a label) matches a linked record. */
function itemMatches(p: PickerItem, x: string): boolean {
  return p.id === x || (!isValidId(x) && norm(p.label) === norm(x));
}

const ID_OPS = new Set<FilterOp>(["is", "isNot", "anyOf", "noneOf"]);

/**
 * Link filters saved with labels (before they stored ids) → ids, resolving each label once
 * against the records `lookup` knows (the linked records in the rows, then the column's
 * picker search). Unresolvable labels stay (they still match by label). Returns `config`
 * itself when nothing changed.
 */
export function migrateLinkFilters<V>(
  config: ViewConfig,
  fields: ReadonlyMap<string, FieldDef<V>>,
  lookup: (field: FieldDef<V>, label: string) => PickerItem | undefined,
): ViewConfig {
  let changed = false;
  const fix = (f: Filter): Filter => {
    const field = fields.get(f.key);
    if (!field || fieldKind(field) !== "link" || !ID_OPS.has(f.op)) return f;
    const values = Array.isArray(f.value) ? f.value : typeof f.value === "string" ? [f.value] : [];
    const labels: Record<string, string> = { ...(f.labels ?? {}) };
    let touched = false;
    const next = values.map((x) => {
      if (typeof x !== "string" || isValidId(x)) return x;
      const hit = lookup(field, x);
      if (!hit) return x;
      touched = true;
      labels[hit.id] = hit.label;
      return hit.id;
    });
    if (!touched) return f;
    changed = true;
    return { ...f, value: Array.isArray(f.value) ? next : next[0], labels };
  };
  const filters = config.filters.map(fix);
  const colorRules = config.colorRules.map((r) => {
    const when = r.when.map(fix);
    return when.every((w, i) => w === r.when[i]) ? r : { ...r, when };
  });
  return changed ? { ...config, filters, colorRules } : config;
}

/** Local midnight of a `YYYY-MM-DD` value, or NaN. */
export function dayStart(value: unknown): number {
  if (typeof value !== "string") return Number.NaN;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return Number.NaN;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}

function toTime(v: unknown): number {
  if (typeof v === "number") return v;
  // A date custom field (`YYYY-MM-DD`): local midnight, like the filter's day.
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.trim())) return dayStart(v);
  if (typeof v === "string" && v.trim()) return Date.parse(v);
  return Number.NaN;
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * A measurement filter value in meters. Values are saved with the unit they were typed in
 * ("4 cm", `14'`); a bare number or unit-less text (older filters) is meters. null when it
 * isn't a length.
 */
export function measurementFilterMeters(value: unknown): number | null {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value : "";
  const r = parseLength(text, "m");
  return r && "m" in r ? r.m : null;
}

/** Does one row match one (complete) filter? */
export function matchesFilter<V>(f: FieldDef<V>, row: V, filter: Filter): boolean {
  const value0 = f.getValue(row);
  // Formula results filter as plain values: lengths in meters, errors as empty.
  const raw = f.type === "formula" ? formulaScalar(value0 as Value) : value0;
  const empty = isEmptyValue(raw) || (f.type === "checkbox" && raw === false);
  const { op, value } = filter;
  if (op === "isEmpty") return empty;
  if (op === "isNotEmpty") return !empty;
  if (op === "isTrue") return !empty;
  if (op === "isFalse") return empty;

  const kind = fieldKind(f);
  if (kind === "measurement") {
    // Meters, compared with the filter value as a length (saved with its unit; bare = m),
    // so the same filter matches the same rows whatever unit the viewer uses.
    if (typeof raw !== "number") return op === "isNot";
    const t = measurementFilterMeters(value);
    if (t === null) return false;
    switch (op) {
      case "is":
        return lengthsEqual(raw, t);
      case "isNot":
        return !lengthsEqual(raw, t);
      case "gt":
        return raw > t && !lengthsEqual(raw, t);
      case "gte":
        return raw >= t || lengthsEqual(raw, t);
      case "lt":
        return raw < t && !lengthsEqual(raw, t);
      case "lte":
        return raw <= t || lengthsEqual(raw, t);
      default:
        return false;
    }
  }
  if (kind === "date") {
    const t = toTime(raw);
    const day = dayStart(value);
    if (Number.isNaN(t) || Number.isNaN(day)) return false;
    if (op === "before") return t < day;
    if (op === "after") return t >= day + DAY;
    return false;
  }

  const list = LIST_OPS.has(op) ? (Array.isArray(value) ? value.map(String) : []) : [];
  const target = typeof value === "number" ? String(value) : typeof value === "string" ? value : "";

  if (kind === "link") {
    // Values are record ids (a label only in a filter saved before ids and not yet
    // resolved); `contains` matches labels.
    const picked = linkItems(raw);
    const has = (x: string) => picked.some((p) => itemMatches(p, x));
    const t = norm(target);
    switch (op) {
      case "is":
        return has(target);
      case "isNot":
        return !has(target);
      case "contains":
        return picked.some((p) => norm(p.label).includes(t));
      case "notContains":
        return !picked.some((p) => norm(p.label).includes(t));
      case "anyOf":
        return list.some(has);
      case "noneOf":
        return !list.some(has);
      default:
        return false;
    }
  }

  if (kind === "select" || kind === "multi") {
    const its = items(f as FieldDef<unknown>, raw).map(norm);
    const t = norm(target);
    switch (op) {
      case "is":
        return its.includes(t);
      case "isNot":
        return !its.includes(t);
      case "contains":
        return its.some((i) => i.includes(t));
      case "notContains":
        return !its.some((i) => i.includes(t));
      case "anyOf":
        return list.some((x) => its.includes(norm(x)));
      case "noneOf":
        return !list.some((x) => its.includes(norm(x)));
      case "gt":
      case "gte":
      case "lt":
      case "lte": {
        const first = items(f as FieldDef<unknown>, raw)[0];
        return first === undefined ? false : compareOp(op, compareScalar(first, target));
      }
      default:
        return false;
    }
  }

  // Text and numbers (readonly cells too).
  if (empty) {
    return op === "isNot" || op === "notContains" || op === "noneOf";
  }
  const scalar = typeof raw === "number" ? raw : f.format ? f.format(raw) : String(raw);
  const s = String(scalar);
  switch (op) {
    case "is":
      return equalScalar(scalar, target);
    case "isNot":
      return !equalScalar(scalar, target);
    case "contains":
      return norm(s).includes(norm(target));
    case "notContains":
      return !norm(s).includes(norm(target));
    case "anyOf":
      return list.some((x) => equalScalar(scalar, x));
    case "noneOf":
      return !list.some((x) => equalScalar(scalar, x));
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const b = typeof raw === "number" ? Number.parseFloat(target) : target;
      if (typeof b === "number" && Number.isNaN(b)) return false;
      return compareOp(op, compareScalar(scalar, b));
    }
    default:
      return false;
  }
}

function equalScalar(a: string | number, b: string): boolean {
  if (typeof a === "number") return a === Number.parseFloat(b);
  const n = compareNumericText(a, b);
  return n !== null ? n === 0 : norm(a) === norm(b);
}

function compareOp(op: FilterOp, c: number): boolean {
  switch (op) {
    case "gt":
      return c > 0;
    case "gte":
      return c >= 0;
    case "lt":
      return c < 0;
    case "lte":
      return c <= 0;
    default:
      return false;
  }
}

/**
 * A predicate for a filter list. Filters on unknown fields and incomplete filters are
 * skipped; with nothing left, `whenNone` decides (filters: true = keep every row; color
 * rules: false = color nothing). Returns null when every row matches (no filtering).
 */
export function compileFilters<V>(
  filters: readonly Filter[],
  mode: MatchMode,
  fields: ReadonlyMap<string, FieldDef<V>>,
  whenNone: boolean,
): ((row: V) => boolean) | null {
  const active = filters.filter(isComplete).flatMap((f) => {
    const field = fields.get(f.key);
    return field ? [{ field, filter: f }] : [];
  });
  if (active.length === 0) return whenNone ? null : () => false;
  return mode === "or"
    ? (row) => active.some(({ field, filter }) => matchesFilter(field, row, filter))
    : (row) => active.every(({ field, filter }) => matchesFilter(field, row, filter));
}

/** Saved color rules → the grid's `colorRules` (same order: first row match wins). */
export function gridColorRules<V>(
  rules: readonly SavedColorRule[],
  fields: ReadonlyMap<string, FieldDef<V>>,
): ColorRule<V>[] {
  return rules.flatMap((r): ColorRule<V>[] => {
    const when = compileFilters(r.when, r.mode, fields, false);
    if (!when) return [];
    if (r.target === "row") return [{ when, row: r.color }];
    if (!fields.has(r.target.cell)) return [];
    return [{ when, cell: { key: r.target.cell, color: r.color } }];
  });
}

/**
 * The grid's columns for a view: order from `config.fields` (unlisted columns keep their
 * default order after the listed ones), hidden ones dropped, saved widths applied, and the
 * first `frozenCount` visible columns frozen (the rest not).
 */
export function layoutColumns<V>(columns: readonly Column<V>[], config: ViewConfig): Column<V>[] {
  const byKey = new Map(columns.map((c) => [c.key, c]));
  const listed = config.fields.filter((f) => byKey.has(f.key));
  const listedKeys = new Set(listed.map((f) => f.key));
  const ordered = [
    ...listed.map((f) => ({ col: byKey.get(f.key) as Column<V>, f })),
    ...columns.filter((c) => !listedKeys.has(c.key)).map((col) => ({ col, f: undefined })),
  ];
  return ordered
    .filter(({ f }) => !f?.hidden)
    .map(({ col, f }, i) => {
      const frozen = i < config.frozenCount;
      const width = f?.width;
      if (!width && !!col.frozen === frozen) return col;
      return { ...col, ...(width ? { width } : {}), frozen };
    });
}

/** Every column in view order with its hidden flag (the Fields popover's list). */
export function fieldList<V>(
  columns: readonly Column<V>[],
  config: ViewConfig,
): { key: string; title: string; hidden: boolean }[] {
  const byKey = new Map(columns.map((c) => [c.key, c]));
  const listed = config.fields.filter((f) => byKey.has(f.key));
  const listedKeys = new Set(listed.map((f) => f.key));
  return [
    ...listed.map((f) => ({
      key: f.key,
      title: byKey.get(f.key)?.title ?? f.key,
      hidden: !!f.hidden,
    })),
    ...columns
      .filter((c) => !listedKeys.has(c.key))
      .map((c) => ({ key: c.key, title: c.title, hidden: false })),
  ];
}

/** A copy of `config.fields` covering every column in the given order (for edits). */
export function withFieldOrder<V>(
  columns: readonly Column<V>[],
  config: ViewConfig,
  order: readonly { key: string; hidden: boolean }[],
): ViewConfig["fields"] {
  const saved = new Map(config.fields.map((f) => [f.key, f]));
  const known = new Set(columns.map((c) => c.key));
  return order
    .filter((o) => known.has(o.key))
    .map((o) => {
      const width = saved.get(o.key)?.width;
      return { key: o.key, ...(width ? { width } : {}), ...(o.hidden ? { hidden: true } : {}) };
    });
}

/** The grid's `sort` prop: the view's sorts (hidden columns too) when the sort is live. */
export function gridSort<V>(
  config: ViewConfig,
  columns: readonly Column<V>[],
): { key: string; dir: "asc" | "desc" }[] | undefined {
  if (config.sortMode !== "live") return undefined;
  const keys = new Set(columns.map((c) => c.key));
  const sorts = config.sorts.filter((s) => keys.has(s.key));
  return sorts.length ? sorts : undefined;
}

/**
 * A viewer's/commenter's own column widths and frozen count on a shared view (kept in
 * their browser, never forking the view).
 */
export interface LayoutOverlay {
  widths: Record<string, number>;
  frozenCount?: number;
}

/** `config` with the overlay's widths and frozen count; column order stays as it was. */
export function applyLayoutOverlay(
  config: ViewConfig,
  overlay: LayoutOverlay,
  columnKeys: readonly string[],
): ViewConfig {
  const listed = new Set(config.fields.map((f) => f.key));
  const needsAll = Object.keys(overlay.widths).some((k) => !listed.has(k));
  const all = needsAll
    ? [...config.fields, ...columnKeys.filter((k) => !listed.has(k)).map((key) => ({ key }))]
    : config.fields;
  const fields = all.map((f) => {
    const width = overlay.widths[f.key];
    return width ? { ...f, width } : f;
  });
  return {
    ...config,
    fields,
    ...(overlay.frozenCount !== undefined ? { frozenCount: overlay.frozenCount } : {}),
  };
}

/** The widths and frozen count a config sets (to store as an overlay). */
export function layoutOverlayOf(config: ViewConfig): LayoutOverlay {
  const widths: Record<string, number> = {};
  for (const f of config.fields) if (f.width) widths[f.key] = f.width;
  return { widths, frozenCount: config.frozenCount };
}

/** Do two configs differ only in column widths and frozen count? */
export function differsOnlyInLayout<V>(
  a: ViewConfig,
  b: ViewConfig,
  columns: readonly Column<V>[],
): boolean {
  const strip = (c: ViewConfig) => ({
    ...c,
    frozenCount: 0,
    fields: fieldList(columns, c).map((f) => ({ key: f.key, hidden: f.hidden })),
  });
  return jsonEqual(strip(a), strip(b));
}
