// Public types for the generic DataGrid. See ./README.md for how to wire a real table.

export type ColumnType =
  | "text"
  | "longtext"
  | "number"
  | "checkbox"
  | "select"
  | "multiselect"
  | "link"
  | "multilink"
  | "readonly";

/** Names of the `--option-<name>-bg/fg` theme palettes. */
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
export type OptionColor = (typeof OPTION_COLORS)[number];

export interface SelectOption {
  value: string;
  label?: string;
  /** An option palette name (`OptionColor`); unknown names fall back to gray. */
  color?: string;
}

/** A record shown in a link picker, and the value shape of link/multilink cells. */
export interface PickerItem {
  id: string;
  label: string;
  secondary?: string;
  color?: string;
}

export interface Column<Row> {
  key: string;
  title: string;
  width?: number;
  minWidth?: number;
  frozen?: boolean;
  type: ColumnType;
  /** select / multiselect: the choices, in sort order. */
  options?: SelectOption[];
  /**
   * link / multilink: find records. Called debounced (100 ms) with the typed query and the
   * row being edited (rank same-scene records first, R5a).
   */
  search?: (query: string, row: Row) => Promise<PickerItem[]> | PickerItem[];
  /** link / multilink: create a record from the typed name, in the row's context (R5a). */
  create?: (name: string, row: Row) => Promise<PickerItem>;
  /**
   * The cell value. Shapes by type: text/longtext `string`, number `number | null`,
   * checkbox `boolean`, select `string | null` (option value), multiselect `string[]`,
   * link `PickerItem | null`, multilink `PickerItem[]`, readonly anything (shown via format).
   * `onEdit` receives values in the same shape.
   */
  getValue: (row: Row) => unknown;
  /** Display text for text-like and readonly cells. */
  format?: (v: unknown) => string;
  /** Sort comparator for two non-empty values; defaults to `compareValues`. */
  compare?: (a: unknown, b: unknown) => number;
  /** Defaults to true for everything but readonly. */
  editable?: boolean | ((row: Row) => boolean);
}

export interface Group<Row> {
  id: string;
  title: string;
  subtitle?: string;
  rows: Row[];
  /** Shown in the header; defaults to the number of non-section rows. */
  count?: number;
}

export interface SortSpec {
  key: string;
  dir: "asc" | "desc";
}

export interface ColorRule<Row> {
  when: (r: Row) => boolean;
  /** Row background: an option palette name. The first matching row rule wins. */
  row?: string;
  /** Cell background + text: an option palette name. Cell rules stack (later rules win). */
  cell?: { key: string; color: string };
}

export interface InsertPosition {
  afterRowId?: string;
  beforeRowId?: string;
  groupId?: string;
}

export type RowHeight = "compact" | "normal" | "tall";

/** An entry of the row context menu. */
export interface MenuItem {
  label: string;
  shortcut?: string;
  danger?: boolean;
  onSelect: () => void;
}

/** Per-cell extras from `cellDecoration`. */
export interface CellDecoration {
  /** Orange underline + tooltip (e.g. "Duplicate cue number"). Never blocks editing. */
  warning?: string;
  /**
   * A suggested value shown faintly in the empty cell (e.g. the midpoint cue number). Tab or
   * → accepts it; typing replaces it.
   */
  ghost?: string;
}

/** Imperative handle (`ref` prop). */
export interface DataGridHandle {
  /** Make a row's cell (default: its first editable column) active and focus it. */
  focusRow(rowId: string, columnKey?: string): void;
  /** Scroll a row into view (expanding its group if collapsed) without moving focus. */
  scrollToRow(rowId: string): void;
}

export type GridAction = "edit" | "insert" | "duplicate" | "move" | "delete";

export interface DataGridProps<Row> {
  columns: Column<Row>[];
  rowId: (r: Row) => string;
  /** Exactly one of rows / groups. */
  rows?: Row[];
  groups?: Group<Row>[];
  /** Full-width divider rows (label = the row's first text column). */
  isSection?: (r: Row) => boolean;
  /** Column shown (and edited) as a section row's label; defaults to the first text column. */
  sectionLabelKey?: string;
  onEdit: (rowId: string, key: string, value: unknown) => void | Promise<void>;
  /** Returns the new row's id; the grid focuses its first editable cell once it appears. */
  onInsert?: (opts: InsertPosition) => string | Promise<string>;
  onMove?: (rowId: string, opts: InsertPosition) => void;
  onDelete?: (rowIds: string[]) => void;
  /** Space / the expand icon. */
  onOpenRow?: (rowId: string) => void;
  /** Live sort. Rows hold their place while focused (see README "Ordering"). */
  sort?: SortSpec[];
  colorRules?: ColorRule<Row>[];
  rowHeight?: RowHeight;
  className?: string;
  /** Controlled row selection; omit for internal state. */
  selectedRowIds?: string[];
  onSelectionChange?: (ids: string[]) => void;
  /** The user resized a column (persist it per view). */
  onColumnResize?: (key: string, width: number) => void;
  /** Accessible name of the grid. */
  "aria-label"?: string;
  /** Imperative handle: `focusRow`, `scrollToRow`. */
  ref?: React.Ref<DataGridHandle>;
  /** The active row changed (null: none, or a group header). */
  onActiveRowChange?: (rowId: string | null) => void;
  /** Controlled collapsed group ids; omit for internal state. */
  collapsed?: string[];
  onCollapsedChange?: (ids: string[]) => void;
  /** Extra context-menu entries for a row. */
  extraMenuItems?: (ctx: { rowId: string; selectedRowIds: string[] }) => MenuItem[];
  /** Warnings and ghost suggestions per cell. Keep it stable (`useCallback`). */
  cellDecoration?: (row: Row, key: string) => CellDecoration | undefined;
  /**
   * A callback threw or rejected. The grid also shows a short inline message. Defaults to
   * `console.error`.
   */
  onError?: (error: unknown, action: GridAction) => void;
}
