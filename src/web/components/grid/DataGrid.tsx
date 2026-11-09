// The spreadsheet-like grid every table uses. Generic over the row type: the caller maps its
// data to columns + callbacks and owns all persistence. Behaviors follow docs/spec/ux.md
// (§Ordering and sorting, §Inserting a cue, §Grid, §Grouping, §Conditional formatting).
// See ./README.md for the props, the keyboard map and how to wire a real table.
//
// biome-ignore-all lint/a11y/useSemanticElements: an ARIA grid over absolutely positioned, virtualized divs; <table> layout can't do that
// biome-ignore-all lint/a11y/useFocusableInteractive: APG grid pattern: only the active cell is in the tab order (roving tabindex); rows and headers aren't focusable

import {
  defaultRangeExtractor,
  measureElement,
  type Range,
  useVirtualizer,
} from "@tanstack/react-virtual";
import {
  type CSSProperties,
  memo,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { anchorTarget, captureAnchors } from "../../lib/scrollMemory";
import { Chip, optionColor } from "./Chip";
import { ContextMenu } from "./ContextMenu";
import { CellContent, TextEditor } from "./cells";
import styles from "./DataGrid.module.css";
import { ChevronIcon, ExpandIcon, GripIcon, PlusIcon, TypeIcon } from "./icons";
import { buildLayout, type FlatItem, type Hold, isEmptyValue } from "./ordering";
import { type CloseReason, type PickVia, RecordPicker } from "./RecordPicker";
import {
  AUTO_MAX_LINES,
  AUTO_MIN_HEIGHT,
  EDIT_MAX_LINES,
  editorScrollTarget,
  estimateRowHeight,
  LINE_HEIGHT,
  ROW_HEIGHTS,
} from "./rowHeights";
import type {
  CellDecoration,
  ColorRule,
  Column,
  ColumnMoveTarget,
  DataGridProps,
  GridAction,
  InsertPosition,
  MenuItem,
  PickerItem,
  ScrollPosition,
} from "./types";
import {
  copyText,
  type EditRecord,
  editTextOf,
  emptyValue,
  formatValue,
  NOT_PARSED,
  parseError,
  parseText,
  parseTsv,
  toTsv,
  UndoStack,
  valuesEqual,
} from "./values";

export { ROW_HEIGHTS };
export const HEADER_HEIGHT = 34;
export const GROUP_HEIGHT = 40;
export const ROWNUM_WIDTH = 76;
const DEFAULT_WIDTH = 160;
const MIN_WIDTH = 60;
const MOVED_MS = 2400;
const SLIDE_MS = 320;
const PASTE_TYPES = new Set(["text", "longtext", "number", "select", "measurement", "pixelsize"]);
const PICKER_TYPES = new Set(["select", "multiselect", "link", "multilink"]);
const GHOST_TYPES = new Set(["text", "longtext", "number"]);
const MRU_SIZE = 5;
const NO_IDS: string[] = [];
/** How far (px) a header must be dragged before it moves (a shorter one is a click). */
const COL_DRAG_SLOP = 5;
const GROUP_COL = "__group";
/** Zero-width space: the edit sizer's last character, so a trailing newline gets its line. */
const ZWSP = String.fromCharCode(0x200b);
/** The auto-row caps, for the stylesheet (rowHeights.ts is the source). */
const AUTO_VARS = {
  "--auto-max-lines": AUTO_MAX_LINES,
  "--edit-max-height": `${EDIT_MAX_LINES * LINE_HEIGHT}px`,
} as CSSProperties;

/** The active cell: a row cell, or a group header (`group: true`, `rowId` = group id). */
interface CellRef {
  rowId: string;
  key: string;
  group?: boolean;
}

type Editing =
  | { kind: "text"; rowId: string; key: string; draft: string; invalid?: string }
  | { kind: "picker"; rowId: string; key: string; query: string; value: unknown };

interface ColLayout<Row> {
  col: Column<Row>;
  key: string;
  width: number;
  /** Left offset (px) within the row, including the row-number column. */
  left: number;
  frozen: boolean;
  index: number;
}

type RowItem<Row> = Extract<FlatItem<Row>, { kind: "row" }>;
type Edit = { rowId: string; key: string; value: unknown };

const isMod = (e: { metaKey: boolean; ctrlKey: boolean }) => e.metaKey || e.ctrlKey;

function isEditable<Row>(col: Column<Row>, row: Row): boolean {
  // Attachment cells change through files (canTakeFiles), never through cell edits.
  if (col.type === "readonly" || col.type === "formula" || col.type === "attachment") {
    return false;
  }
  if (col.editable === undefined) return true;
  return typeof col.editable === "function" ? col.editable(row) : col.editable;
}

/** An attachment cell that accepts dropped / pasted files. */
function canTakeFiles<Row>(col: Column<Row>, row: Row): boolean {
  if (col.type !== "attachment" || !col.onFiles) return false;
  if (col.editable === undefined) return true;
  return typeof col.editable === "function" ? col.editable(row) : col.editable;
}

/** Value → editable text for text/number editors. */
const editText = editTextOf;

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Interface the memoized rows call back into (stable identity; reads the latest state). */
interface RowApi {
  cellPointerDown(rowId: string, key: string, e: ReactPointerEvent): void;
  cellDoubleClick(rowId: string, key: string): void;
  toggle(rowId: string, key: string): void;
  setDraft(v: string): void;
  rowNumberClick(rowId: string, e: React.MouseEvent): void;
  gripPointerDown(rowId: string, e: ReactPointerEvent): void;
  insertBelow(rowId: string): void;
  openRow(rowId: string): void;
  contextMenu(rowId: string, e: React.MouseEvent): void;
}

export function DataGrid<Row>(props: DataGridProps<Row>) {
  const {
    columns,
    rows,
    groups,
    onInsert,
    onMove,
    onDelete,
    onOpenRow,
    sort,
    colorRules,
    rowHeight = "auto",
    className,
  } = props;
  const gridId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const sortOn = !!sort && sort.length > 0;
  /** Fit to content: rows are measured (rowHeights.ts); otherwise every row is `rh` tall. */
  const auto = rowHeight === "auto";
  const rh = rowHeight === "auto" ? AUTO_MIN_HEIGHT : ROW_HEIGHTS[rowHeight];

  // rowId / isSection are usually inline lambdas: read them through refs so a parent
  // re-render doesn't rebuild the layout (and re-render every row).
  const rowIdRef = useRef(props.rowId);
  rowIdRef.current = props.rowId;
  const isSectionRef = useRef(props.isSection);
  isSectionRef.current = props.isSection;
  const rowId = useCallback((r: Row) => rowIdRef.current(r), []);
  const isSection = useCallback((r: Row) => !!isSectionRef.current?.(r), []);

  // --- State ---
  const [active, setActive] = useState<CellRef | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [range, setRange] = useState<{ anchor: CellRef; focus: CellRef } | null>(null);
  const [internalSelection, setInternalSelection] = useState<string[]>([]);
  const [internalCollapsed, setInternalCollapsed] = useState<string[]>([]);
  const [hold, setHold] = useState<Hold | null>(null);
  const [moved, setMoved] = useState<ReadonlySet<string>>(() => new Set());
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [menu, setMenu] = useState<{ x: number; y: number; rowId: string } | null>(null);
  const [drag, setDrag] = useState<{ rowId: string; gap: number | null } | null>(null);
  /** A header being dragged: the gap it would drop into and the drop line's x in the viewport. */
  const [colDrag, setColDrag] = useState<{
    key: string;
    gap: number;
    x: number;
    height: number;
  } | null>(null);
  const [confirm, setConfirm] = useState<string[] | null>(null);
  const [hint, setHint] = useState<string>("");
  const [viewportWidth, setViewportWidth] = useState(0);
  const [pickerAnchor, setPickerAnchor] = useState<HTMLElement | null>(null);
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const undo = useRef(new UndoStack());
  const mru = useRef(new Map<string, PickerItem[]>());
  const focusPending = useRef(false);
  /** A row to activate once it appears (inserted rows, `focusRow`). */
  const pendingFocus = useRef<{
    id: string;
    key?: string | undefined;
    focus: boolean;
    /** Scroll it to the vertical middle (focusRow), not just into view. */
    center?: boolean;
    /** focusRow before the row reached the grid (a fresh insert): expand its group on arrival. */
    expand?: boolean;
  } | null>(null);
  const pendingScroll = useRef<string | null>(null);
  /**
   * Auto rows: a row just scrolled into view, re-checked while measurements of the rows
   * around it (estimated until rendered) move it, until `until` or the user scrolls.
   */
  const settle = useRef<{
    target: CellRef;
    center: boolean;
    until: number;
    offsets: number[];
  } | null>(null);
  /** The last `scrollRestore.key` applied (README "Scroll memory"). */
  const restoredKey = useRef<string | null>(null);
  /** A restore re-checked while the rows around it get measured, until `until` or you act. */
  const restoreSettle = useRef<{
    position: ScrollPosition;
    until: number;
    offsets: number[];
  } | null>(null);
  const scrollActive = useRef(false);
  const afterDelete = useRef<string | null>(null);
  const lastSeen = useRef<{ flat: number; groupId: string | undefined } | null>(null);
  const flip = useRef<{ id: string; from: number } | null>(null);
  const selectionAnchor = useRef<string | null>(null);
  const hintTimer = useRef<number | undefined>(undefined);

  const selected = props.selectedRowIds ?? internalSelection;
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const collapsedList = props.collapsed ?? internalCollapsed;
  const collapsed = useMemo<ReadonlySet<string>>(() => new Set(collapsedList), [collapsedList]);

  // --- Derived layout ---
  const holds = useMemo(() => (hold ? [hold] : []), [hold]);
  const items = useMemo(
    () =>
      buildLayout({
        rows,
        groups,
        columns,
        sortColumns: props.sortColumns,
        rowId,
        sort,
        holds,
        collapsed,
        isSection,
      }),
    [rows, groups, columns, props.sortColumns, rowId, sort, holds, collapsed, isSection],
  );
  const allRows = useMemo(() => {
    const m = new Map<string, { row: Row; groupId: string | undefined }>();
    if (groups)
      for (const g of groups) for (const r of g.rows) m.set(rowId(r), { row: r, groupId: g.id });
    else for (const r of rows ?? []) m.set(rowId(r), { row: r, groupId: undefined });
    return m;
  }, [rows, groups, rowId]);
  const { indexById, groupIndexById } = useMemo(() => {
    const rowsM = new Map<string, number>();
    const groupsM = new Map<string, number>();
    items.forEach((it, i) => {
      if (it.kind === "row") rowsM.set(it.id, i);
      else groupsM.set(it.group.id, i);
    });
    return { indexById: rowsM, groupIndexById: groupsM };
  }, [items]);
  /** Flat indices of row items (paste, ranges, select all). */
  const navRows = useMemo(() => items.flatMap((it, i) => (it.kind === "row" ? [i] : [])), [items]);
  const groupIndexes = useMemo(
    () => items.flatMap((it, i) => (it.kind === "group" ? [i] : [])),
    [items],
  );
  const cols = useMemo(() => {
    const ordered = [...columns.filter((c) => c.frozen), ...columns.filter((c) => !c.frozen)];
    let left = ROWNUM_WIDTH;
    let frozenOk = true;
    return ordered.map((col, index): ColLayout<Row> => {
      const width = Math.max(
        col.minWidth ?? MIN_WIDTH,
        widths[col.key] ?? col.width ?? DEFAULT_WIDTH,
      );
      // Freeze a leading run of columns, but only while they leave most of a narrow screen free.
      let frozen = !!col.frozen && frozenOk;
      if (frozen && index > 0 && viewportWidth > 0 && left + width > viewportWidth * 0.6)
        frozen = false;
      if (!frozen) frozenOk = false;
      const out = { col, key: col.key, width, left, frozen, index };
      left += width;
      return out;
    });
  }, [columns, widths, viewportWidth]);
  const colIndex = useMemo(() => new Map(cols.map((c, i) => [c.key, i])), [cols]);
  const totalWidth = cols.reduce((s, c) => s + c.width, ROWNUM_WIDTH);
  const frozenWidth = cols.reduce((s, c) => (c.frozen ? s + c.width : s), ROWNUM_WIDTH);
  const labelKey = useMemo(
    () =>
      props.sectionLabelKey ??
      (columns.find((c) => c.type === "text" || c.type === "longtext") ?? columns[0])?.key ??
      "",
    [columns, props.sectionLabelKey],
  );

  const indexOfRef = (a: CellRef | null | undefined) =>
    a ? (a.group ? groupIndexById.get(a.rowId) : indexById.get(a.rowId)) : undefined;

  // --- Virtualization ---
  const activeIndex = indexOfRef(active) ?? -1;
  const dragIndex = drag ? (indexById.get(drag.rowId) ?? -1) : -1;
  // Always render the active and dragged rows, so focus and pointer tracking survive scrolling.
  const rangeExtractor = useCallback(
    (r: Range) => {
      const base = defaultRangeExtractor(r);
      const extra = [activeIndex, dragIndex].filter((i) => i >= 0 && i < r.count);
      return extra.length ? [...new Set([...base, ...extra])].sort((a, b) => a - b) : base;
    },
    [activeIndex, dragIndex],
  );
  // Auto rows: estimated from their text until rendered, then measured. Estimates are cached
  // per row object (rows keep identity until they change) for the current column layout.
  const estimates = useMemo(() => ({ cols, map: new WeakMap<object, number>() }), [cols]);
  const estimateSize = (i: number): number => {
    const it = items[i];
    if (!it) return rh;
    if (it.kind === "group") return GROUP_HEIGHT;
    if (!auto || it.section) return rh;
    const row = it.row;
    const key = typeof row === "object" && row !== null ? (row as object) : null;
    const hit = key ? estimates.map.get(key) : undefined;
    if (hit !== undefined) return hit;
    const h = estimateRowHeight(row, estimates.cols);
    if (key) estimates.map.set(key, h);
    return h;
  };
  // Sizes are cached by key: the mode is part of it, so a row measured in one mode never
  // lends its height to another. A new function (items, mode or columns changed) makes the
  // virtualizer recompute positions; otherwise they're reused across renders.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `estimates` (new with the columns) is a dep so estimates are re-read when widths change
  const getItemKey = useCallback(
    (i: number) => {
      const k = items[i]?.key;
      return k === undefined ? i : `${rowHeight}:${k}`;
    },
    [items, rowHeight, estimates],
  );
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    getItemKey,
    overscan: 8,
    scrollMargin: HEADER_HEIGHT,
    rangeExtractor,
    // jsdom (unit tests) has no layout: keep the estimate instead of a 0 px row.
    measureElement: (el, entry, inst) => {
      const size = measureElement(el, entry, inst);
      return size > 0 ? size : estimateSize(inst.indexFromElement(el));
    },
  });
  const virtualItems = virtualizer.getVirtualItems();
  // Body offsets of every item (and the end), from the virtualizer's measurements: the
  // stuck header, drag gaps, scroll-into-view and the FLIP all read these.
  // (getVirtualItems just brought measurementsCache up to date; it's a new array whenever
  // a position changed.)
  const measurements = virtualizer.measurementsCache;
  const offsets = useMemo(() => {
    const o = new Array<number>(measurements.length + 1);
    o[0] = 0;
    for (let i = 0; i < measurements.length; i++) {
      const m = measurements[i];
      o[i] = m ? m.start - HEADER_HEIGHT : (o[i - 1] ?? 0);
      o[i + 1] = m ? m.end - HEADER_HEIGHT : (o[i] as number);
    }
    return o;
  }, [measurements]);

  // The stuck group header names the group of the first row visible below it: the item
  // at body offset scrollTop + GROUP_HEIGHT (just under the column header and the stuck
  // header itself), or that item's own group header.
  // Unless that item is itself a group header still below the top: it labels itself, and
  // the slot above it holds the previous group (its last row, or its header when it's
  // collapsed or empty). Sticking the lower header there drew it over the previous one: at
  // scrollTop 0 a collapsed (or empty) first group lost its header for good. The previous
  // group's header sticks instead, pushed up so it ends where the next header begins.
  const scrollTop = virtualizer.scrollOffset ?? 0;
  let sticky = -1;
  let stickyPush = 0;
  if (groups && items.length) {
    const probe = scrollTop + GROUP_HEIGHT;
    let lo = 0;
    let hi = items.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((offsets[mid] as number) <= probe) lo = mid;
      else hi = mid - 1;
    }
    const loTop = offsets[lo] as number;
    const nextHeader = items[lo]?.kind === "group" && loTop > scrollTop;
    for (const g of groupIndexes) {
      if (g < lo || (g === lo && !nextHeader)) sticky = g;
      else break;
    }
    if (nextHeader && sticky >= 0) stickyPush = probe - loTop;
  }
  const stickyTop = HEADER_HEIGHT - stickyPush;

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewportWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setViewportWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // --- Latest-state ref for stable callbacks ---
  const S = {
    props,
    items,
    allRows,
    indexById,
    groupIndexById,
    navRows,
    offsets,
    cols,
    colIndex,
    active,
    editing,
    range,
    selected,
    hold,
    sortOn,
    frozenWidth,
    labelKey,
    drag,
    collapsed,
    auto,
  };
  const ref = useRef(S);
  ref.current = S;
  // Whether focus was inside the grid when this render started (see the focus effect).
  const hadFocus = useRef(false);
  hadFocus.current =
    typeof document !== "undefined" && !!rootRef.current?.contains(document.activeElement);

  // --- Helpers ---
  const colOf = (key: string) => S.cols[S.colIndex.get(key) ?? -1]?.col;
  const rowItemAt = (i: number): RowItem<Row> | undefined => {
    const it = ref.current.items[i];
    return it?.kind === "row" ? it : undefined;
  };
  const rowItem = (id: string) => rowItemAt(ref.current.indexById.get(id) ?? -1);
  const firstEditableKey = (row: Row | undefined) =>
    (row ? S.cols.find((c) => isEditable(c.col, row)) : undefined)?.key ?? S.cols[0]?.key ?? "";
  const refAt = (i: number, key: string): CellRef | null => {
    const it = ref.current.items[i];
    if (!it) return null;
    return it.kind === "row" ? { rowId: it.id, key } : { rowId: it.group.id, key, group: true };
  };

  const showHint = (text: string) => {
    setHint(text);
    window.clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => setHint(""), 4000);
  };

  /** Runs a consumer callback, reporting sync throws and async rejections. */
  const guard = (action: GridAction, fn: () => unknown) => {
    const report = (err: unknown) => {
      (ref.current.props.onError ?? ((e: unknown) => console.error(e)))(err, action);
      showHint(`Couldn't ${action === "edit" ? "save the change" : `${action} the row`}.`);
    };
    try {
      const r = fn();
      if (r && typeof (r as Promise<unknown>).then === "function")
        (r as Promise<unknown>).catch(report);
    } catch (err) {
      report(err);
    }
  };

  const setSelected = (ids: string[]) => {
    if (ref.current.selected.length === 0 && ids.length === 0) return;
    if (props.selectedRowIds === undefined) setInternalSelection(ids);
    props.onSelectionChange?.(ids);
    ref.current = { ...ref.current, selected: ids };
  };
  /** Row ids in display order (rows of expanded groups). */
  const rowOrderOf = (cur: typeof S) => cur.navRows.map((i) => (cur.items[i] as RowItem<Row>).id);
  /** The rows from `anchor` to `id` in display order (just `id` without a usable anchor). */
  const rowSpan = (cur: typeof S, anchor: string | null, id: string) => {
    const order = rowOrderOf(cur);
    const a = anchor === null ? -1 : order.indexOf(anchor);
    const b = order.indexOf(id);
    if (a < 0 || b < 0) return [id];
    return order.slice(Math.min(a, b), Math.max(a, b) + 1);
  };
  /** The rows a cell range covers, when it spans more than one row. */
  const rangeRowIds = (cur: typeof S): string[] => {
    const r = cur.range;
    if (!r || r.anchor.group || r.focus.group || r.anchor.rowId === r.focus.rowId) return [];
    return rowSpan(cur, r.anchor.rowId, r.focus.rowId);
  };
  /**
   * ⌘/Ctrl+click on a row: toggle it. With nothing selected yet, the rows you were already
   * on (a multi-row range, else the active row) count as selected, like a plain click in a
   * file list, so click A then ⌘-click B selects both.
   */
  const toggledSelection = (cur: typeof S, id: string) => {
    if (cur.selected.length)
      return cur.selected.includes(id)
        ? cur.selected.filter((x) => x !== id)
        : [...cur.selected, id];
    const ranged = rangeRowIds(cur);
    const seed = ranged.length
      ? ranged
      : cur.active && !cur.active.group && cur.allRows.has(cur.active.rowId)
        ? [cur.active.rowId]
        : [];
    return seed.includes(id) ? seed : [...seed, id];
  };

  const setCollapsed = (update: (s: Set<string>) => Set<string>) => {
    const next = [...update(new Set(ref.current.collapsed))];
    if (props.collapsed === undefined) setInternalCollapsed(next);
    ref.current = { ...ref.current, collapsed: new Set(next) };
    props.onCollapsedChange?.(next);
  };
  const expandGroup = (id: string | undefined) => {
    if (id !== undefined && ref.current.collapsed.has(id))
      setCollapsed((s) => {
        s.delete(id);
        return s;
      });
  };

  const flashMoved = (id: string) => {
    setMoved((m) => new Set(m).add(id));
    setTimeout(() => {
      setMoved((m) => {
        const n = new Set(m);
        n.delete(id);
        return n;
      });
    }, MOVED_MS);
  };

  /**
   * Ends the current hold; the row slides (FLIP) into its sorted place with a highlight.
   * Returns the settled layout (null if nothing was held).
   */
  const releaseHold = (): FlatItem<Row>[] | null => {
    const h = ref.current.hold;
    if (!h) return null;
    const cur = ref.current;
    const before = cur.indexById.get(h.id);
    const settled = buildLayout({
      rows: cur.props.rows,
      groups: cur.props.groups,
      columns: cur.props.columns,
      sortColumns: cur.props.sortColumns,
      rowId,
      sort: cur.props.sort,
      collapsed: cur.collapsed,
      isSection,
    });
    const after = settled.findIndex((it) => it.kind === "row" && it.id === h.id);
    setHold(null);
    ref.current = { ...ref.current, hold: null };
    if (before !== undefined && after >= 0 && after !== before) {
      flashMoved(h.id);
      flip.current = { id: h.id, from: cur.offsets[before] ?? 0 };
    }
    return settled;
  };

  /** Would releasing the current hold move the row (live sort / changed group)? */
  const holdWouldMove = (): boolean => {
    const cur = ref.current;
    const h = cur.hold;
    if (!h) return false;
    const settled = buildLayout({
      rows: cur.props.rows,
      groups: cur.props.groups,
      columns: cur.props.columns,
      sortColumns: cur.props.sortColumns,
      rowId,
      sort: cur.props.sort,
      collapsed: cur.collapsed,
      isSection,
    });
    const after = settled.findIndex((it) => it.kind === "row" && it.id === h.id);
    return after >= 0 && after !== cur.indexById.get(h.id);
  };

  /** A hold for `id` at its slot within its group in `layout`. */
  const holdFor = (id: string, layout: FlatItem<Row>[]): Hold | null => {
    const i = layout.findIndex((it) => it.kind === "row" && it.id === id);
    const it = layout[i];
    if (it?.kind !== "row") return null;
    let index = 0;
    for (let j = i - 1; j >= 0; j--) {
      const p = layout[j];
      if (p?.kind !== "row") break;
      index++;
    }
    return { id, groupId: it.groupId, index };
  };

  /** Slot within its group for an insert/drop position, computed on `layout`. */
  const slotFor = (pos: InsertPosition, layout: FlatItem<Row>[], exclude?: string): number => {
    const list = layout.filter(
      (it): it is RowItem<Row> =>
        it.kind === "row" &&
        it.id !== exclude &&
        (pos.groupId === undefined || it.groupId === pos.groupId),
    );
    if (pos.afterRowId !== undefined) {
      const i = list.findIndex((it) => it.id === pos.afterRowId);
      if (i >= 0) return i + 1;
    }
    if (pos.beforeRowId !== undefined) {
      const i = list.findIndex((it) => it.id === pos.beforeRowId);
      if (i >= 0) return i;
    }
    return Number.POSITIVE_INFINITY;
  };

  const ensureVisible = (flatIndex: number, key?: string, center = false) => {
    const el = scrollRef.current;
    const o = ref.current.offsets;
    if (!el || flatIndex < 0) return;
    const stickyRoom = groups && ref.current.items[flatIndex]?.kind === "row" ? GROUP_HEIGHT : 0;
    const top = (o[flatIndex] ?? 0) + HEADER_HEIGHT;
    const bottom = (o[flatIndex + 1] ?? top) + HEADER_HEIGHT;
    const viewTop = el.scrollTop + HEADER_HEIGHT + stickyRoom;
    const outside = top < viewTop || bottom > el.scrollTop + el.clientHeight;
    if (center && outside) {
      // Jumps (⌘K, a link) land mid-view, with context above and below.
      const room = el.clientHeight - HEADER_HEIGHT - stickyRoom;
      el.scrollTop = Math.max(0, top - HEADER_HEIGHT - stickyRoom - (room - (bottom - top)) / 2);
    } else if (top < viewTop) el.scrollTop = Math.max(0, top - HEADER_HEIGHT - stickyRoom);
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
    const c = key === undefined ? undefined : ref.current.cols[ref.current.colIndex.get(key) ?? -1];
    if (c && !c.frozen) {
      if (c.left < el.scrollLeft + ref.current.frozenWidth)
        el.scrollLeft = Math.max(0, c.left - ref.current.frozenWidth);
      else if (c.left + c.width > el.scrollLeft + el.clientWidth)
        el.scrollLeft = c.left + c.width - el.clientWidth;
    }
  };

  /** Makes a cell (or group header) active. Leaving a row releases its hold. */
  const activate = (
    target: CellRef,
    opts: { scroll?: boolean | "center"; keepRange?: boolean; focus?: boolean } = {},
  ) => {
    const cur = ref.current;
    if (target.group) {
      releaseHold();
    } else if (!cur.hold || cur.hold.id !== target.rowId) {
      // Anchor the new hold in the layout as it is once the old row has settled.
      const layout = releaseHold() ?? cur.items;
      const h = holdFor(target.rowId, layout);
      if (h) {
        setHold(h);
        ref.current = { ...ref.current, hold: h };
      }
    }
    setActive(target);
    ref.current = { ...ref.current, active: target };
    if (!opts.keepRange) setRange(null);
    if (opts.focus !== false) focusPending.current = true;
    if (opts.scroll) {
      restoreSettle.current = null; // a scroll to this cell wins over a restore settling
      const i = target.group
        ? ref.current.groupIndexById.get(target.rowId)
        : ref.current.indexById.get(target.rowId);
      const center = opts.scroll === "center";
      ensureVisible(i ?? -1, target.group ? undefined : target.key, center);
      if (ref.current.auto) {
        settle.current = {
          target,
          center,
          until: performance.now() + 800,
          offsets: ref.current.offsets,
        };
      }
    }
  };

  // --- Edits + undo ---
  const applyEdits = (edits: Edit[], record = true) => {
    const batch: EditRecord[] = [];
    for (const e of edits) {
      const col = colOf(e.key);
      const entry = ref.current.allRows.get(e.rowId);
      const before = col && entry ? col.getValue(entry.row) : undefined;
      batch.push({ rowId: e.rowId, key: e.key, before, after: e.value });
      guard("edit", () => ref.current.props.onEdit(e.rowId, e.key, e.value));
    }
    if (record) undo.current.push(batch);
  };

  /**
   * Undo/redo replays inverse edits, but skips a cell that no longer holds the value this
   * grid left there (someone else changed it since): their change wins.
   */
  const replay = (which: "undo" | "redo") => {
    const edits = which === "undo" ? undo.current.undo() : undo.current.redo();
    if (!edits || edits.length === 0) return;
    let first: Edit | undefined;
    let skipped = 0;
    for (const e of edits) {
      const col = colOf(e.key);
      const entry = ref.current.allRows.get(e.rowId);
      if (!col || !entry || !valuesEqual(col.getValue(entry.row), e.expect)) {
        skipped++;
        continue;
      }
      guard("edit", () => ref.current.props.onEdit(e.rowId, e.key, e.value));
      first ??= e;
    }
    if (skipped)
      showHint(`Skipped ${skipped} cell${skipped === 1 ? "" : "s"} changed by someone else.`);
    if (first && ref.current.indexById.has(first.rowId))
      activate({ rowId: first.rowId, key: first.key }, { scroll: true });
  };

  const decorationOf = (id: string, key: string): CellDecoration | undefined => {
    const entry = ref.current.allRows.get(id);
    return entry ? ref.current.props.cellDecoration?.(entry.row, key) : undefined;
  };

  /** Accept a ghost suggestion on an empty cell. Returns true if one was accepted. */
  const acceptGhost = (id: string, key: string): boolean => {
    const col = colOf(key);
    const entry = ref.current.allRows.get(id);
    const ghost = decorationOf(id, key)?.ghost;
    if (!col || !entry || !ghost || !GHOST_TYPES.has(col.type)) return false;
    if (!isEditable(col, entry.row) || !isEmptyValue(col.getValue(entry.row))) return false;
    const value = parseText(col, ghost);
    if (value === NOT_PARSED) return false;
    applyEdits([{ rowId: id, key, value }]);
    return true;
  };

  // --- Editing ---
  const startEdit = (id: string, key: string, initial?: string) => {
    const it = rowItem(id);
    if (!it) return;
    const editKey = it.section ? ref.current.labelKey : key;
    const col = colOf(editKey);
    if (col?.type === "attachment") {
      if (initial === undefined) col.onOpen?.(it.row);
      return;
    }
    if (!col || !isEditable(col, it.row)) return;
    // Editing always holds the row in place (e.g. after Escape released it).
    if (ref.current.hold?.id !== id) {
      const h = holdFor(id, ref.current.items);
      if (h) {
        setHold(h);
        ref.current = { ...ref.current, hold: h };
      }
    }
    if (col.type === "checkbox") {
      applyEdits([{ rowId: id, key: editKey, value: !col.getValue(it.row) }]);
      return;
    }
    const next: Editing = PICKER_TYPES.has(col.type)
      ? {
          kind: "picker",
          rowId: id,
          key: editKey,
          query: initial ?? "",
          value: col.getValue(it.row),
        }
      : {
          kind: "text",
          rowId: id,
          key: editKey,
          draft: initial ?? editText(col, col.getValue(it.row)),
        };
    setEditing(next);
    ref.current = { ...ref.current, editing: next };
  };

  const move = (
    dir: "up" | "down" | "left" | "right",
    opts: { extend?: boolean; wrap?: boolean } = {},
  ) => {
    const cur = ref.current;
    // Shift+↑/↓ with a row selection extends it from its anchor, a row at a time.
    const a0 = cur.active;
    if (opts.extend && cur.selected.length && a0 && !a0.group && (dir === "up" || dir === "down")) {
      let n = cur.navRows.indexOf(cur.indexById.get(a0.rowId) ?? -1);
      if (n < 0) return;
      n = dir === "up" ? Math.max(0, n - 1) : Math.min(cur.navRows.length - 1, n + 1);
      const target = rowItemAt(cur.navRows[n] ?? -1);
      if (!target) return;
      const anchor = cur.selected.includes(selectionAnchor.current ?? "")
        ? selectionAnchor.current
        : a0.rowId;
      selectionAnchor.current = anchor;
      setSelected(rowSpan(cur, anchor, target.id));
      activate({ rowId: target.id, key: a0.key }, { scroll: true });
      return;
    }
    if (cur.selected.length) setSelected([]);
    const from = opts.extend && cur.range ? cur.range.focus : cur.active;
    if (!from) {
      const first = refAt(0, cur.cols[0]?.key ?? "");
      if (first) activate(first, { scroll: true });
      return;
    }
    const flat =
      (from.group ? cur.groupIndexById.get(from.rowId) : cur.indexById.get(from.rowId)) ?? -1;
    if (dir === "up" || dir === "down") {
      if (opts.extend) {
        // Ranges span rows only.
        let n = cur.navRows.indexOf(flat);
        if (n < 0) return;
        n = dir === "up" ? Math.max(0, n - 1) : Math.min(cur.navRows.length - 1, n + 1);
        const target = rowItemAt(cur.navRows[n] ?? -1);
        if (!target || !cur.active) return;
        setRange({
          anchor: cur.range?.anchor ?? cur.active,
          focus: { rowId: target.id, key: from.key },
        });
        ensureVisible(cur.navRows[n] ?? -1, from.key);
        return;
      }
      const i = dir === "up" ? flat - 1 : flat + 1;
      const target = refAt(i, from.key);
      if (target) activate(target, { scroll: true });
      return;
    }
    // Left / right.
    if (from.group) {
      if (opts.wrap) move(dir === "right" ? "down" : "up");
      return;
    }
    let ci = cur.colIndex.get(from.key) ?? 0;
    let i = flat;
    if (dir === "left") {
      if (ci > 0) ci--;
      else if (opts.wrap) {
        i = flat - 1;
        ci = cur.cols.length - 1;
      }
    } else if (ci < cur.cols.length - 1) ci++;
    else if (opts.wrap) {
      i = flat + 1;
      ci = 0;
    }
    const key = cur.cols[ci]?.key;
    const target = key === undefined ? null : refAt(i, key);
    if (!target) return;
    if (opts.extend && cur.active && !target.group) {
      setRange({ anchor: cur.range?.anchor ?? cur.active, focus: target });
      ensureVisible(i, key);
      return;
    }
    activate(target, { scroll: true });
  };

  const commitText = (then?: "down" | "right" | "left", draftOverride?: string) => {
    const e = ref.current.editing;
    if (e?.kind !== "text") return;
    const col = colOf(e.key);
    const entry = ref.current.allRows.get(e.rowId);
    const text = draftOverride ?? e.draft;
    const value = col ? parseText(col, text) : NOT_PARSED;
    if (col && entry && value === NOT_PARSED) {
      // Refused (a non-number, a negative or out-of-range length…): say why, keep editing.
      const why = parseError(col, text) ?? `Not a valid ${col.title}`;
      const next: Editing = { ...e, draft: text, invalid: why };
      setEditing(next);
      ref.current = { ...ref.current, editing: next };
      showHint(why);
      return;
    }
    setEditing(null);
    ref.current = { ...ref.current, editing: null };
    focusPending.current = true;
    if (col && entry && !valuesEqual(value, col.getValue(entry.row), col.type)) {
      applyEdits([{ rowId: e.rowId, key: e.key, value }]);
    }
    if (then === "down") move("down");
    else if (then === "right") move("right", { wrap: true });
    else if (then === "left") move("left", { wrap: true });
  };

  const cancelEdit = () => {
    setEditing(null);
    ref.current = { ...ref.current, editing: null };
    focusPending.current = true;
  };

  const commitAny = () => {
    if (ref.current.editing?.kind === "text") commitText();
    else if (ref.current.editing) cancelEdit();
  };

  // --- Pickers ---
  const pushMru = (key: string, item: PickerItem) => {
    const list = (mru.current.get(key) ?? []).filter((x) => x.id !== item.id);
    mru.current.set(key, [item, ...list].slice(0, MRU_SIZE));
  };

  const onPick = (item: PickerItem, via: PickVia) => {
    const e = ref.current.editing;
    if (e?.kind !== "picker") return;
    const col = colOf(e.key);
    if (!col) return;
    const link = (x: PickerItem): PickerItem => ({
      id: x.id,
      label: x.label,
      ...(x.secondary !== undefined ? { secondary: x.secondary } : {}),
      ...(x.color !== undefined ? { color: x.color } : {}),
    });
    if (col.type === "multiselect" || col.type === "multilink") {
      const cur = (Array.isArray(e.value) ? e.value : []) as unknown[];
      const has = cur.some((v) =>
        col.type === "multiselect" ? v === item.id : (v as PickerItem).id === item.id,
      );
      const next =
        col.type === "multiselect"
          ? has
            ? cur.filter((v) => v !== item.id)
            : [...cur, item.id]
          : has
            ? cur.filter((v) => (v as PickerItem).id !== item.id)
            : [...cur, link(item)];
      if (col.type === "multilink" && !has) pushMru(col.key, link(item));
      applyEdits([{ rowId: e.rowId, key: e.key, value: next }]);
      const upd = { ...e, value: next, query: "" };
      setEditing(upd);
      ref.current = { ...ref.current, editing: upd };
      if (via === "tab" || via === "shiftTab") {
        cancelEdit();
        move(via === "tab" ? "right" : "left", { wrap: true });
      }
      return;
    }
    const value = col.type === "select" ? item.id : link(item);
    if (col.type === "link") pushMru(col.key, link(item));
    const entry = ref.current.allRows.get(e.rowId);
    if (!entry || !valuesEqual(value, col.getValue(entry.row), col.type))
      applyEdits([{ rowId: e.rowId, key: e.key, value }]);
    cancelEdit();
    if (via === "tab") move("right", { wrap: true });
    else if (via === "shiftTab") move("left", { wrap: true });
  };

  const onPickerClose = (reason: CloseReason) => {
    if (reason === "outside") {
      setEditing(null);
      ref.current = { ...ref.current, editing: null };
      return;
    }
    cancelEdit();
    if (reason === "tab") move("right", { wrap: true });
    else if (reason === "shiftTab") move("left", { wrap: true });
  };

  const onBackspaceEmpty = () => {
    const e = ref.current.editing;
    if (e?.kind !== "picker") return;
    const col = colOf(e.key);
    if (!col || (col.type !== "multiselect" && col.type !== "multilink")) return;
    const cur = (Array.isArray(e.value) ? e.value : []) as unknown[];
    if (cur.length === 0) return;
    const next = cur.slice(0, -1);
    applyEdits([{ rowId: e.rowId, key: e.key, value: next }]);
    const upd = { ...e, value: next };
    setEditing(upd);
    ref.current = { ...ref.current, editing: upd };
  };

  // --- Insert / duplicate / delete ---
  const positionFor = (
    target: CellRef | null | undefined,
    where: "above" | "below",
  ): InsertPosition => {
    if (!target) return {};
    if (target.group) return { groupId: target.rowId };
    const it = rowItem(target.rowId);
    if (!it) return {};
    const pos: InsertPosition = where === "below" ? { afterRowId: it.id } : { beforeRowId: it.id };
    if (it.groupId !== undefined) pos.groupId = it.groupId;
    return pos;
  };

  const afterInsert = (newId: string, pos: InsertPosition) => {
    const layout = releaseHold() ?? ref.current.items;
    const h: Hold = { id: newId, groupId: pos.groupId, index: slotFor(pos, layout) };
    setHold(h);
    ref.current = { ...ref.current, hold: h };
    pendingFocus.current = { id: newId, focus: true };
    expandGroup(pos.groupId);
    focusPending.current = true;
    bump();
  };

  const insert = async (pos: InsertPosition) => {
    const fn = ref.current.props.onInsert;
    if (!fn) return;
    commitAny();
    flushActive();
    const newId = await fn(pos);
    afterInsert(newId, pos);
  };
  const runInsert = (pos: InsertPosition) => guard("insert", () => insert(pos));

  /** A row can be duplicated when you could edit it (some editable column). */
  const canDuplicate = (id: string): boolean => {
    const entry = ref.current.allRows.get(id);
    return !!entry && ref.current.cols.some((c) => isEditable(c.col, entry.row));
  };

  const duplicate = async (id: string) => {
    const entry = ref.current.allRows.get(id);
    const fn = ref.current.props.onInsert;
    if (!fn || !entry || !canDuplicate(id)) return;
    commitAny();
    flushActive();
    const pos = positionFor({ rowId: id, key: "" }, "below");
    const newId = await fn(pos);
    for (const c of ref.current.cols) {
      if (!isEditable(c.col, entry.row)) continue;
      const v = c.col.getValue(entry.row);
      if (!valuesEqual(v, emptyValue(c.col.type)))
        guard("edit", () => ref.current.props.onEdit(newId, c.key, v));
    }
    afterInsert(newId, pos);
  };
  const runDuplicate = (id: string) => guard("duplicate", () => duplicate(id));

  /**
   * Deletes rows; more than one (or any, with `ask`: Backspace) needs a confirmation first.
   * Ids no longer in the grid are dropped.
   */
  const deleteRows = (requested: string[], confirmed = false, ask = false) => {
    const ids = requested.filter((id) => ref.current.allRows.has(id));
    if (!ref.current.props.onDelete || ids.length === 0) return;
    commitAny();
    if ((ids.length > 1 || ask) && !confirmed) {
      setConfirm(ids);
      return;
    }
    const cur = ref.current;
    const gone = new Set(ids);
    // Where focus goes afterwards: the next remaining row in display order, else the previous.
    if (!cur.active || cur.active.group || gone.has(cur.active.rowId)) {
      const order = cur.navRows.map((i) => (cur.items[i] as RowItem<Row>).id);
      const idx = order.map((id, i) => (gone.has(id) ? i : -1)).filter((i) => i >= 0);
      const last = Math.max(...idx);
      const firstIdx = Math.min(...idx);
      afterDelete.current =
        order.slice(last + 1).find((id) => !gone.has(id)) ??
        order
          .slice(0, firstIdx)
          .reverse()
          .find((id) => !gone.has(id)) ??
        null;
    }
    guard("delete", () => cur.props.onDelete?.(ids));
    setSelected([]);
  };

  // --- Scroll memory (props.scrollRestore / onScrollPositionChange; README "Scroll memory") ---
  const anchorItem = (key: string) => {
    const cur = ref.current;
    const i = key.startsWith("g:")
      ? cur.groupIndexById.get(key.slice(2))
      : key.startsWith("r:")
        ? cur.indexById.get(key.slice(2))
        : undefined;
    if (i === undefined) return undefined;
    const start = cur.offsets[i] ?? 0;
    return { start, size: (cur.offsets[i + 1] ?? start) - start };
  };
  /** The body offset to scroll to for `position` (scrollTop = body offset of the view's top). */
  const restoreTarget = (position: ScrollPosition) =>
    anchorTarget(position.anchors, anchorItem) ?? position.top;
  const capturePosition = (): ScrollPosition | null => {
    const el = scrollRef.current;
    const cur = ref.current;
    if (!el || cur.items.length === 0) return null;
    // Live measurements, not the last render's `offsets`: this scroll event may be the
    // virtualizer compensating for a row it just measured, before React re-rendered.
    virtualizer.getVirtualItems(); // brings measurementsCache up to date
    const ms = virtualizer.measurementsCache;
    const list = cur.items.map((it, i) => {
      const m = ms[i];
      const start = m ? m.start - HEADER_HEIGHT : (cur.offsets[i] ?? 0);
      return { key: it.key, start, size: m ? m.size : 0 };
    });
    const a = cur.active;
    return {
      anchors: captureAnchors(list, el.scrollTop),
      top: el.scrollTop,
      left: el.scrollLeft,
      active: a ? { rowId: a.rowId, key: a.key, ...(a.group ? { group: true } : {}) } : null,
    };
  };
  const report = () => {
    const on = ref.current.props.onScrollPositionChange;
    if (!on) return;
    const p = capturePosition();
    if (p) on(p);
  };
  const reportRef = useRef(report);
  reportRef.current = report;
  useLayoutEffect(() => {
    const r = props.scrollRestore;
    const el = scrollRef.current;
    if (!el || !r?.position || r.key === restoredKey.current || items.length === 0) return;
    restoredKey.current = r.key;
    const position = r.position;
    el.scrollTop = restoreTarget(position);
    el.scrollLeft = position.left;
    // Lay out the rows at the new offset in this commit (the virtualizer would only hear of
    // it from the scroll event, after a frame of blank rows).
    virtualizer.scrollOffset = el.scrollTop;
    restoreSettle.current = { position, until: performance.now() + 1000, offsets };
    const a = position.active;
    const known = a && (a.group ? groupIndexById.has(a.rowId) : indexById.has(a.rowId));
    const entry = a && !a.group ? allRows.get(a.rowId) : undefined;
    if (a && known) {
      const key = a.key ?? firstEditableKey(entry?.row);
      activate(a.group ? { rowId: a.rowId, key, group: true } : { rowId: a.rowId, key });
    } else if (a?.reveal && entry) {
      // The URL's row, in a group collapsed since: show it the way focusRow does.
      expandGroup(entry.groupId);
      pendingFocus.current = { id: a.rowId, key: a.key, focus: true, center: true };
    }
    bump();
  });
  // Auto rows: measuring the restored rows (estimated until rendered) can move them.
  useLayoutEffect(() => {
    const st = restoreSettle.current;
    const el = scrollRef.current;
    if (!st || !el) return;
    if (performance.now() > st.until) restoreSettle.current = null;
    else if (st.offsets !== offsets) {
      st.offsets = offsets;
      const top = restoreTarget(st.position);
      if (Math.abs(el.scrollTop - top) > 1) el.scrollTop = top;
    }
  });
  // Report every scroll (and active cell change) to the consumer, which keeps the latest.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => reportRef.current();
    // Scrolling or keys of your own end a restore's settling.
    const stop = () => {
      restoreSettle.current = null;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    for (const t of ["wheel", "touchstart", "pointerdown", "keydown"])
      el.addEventListener(t, stop, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      for (const t of ["wheel", "touchstart", "pointerdown", "keydown"])
        el.removeEventListener(t, stop);
    };
  }, []);
  const activeSeen = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reports when the active cell changes
  useEffect(() => {
    // Not the mount: nothing has happened yet, and a restore may still be coming.
    if (!activeSeen.current) {
      activeSeen.current = true;
      return;
    }
    reportRef.current();
  }, [active]);

  // Activate a pending row (new row, focusRow) once it shows up in the data; scroll to
  // a pending row; scroll to the active row after Escape released it; FLIP a settled row.
  useLayoutEffect(() => {
    const pf = pendingFocus.current;
    if (pf) {
      const i = indexById.get(pf.id);
      const entry = pf.expand ? ref.current.allRows.get(pf.id) : undefined;
      if (entry) {
        pf.expand = false;
        expandGroup(entry.groupId);
      }
      if (i !== undefined) {
        pendingFocus.current = null;
        const it = items[i];
        const key = pf.key ?? firstEditableKey(it?.kind === "row" ? it.row : undefined);
        activate({ rowId: pf.id, key }, { scroll: pf.center ? "center" : true, focus: pf.focus });
      }
    }
    const ps = pendingScroll.current;
    if (ps !== null && indexById.has(ps)) {
      pendingScroll.current = null;
      ensureVisible(indexById.get(ps) ?? -1);
    }
    if (scrollActive.current) {
      scrollActive.current = false;
      const a = ref.current.active;
      if (a) ensureVisible(indexOfRef(a) ?? -1, a.group ? undefined : a.key);
    }
    const f = flip.current;
    if (f) {
      flip.current = null;
      const to = indexById.get(f.id);
      const el = [...(rootRef.current?.querySelectorAll<HTMLElement>("[data-row-id]") ?? [])].find(
        (x) => x.dataset.rowId === f.id,
      );
      if (to !== undefined && el?.animate && !prefersReducedMotion()) {
        const end = offsets[to] ?? 0;
        if (end !== f.from)
          el.animate(
            [{ transform: `translateY(${f.from}px)` }, { transform: `translateY(${end}px)` }],
            { duration: SLIDE_MS, easing: "ease-out" },
          );
      }
    }
    // Auto rows: measuring the rows around a row we just scrolled to can move it; keep it in
    // view until the layout settles.
    const st = settle.current;
    if (st) {
      if (performance.now() > st.until) settle.current = null;
      else if (st.offsets !== offsets) {
        st.offsets = offsets;
        const i = indexOfRef(st.target);
        if (i !== undefined)
          ensureVisible(i, st.target.group ? undefined : st.target.key, st.center);
      }
    }
  });

  // The user scrolling ends any settling (see `settle`).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const stop = () => {
      settle.current = null;
    };
    el.addEventListener("wheel", stop, { passive: true });
    el.addEventListener("touchstart", stop, { passive: true });
    el.addEventListener("pointerdown", stop, { passive: true });
    return () => {
      el.removeEventListener("wheel", stop);
      el.removeEventListener("touchstart", stop);
      el.removeEventListener("pointerdown", stop);
    };
  }, []);

  // While typing in a cell, keep the editor (and the caret) in view: an auto row grows with
  // the text, a fixed row's editor overlays the rows below. Runs when the draft changes,
  // never on a plain scroll, so you can still scroll away from the cell you're editing.
  useLayoutEffect(() => {
    if (editing?.kind !== "text") return;
    const el = scrollRef.current;
    const editor = rootRef.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      "[data-editor='true']",
    );
    if (!el || !editor) return;
    if (ref.current.auto) {
      // The row grew or shrank with the draft: tell the virtualizer now, so the rows below
      // move in this frame instead of after the next resize observation.
      const rowEl = editor.closest<HTMLElement>("[data-index]");
      const index = Number(rowEl?.dataset.index);
      if (rowEl && Number.isInteger(index) && rowEl.offsetHeight > 0)
        virtualizer.resizeItem(index, rowEl.offsetHeight);
    }
    const box = el.getBoundingClientRect();
    const r = editor.getBoundingClientRect();
    const sticky = ref.current.props.groups ? GROUP_HEIGHT : 0;
    const top = editorScrollTarget(
      el.scrollTop,
      { top: r.top, bottom: r.bottom },
      { top: box.top + HEADER_HEIGHT + sticky, bottom: box.top + el.clientHeight },
      editor.selectionEnd === editor.value.length,
    );
    if (top !== null) el.scrollTop = top;
  }, [editing, virtualizer]);

  // If the active row disappears (deleted, collapsed away, removed remotely), move to a
  // neighbor instead of dropping focus on <body>.
  useLayoutEffect(() => {
    if (!active) return;
    const idx = indexOfRef(active);
    if (idx !== undefined) {
      lastSeen.current = {
        flat: idx,
        groupId: active.group ? active.rowId : rowItemAt(idx)?.groupId,
      };
      return;
    }
    if (pendingFocus.current?.id === active.rowId) return;
    if (editing?.rowId === active.rowId) {
      setEditing(null);
      ref.current = { ...ref.current, editing: null };
    }
    const root = rootRef.current;
    const hadFocus =
      !document.activeElement ||
      document.activeElement === document.body ||
      !!root?.contains(document.activeElement);
    let next: CellRef | null = null;
    const ad = afterDelete.current;
    afterDelete.current = null;
    const seen = lastSeen.current;
    if (ad && indexById.has(ad)) next = { rowId: ad, key: active.key };
    else if (
      seen?.groupId !== undefined &&
      collapsed.has(seen.groupId) &&
      groupIndexById.has(seen.groupId)
    )
      next = { rowId: seen.groupId, key: active.key, group: true };
    else if (seen && items.length) next = refAt(Math.min(seen.flat, items.length - 1), active.key);
    if (next) activate(next, { scroll: true, focus: hadFocus });
    else {
      setActive(null);
      ref.current = { ...ref.current, active: null };
    }
  });

  // Report the active row (after paint, so ↑/↓ stay snappy). `flushActive` reports it at
  // once when a callback that depends on it is about to run: an insert right after a click
  // (a fast keypress beats the passive effect) must reach the consumer after the click's
  // report, or the late report undoes what the insert set up (the view's filter hold).
  const activeRowId = active && !active.group ? active.rowId : null;
  const onActiveRowChange = props.onActiveRowChange;
  const reported = useRef<{ id: string | null; to: unknown } | null>(null);
  const flushActive = () => {
    const a = ref.current.active;
    const id = a && !a.group ? a.rowId : null;
    const to = ref.current.props.onActiveRowChange;
    if (reported.current?.id === id && reported.current.to === to) return;
    reported.current = { id, to };
    to?.(id);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: flushActive reads the same values through `ref`
  useEffect(() => {
    flushActive();
  }, [activeRowId, onActiveRowChange]);

  // Move DOM focus to the active cell after keyboard/mouse navigation and edits, and put it
  // back if this commit moved the focused row's DOM node (a re-sort), which drops focus.
  useLayoutEffect(() => {
    // Read through the ref: an earlier effect in this commit may have moved the active cell.
    const a = ref.current.active;
    const root = rootRef.current;
    if (
      hadFocus.current &&
      root &&
      (!document.activeElement || document.activeElement === document.body)
    )
      focusPending.current = true;
    if (!focusPending.current || ref.current.editing || !a || confirm || menu) return;
    const cell = findCell(a);
    if (cell) {
      focusPending.current = false;
      if (document.activeElement !== cell) cell.focus({ preventScroll: true });
    }
  });

  const findCell = (a: CellRef): HTMLElement | null => {
    const root = rootRef.current;
    if (!root) return null;
    const rowEl = a.group
      ? [...root.querySelectorAll<HTMLElement>("[data-group-id]")].find(
          (el) => el.dataset.groupId === a.rowId,
        )
      : [...root.querySelectorAll<HTMLElement>("[data-row-id]")].find(
          (el) => el.dataset.rowId === a.rowId,
        );
    const cells = [...(rowEl?.querySelectorAll<HTMLElement>("[data-cell]") ?? [])];
    return cells.find((el) => el.dataset.col === a.key) ?? cells[0] ?? null;
  };

  // Anchor for the picker popover: the editing cell.
  useLayoutEffect(() => {
    if (editing?.kind !== "picker") {
      if (pickerAnchor) setPickerAnchor(null);
      return;
    }
    const cell = findCell({ rowId: editing.rowId, key: editing.key });
    const exact = cell?.dataset.col === editing.key ? cell : null;
    if (exact !== pickerAnchor) setPickerAnchor(exact);
  });

  // --- Imperative handle ---
  const expandGroupRef = useRef(expandGroup);
  expandGroupRef.current = expandGroup;
  const activateRef = useRef(activate);
  activateRef.current = activate;
  const selectionOps = useRef({ setSelected, deleteRows, setRange });
  selectionOps.current = { setSelected, deleteRows, setRange };
  useImperativeHandle(
    props.ref,
    () => ({
      selectRows(ids: string[]) {
        selectionOps.current.setSelected(ids.filter((id) => ref.current.allRows.has(id)));
      },
      clearSelection() {
        selectionOps.current.setRange(null);
        selectionOps.current.setSelected([]);
        // Called from outside (a selection bar that's about to unmount): back to the cell.
        focusPending.current = true;
        bump();
      },
      deleteRows(ids: string[]) {
        selectionOps.current.deleteRows(ids);
        focusPending.current = true;
        bump();
      },
      focusRow(id: string, columnKey?: string) {
        // A row the grid hasn't rendered yet (an optimistic insert) is focused in the commit
        // that adds it, so keys typed right after "+ Add" land in it.
        const entry = ref.current.allRows.get(id);
        if (entry) expandGroupRef.current(entry.groupId);
        pendingFocus.current = { id, key: columnKey, focus: true, center: true, expand: !entry };
        bump();
      },
      stepRow(delta: number) {
        const cur = ref.current;
        const a = cur.active;
        const flat = a && !a.group ? cur.indexById.get(a.rowId) : undefined;
        let n = flat === undefined ? -1 : cur.navRows.indexOf(flat);
        n = n < 0 ? 0 : Math.max(0, Math.min(cur.navRows.length - 1, n + delta));
        const it = cur.items[cur.navRows[n] ?? -1];
        if (it?.kind !== "row") return null;
        const key = a && !a.group ? a.key : (cur.cols[0]?.key ?? "");
        activateRef.current({ rowId: it.id, key }, { scroll: true, focus: false });
        bump();
        return it.id;
      },
      scrollToRow(id: string) {
        const entry = ref.current.allRows.get(id);
        if (!entry) return;
        expandGroupRef.current(entry.groupId);
        pendingScroll.current = id;
        bump();
      },
    }),
    [],
  );

  // --- Keyboard ---
  const onKeyDown = (e: React.KeyboardEvent) => {
    // IME composition: keys belong to the input method.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const target = e.target as HTMLElement;
    const cur = ref.current;
    if (cur.drag && e.key === "Escape") {
      endDrag(false);
      return;
    }
    const inEditor = target.dataset.editor === "true";
    if (!inEditor && (target.tagName === "BUTTON" || !target.closest("[data-cell]"))) return;
    const mod = isMod(e);

    // Shortcuts that work while editing too.
    if (mod && e.shiftKey && e.key === "Enter") {
      e.preventDefault();
      runInsert(positionFor(cur.active, "below"));
      return;
    }
    if (mod && e.shiftKey && e.key === "ArrowUp") {
      e.preventDefault();
      runInsert(positionFor(cur.active, "above"));
      return;
    }

    if (cur.editing) {
      if (cur.editing.kind === "picker") {
        // Keys typed before the picker's search box took focus: add them to its query.
        if (!inEditor && e.key.length === 1 && !mod && !e.altKey) {
          e.preventDefault();
          const upd = { ...cur.editing, query: cur.editing.query + e.key };
          setEditing(upd);
          ref.current = { ...ref.current, editing: upd };
        }
        return;
      }
      const ghost =
        cur.editing.draft === ""
          ? decorationOf(cur.editing.rowId, cur.editing.key)?.ghost
          : undefined;
      if (e.key === "Enter" && !e.shiftKey && !mod) {
        e.preventDefault();
        commitText("down");
      } else if (e.key === "Tab") {
        e.preventDefault();
        commitText(e.shiftKey ? "left" : "right", !e.shiftKey && ghost ? ghost : undefined);
      } else if (e.key === "ArrowRight" && ghost) {
        e.preventDefault();
        const upd = { ...cur.editing, draft: ghost };
        setEditing(upd);
        ref.current = { ...ref.current, editing: upd };
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelEdit();
      }
      return;
    }

    const a = cur.active;
    if (mod && (e.key === "z" || e.key === "Z")) {
      e.preventDefault();
      replay(e.shiftKey ? "redo" : "undo");
      return;
    }
    if (mod && (e.key === "y" || e.key === "Y")) {
      e.preventDefault();
      replay("redo");
      return;
    }
    if (mod && (e.key === "a" || e.key === "A")) {
      e.preventDefault();
      setSelected(cur.navRows.map((i) => (cur.items[i] as RowItem<Row>).id));
      return;
    }

    // Group header row: toggle / collapse / expand; arrows move on.
    if (a?.group) {
      const isCollapsed = cur.collapsed.has(a.rowId);
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleGroup(a.rowId);
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        if ((e.key === "ArrowLeft") !== isCollapsed) toggleGroup(a.rowId);
        return;
      }
    }

    if (mod && (e.key === "d" || e.key === "D")) {
      e.preventDefault();
      if (a && !a.group) runDuplicate(a.rowId);
      return;
    }
    switch (e.key) {
      case "ArrowUp":
      case "ArrowDown":
      case "ArrowLeft":
      case "ArrowRight": {
        e.preventDefault();
        if (e.key === "ArrowRight" && a && !a.group && !e.shiftKey && acceptGhost(a.rowId, a.key)) {
          move("right");
          return;
        }
        const dir = e.key.slice(5).toLowerCase() as "up" | "down" | "left" | "right";
        move(dir, { extend: e.shiftKey });
        return;
      }
      case "Tab": {
        const flat = indexOfRef(a) ?? -1;
        const lastCell =
          a &&
          flat === cur.items.length - 1 &&
          (a.group || cur.colIndex.get(a.key) === cur.cols.length - 1);
        const firstCell = a && flat === 0 && (a.group || cur.colIndex.get(a.key) === 0);
        if ((e.shiftKey && firstCell) || (!e.shiftKey && lastCell)) return; // let focus leave the grid
        e.preventDefault();
        if (!e.shiftKey && a && !a.group) acceptGhost(a.rowId, a.key);
        move(e.shiftKey ? "left" : "right", { wrap: true });
        return;
      }
      case "Enter":
      case "F2":
        e.preventDefault();
        if (a && !a.group) startEdit(a.rowId, a.key);
        return;
      case " ":
        e.preventDefault();
        if (a && !a.group) cur.props.onOpenRow?.(a.rowId);
        return;
      case "Escape": {
        // Nothing to cancel (no range, no row selection, no held row that would move):
        // let the page handle it (e.g. close a detail panel).
        const idle = !cur.range && cur.selected.length === 0 && !holdWouldMove();
        setRange(null);
        setSelected([]);
        if (cur.hold) {
          releaseHold();
          scrollActive.current = true;
          focusPending.current = true;
        }
        if (idle) cur.props.onEscape?.();
        return;
      }
      case "Delete":
      case "Backspace": {
        e.preventDefault();
        if (!a || a.group) return;
        // Delete / Backspace remove the selected rows when the active row is one of them
        // (Backspace always asks first, even for one row: it's also the clear-cell key);
        // otherwise they clear cells (a range, else the active cell).
        if (cur.selected.length > 0 && cur.selected.includes(a.rowId)) {
          deleteRows(cur.selected, false, e.key === "Backspace");
          return;
        }
        const edits: Edit[] = [];
        for (const { item, col } of rangeCells()) {
          if (item.section && col.key !== cur.labelKey) continue;
          if (!isEditable(col, item.row)) continue;
          const empty = emptyValue(col.type);
          if (!valuesEqual(col.getValue(item.row), empty))
            edits.push({ rowId: item.id, key: col.key, value: empty });
        }
        if (edits.length) applyEdits(edits);
        return;
      }
      case "ContextMenu":
      case "F10":
        if (e.key === "F10" && !e.shiftKey) return;
        e.preventDefault();
        if (a && !a.group) {
          const r = target.getBoundingClientRect();
          setMenu({ x: r.left + 8, y: r.bottom, rowId: a.rowId });
        }
        return;
    }
    if (a && !a.group && e.key.length === 1 && !mod && !e.altKey) {
      e.preventDefault();
      startEdit(a.rowId, a.key, e.key);
    }
  };

  /** Cells in the current range, or the active cell. */
  const rangeCells = (): { item: RowItem<Row>; col: Column<Row> }[] => {
    const cur = ref.current;
    const r = cur.range ?? (cur.active ? { anchor: cur.active, focus: cur.active } : null);
    if (!r || r.anchor.group || r.focus.group) return [];
    const n0 = cur.navRows.indexOf(cur.indexById.get(r.anchor.rowId) ?? -1);
    const n1 = cur.navRows.indexOf(cur.indexById.get(r.focus.rowId) ?? -1);
    const c0 = cur.colIndex.get(r.anchor.key) ?? 0;
    const c1 = cur.colIndex.get(r.focus.key) ?? 0;
    if (n0 < 0 || n1 < 0) return [];
    const out: { item: RowItem<Row>; col: Column<Row> }[] = [];
    for (let n = Math.min(n0, n1); n <= Math.max(n0, n1); n++) {
      const item = rowItemAt(cur.navRows[n] ?? -1);
      if (!item) continue;
      for (let c = Math.min(c0, c1); c <= Math.max(c0, c1); c++) {
        const col = cur.cols[c]?.col;
        if (col) out.push({ item, col });
      }
    }
    return out;
  };

  // --- Clipboard ---
  const onCopy = (e: React.ClipboardEvent) => {
    const cur = ref.current;
    if (cur.editing || !(e.target as HTMLElement).closest?.("[data-cell]")) return;
    let grid: string[][];
    if (cur.selected.length > 0) {
      grid = cur.navRows
        .map((i) => cur.items[i] as RowItem<Row>)
        .filter((it) => cur.selected.includes(it.id))
        .map((it) => cur.cols.map((c) => copyText(c.col, c.col.getValue(it.row))));
    } else {
      const byRow = new Map<string, string[]>();
      for (const { item, col } of rangeCells()) {
        const list = byRow.get(item.id) ?? [];
        list.push(copyText(col, col.getValue(item.row)));
        byRow.set(item.id, list);
      }
      grid = [...byRow.values()];
    }
    if (grid.length === 0) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", toTsv(grid));
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const cur = ref.current;
    const a = cur.active;
    if (cur.editing || !a || a.group || !(e.target as HTMLElement).closest?.("[data-cell]")) return;
    const files = [...(e.clipboardData.files ?? [])];
    if (files.length > 0) {
      // Pasted files (a screenshot) go to an attachment cell.
      const col = colOf(a.key);
      const entry = cur.allRows.get(a.rowId);
      e.preventDefault();
      if (col && entry && canTakeFiles(col, entry.row)) col.onFiles?.(entry.row, files);
      return;
    }
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    e.preventDefault();
    const data = parseTsv(text);
    const r = cur.range ?? { anchor: a, focus: a };
    const n0 = cur.navRows.indexOf(cur.indexById.get(r.anchor.rowId) ?? -1);
    const n1 = cur.navRows.indexOf(cur.indexById.get(r.focus.rowId) ?? -1);
    const c0 = cur.colIndex.get(r.anchor.key) ?? 0;
    const c1 = cur.colIndex.get(r.focus.key) ?? 0;
    const top = Math.min(n0, n1);
    const left = Math.min(c0, c1);
    const single = data.length === 1 && data[0]?.length === 1;
    const fill = single && !!cur.range;
    const colsN = fill ? Math.abs(c1 - c0) + 1 : Math.max(...data.map((d) => d.length));
    const edits: Edit[] = [];
    const pasteRow = (item: RowItem<Row>, values: (dc: number) => string | undefined) => {
      for (let dc = 0; dc < colsN; dc++) {
        const col = cur.cols[left + dc]?.col;
        const raw = values(dc);
        if (!col || raw === undefined || !PASTE_TYPES.has(col.type) || !isEditable(col, item.row))
          continue;
        const value = parseText(col, raw);
        if (value === NOT_PARSED || valuesEqual(value, col.getValue(item.row), col.type)) continue;
        edits.push({ rowId: item.id, key: col.key, value });
      }
    };
    if (fill) {
      for (let n = top; n <= Math.max(n0, n1); n++) {
        const item = rowItemAt(cur.navRows[n] ?? -1);
        if (item && !item.section) pasteRow(item, () => data[0]?.[0]);
      }
    } else {
      // Section rows are skipped without consuming a pasted row.
      let n = top;
      for (const values of data) {
        let item = rowItemAt(cur.navRows[n] ?? -1);
        while (item?.section) item = rowItemAt(cur.navRows[++n] ?? -1);
        if (!item) break;
        pasteRow(item, (dc) => values[dc]);
        n++;
      }
    }
    if (edits.length) applyEdits(edits);
  };

  // --- Files dropped onto attachment cells ---
  const dropTarget = (
    e: React.DragEvent,
  ): { cell: HTMLElement; row: Row; col: Column<Row> } | null => {
    if (!e.dataTransfer?.types?.includes("Files")) return null;
    const cell = (e.target as HTMLElement).closest?.<HTMLElement>("[data-cell]");
    const rowId = cell?.closest<HTMLElement>("[data-row-id]")?.dataset.rowId;
    const col = cell?.dataset.col ? colOf(cell.dataset.col) : undefined;
    const entry = rowId ? ref.current.allRows.get(rowId) : undefined;
    if (!cell || !col || !entry || !canTakeFiles(col, entry.row)) return null;
    return { cell, row: entry.row, col };
  };
  const dropCell = useRef<HTMLElement | null>(null);
  const markDrop = (cell: HTMLElement | null) => {
    if (dropCell.current === cell) return;
    dropCell.current?.removeAttribute("data-drop");
    cell?.setAttribute("data-drop", "true");
    dropCell.current = cell;
  };
  const onFileDragOver = (e: React.DragEvent) => {
    const t = dropTarget(e);
    markDrop(t?.cell ?? null);
    if (!t) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const onFileDragLeave = (e: React.DragEvent) => {
    if (!rootRef.current?.contains(e.relatedTarget as Node | null)) markDrop(null);
  };
  const onFileDrop = (e: React.DragEvent) => {
    const t = dropTarget(e);
    markDrop(null);
    if (!t) return;
    e.preventDefault();
    const files = [...e.dataTransfer.files];
    if (files.length) t.col.onFiles?.(t.row, files);
  };

  // --- Focus ---
  // A cell focused some other way (Tab into the grid, screen reader) becomes the active one.
  const onFocus = (e: React.FocusEvent) => {
    const t = e.target as HTMLElement;
    if (!t.dataset?.cell) return;
    const groupEl = t.closest<HTMLElement>("[data-group-id]");
    const rowEl = t.closest<HTMLElement>("[data-row-id]");
    const next: CellRef | null = groupEl?.dataset.groupId
      ? { rowId: groupEl.dataset.groupId, key: ref.current.active?.key ?? "", group: true }
      : rowEl?.dataset.rowId
        ? { rowId: rowEl.dataset.rowId, key: t.dataset.col ?? "" }
        : null;
    const a = ref.current.active;
    if (
      !next ||
      (a && a.rowId === next.rowId && !!a.group === !!next.group && (a.group || a.key === next.key))
    )
      return;
    activate(next, { focus: false });
  };

  // Focus leaving the grid ends the hold (and commits a text edit).
  const onBlur = () => {
    setTimeout(() => {
      const root = rootRef.current;
      const el = document.activeElement;
      if (!root) return;
      if (el && (root.contains(el) || el.closest(`[data-grid-portal="${gridId}"]`))) return;
      if (ref.current.editing?.kind === "text") {
        const e = ref.current.editing;
        const col = colOf(e.key);
        const entry = ref.current.allRows.get(e.rowId);
        setEditing(null);
        ref.current = { ...ref.current, editing: null };
        if (col && entry) {
          const value = parseText(col, e.draft);
          if (value === NOT_PARSED) {
            showHint(`Not saved: ${parseError(col, e.draft) ?? `not a valid ${col.title}`}`);
          } else if (!valuesEqual(value, col.getValue(entry.row), col.type)) {
            applyEdits([{ rowId: e.rowId, key: e.key, value }]);
          }
        }
      }
      releaseHold();
    }, 0);
  };

  // --- Drag to reorder ---
  const dragPointer = useRef<{ rowId: string; clientY: number; timer: number } | null>(null);

  const gapAt = (y: number): number => {
    const o = ref.current.offsets;
    const n = ref.current.items.length;
    if (y <= 0) return 0;
    if (y >= (o[n] ?? 0)) return n;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((o[mid] as number) <= y) lo = mid;
      else hi = mid - 1;
    }
    const mid = ((o[lo] as number) + (o[lo + 1] as number)) / 2;
    return y < mid ? lo : lo + 1;
  };

  /** Where a drop at `gap` (between items gap-1 and gap) puts the row, or null for no move. */
  const resolveDrop = (dragged: string, gap: number): InsertPosition | null => {
    const its = ref.current.items;
    let p = gap - 1;
    while (p >= 0 && its[p]?.kind === "row" && (its[p] as RowItem<Row>).id === dragged) p--;
    let n = gap;
    while (n < its.length && its[n]?.kind === "row" && (its[n] as RowItem<Row>).id === dragged) n++;
    const P = its[p];
    const N = its[n];
    let pos: InsertPosition | null = null;
    const withGroup = (x: InsertPosition, g: string | undefined): InsertPosition =>
      g === undefined ? x : { ...x, groupId: g };
    if (P?.kind === "row") pos = withGroup({ afterRowId: P.id }, P.groupId);
    else if (P?.kind === "group") {
      if (!P.collapsed && N?.kind === "row" && N.groupId === P.group.id)
        pos = withGroup({ beforeRowId: N.id }, P.group.id);
      else pos = { groupId: P.group.id };
    } else if (N?.kind === "row") pos = withGroup({ beforeRowId: N.id }, N.groupId);
    else if (N?.kind === "group") {
      const NN = its[n + 1];
      pos =
        NN?.kind === "row" && NN.groupId === N.group.id && !N.collapsed
          ? { beforeRowId: NN.id, groupId: N.group.id }
          : { groupId: N.group.id };
    }
    if (!pos) return null;
    // No-op if the row would land where it already is.
    const d = ref.current.indexById.get(dragged) ?? -1;
    const me = its[d] as RowItem<Row> | undefined;
    const before = its[d - 1];
    const after = its[d + 1];
    const sameGroup = pos.groupId === me?.groupId;
    if (sameGroup && pos.afterRowId && before?.kind === "row" && before.id === pos.afterRowId)
      return null;
    if (sameGroup && pos.beforeRowId && after?.kind === "row" && after.id === pos.beforeRowId)
      return null;
    if (
      sameGroup &&
      !pos.afterRowId &&
      !pos.beforeRowId &&
      before?.kind === "group" &&
      after?.kind !== "row"
    )
      return null;
    return pos;
  };

  const updateGap = () => {
    const d = dragPointer.current;
    const body = bodyRef.current;
    if (!d || !body) return;
    const y = d.clientY - body.getBoundingClientRect().top;
    const gap = gapAt(y);
    setDrag((cur) => (cur && cur.gap !== gap ? { ...cur, gap } : cur));
  };

  const onDragMove = (e: PointerEvent) => {
    if (!dragPointer.current) return;
    dragPointer.current.clientY = e.clientY;
    updateGap();
  };
  const onDragUp = () => endDrag(true);

  const endDrag = (drop: boolean) => {
    const d = dragPointer.current;
    removeDragListeners();
    if (d) clearInterval(d.timer);
    dragPointer.current = null;
    const state = ref.current.drag;
    setDrag(null);
    ref.current = { ...ref.current, drag: null };
    if (!drop || !state || state.gap === null) return;
    const pos = resolveDrop(state.rowId, state.gap);
    if (!pos) return;
    const layout = ref.current.items;
    guard("move", () => ref.current.props.onMove?.(state.rowId, pos));
    // Dropping onto a collapsed group opens it, so you can see where the row went.
    expandGroup(pos.groupId);
    // Keep the moved row in its new group until focus leaves it (the data may lag).
    const h: Hold = {
      id: state.rowId,
      groupId: pos.groupId,
      index: slotFor(pos, layout, state.rowId),
    };
    setHold(h);
    ref.current = { ...ref.current, hold: h };
    const next = {
      rowId: state.rowId,
      key: ref.current.active?.key || ref.current.cols[0]?.key || "",
    };
    setActive(next);
    ref.current = { ...ref.current, active: next };
    focusPending.current = true;
  };
  const onDragMoveRef = useRef(onDragMove);
  const onDragUpRef = useRef(onDragUp);
  onDragMoveRef.current = onDragMove;
  onDragUpRef.current = onDragUp;
  const stableMove = useCallback((e: PointerEvent) => onDragMoveRef.current(e), []);
  const stableUp = useCallback(() => onDragUpRef.current(), []);

  const startDrag = (id: string, e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    if (ref.current.sortOn) {
      showHint("Reordering by drag is off while a live sort is on. Remove the sort to drag rows.");
      return;
    }
    if (!ref.current.props.onMove) return;
    e.preventDefault();
    commitAny();
    releaseHold();
    const timer = window.setInterval(() => {
      const d = dragPointer.current;
      const el = scrollRef.current;
      if (!d || !el) return;
      const r = el.getBoundingClientRect();
      const topEdge = r.top + HEADER_HEIGHT + 24;
      if (d.clientY < topEdge) el.scrollTop -= Math.min(30, (topEdge - d.clientY) / 2 + 4);
      else if (d.clientY > r.bottom - 24)
        el.scrollTop += Math.min(30, (d.clientY - r.bottom + 24) / 2 + 4);
      else return;
      updateGap();
    }, 30);
    dragPointer.current = { rowId: id, clientY: e.clientY, timer };
    setDrag({ rowId: id, gap: null });
    ref.current = { ...ref.current, drag: { rowId: id, gap: null } };
    window.addEventListener("pointermove", stableMove);
    window.addEventListener("pointerup", stableUp);
    window.addEventListener("pointercancel", stableUp);
  };
  function removeDragListeners() {
    window.removeEventListener("pointermove", stableMove);
    window.removeEventListener("pointerup", stableUp);
    window.removeEventListener("pointercancel", stableUp);
  }
  useEffect(
    () => () => {
      window.removeEventListener("pointermove", stableMove);
      window.removeEventListener("pointerup", stableUp);
      window.removeEventListener("pointercancel", stableUp);
      if (dragPointer.current) clearInterval(dragPointer.current.timer);
      window.clearTimeout(hintTimer.current);
    },
    [stableMove, stableUp],
  );

  // --- Column resize ---
  const startResize = (key: string, e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const c = cols.find((x) => x.key === key);
    if (!c) return;
    const startX = e.clientX;
    const startW = c.width;
    const min = c.col.minWidth ?? MIN_WIDTH;
    let last = startW;
    const moveH = (ev: PointerEvent) => {
      last = Math.max(min, Math.round(startW + ev.clientX - startX));
      setWidths((w) => ({ ...w, [key]: last }));
    };
    const up = () => {
      window.removeEventListener("pointermove", moveH);
      window.removeEventListener("pointerup", up);
      if (last !== startW) props.onColumnResize?.(key, last);
    };
    window.addEventListener("pointermove", moveH);
    window.addEventListener("pointerup", up);
  };
  const resizeBy = (key: string, delta: number) => {
    const c = cols.find((x) => x.key === key);
    if (!c) return;
    const w = Math.max(c.col.minWidth ?? MIN_WIDTH, c.width + delta);
    setWidths((ws) => ({ ...ws, [key]: w }));
    props.onColumnResize?.(key, w);
  };

  // --- Drag a header to reorder columns ---
  // Pointer events like the row drag (not HTML5 drag and drop, which the file drop uses).
  // The drag starts after COL_DRAG_SLOP px, so a plain click on a header does nothing new.
  const colPointer = useRef<{
    key: string;
    startX: number;
    clientX: number;
    active: boolean;
    gap: number | null;
    timer: number;
  } | null>(null);
  /** The resize handle to refocus after a keyboard move (if the move lands soon). */
  const refocusResizer = useRef<{ key: string; at: number } | null>(null);

  /** Where a shown column sits in the scroll viewport: frozen ones stick, the rest scroll under them. */
  const colEdges = (c: ColLayout<Row>, scrollLeft: number, frozenW: number) =>
    c.frozen
      ? { l: c.left, r: c.left + c.width }
      : { l: Math.max(frozenW, c.left - scrollLeft), r: c.left + c.width - scrollLeft };

  /** The gap (0..cols.length) nearest viewport x, and where its drop line goes. */
  const columnGapAt = (x: number): { gap: number; lineX: number } => {
    const { cols: cs, frozenWidth: fw } = ref.current;
    const sl = scrollRef.current?.scrollLeft ?? 0;
    const inFrozen = x < fw;
    let gap = -1;
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i] as ColLayout<Row>;
      if (c.frozen !== inFrozen) continue;
      const e = colEdges(c, sl, fw);
      if (e.r <= e.l) continue; // scrolled under the frozen columns
      if (x < (e.l + e.r) / 2) {
        gap = i;
        break;
      }
    }
    if (gap < 0) gap = inFrozen ? cs.filter((c) => c.frozen).length : cs.length;
    const prev = cs[gap - 1];
    const next = cs[gap];
    const lineX =
      prev && (prev.frozen || !next)
        ? colEdges(prev, sl, fw).r
        : next
          ? colEdges(next, sl, fw).l
          : ROWNUM_WIDTH;
    return { gap, lineX };
  };

  /** The move a drop at `gap` asks for, or null when the column would stay put. */
  const columnTarget = (key: string, gap: number): ColumnMoveTarget | null => {
    const cs = ref.current.cols;
    const from = ref.current.colIndex.get(key);
    if (from === undefined || gap === from || gap === from + 1) return null;
    const next = cs[gap];
    if (next) return { before: next.key };
    const last = cs[cs.length - 1];
    return last ? { after: last.key } : null;
  };

  const updateColGap = () => {
    const p = colPointer.current;
    const el = scrollRef.current;
    if (!p?.active || !el) return;
    const r = el.getBoundingClientRect();
    const { gap, lineX } = columnGapAt(p.clientX - r.left);
    p.gap = gap;
    const x = Math.max(0, Math.min(el.clientWidth, lineX));
    setColDrag((cur) =>
      cur && cur.gap === gap && cur.x === x ? cur : { key: p.key, gap, x, height: el.clientHeight },
    );
  };

  const onColMove = (e: PointerEvent) => {
    const p = colPointer.current;
    if (!p) return;
    p.clientX = e.clientX;
    if (!p.active) {
      if (Math.abs(e.clientX - p.startX) < COL_DRAG_SLOP) return;
      p.active = true;
      commitAny();
      p.timer = window.setInterval(() => {
        const d = colPointer.current;
        const el = scrollRef.current;
        if (!d || !el) return;
        const r = el.getBoundingClientRect();
        const fw = ref.current.frozenWidth;
        const leftEdge = r.left + fw + 24;
        // Near the frozen columns' edge, not over them (that's aiming at a frozen spot).
        const overFrozen = fw > ROWNUM_WIDTH && d.clientX < r.left + fw;
        if (d.clientX < leftEdge && !overFrozen && el.scrollLeft > 0)
          el.scrollLeft -= Math.min(30, (leftEdge - d.clientX) / 2 + 4);
        else if (d.clientX > r.right - 24)
          el.scrollLeft += Math.min(30, (d.clientX - r.right + 24) / 2 + 4);
        else return;
        updateColGap();
      }, 30);
    }
    updateColGap();
  };

  const endColDrag = (drop: boolean) => {
    const p = colPointer.current;
    removeColListeners();
    colPointer.current = null;
    if (!p) return;
    clearInterval(p.timer);
    setColDrag(null);
    if (!drop || !p.active || p.gap === null) return;
    const to = columnTarget(p.key, p.gap);
    if (to) ref.current.props.onColumnMove?.(p.key, to);
  };
  const onColMoveRef = useRef(onColMove);
  const endColDragRef = useRef(endColDrag);
  onColMoveRef.current = onColMove;
  endColDragRef.current = endColDrag;
  const stableColMove = useCallback((e: PointerEvent) => onColMoveRef.current(e), []);
  const stableColUp = useCallback(() => endColDragRef.current(true), []);
  const stableColCancel = useCallback(() => endColDragRef.current(false), []);
  const stableColKey = useCallback((e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    endColDragRef.current(false);
  }, []);
  function removeColListeners() {
    window.removeEventListener("pointermove", stableColMove);
    window.removeEventListener("pointerup", stableColUp);
    window.removeEventListener("pointercancel", stableColCancel);
    window.removeEventListener("keydown", stableColKey, true);
  }
  useEffect(
    () => () => {
      window.removeEventListener("pointermove", stableColMove);
      window.removeEventListener("pointerup", stableColUp);
      window.removeEventListener("pointercancel", stableColCancel);
      window.removeEventListener("keydown", stableColKey, true);
      if (colPointer.current) clearInterval(colPointer.current.timer);
    },
    [stableColMove, stableColUp, stableColCancel, stableColKey],
  );

  const headerPointerDown = (key: string, e: ReactPointerEvent) => {
    // Touch swipes on the header scroll the grid; phones reorder in the Fields popover.
    if (e.button !== 0 || e.pointerType === "touch" || !props.onColumnMove) return;
    if (colPointer.current) endColDrag(false);
    e.preventDefault(); // no text selection while dragging
    colPointer.current = {
      key,
      startX: e.clientX,
      clientX: e.clientX,
      active: false,
      gap: null,
      timer: 0,
    };
    window.addEventListener("pointermove", stableColMove);
    window.addEventListener("pointerup", stableColUp);
    window.addEventListener("pointercancel", stableColCancel);
    window.addEventListener("keydown", stableColKey, true);
  };

  /** ⌘/Ctrl+Shift+←/→ on a resize handle: move that column one place. */
  const moveColumnBy = (key: string, dir: -1 | 1) => {
    const from = colIndex.get(key);
    if (from === undefined || !props.onColumnMove) return;
    const other = cols[from + dir];
    const c = cols[from];
    if (!other || !c) return;
    refocusResizer.current = { key, at: Date.now() };
    props.onColumnMove(key, dir < 0 ? { before: other.key } : { after: other.key });
    showHint(`${c.col.title}: column ${from + dir + 1} of ${cols.length}`);
  };
  // The moved header may be re-inserted in the DOM, which drops focus: put it back.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the columns move
  useEffect(() => {
    const pending = refocusResizer.current;
    refocusResizer.current = null;
    if (!pending || Date.now() - pending.at > 2000) return;
    const want = `resize-${pending.key}`;
    const el = [
      ...(rootRef.current?.querySelectorAll<HTMLElement>('[role="separator"]') ?? []),
    ].find((x) => x.dataset.testid === want);
    if (el && document.activeElement !== el) el.focus();
  }, [cols]);

  function toggleGroup(id: string) {
    setCollapsed((s) => {
      if (s.has(id)) s.delete(id);
      else s.add(id);
      return s;
    });
  }

  // --- Row API (stable) ---
  const apiImpl: RowApi = {
    cellPointerDown(id, key, e) {
      if (e.button !== 0) return;
      const t = e.target as HTMLElement;
      if (t.dataset.editor === "true" || t.closest("[data-editor]")) return;
      const cur = ref.current;
      if (cur.editing && (cur.editing.rowId !== id || cur.editing.key !== key)) commitAny();
      // Row selection by clicking cells (README "Mouse"): ⌘/Ctrl toggles the row, Shift
      // extends a row selection that exists; otherwise Shift makes a cell range.
      if (isMod(e)) {
        e.preventDefault();
        setSelected(toggledSelection(cur, id));
        selectionAnchor.current = id;
        activate({ rowId: id, key });
        return;
      }
      if (e.shiftKey && cur.selected.length) {
        e.preventDefault();
        setSelected(rowSpan(cur, selectionAnchor.current, id));
        activate({ rowId: id, key });
        return;
      }
      if (e.shiftKey && cur.active && !cur.active.group) {
        e.preventDefault();
        setRange({ anchor: cur.range?.anchor ?? cur.active, focus: { rowId: id, key } });
        return;
      }
      if (cur.selected.length) setSelected([]);
      selectionAnchor.current = id;
      activate({ rowId: id, key });
    },
    cellDoubleClick(id, key) {
      startEdit(id, key);
    },
    toggle(id, key) {
      const entry = ref.current.allRows.get(id);
      const col = colOf(key);
      if (!entry || !col || !isEditable(col, entry.row)) return;
      applyEdits([{ rowId: id, key, value: !col.getValue(entry.row) }]);
    },
    setDraft(v) {
      const e = ref.current.editing;
      if (e?.kind === "text") {
        const { invalid: _was, ...rest } = e;
        const upd = { ...rest, draft: v };
        setEditing(upd);
        ref.current = { ...ref.current, editing: upd };
      }
    },
    rowNumberClick(id, e) {
      const cur = ref.current;
      commitAny();
      let next: string[];
      if (
        e.shiftKey &&
        selectionAnchor.current &&
        rowOrderOf(cur).includes(selectionAnchor.current)
      ) {
        next = rowSpan(cur, selectionAnchor.current, id);
      } else if (isMod(e)) {
        next = toggledSelection(cur, id);
        selectionAnchor.current = id;
      } else {
        next = [id];
        selectionAnchor.current = id;
      }
      setSelected(next);
      const key = (cur.active && !cur.active.group ? cur.active.key : cur.cols[0]?.key) ?? "";
      activate({ rowId: id, key });
    },
    gripPointerDown(id, e) {
      startDrag(id, e);
    },
    insertBelow(id) {
      runInsert(positionFor({ rowId: id, key: "" }, "below"));
    },
    openRow(id) {
      ref.current.props.onOpenRow?.(id);
    },
    contextMenu(id, e) {
      e.preventDefault();
      commitAny();
      const cur = ref.current;
      const key = (cur.active && !cur.active.group ? cur.active.key : cur.cols[0]?.key) ?? "";
      // Right-clicking inside a multi-row range keeps it: the menu acts on its rows.
      const keepRange = rangeRowIds(cur).includes(id);
      if (!cur.active || cur.active.group || cur.active.rowId !== id)
        activate({ rowId: id, key }, { keepRange });
      // Keyboard-invoked context menus (Shift+F10 in some browsers) report 0,0.
      const at =
        e.clientX || e.clientY
          ? { x: e.clientX, y: e.clientY }
          : (() => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              return { x: r.left + 8, y: r.bottom };
            })();
      setMenu({ ...at, rowId: id });
    },
  };
  const apiRef = useRef(apiImpl);
  apiRef.current = apiImpl;
  const api = useMemo<RowApi>(
    () => ({
      cellPointerDown: (...a) => apiRef.current.cellPointerDown(...a),
      cellDoubleClick: (...a) => apiRef.current.cellDoubleClick(...a),
      toggle: (...a) => apiRef.current.toggle(...a),
      setDraft: (...a) => apiRef.current.setDraft(...a),
      rowNumberClick: (...a) => apiRef.current.rowNumberClick(...a),
      gripPointerDown: (...a) => apiRef.current.gripPointerDown(...a),
      insertBelow: (...a) => apiRef.current.insertBelow(...a),
      openRow: (...a) => apiRef.current.openRow(...a),
      contextMenu: (...a) => apiRef.current.contextMenu(...a),
    }),
    [],
  );

  // --- Menu ---
  const menuItems = (id: string): MenuItem[] => {
    // The selection (or a multi-row range) when the row is part of it, else just this row.
    const targets = targetRows.length > 1 && targetRows.includes(id) ? targetRows : [id];
    const list: MenuItem[] = [];
    const at: CellRef = { rowId: id, key: "" };
    if (onInsert) {
      list.push(
        {
          label: "Insert row above",
          shortcut: "⌘⇧↑",
          onSelect: () => runInsert(positionFor(at, "above")),
        },
        {
          label: "Insert row below",
          shortcut: "⌘⇧↵",
          onSelect: () => runInsert(positionFor(at, "below")),
        },
      );
      if (canDuplicate(id)) {
        list.push({ label: "Duplicate row", shortcut: "⌘D", onSelect: () => runDuplicate(id) });
      }
    }
    if (onOpenRow) list.push({ label: "Open", shortcut: "Space", onSelect: () => onOpenRow(id) });
    list.push(...(props.extraMenuItems?.({ rowId: id, selectedRowIds: targets }) ?? []));
    if (onDelete) {
      list.push({
        label: targets.length > 1 ? `Delete ${targets.length} rows` : "Delete row",
        danger: true,
        onSelect: () => deleteRows(targets),
      });
    }
    return list;
  };

  // --- Render ---
  const rangeRect = useMemo(() => {
    if (!range) return null;
    const n0 = navRows.indexOf(indexById.get(range.anchor.rowId) ?? -1);
    const n1 = navRows.indexOf(indexById.get(range.focus.rowId) ?? -1);
    const c0 = colIndex.get(range.anchor.key) ?? 0;
    const c1 = colIndex.get(range.focus.key) ?? 0;
    return {
      n: [Math.min(n0, n1), Math.max(n0, n1)] as [number, number],
      c: [Math.min(c0, c1), Math.max(c0, c1)] as [number, number],
    };
  }, [range, navRows, indexById, colIndex]);

  // What row actions apply to (props.onTargetRowsChange): the selection, else a multi-row range.
  const targetRows = useMemo(() => {
    const live = selected.filter((id) => allRows.has(id));
    if (live.length) return live.length === selected.length ? selected : live;
    if (!rangeRect || rangeRect.n[0] < 0 || rangeRect.n[0] === rangeRect.n[1]) return NO_IDS;
    return navRows
      .slice(rangeRect.n[0], rangeRect.n[1] + 1)
      .map((i) => (items[i] as RowItem<Row>).id);
  }, [selected, allRows, rangeRect, navRows, items]);
  const allSelected = useMemo(
    () =>
      navRows.length > 0 && navRows.every((i) => selectedSet.has((items[i] as RowItem<Row>).id)),
    [navRows, items, selectedSet],
  );
  const reportedTargets = useRef<string[]>(NO_IDS);
  useEffect(() => {
    const prev = reportedTargets.current;
    reportedTargets.current = targetRows;
    if (prev.length === targetRows.length && prev.every((id, i) => id === targetRows[i])) return;
    ref.current.props.onTargetRowsChange?.(targetRows);
  }, [targetRows]);

  const pickerCol =
    editing?.kind === "picker" ? cols[colIndex.get(editing.key) ?? -1]?.col : undefined;
  const firstIndex = items.length ? 0 : -1;
  const dropY = drag?.gap !== null && drag?.gap !== undefined ? (offsets[drag.gap] ?? 0) : null;

  const renderItem = (index: number, start: number, isSticky: boolean) => {
    const item = items[index];
    if (!item) return null;
    if (item.kind === "group") {
      const g = item.group;
      const isActive = !!active?.group && active.rowId === g.id;
      const tabbable = isActive || (!active && index === firstIndex);
      const posStyle: CSSProperties = isSticky
        ? { position: "sticky", top: stickyTop, zIndex: 3 }
        : { transform: `translateY(${start - HEADER_HEIGHT}px)` };
      return (
        <div
          key={item.key}
          role="row"
          aria-rowindex={index + 2}
          aria-expanded={!item.collapsed}
          className={styles.groupRow}
          style={{ ...posStyle, height: GROUP_HEIGHT, width: totalWidth }}
          data-testid="group-header"
          data-group-id={g.id}
          data-stuck={isSticky || undefined}
          data-collapsed={item.collapsed || undefined}
          data-drop-target={drag && drag.gap === index + 1 ? true : undefined}
        >
          <div
            role="gridcell"
            aria-colspan={cols.length + 1}
            className={styles.groupCell}
            data-cell="true"
            data-col={GROUP_COL}
            data-active={isActive || undefined}
            tabIndex={tabbable ? 0 : -1}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              commitAny();
              activate({ rowId: g.id, key: active?.key ?? cols[0]?.key ?? "", group: true });
            }}
          >
            <div className={styles.groupInner} style={{ maxWidth: viewportWidth || undefined }}>
              <button
                type="button"
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
                className={styles.iconButton}
                aria-expanded={!item.collapsed}
                aria-label={`${item.collapsed ? "Expand" : "Collapse"} ${g.title}`}
                onClick={() => toggleGroup(g.id)}
              >
                <ChevronIcon open={!item.collapsed} />
              </button>
              <span className={styles.groupTitle}>{g.title}</span>
              {g.subtitle && <span className={styles.groupSubtitle}>{g.subtitle}</span>}
              <span className={styles.groupCount} title={`${item.count} rows`}>
                {item.count}
              </span>
              {onInsert && (
                <button
                  type="button"
                  tabIndex={-1}
                  onMouseDown={(e) => e.preventDefault()}
                  className={styles.addRow}
                  aria-label={`${props.addRowLabel ?? "Add row"} to ${g.title}`}
                  onClick={() => runInsert({ groupId: g.id })}
                >
                  <PlusIcon />{" "}
                  <span className={styles.addRowText}>{props.addRowLabel ?? "Add row"}</span>
                </button>
              )}
            </div>
          </div>
        </div>
      );
    }
    const isActive = !!active && !active.group && active.rowId === item.id;
    const inRange = rangeRect && rangeRect.n[0] >= 0 ? navRows.indexOf(index) : -1;
    const rangeCols =
      rangeRect && inRange >= rangeRect.n[0] && inRange <= rangeRect.n[1] ? rangeRect.c : null;
    return (
      <GridRow
        key={item.key}
        id={item.id}
        row={item.row}
        number={item.number}
        section={item.section}
        groupId={item.groupId}
        cols={cols}
        index={index}
        top={start - HEADER_HEIGHT}
        height={auto && !item.section ? undefined : rh}
        fit={auto}
        measureRef={auto ? virtualizer.measureElement : undefined}
        width={totalWidth}
        activeKey={isActive ? (active?.key ?? null) : null}
        tabbableKey={!active && index === firstIndex ? (cols[0]?.key ?? null) : null}
        editing={editing && editing.rowId === item.id ? editing : null}
        selected={selectedSet.has(item.id)}
        rangeCols={rangeCols}
        moved={moved.has(item.id)}
        dragging={drag?.rowId === item.id}
        colorRules={colorRules}
        decorate={props.cellDecoration}
        labelKey={labelKey}
        sortOn={sortOn}
        canDrag={!!onMove}
        canInsert={!!onInsert}
        canOpen={!!onOpenRow}
        api={api}
      />
    );
  };

  const renderList =
    sticky >= 0 && !virtualItems.some((v) => v.index === sticky)
      ? [...virtualItems, { index: sticky, start: (offsets[sticky] ?? 0) + HEADER_HEIGHT }].sort(
          (a, b) => a.index - b.index,
        )
      : virtualItems;

  return (
    <div
      ref={rootRef}
      className={[styles.root, className].filter(Boolean).join(" ")}
      role="grid"
      aria-label={props["aria-label"] ?? "Data grid"}
      aria-rowcount={items.length + 1}
      aria-colcount={cols.length + 1}
      aria-multiselectable="true"
      data-row-height={rowHeight}
      style={AUTO_VARS}
      data-dragging={drag || colDrag ? true : undefined}
      onKeyDown={onKeyDown}
      onCopy={onCopy}
      onPaste={onPaste}
      onFocus={onFocus}
      onBlur={onBlur}
      onDragOver={onFileDragOver}
      onDragLeave={onFileDragLeave}
      onDrop={onFileDrop}
    >
      <div
        ref={scrollRef}
        className={styles.scroll}
        data-testid="grid-scroll"
        // The scroll offset this render laid out rows and the stuck header for. It trails
        // el.scrollTop until the scroll event has been handled and React has committed, so
        // tests wait for the two to agree before reading the layout (e2e/grid.spec.ts).
        data-scroll-offset={Math.round(scrollTop)}
      >
        <div
          role="row"
          aria-rowindex={1}
          className={styles.headerRow}
          style={{ width: totalWidth, height: HEADER_HEIGHT }}
        >
          <div
            role="columnheader"
            className={`${styles.hcell} ${styles.rownumHeader}`}
            style={{ width: ROWNUM_WIDTH }}
          >
            {navRows.length > 0 && (
              <input
                type="checkbox"
                tabIndex={-1}
                className={styles.selectAll}
                aria-label="Select all rows"
                title="Select all rows (⌘/Ctrl+A)"
                data-testid="select-all"
                checked={allSelected}
                ref={(el) => {
                  if (el) el.indeterminate = !allSelected && selected.length > 0;
                }}
                onMouseDown={(e) => e.preventDefault()}
                onChange={() => {
                  commitAny();
                  setRange(null);
                  setSelected(allSelected ? [] : rowOrderOf(ref.current));
                  focusPending.current = true;
                  bump();
                }}
              />
            )}
            <span className={styles.visuallyHidden}>Row</span>#
          </div>
          {cols.map((c) => {
            const s = sort?.find((x) => x.key === c.key);
            return (
              <div
                key={c.key}
                role="columnheader"
                aria-colindex={c.index + 2}
                aria-sort={s ? (s.dir === "asc" ? "ascending" : "descending") : undefined}
                className={styles.hcell}
                data-frozen={c.frozen || undefined}
                data-movable={props.onColumnMove ? true : undefined}
                data-dragging={colDrag?.key === c.key || undefined}
                data-testid={`header-${c.key}`}
                style={{ width: c.width, left: c.frozen ? c.left : undefined }}
                title={c.col.title}
                onPointerDown={(e) => headerPointerDown(c.key, e)}
              >
                <span className={styles.typeIcon}>
                  <TypeIcon type={c.col.type} />
                </span>
                <span className={styles.htitle}>{c.col.title}</span>
                {s && (
                  <span className={styles.sortMark} aria-hidden="true">
                    {s.dir === "asc" ? "↑" : "↓"}
                  </span>
                )}
                <div
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={`Resize ${c.col.title} column`}
                  aria-valuenow={c.width}
                  aria-valuemin={c.col.minWidth ?? MIN_WIDTH}
                  aria-valuemax={2000}
                  tabIndex={0}
                  className={styles.resizer}
                  data-testid={`resize-${c.key}`}
                  onPointerDown={(e) => startResize(c.key, e)}
                  aria-keyshortcuts={
                    props.onColumnMove
                      ? "Control+Shift+ArrowLeft Control+Shift+ArrowRight Meta+Shift+ArrowLeft Meta+Shift+ArrowRight"
                      : undefined
                  }
                  onKeyDown={(e) => {
                    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                      e.preventDefault();
                      e.stopPropagation();
                      const dir = e.key === "ArrowLeft" ? -1 : 1;
                      if ((e.metaKey || e.ctrlKey) && e.shiftKey) moveColumnBy(c.key, dir);
                      else resizeBy(c.key, dir * (e.shiftKey ? 50 : 10));
                    }
                  }}
                />
              </div>
            );
          })}
        </div>
        <div
          ref={bodyRef}
          className={styles.body}
          style={{ height: virtualizer.getTotalSize(), width: totalWidth }}
        >
          {/* Index order, sticky header included, so React never reorders DOM nodes just
              because the stuck header changed. */}
          {renderList.map((v) => renderItem(v.index, v.start, v.index === sticky))}
          {dropY !== null && (
            <div
              className={styles.dropLine}
              style={{ top: dropY - 1, width: totalWidth }}
              data-testid="drop-line"
            />
          )}
          {items.length === 0 && <div className={styles.empty}>No rows</div>}
        </div>
      </div>
      {colDrag && (
        <div
          className={styles.colDropLine}
          style={{ left: colDrag.x - 1, height: colDrag.height }}
          data-testid="column-drop-line"
          data-gap={colDrag.gap}
        />
      )}
      <div role="status" aria-live="polite" className={hint ? styles.hint : styles.visuallyHidden}>
        {hint}
      </div>
      {confirm && (
        <ConfirmDelete
          count={confirm.length}
          undoable={!!props.deleteUndoable}
          onConfirm={() => {
            const ids = confirm;
            setConfirm(null);
            deleteRows(ids, true);
            focusPending.current = true;
          }}
          onCancel={() => {
            setConfirm(null);
            focusPending.current = true;
          }}
        />
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label="Row actions"
          items={menuItems(menu.rowId)}
          portalOwner={gridId}
          onClose={() => {
            setMenu(null);
            focusPending.current = true;
          }}
        />
      )}
      {editing?.kind === "picker" && pickerCol && pickerAnchor && (
        <PickerFor
          key={`${editing.rowId}:${editing.key}`}
          col={pickerCol}
          row={allRows.get(editing.rowId)?.row as Row}
          editing={editing}
          anchor={pickerAnchor}
          recent={mru.current.get(pickerCol.key) ?? []}
          portalOwner={gridId}
          onPick={onPick}
          onClose={onPickerClose}
          onBackspaceEmpty={onBackspaceEmpty}
          onRemove={(v) => {
            const cur = (Array.isArray(editing.value) ? editing.value : []) as unknown[];
            const next = cur.filter((x) => x !== v);
            applyEdits([{ rowId: editing.rowId, key: editing.key, value: next }]);
            setEditing({ ...editing, value: next });
          }}
        />
      )}
    </div>
  );
}

