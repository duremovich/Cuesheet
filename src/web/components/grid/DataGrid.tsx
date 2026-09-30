// The spreadsheet-like grid every table uses. Generic over the row type: the caller maps its
// data to columns + callbacks and owns all persistence. Behaviors follow docs/spec/ux.md
// (§Ordering and sorting, §Inserting a cue, §Grid, §Grouping, §Conditional formatting).
// See ./README.md for the props, the keyboard map and how to wire a real table.
//
// biome-ignore-all lint/a11y/useSemanticElements: an ARIA grid over absolutely positioned, virtualized divs; <table> layout can't do that
// biome-ignore-all lint/a11y/useFocusableInteractive: APG grid pattern: only the active cell is in the tab order (roving tabindex); rows and headers aren't focusable

import { defaultRangeExtractor, type Range, useVirtualizer } from "@tanstack/react-virtual";
import {
  type CSSProperties,
  memo,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Chip, optionColor } from "./Chip";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { CellContent, TextEditor } from "./cells";
import styles from "./DataGrid.module.css";
import { ChevronIcon, ExpandIcon, GripIcon, PlusIcon, TypeIcon } from "./icons";
import { buildLayout, type FlatItem, type Hold } from "./ordering";
import { type CloseReason, type PickVia, RecordPicker } from "./RecordPicker";
import type {
  ColorRule,
  Column,
  DataGridProps,
  InsertPosition,
  PickerItem,
  RowHeight,
} from "./types";
import {
  type EditRecord,
  emptyValue,
  formatValue,
  NOT_PARSED,
  parseText,
  parseTsv,
  toTsv,
  UndoStack,
  valuesEqual,
} from "./values";

export const ROW_HEIGHTS: Record<RowHeight, number> = { compact: 30, normal: 40, tall: 72 };
export const HEADER_HEIGHT = 34;
export const GROUP_HEIGHT = 40;
export const ROWNUM_WIDTH = 76;
const DEFAULT_WIDTH = 160;
const MIN_WIDTH = 60;
const MOVED_MS = 2400;
const PASTE_TYPES = new Set(["text", "longtext", "number", "select"]);
const PICKER_TYPES = new Set(["select", "multiselect", "link", "multilink"]);
const MRU_SIZE = 5;

interface CellRef {
  rowId: string;
  key: string;
}

type Editing =
  | { kind: "text"; rowId: string; key: string; draft: string }
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

const isMod = (e: { metaKey: boolean; ctrlKey: boolean }) => e.metaKey || e.ctrlKey;

function isEditable<Row>(col: Column<Row>, row: Row): boolean {
  if (col.type === "readonly") return false;
  if (col.editable === undefined) return true;
  return typeof col.editable === "function" ? col.editable(row) : col.editable;
}

