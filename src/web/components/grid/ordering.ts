// Pure ordering logic for the DataGrid: live sort (empty values last), and "holds" that
// keep a focused or just-inserted row in place until focus leaves it (ux.md §Ordering).

import { formulaScalar, type Value } from "../../../shared/formula";
import type { Column, Group, SortSpec } from "./types";

export function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  if (typeof v === "number") return Number.isNaN(v);
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/** A decimal with an optional letter suffix: "14.25", "8.5A", ".5". */
const NUMERIC_TEXT = /^\s*(-?(?:\d+(?:\.\d*)?|\.\d+))\s*([A-Za-z]*)\s*$/;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * Compares two cue-number-like strings: the decimal part numerically, then the letter
 * suffix (none first): 14.2 = 14.20 < 14.25 < 14.3 < 14.3A < 14.3B, 14.05A < 14.5.
 * Returns null when either isn't of that form. Used by the grid's sort and view filters.
 */
export function compareNumericText(a: string, b: string): number | null {
  const ma = NUMERIC_TEXT.exec(a);
  const mb = NUMERIC_TEXT.exec(b);
  if (!ma || !mb) return null;
  const d = Number.parseFloat(ma[1] ?? "") - Number.parseFloat(mb[1] ?? "");
  if (d !== 0) return d;
  const sa = (ma[2] ?? "").toUpperCase();
  const sb = (mb[2] ?? "").toUpperCase();
  return sa === sb ? 0 : sa < sb ? -1 : 1;
}

/**
 * Default comparator for two non-empty values. Numbers compare numerically, cue-number-like
 * strings by `compareNumericText`; other strings use a natural, case-insensitive collation.
 */
export function compareValues(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  const sa = String(a);
  const sb = String(b);
  const n = compareNumericText(sa, sb);
  if (n !== null && n !== 0) return n;
  return collator.compare(sa, sb);
}

/** The value used for sorting a cell: option index for selects, labels for links. */
export function sortValue<Row>(col: Column<Row>, row: Row): unknown {
  const v = col.getValue(row);
  if (isEmptyValue(v)) return null;
  switch (col.type) {
    case "select":
    case "multiselect": {
      const first = Array.isArray(v) ? v[0] : v;
      const i = col.options?.findIndex((o) => o.value === first) ?? -1;
      return i >= 0 ? i : String(first);
    }
    case "link":
      return (v as { label?: string }).label ?? null;
    case "multilink":
      return (v as { label?: string }[])[0]?.label ?? null;
    case "pixelsize": {
      // By area, then width.
      const p = v as { w: number; h: number };
      return p.w * p.h + p.w / 1e6;
    }
    case "formula":
      // Lengths in meters, lists joined; errors and blanks sort last like empty cells.
      return formulaScalar(v as Value);
    default:
      return v;
  }
}

/** Stable multi-key sort. Rows whose sort value is empty go last regardless of direction. */
export function sortRows<Row>(
  rows: readonly Row[],
  sort: readonly SortSpec[],
  columns: readonly Column<Row>[],
): Row[] {
  const keys = sort
    .map((s) => ({ s, col: columns.find((c) => c.key === s.key) }))
    .filter((k): k is { s: SortSpec; col: Column<Row> } => !!k.col);
  if (keys.length === 0) return [...rows];
  const decorated = rows.map((row, i) => ({
    row,
    i,
    vals: keys.map((k) => sortValue(k.col, row)),
  }));
  decorated.sort((x, y) => {
    for (let k = 0; k < keys.length; k++) {
      const key = keys[k] as { s: SortSpec; col: Column<Row> };
      const a = x.vals[k];
      const b = y.vals[k];
      const ea = isEmptyValue(a);
      const eb = isEmptyValue(b);
      if (ea && eb) continue;
      if (ea) return 1;
      if (eb) return -1;
      const c = (key.col.compare ?? compareValues)(a, b);
      if (c !== 0) return key.s.dir === "desc" ? -c : c;
    }
    return x.i - y.i;
  });
  return decorated.map((d) => d.row);
}

/**
 * A row pinned in place: it stays at slot `index` (0-based, clamped) of its group's list,
 * whatever its neighbors do. `groupId` keeps it in its group even if the data moved it to
 * another one (e.g. its scene was edited) until the hold ends.
 */