/** In-grid confirmation for multi-row deletes (testable, unlike window.confirm). */
function ConfirmDelete({
  count,
  undoable,
  onConfirm,
  onCancel,
}: {
  count: number;
  undoable: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const textId = useId();
  useLayoutEffect(() => cancelRef.current?.focus(), []);
  return (
    <div
      role="alertdialog"
      aria-modal="false"
      aria-labelledby={textId}
      className={styles.confirm}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
    >
      <span id={textId}>
        Delete {count === 1 ? "this row" : `${count} rows`}?
        {undoable ? "" : " This can't be undone."}
      </span>
      <button type="button" className={styles.danger} onClick={onConfirm}>
        Delete {count === 1 ? "row" : `${count} rows`}
      </button>
      <button type="button" ref={cancelRef} onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

/** The picker configured for a select/multiselect/link/multilink column. */
function PickerFor<Row>({
  col,
  row,
  editing,
  anchor,
  recent,
  portalOwner,
  onPick,
  onClose,
  onBackspaceEmpty,
  onRemove,
}: {
  col: Column<Row>;
  row: Row;
  editing: Extract<Editing, { kind: "picker" }>;
  anchor: HTMLElement;
  recent: PickerItem[];
  portalOwner: string;
  onPick: (item: PickerItem, via: PickVia) => void;
  onClose: (reason: CloseReason) => void;
  onBackspaceEmpty: () => void;
  onRemove: (v: unknown) => void;
}) {
  const isOptions = col.type === "select" || col.type === "multiselect";
  const multi = col.type === "multiselect" || col.type === "multilink";
  const options = col.options;
  const search = useMemo(() => {
    if (!isOptions) {
      const find = col.search;
      return find ? (q: string) => find(q, row) : () => [];
    }
    const items: PickerItem[] = (options ?? []).map((o) => ({
      id: o.value,
      label: o.label ?? o.value,
      color: optionColor(o.color),
    }));
    return (q: string) => {
      const t = q.trim().toLowerCase();
      return t ? items.filter((i) => i.label.toLowerCase().includes(t)) : items;
    };
  }, [isOptions, options, col.search, row]);
  const create = useMemo(() => {
    const make = col.create;
    return make && !isOptions ? (name: string) => make(name, row) : undefined;
  }, [isOptions, col.create, row]);
  const v = editing.value;
  const selectedIds = Array.isArray(v)
    ? v.map((x) => (typeof x === "string" ? x : (x as PickerItem).id))
    : v === null || v === undefined || v === ""
      ? []
      : [typeof v === "string" ? v : (v as PickerItem).id];
  const chips = multi
    ? (Array.isArray(v) ? v : []).map((x) => {
        const id = typeof x === "string" ? x : (x as PickerItem).id;
        const o = isOptions ? options?.find((op) => op.value === id) : undefined;
        const label = isOptions ? (o?.label ?? id) : (x as PickerItem).label;
        return (
          <Chip
            key={id}
            label={label}
            color={isOptions ? (o?.color ?? "gray") : (x as PickerItem).color}
            removeLabel={`Remove ${label}`}
            onRemove={() => onRemove(x)}
          />
        );
      })
    : null;
  return (
    <RecordPicker
      anchor={anchor}
      search={search}
      create={create}
      initialQuery={editing.query}
      recent={isOptions ? [] : recent}
      selectedIds={selectedIds}
      multi={multi}
      chips={chips && chips.length > 0 ? chips : undefined}
      debounceMs={isOptions ? 0 : 100}
      label={`${col.title}: search`}
      placeholder={isOptions ? "Find an option…" : col.create ? "Find or create…" : "Find…"}
      portalOwner={portalOwner}
      onPick={onPick}
      onClose={onClose}
      onBackspaceEmpty={multi ? onBackspaceEmpty : undefined}
    />
  );
}

/** Row props are primitives (or stable references) so unchanged rows skip re-rendering. */
interface GridRowProps<Row> {
  id: string;
  row: Row;
  number: number;
  section: boolean;
  groupId: string | undefined;
  cols: ColLayout<Row>[];
  index: number;
  top: number;
  /** Fixed height (px); undefined for an auto row, which is measured. */
  height: number | undefined;
  /** Auto rows: cells wrap, and an editing cell grows with its text. */
  fit: boolean;
  /** Auto rows: the virtualizer's measureElement (stable). */
  measureRef: ((el: HTMLElement | null) => void) | undefined;
  width: number;
  activeKey: string | null;
  tabbableKey: string | null;
  editing: Editing | null;
  selected: boolean;
  rangeCols: [number, number] | null;
  moved: boolean;
  dragging: boolean;
  colorRules: ColorRule<Row>[] | undefined;
  decorate: ((row: Row, key: string) => CellDecoration | undefined) | undefined;
  labelKey: string;
  sortOn: boolean;
  canDrag: boolean;
  canInsert: boolean;
  canOpen: boolean;
  api: RowApi;
}

function GridRowImpl<Row>(p: GridRowProps<Row>) {
  const { id, row, cols, index, activeKey, editing, api, rangeCols } = p;
  const { rowColor, cellColors } = useMemo(() => {
    let rowColor: string | undefined;
    const cellColors = new Map<string, string>();
    for (const r of p.colorRules ?? []) {
      let hit = false;
      try {
        hit = r.when(row);
      } catch {
        hit = false;
      }
      if (!hit) continue;
      if (r.row && rowColor === undefined) rowColor = optionColor(r.row);
      if (r.cell) cellColors.set(r.cell.key, optionColor(r.cell.color));
    }
    return { rowColor, cellColors };
  }, [p.colorRules, row]);
  const isActiveRow = activeKey !== null;
  const rowStyle = {
    transform: `translateY(${p.top}px)`,
    height: p.height,
    width: p.width,
    ...(rowColor ? { "--row-bg": `var(--option-${rowColor}-bg)` } : {}),
  } as CSSProperties;
  const n = p.number;
  const rowLabel = p.section ? "section" : `row ${n}`;

  const rowNumber = (
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard selection is ⌘A / Shift+arrows on cells
    <div
      role="rowheader"
      className={styles.rownum}
      style={{ width: ROWNUM_WIDTH }}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        api.rowNumberClick(id, e);
      }}
      data-testid="row-number"
    >
      {p.canDrag && (
        <button
          type="button"
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          className={styles.grip}
          aria-label={`Drag ${rowLabel} to reorder`}
          aria-disabled={p.sortOn || undefined}
          title={p.sortOn ? "Drag is off while a live sort is on" : "Drag to reorder"}
          onPointerDown={(e) => api.gripPointerDown(id, e)}
          data-testid="drag-handle"
        >
          <GripIcon />
        </button>
      )}
      <span className={styles.rownumText}>{p.section ? "" : n}</span>
      {p.canOpen && (
        <button
          type="button"
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          className={styles.expand}
          aria-label={`Open ${rowLabel}`}
          onClick={() => api.openRow(id)}
        >
          <ExpandIcon />
        </button>
      )}
      {p.canInsert && (
        <button
          type="button"
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          className={styles.insertBtn}
          aria-label={`Insert row below ${rowLabel}`}
          onClick={() => api.insertBelow(id)}
          data-testid="insert-below"
        >
          <PlusIcon />
        </button>
      )}
    </div>
  );

  const cellProps = (key: string, i: number) => {
    const isActive = activeKey === key || (p.section && isActiveRow);
    const inRange = !!rangeCols && i >= rangeCols[0] && i <= rangeCols[1];
    return {
      "data-cell": "true",
      "data-col": key,
      "aria-colindex": i + 2,
      "aria-selected": isActive || inRange || p.selected,
      "data-active": isActive || undefined,
      "data-inrange": inRange || undefined,
      tabIndex: isActive || p.tabbableKey === key ? 0 : -1,
      onPointerDown: (e: ReactPointerEvent) => api.cellPointerDown(id, key, e),
      onDoubleClick: () => api.cellDoubleClick(id, key),
    };
  };

  let cells: React.ReactNode;
  if (p.section) {
    const lc = cols.find((c) => c.key === p.labelKey);
    const text = lc ? formatValue(lc.col, lc.col.getValue(row)) : "";
    const isEditing = editing?.kind === "text";
    cells = (
      <div
        role="gridcell"
        {...cellProps(p.labelKey, lc?.index ?? 0)}
        className={styles.sectionCell}
        aria-colspan={cols.length}
        data-editing={isEditing || undefined}
      >
        {isEditing ? (
          <TextEditor
            multiline={false}
            numeric={false}
            value={editing.draft}
            label={lc?.col.title ?? "Section"}
            onChange={api.setDraft}
          />
        ) : (
          <span className={styles.sectionLabel} style={{ left: ROWNUM_WIDTH + 8 }}>
            {text}
          </span>
        )}
      </div>
    );
  } else {
    cells = cols.map((c) => {
      const value = c.col.getValue(row);
      const editable = isEditable(c.col, row);
      const isEditingText = editing?.kind === "text" && editing.key === c.key;
      const isEditingPicker = editing?.kind === "picker" && editing.key === c.key;
      const deco = p.decorate?.(row, c.key);
      const ghost =
        deco?.ghost && GHOST_TYPES.has(c.col.type) && isEmptyValue(value) ? deco.ghost : undefined;
      const cc = cellColors.get(c.key);
      const style: CSSProperties = {
        width: c.width,
        left: c.frozen ? c.left : undefined,
        ...(cc
          ? { "--cell-bg": `var(--option-${cc}-bg)`, "--cell-fg": `var(--option-${cc}-fg)` }
          : {}),
      } as CSSProperties;
      return (
        <div
          key={c.key}
          role="gridcell"
          {...cellProps(c.key, c.index)}
          aria-readonly={!editable || undefined}
          className={styles.cell}
          data-type={c.col.type}
          data-frozen={c.frozen || undefined}
          data-colored={cc ? true : undefined}
          data-editing={isEditingText || isEditingPicker || undefined}
          data-warning={
            deco?.warning ? (deco.warningStyle === "dashed" ? "dashed" : true) : undefined
          }
          title={deco?.warning}
          style={style}
        >
          {isEditingText ? (
            <>
              {p.fit && (
                // Gives the cell (so the row) the height of the wrapped draft; the editor
                // covers the cell. The zero-width space keeps a trailing newline's line.
                <span className={styles.editSizer} aria-hidden="true">
                  {editing.draft}
                  {ZWSP}
                </span>
              )}
              <TextEditor
                multiline={c.col.type === "longtext"}
                numeric={c.col.type === "number"}
                fit={p.fit}
                value={editing.draft}
                label={c.col.title}
                placeholder={ghost}
                invalid={editing.invalid}
                onChange={api.setDraft}
              />
            </>
          ) : (
            <>
              {c.col.type === "attachment" && c.col.renderCell ? (
                c.col.renderCell(row)
              ) : (
                <CellContent
                  col={c.col}
                  value={isEditingPicker ? editing.value : value}
                  editable={editable}
                  onToggle={() => api.toggle(id, c.key)}
                />
              )}
              {ghost && activeKey === c.key && (
                <span className={styles.ghost} data-testid="ghost">
                  {ghost}
                </span>
              )}
              {deco?.warning && (
                <span className={styles.visuallyHidden}>Warning: {deco.warning}</span>
              )}
            </>
          )}
        </div>
      );
    });
  }

  return (
    <div
      ref={p.measureRef}
      role="row"
      aria-rowindex={index + 2}
      aria-selected={p.selected}
      className={styles.row}
      style={rowStyle}
      data-index={index}
      data-row-id={id}
      data-group={p.groupId}
      data-testid="grid-row"
      data-section={p.section || undefined}
      data-selected={p.selected || undefined}
      data-active-row={isActiveRow || undefined}
      data-colored={rowColor ? true : undefined}
      data-moved={p.moved || undefined}
      data-dragging={p.dragging || undefined}
      data-editing-row={editing ? true : undefined}
      onContextMenu={(e) => api.contextMenu(id, e)}
    >
      {rowNumber}
      {cells}
    </div>
  );
}

const GridRow = memo(GridRowImpl) as typeof GridRowImpl;