/** Value → editable text for text/number editors. */
function editText<Row>(col: Column<Row>, v: unknown): string {
  if (v === null || v === undefined) return "";
  return col.type === "number" ? String(v) : formatValue(col, v);
}

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
    rowId,
    rows,
    groups,
    isSection,
    onInsert,
    onMove,
    onDelete,
    onOpenRow,
    sort,
    colorRules,
    rowHeight = "normal",
    className,
  } = props;
  const gridId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const sortOn = !!sort && sort.length > 0;
  const rh = ROW_HEIGHTS[rowHeight];

  // --- State ---
  const [active, setActive] = useState<CellRef | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [range, setRange] = useState<{ anchor: CellRef; focus: CellRef } | null>(null);
  const [internalSelection, setInternalSelection] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [hold, setHold] = useState<Hold | null>(null);
  const [moved, setMoved] = useState<ReadonlySet<string>>(() => new Set());
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [menu, setMenu] = useState<{ x: number; y: number; rowId: string } | null>(null);
  const [drag, setDrag] = useState<{ rowId: string; gap: number | null } | null>(null);
  const [hint, setHint] = useState<string>("");
  const [viewportWidth, setViewportWidth] = useState(0);
  const [pickerAnchor, setPickerAnchor] = useState<HTMLElement | null>(null);
  const undo = useRef(new UndoStack());
  const mru = useRef(new Map<string, PickerItem[]>());
  const focusPending = useRef(false);
  const pendingInsert = useRef<string | null>(null);
  const selectionAnchor = useRef<string | null>(null);

  const selected = props.selectedRowIds ?? internalSelection;
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  // --- Derived layout ---
  const holds = useMemo(() => (hold ? [hold] : []), [hold]);
  const items = useMemo(
    () => buildLayout({ rows, groups, columns, rowId, sort, holds, collapsed, isSection }),
    [rows, groups, columns, rowId, sort, holds, collapsed, isSection],
  );
  const allRows = useMemo(() => {
    const m = new Map<string, { row: Row; groupId: string | undefined }>();
    if (groups)
      for (const g of groups) for (const r of g.rows) m.set(rowId(r), { row: r, groupId: g.id });
    else for (const r of rows ?? []) m.set(rowId(r), { row: r, groupId: undefined });
    return m;
  }, [rows, groups, rowId]);
  const indexById = useMemo(() => {
    const m = new Map<string, number>();
    items.forEach((it, i) => {
      if (it.kind === "row") m.set(it.id, i);
    });
    return m;
  }, [items]);
  /** Flat indices of row items, for up/down navigation. */
  const navRows = useMemo(() => items.flatMap((it, i) => (it.kind === "row" ? [i] : [])), [items]);
  const offsets = useMemo(() => {
    const o = new Array<number>(items.length + 1);
    o[0] = 0;
    for (let i = 0; i < items.length; i++) {
      o[i + 1] =
        (o[i] as number) + ((items[i] as FlatItem<Row>).kind === "group" ? GROUP_HEIGHT : rh);
    }
    return o;
  }, [items, rh]);

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

  // --- Virtualization ---
  const activeIndex = active ? (indexById.get(active.rowId) ?? -1) : -1;
  const dragIndex = drag ? (indexById.get(drag.rowId) ?? -1) : -1;
  const groupIndexes = useMemo(
    () => items.flatMap((it, i) => (it.kind === "group" ? [i] : [])),
    [items],
  );
  const stickyRef = useRef(-1);
  // Always render the active and dragged rows (so focus and pointer tracking survive
  // scrolling) and the group header stuck to the top.
  const rangeExtractor = useCallback(
    (r: Range) => {
      const base = defaultRangeExtractor(r);
      let stuck = -1;
      for (const g of groupIndexes) {
        if (g <= r.startIndex) stuck = g;
        else break;
      }
      stickyRef.current = stuck;
      const extra = [activeIndex, dragIndex, stuck].filter((i) => i >= 0 && i < r.count);
      return [...new Set([...base, ...extra])].sort((a, b) => a - b);
    },
    [groupIndexes, activeIndex, dragIndex],
  );
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (items[i]?.kind === "group" ? GROUP_HEIGHT : rh),
    getItemKey: (i) => items[i]?.key ?? i,
    overscan: 8,
    scrollMargin: HEADER_HEIGHT,
    rangeExtractor,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const sticky = groups ? stickyRef.current : -1;

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
    rh,
    frozenWidth,
    labelKey,
    drag,
  };
  const ref = useRef(S);
  ref.current = S;

  // --- Helpers ---
  const colOf = (key: string) => S.cols[S.colIndex.get(key) ?? -1]?.col;
  const rowItemAt = (i: number): RowItem<Row> | undefined => {
    const it = S.items[i];
    return it?.kind === "row" ? it : undefined;
  };
  const rowItem = (id: string) => rowItemAt(S.indexById.get(id) ?? -1);
  const firstEditableKey = (row: Row | undefined) =>
    (row ? S.cols.find((c) => isEditable(c.col, row)) : undefined)?.key ?? S.cols[0]?.key ?? "";

  const setSelected = (ids: string[]) => {
    if (props.selectedRowIds === undefined) setInternalSelection(ids);
    props.onSelectionChange?.(ids);
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

  /** Ends the current hold; the row settles into its sorted place with a highlight. */
  /**
   * Ends the current hold; the row settles into its sorted place with a highlight.
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
      rowId: cur.props.rowId,
      sort: cur.props.sort,
      collapsed,
      isSection: cur.props.isSection,
    });
    const after = settled.findIndex((it) => it.kind === "row" && it.id === h.id);
    setHold(null);
    ref.current = { ...ref.current, hold: null };
    if (before !== undefined && after >= 0 && after !== before) flashMoved(h.id);
    return settled;
  };

  /** A hold for `id` at its place in `layout` (after its current predecessor). */
  const holdFor = (id: string, layout: FlatItem<Row>[]): Hold | null => {
    const i = layout.findIndex((it) => it.kind === "row" && it.id === id);
    const it = layout[i];
    if (it?.kind !== "row") return null;
    const prev = layout[i - 1];
    return { id, groupId: it.groupId, afterId: prev?.kind === "row" ? prev.id : null };
  };

  const ensureVisible = (flatIndex: number, key?: string) => {
    const el = scrollRef.current;
    if (!el || flatIndex < 0) return;
    const top = (S.offsets[flatIndex] ?? 0) + HEADER_HEIGHT;
    const bottom = (S.offsets[flatIndex + 1] ?? top) + HEADER_HEIGHT;
    const viewTop = el.scrollTop + HEADER_HEIGHT + (groups ? GROUP_HEIGHT : 0);
    if (top < viewTop)
      el.scrollTop = Math.max(0, top - HEADER_HEIGHT - (groups ? GROUP_HEIGHT : 0));
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
    const c = key === undefined ? undefined : S.cols[S.colIndex.get(key) ?? -1];
    if (c && !c.frozen) {
      if (c.left < el.scrollLeft + S.frozenWidth)
        el.scrollLeft = Math.max(0, c.left - S.frozenWidth);
      else if (c.left + c.width > el.scrollLeft + el.clientWidth)
        el.scrollLeft = c.left + c.width - el.clientWidth;
    }
  };

  /** Makes a cell the active one. Moving to another row releases the previous row's hold. */
  const activate = (
    rowIdArg: string,
    key: string,
    opts: { scroll?: boolean; keepRange?: boolean } = {},
  ) => {
    const cur = ref.current;
    if (!cur.hold || cur.hold.id !== rowIdArg) {
      // Anchor the new hold in the layout as it is once the old row has settled.
      const layout = releaseHold() ?? cur.items;
      const h = holdFor(rowIdArg, layout);
      if (h) {
        setHold(h);
        ref.current = { ...ref.current, hold: h };
      }
    }
    setActive({ rowId: rowIdArg, key });
    ref.current = { ...ref.current, active: { rowId: rowIdArg, key } };
    if (!opts.keepRange) setRange(null);
    focusPending.current = true;
    if (opts.scroll) ensureVisible(S.indexById.get(rowIdArg) ?? -1, key);
  };

  // --- Edits + undo ---
  const applyEdits = (edits: { rowId: string; key: string; value: unknown }[], record = true) => {
    const batch: EditRecord[] = [];
    for (const e of edits) {
      const col = colOf(e.key);
      const entry = S.allRows.get(e.rowId);
      const before = col && entry ? col.getValue(entry.row) : undefined;
      batch.push({ rowId: e.rowId, key: e.key, before, after: e.value });
      void props.onEdit(e.rowId, e.key, e.value);
    }
    if (record) undo.current.push(batch);
  };

  const replay = (which: "undo" | "redo") => {
    const edits = which === "undo" ? undo.current.undo() : undo.current.redo();
    if (!edits || edits.length === 0) return;
    for (const e of edits) void props.onEdit(e.rowId, e.key, e.value);
    const first = edits[0];
    if (first && S.indexById.has(first.rowId)) activate(first.rowId, first.key, { scroll: true });
  };

  // --- Editing ---
  const startEdit = (rowIdArg: string, key: string, initial?: string) => {
    const it = rowItem(rowIdArg);
    if (!it) return;
    const editKey = it.section ? S.labelKey : key;
    const col = colOf(editKey);
    if (!col || !isEditable(col, it.row)) return;
    // Editing always holds the row in place (e.g. after Escape released it).
    if (ref.current.hold?.id !== rowIdArg) {
      const h = holdFor(rowIdArg, ref.current.items);
      if (h) {
        setHold(h);
        ref.current = { ...ref.current, hold: h };
      }
    }
    if (col.type === "checkbox") {
      applyEdits([{ rowId: rowIdArg, key: editKey, value: !col.getValue(it.row) }]);
      return;
    }
    if (PICKER_TYPES.has(col.type)) {
      setEditing({
        kind: "picker",
        rowId: rowIdArg,
        key: editKey,
        query: initial ?? "",
        value: col.getValue(it.row),
      });
    } else {
      setEditing({
        kind: "text",
        rowId: rowIdArg,
        key: editKey,
        draft: initial ?? editText(col, col.getValue(it.row)),
      });
    }
  };

  const move = (
    dir: "up" | "down" | "left" | "right",
    opts: { extend?: boolean; wrap?: boolean } = {},
  ) => {
    const cur = ref.current;
    const from = opts.extend && cur.range ? cur.range.focus : cur.active;
    if (!from) {
      const first = rowItemAt(cur.navRows[0] ?? -1);
      if (first) activate(first.id, cur.cols[0]?.key ?? "", { scroll: true });
      return;
    }
    const flat = cur.indexById.get(from.rowId) ?? -1;
    let nav = cur.navRows.indexOf(flat);
    let ci = cur.colIndex.get(from.key) ?? 0;
    if (dir === "up") nav = Math.max(0, nav - 1);
    else if (dir === "down") nav = Math.min(cur.navRows.length - 1, nav + 1);
    else if (dir === "left") {
      if (ci > 0) ci--;
      else if (opts.wrap && nav > 0) {
        nav--;
        ci = cur.cols.length - 1;
      }
    } else if (ci < cur.cols.length - 1) ci++;
    else if (opts.wrap && nav < cur.navRows.length - 1) {
      nav++;
      ci = 0;
    }
    const target = rowItemAt(cur.navRows[nav] ?? -1);
    const key = cur.cols[ci]?.key;
    if (!target || key === undefined) return;
    if (opts.extend && cur.active) {
      setRange({ anchor: cur.range?.anchor ?? cur.active, focus: { rowId: target.id, key } });
      ensureVisible(cur.navRows[nav] ?? -1, key);
      return;
    }
    activate(target.id, key, { scroll: true });
  };

  const commitText = (then?: "down" | "right" | "left") => {
    const e = ref.current.editing;
    if (e?.kind !== "text") return;
    const col = colOf(e.key);
    const entry = S.allRows.get(e.rowId);
    setEditing(null);
    ref.current = { ...ref.current, editing: null };
    focusPending.current = true;
    if (col && entry) {
      const value = parseText(col, e.draft);
      if (value !== NOT_PARSED && !valuesEqual(value, col.getValue(entry.row))) {
        applyEdits([{ rowId: e.rowId, key: e.key, value }]);
      }
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
    const entry = S.allRows.get(e.rowId);
    if (!entry || !valuesEqual(value, col.getValue(entry.row)))
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
  const positionFor = (rowIdArg: string | undefined, where: "above" | "below"): InsertPosition => {
    const it = rowIdArg ? rowItem(rowIdArg) : undefined;
    if (!it) return {};
    const pos: InsertPosition = where === "below" ? { afterRowId: it.id } : { beforeRowId: it.id };
    if (it.groupId !== undefined) pos.groupId = it.groupId;
    return pos;
  };

  const afterInsert = (newId: string, pos: InsertPosition) => {
    releaseHold();
    const h: Hold = {
      id: newId,
      groupId: pos.groupId,
      afterId: pos.afterRowId,
      beforeId: pos.beforeRowId ?? (pos.afterRowId ? undefined : null),
    };
    setHold(h);
    ref.current = { ...ref.current, hold: h };
    pendingInsert.current = newId;
    if (pos.groupId !== undefined && collapsed.has(pos.groupId)) {
      setCollapsed((c) => {
        const n = new Set(c);
        n.delete(pos.groupId as string);
        return n;
      });
    }
    focusPending.current = true;
  };

  const insert = async (pos: InsertPosition) => {
    if (!props.onInsert) return;
    commitAny();
    const newId = await props.onInsert(pos);
    afterInsert(newId, pos);
  };

  const duplicate = async (id: string) => {
    const entry = S.allRows.get(id);
    if (!props.onInsert || !entry) return;
    commitAny();
    const pos = positionFor(id, "below");
    const newId = await props.onInsert(pos);
    for (const c of ref.current.cols) {
      if (!isEditable(c.col, entry.row)) continue;
      const v = c.col.getValue(entry.row);
      if (!valuesEqual(v, emptyValue(c.col.type))) void props.onEdit(newId, c.key, v);
    }
    afterInsert(newId, pos);
  };

  const deleteRows = (ids: string[]) => {
    if (!props.onDelete || ids.length === 0) return;
    commitAny();
    props.onDelete(ids);
    setSelected([]);
  };

  // Focus the new row's first editable cell once it shows up in the data.
  useLayoutEffect(() => {
    const id = pendingInsert.current;
    if (!id) return;
    const i = indexById.get(id);
    if (i === undefined) return;
    pendingInsert.current = null;
    const it = items[i];
    const key = firstEditableKey(it?.kind === "row" ? it.row : undefined);
    setActive({ rowId: id, key });
    ref.current = { ...ref.current, active: { rowId: id, key } };
    setRange(null);
    focusPending.current = true;
    ensureVisible(i, key);
  });

  // If the active row disappears (deleted, filtered, collapsed), drop the active cell.
  useEffect(() => {
    if (active && !indexById.has(active.rowId) && pendingInsert.current !== active.rowId) {
      setActive(null);
      if (editing?.rowId === active.rowId) setEditing(null);
    }
  }, [active, indexById, editing]);

  // Move DOM focus to the active cell after keyboard/mouse navigation and edits.
  useLayoutEffect(() => {
    // Read through the ref: an earlier effect in this commit may have moved the active cell.
    const active = ref.current.active;
    if (!focusPending.current || ref.current.editing || !active) return;
    const root = rootRef.current;
    if (!root) return;
    const rowEl = [...root.querySelectorAll<HTMLElement>("[data-row-id]")].find(
      (el) => el.dataset.rowId === active.rowId,
    );
    const cell =
      [...(rowEl?.querySelectorAll<HTMLElement>("[data-cell]") ?? [])].find(
        (el) => el.dataset.col === active.key,
      ) ?? rowEl?.querySelector<HTMLElement>("[data-cell]");
    if (cell) {
      focusPending.current = false;
      if (document.activeElement !== cell) cell.focus({ preventScroll: true });
    }
  });

  // Anchor for the picker popover: the editing cell.
  useLayoutEffect(() => {
    if (editing?.kind !== "picker") {
      if (pickerAnchor) setPickerAnchor(null);
      return;
    }
    const root = rootRef.current;
    const rowEl = [...(root?.querySelectorAll<HTMLElement>("[data-row-id]") ?? [])].find(
      (el) => el.dataset.rowId === editing.rowId,
    );
    const cell =
      [...(rowEl?.querySelectorAll<HTMLElement>("[data-cell]") ?? [])].find(
        (el) => el.dataset.col === editing.key,
      ) ?? null;
    if (cell !== pickerAnchor) setPickerAnchor(cell);
  });

  // --- Keyboard ---
  const onKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;
    const cur = ref.current;
    if (cur.drag && e.key === "Escape") {
      endDrag(false);
      return;
    }
    const inEditor = target.dataset.editor === "true";
    if (!inEditor && !target.closest("[data-cell]")) return; // buttons in group headers etc.
    const mod = isMod(e);

    // Shortcuts that work while editing too.
    if (mod && e.shiftKey && e.key === "Enter") {
      e.preventDefault();
      void insert(positionFor(cur.active?.rowId, "below"));
      return;
    }
    if (mod && e.shiftKey && e.key === "ArrowUp") {
      e.preventDefault();
      void insert(positionFor(cur.active?.rowId, "above"));
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
      if (e.key === "Enter" && !e.shiftKey && !mod) {
        e.preventDefault();
        commitText("down");
      } else if (e.key === "Tab") {
        e.preventDefault();
        commitText(e.shiftKey ? "left" : "right");
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
    if (mod && (e.key === "d" || e.key === "D")) {
      e.preventDefault();
      if (a) void duplicate(a.rowId);
      return;
    }
    switch (e.key) {
      case "ArrowUp":
      case "ArrowDown":
      case "ArrowLeft":
      case "ArrowRight": {
        e.preventDefault();
        const dir = e.key.slice(5).toLowerCase() as "up" | "down" | "left" | "right";
        move(dir, { extend: e.shiftKey });
        return;
      }
      case "Tab": {
        const lastCell =
          a &&
          cur.navRows.indexOf(cur.indexById.get(a.rowId) ?? -1) === cur.navRows.length - 1 &&
          cur.colIndex.get(a.key) === cur.cols.length - 1;
        const firstCell =
          a &&
          cur.navRows.indexOf(cur.indexById.get(a.rowId) ?? -1) === 0 &&
          cur.colIndex.get(a.key) === 0;
        if ((e.shiftKey && firstCell) || (!e.shiftKey && lastCell)) return; // let focus leave the grid
        e.preventDefault();
        move(e.shiftKey ? "left" : "right", { wrap: true });
        return;
      }
      case "Enter":
        e.preventDefault();
        if (a) startEdit(a.rowId, a.key);
        return;
      case "F2":
        e.preventDefault();
        if (a) startEdit(a.rowId, a.key);
        return;
      case " ":
        e.preventDefault();
        if (a) props.onOpenRow?.(a.rowId);
        return;
      case "Escape":
        setRange(null);
        if (cur.selected.length) setSelected([]);
        releaseHold();
        return;
      case "Delete":
      case "Backspace": {
        e.preventDefault();
        if (cur.selected.length > 0) {
          deleteRows(cur.selected);
          return;
        }
        const cells = rangeCells();
        const edits: { rowId: string; key: string; value: unknown }[] = [];
        for (const { item, col } of cells) {
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
        if (a) {
          const r = target.getBoundingClientRect();
          setMenu({ x: r.left + 8, y: r.bottom, rowId: a.rowId });
        }
        return;
    }
    if (a && e.key.length === 1 && !mod && !e.altKey) {
      e.preventDefault();
      startEdit(a.rowId, a.key, e.key);
    }
  };

  /** Cells in the current range, or the active cell. */
  const rangeCells = (): { item: RowItem<Row>; col: Column<Row> }[] => {
    const cur = ref.current;
    const r = cur.range ?? (cur.active ? { anchor: cur.active, focus: cur.active } : null);
    if (!r) return [];
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
        .map((it) => cur.cols.map((c) => formatValue(c.col, c.col.getValue(it.row))));
    } else {
      const cells = rangeCells();
      const byRow = new Map<string, string[]>();
      for (const { item, col } of cells) {
        const list = byRow.get(item.id) ?? [];
        list.push(formatValue(col, col.getValue(item.row)));
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
    if (cur.editing || !cur.active || !(e.target as HTMLElement).closest?.("[data-cell]")) return;
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    e.preventDefault();
    const data = parseTsv(text);
    const r = cur.range ?? { anchor: cur.active, focus: cur.active };
    const n0 = cur.navRows.indexOf(cur.indexById.get(r.anchor.rowId) ?? -1);
    const n1 = cur.navRows.indexOf(cur.indexById.get(r.focus.rowId) ?? -1);
    const c0 = cur.colIndex.get(r.anchor.key) ?? 0;
    const c1 = cur.colIndex.get(r.focus.key) ?? 0;
    const top = Math.min(n0, n1);
    const left = Math.min(c0, c1);
    const single = data.length === 1 && data[0]?.length === 1;
    const rowsN = single && cur.range ? Math.abs(n1 - n0) + 1 : data.length;
    const colsN =
      single && cur.range ? Math.abs(c1 - c0) + 1 : Math.max(...data.map((d) => d.length));
    const edits: { rowId: string; key: string; value: unknown }[] = [];
    for (let dr = 0; dr < rowsN; dr++) {
      const item = rowItemAt(cur.navRows[top + dr] ?? -1);
      if (!item || item.section) continue;
      for (let dc = 0; dc < colsN; dc++) {
        const col = cur.cols[left + dc]?.col;
        const raw = single ? data[0]?.[0] : data[dr]?.[dc];
        if (!col || raw === undefined || !PASTE_TYPES.has(col.type) || !isEditable(col, item.row))
          continue;
        const value = parseText(col, raw);
        if (value === NOT_PARSED || valuesEqual(value, col.getValue(item.row))) continue;
        edits.push({ rowId: item.id, key: col.key, value });
      }
    }
    if (edits.length) applyEdits(edits);
  };

  // --- Focus leaving the grid ends the hold (and commits a text edit) ---
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
          if (value !== NOT_PARSED && !valuesEqual(value, col.getValue(entry.row))) {
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
    if (!drop || !state || state.gap === null) return;
    const pos = resolveDrop(state.rowId, state.gap);
    if (!pos) return;
    ref.current.props.onMove?.(state.rowId, pos);
    // Keep the moved row where it was dropped until focus leaves it (sorting is off, but
    // this keeps a cross-group drop in its new group if the data takes a moment).
    const h: Hold = {
      id: state.rowId,
      groupId: pos.groupId,
      afterId: pos.afterRowId,
      beforeId: pos.beforeRowId ?? (pos.afterRowId ? undefined : null),
    };
    setHold(h);
    ref.current = { ...ref.current, hold: h };
    setActive((a) => ({ rowId: state.rowId, key: a?.key ?? ref.current.cols[0]?.key ?? "" }));
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
      setHint("Reordering by drag is off while a live sort is on. Remove the sort to drag rows.");
      setTimeout(() => setHint(""), 4000);
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

  const toggleGroup = (id: string) =>
    setCollapsed((c) => {
      const n = new Set(c);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  // --- Row API (stable) ---
  const apiImpl: RowApi = {
    cellPointerDown(id, key, e) {
      if (e.button !== 0) return;
      const t = e.target as HTMLElement;
      if (t.dataset.editor === "true" || t.closest("[data-editor]")) return;
      const cur = ref.current;
      if (cur.editing && (cur.editing.rowId !== id || cur.editing.key !== key)) commitAny();
      if (e.shiftKey && cur.active) {
        e.preventDefault();
        setRange({ anchor: cur.range?.anchor ?? cur.active, focus: { rowId: id, key } });
        return;
      }
      if (cur.selected.length && !isMod(e)) setSelected([]);
      activate(id, key);
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
      if (e?.kind === "text") setEditing({ ...e, draft: v });
    },
    rowNumberClick(id, e) {
      const cur = ref.current;
      commitAny();
      const order = cur.navRows.map((i) => (cur.items[i] as RowItem<Row>).id);
      let next: string[];
      if (e.shiftKey && selectionAnchor.current && order.includes(selectionAnchor.current)) {
        const a = order.indexOf(selectionAnchor.current);
        const b = order.indexOf(id);
        next = order.slice(Math.min(a, b), Math.max(a, b) + 1);
      } else if (isMod(e)) {
        next = cur.selected.includes(id)
          ? cur.selected.filter((x) => x !== id)
          : [...cur.selected, id];
        selectionAnchor.current = id;
      } else {
        next = [id];
        selectionAnchor.current = id;
      }
      setSelected(next);
      const key = cur.active?.key ?? cur.cols[0]?.key ?? "";
      activate(id, key);
    },
    gripPointerDown(id, e) {
      startDrag(id, e);
    },
    insertBelow(id) {
      void insert(positionFor(id, "below"));
    },
    openRow(id) {
      ref.current.props.onOpenRow?.(id);
    },
    contextMenu(id, e) {
      e.preventDefault();
      commitAny();
      const cur = ref.current;
      if (!cur.active || cur.active.rowId !== id)
        activate(id, cur.active?.key ?? cur.cols[0]?.key ?? "");
      setMenu({ x: e.clientX, y: e.clientY, rowId: id });
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
    const inSel = selected.includes(id) && selected.length > 1;
    const targets = inSel ? selected : [id];
    const list: MenuItem[] = [];
    if (onInsert) {
      list.push(
        {
          label: "Insert row above",
          shortcut: "⌘⇧↑",
          onSelect: () => void insert(positionFor(id, "above")),
        },
        {
          label: "Insert row below",
          shortcut: "⌘⇧↵",
          onSelect: () => void insert(positionFor(id, "below")),
        },
        { label: "Duplicate row", shortcut: "⌘D", onSelect: () => void duplicate(id) },
      );
    }
    if (onOpenRow) list.push({ label: "Open", shortcut: "Space", onSelect: () => onOpenRow(id) });
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

  const pickerCol =
    editing?.kind === "picker" ? cols[colIndex.get(editing.key) ?? -1]?.col : undefined;
  const firstRowIndex = navRows[0] ?? -1;
  const dropY = drag?.gap !== null && drag?.gap !== undefined ? (offsets[drag.gap] ?? 0) : null;

  const renderItem = (index: number, start: number, isSticky: boolean) => {
    const item = items[index];
    if (!item) return null;
    const posStyle: CSSProperties = isSticky
      ? { position: "sticky", top: HEADER_HEIGHT, zIndex: 3 }
      : { transform: `translateY(${start - HEADER_HEIGHT}px)` };
    if (item.kind === "group") {
      const g = item.group;
      return (
        <div
          key={item.key}
          role="row"
          aria-rowindex={index + 2}
          className={styles.groupRow}
          style={{ ...posStyle, height: GROUP_HEIGHT, width: totalWidth }}
          data-testid="group-header"
          data-group-id={g.id}
          data-collapsed={item.collapsed || undefined}
          data-drop-target={drag && drag.gap === index + 1 ? true : undefined}
        >
          <div role="gridcell" aria-colspan={cols.length + 1} className={styles.groupCell}>
            <div className={styles.groupInner} style={{ maxWidth: viewportWidth || undefined }}>
              <button
                type="button"
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
                  className={styles.addRow}
                  aria-label={`Add row to ${g.title}`}
                  onClick={() => void insert({ groupId: g.id })}
                >
                  <PlusIcon /> <span className={styles.addRowText}>Add row</span>
                </button>
              )}
            </div>
          </div>
        </div>
      );
    }
    const isActive = active?.rowId === item.id;
    const inRange = rangeRect && rangeRect.n[0] >= 0 ? navRows.indexOf(index) : -1;
    const rangeCols =
      rangeRect && inRange >= rangeRect.n[0] && inRange <= rangeRect.n[1] ? rangeRect.c : null;
    return (
      <GridRow
        key={item.key}
        item={item}
        cols={cols}
        index={index}
        style={{ ...posStyle, height: rh, width: totalWidth }}
        activeKey={isActive ? (active?.key ?? null) : null}
        tabbableKey={!active && index === firstRowIndex ? (cols[0]?.key ?? null) : null}
        editing={editing && editing.rowId === item.id ? editing : null}
        selected={selectedSet.has(item.id)}
        rangeCols={rangeCols}
        moved={moved.has(item.id)}
        dragging={drag?.rowId === item.id}
        colorRules={colorRules}
        labelKey={labelKey}
        sortOn={sortOn}
        canDrag={!!onMove}
        canInsert={!!onInsert}
        canOpen={!!onOpenRow}
        api={api}
      />
    );
  };

  const stickyItem = sticky >= 0 ? virtualItems.find((v) => v.index === sticky) : undefined;

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
      data-dragging={drag ? true : undefined}
      onKeyDown={onKeyDown}
      onCopy={onCopy}
      onPaste={onPaste}
      onBlur={onBlur}
    >
      <div ref={scrollRef} className={styles.scroll} data-testid="grid-scroll">
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
                style={{ width: c.width, left: c.frozen ? c.left : undefined }}
                title={c.col.title}
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
                  aria-label={`Resize ${c.col.title}`}
                  aria-valuenow={c.width}
                  aria-valuemin={c.col.minWidth ?? MIN_WIDTH}
                  tabIndex={-1}
                  className={styles.resizer}
                  data-testid={`resize-${c.key}`}
                  onPointerDown={(e) => startResize(c.key, e)}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                      e.preventDefault();
                      e.stopPropagation();
                      resizeBy(c.key, e.key === "ArrowLeft" ? -10 : 10);
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
          {stickyItem && renderItem(stickyItem.index, stickyItem.start, true)}
          {virtualItems.map((v) =>
            v.index === sticky ? null : renderItem(v.index, v.start, false),
          )}
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
      <div role="status" aria-live="polite" className={hint ? styles.hint : styles.visuallyHidden}>
        {hint}
      </div>
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

interface GridRowProps<Row> {
  item: RowItem<Row>;
  cols: ColLayout<Row>[];
  index: number;
  style: CSSProperties;
  activeKey: string | null;
  tabbableKey: string | null;
  editing: Editing | null;
  selected: boolean;
  rangeCols: [number, number] | null;
  moved: boolean;
  dragging: boolean;
  colorRules: ColorRule<Row>[] | undefined;
  labelKey: string;
  sortOn: boolean;
  canDrag: boolean;
  canInsert: boolean;
  canOpen: boolean;
  api: RowApi;
}

function GridRowImpl<Row>(p: GridRowProps<Row>) {
  const { item, cols, index, activeKey, editing, api, rangeCols } = p;
  const row = item.row;
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
  const rowStyle: CSSProperties = rowColor
    ? ({ ...p.style, "--row-bg": `var(--option-${rowColor}-bg)` } as CSSProperties)
    : p.style;
  const n = item.number;
  const rowLabel = item.section ? "section" : `row ${n}`;

  const rowNumber = (
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard selection is ⌘A / Shift+arrows on cells
    <div
      role="rowheader"
      className={styles.rownum}
      style={{ width: ROWNUM_WIDTH }}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        api.rowNumberClick(item.id, e);
      }}
      data-testid="row-number"
    >
      {p.canDrag && (
        <button
          type="button"
          tabIndex={-1}
          className={styles.grip}
          aria-label={`Drag ${rowLabel} to reorder`}
          aria-disabled={p.sortOn || undefined}
          title={p.sortOn ? "Drag is off while a live sort is on" : "Drag to reorder"}
          onPointerDown={(e) => api.gripPointerDown(item.id, e)}
          data-testid="drag-handle"
        >
          <GripIcon />
        </button>
      )}
      <span className={styles.rownumText}>{item.section ? "" : n}</span>
      {p.canOpen && (
        <button
          type="button"
          tabIndex={-1}
          className={styles.expand}
          aria-label={`Open ${rowLabel}`}
          onClick={() => api.openRow(item.id)}
        >
          <ExpandIcon />
        </button>
      )}
      {p.canInsert && (
        <button
          type="button"
          tabIndex={-1}
          className={styles.insertBtn}
          aria-label={`Insert row below ${rowLabel}`}
          onClick={() => api.insertBelow(item.id)}
          data-testid="insert-below"
        >
          <PlusIcon />
        </button>
      )}
    </div>
  );

  const cellProps = (key: string, i: number, extra: Record<string, unknown> = {}) => {
    const isActive = activeKey === key || (item.section && isActiveRow);
    const inRange = !!rangeCols && i >= rangeCols[0] && i <= rangeCols[1];
    return {
      "data-cell": "true",
      "data-col": key,
      "aria-colindex": i + 2,
      "aria-selected": isActive || inRange || p.selected,
      "data-active": isActive || undefined,
      "data-inrange": inRange || undefined,
      tabIndex: isActive || p.tabbableKey === key ? 0 : -1,
      onPointerDown: (e: ReactPointerEvent) => api.cellPointerDown(item.id, key, e),
      onDoubleClick: () => api.cellDoubleClick(item.id, key),
      ...extra,
    };
  };

  let cells: React.ReactNode;
  if (item.section) {
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
          style={style}
        >
          {isEditingText ? (
            <TextEditor
              multiline={c.col.type === "longtext"}
              numeric={c.col.type === "number"}
              value={editing.draft}
              label={c.col.title}
              onChange={api.setDraft}
            />
          ) : (
            <CellContent
              col={c.col}
              value={isEditingPicker ? editing.value : value}
              editable={editable}
              onToggle={() => api.toggle(item.id, c.key)}
            />
          )}
        </div>
      );
    });
  }

  return (
    <div
      role="row"
      aria-rowindex={index + 2}
      aria-selected={p.selected}
      className={styles.row}
      style={rowStyle}
      data-row-id={item.id}
      data-testid="grid-row"
      data-section={item.section || undefined}
      data-selected={p.selected || undefined}
      data-active-row={isActiveRow || undefined}
      data-colored={rowColor ? true : undefined}
      data-moved={p.moved || undefined}
      data-dragging={p.dragging || undefined}
      onContextMenu={(e) => api.contextMenu(item.id, e)}
    >
      {rowNumber}
      {cells}
    </div>
  );
}

const GridRow = memo(GridRowImpl) as typeof GridRowImpl;