export interface Hold {
  id: string;
  groupId?: string | undefined;
  /** Slot within the group; `Infinity` = last. */
  index: number;
}

export interface OrderedList {
  groupId?: string | undefined;
  ids: string[];
}

/**
 * Applies holds to already-sorted id lists (one per group, or one when ungrouped).
 * `positional` is false in show order (no sort): then only group holds apply, because the
 * data's own order is already stable.
 */
export function applyHolds(
  lists: OrderedList[],
  holds: readonly Hold[],
  positional: boolean,
): OrderedList[] {
  if (holds.length === 0) return lists;
  const out = lists.map((l) => ({ groupId: l.groupId, ids: [...l.ids] }));
  for (const h of holds) {
    const from = out.find((l) => l.ids.includes(h.id));
    if (!from) continue;
    const target = (h.groupId !== undefined && out.find((l) => l.groupId === h.groupId)) || from;
    if (target === from && !positional) continue;
    from.ids.splice(from.ids.indexOf(h.id), 1);
    const at = Math.max(0, Math.min(h.index, target.ids.length));
    target.ids.splice(at, 0, h.id);
  }
  return out;
}

/** One entry of the flattened, virtualized list. */
export type FlatItem<Row> =
  | { kind: "group"; key: string; group: Group<Row>; collapsed: boolean; count: number }
  | {
      kind: "row";
      key: string;
      id: string;
      row: Row;
      groupId: string | undefined;
      section: boolean;
      /** 1-based row number within the whole grid (sections not counted). */
      number: number;
    };

export interface LayoutInput<Row> {
  rows?: readonly Row[] | undefined;
  groups?: readonly Group<Row>[] | undefined;
  columns: readonly Column<Row>[];
  rowId: (r: Row) => string;
  sort?: readonly SortSpec[] | undefined;
  /** Columns sort keys resolve against (default `columns`; may include hidden ones). */
  sortColumns?: readonly Column<Row>[] | undefined;
  holds?: readonly Hold[] | undefined;
  collapsed?: ReadonlySet<string> | undefined;
  isSection?: ((r: Row) => boolean) | undefined;
}

/** Sort, apply holds, and flatten groups + rows into the list the grid renders. */
export function buildLayout<Row>(input: LayoutInput<Row>): FlatItem<Row>[] {
  const { columns, rowId, sort, holds = [], collapsed, isSection } = input;
  const byId = new Map<string, { row: Row }>();
  const sorted = (rows: readonly Row[]) =>
    sort && sort.length > 0 ? sortRows(rows, sort, input.sortColumns ?? columns) : [...rows];
  const lists: OrderedList[] = [];
  const groups = input.groups;
  if (groups) {
    for (const g of groups) {
      for (const r of g.rows) byId.set(rowId(r), { row: r });
      lists.push({ groupId: g.id, ids: sorted(g.rows).map(rowId) });
    }
  } else {
    const rows = input.rows ?? [];
    for (const r of rows) byId.set(rowId(r), { row: r });
    lists.push({ groupId: undefined, ids: sorted(rows).map(rowId) });
  }
  const held = applyHolds(lists, holds, !!sort && sort.length > 0);

  const items: FlatItem<Row>[] = [];
  let number = 0;
  const pushRows = (ids: string[], groupId: string | undefined, visible: boolean) => {
    for (const id of ids) {
      const entry = byId.get(id);
      if (!entry) continue;
      const section = !!isSection?.(entry.row);
      if (!section) number++;
      if (visible)
        items.push({ kind: "row", key: `r:${id}`, id, row: entry.row, groupId, section, number });
    }
  };
  if (groups) {
    groups.forEach((g, i) => {
      const ids = held[i]?.ids ?? [];
      const isCollapsed = collapsed?.has(g.id) ?? false;
      const count =
        g.count ??
        ids.filter((id) => {
          const e = byId.get(id);
          return e && !isSection?.(e.row);
        }).length;
      items.push({ kind: "group", key: `g:${g.id}`, group: g, collapsed: isCollapsed, count });
      pushRows(ids, g.id, !isCollapsed);
    });
  } else {
    pushRows(held[0]?.ids ?? [], undefined, true);
  }
  return items;
}
