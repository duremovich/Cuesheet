// Everything a table tab wires around its DataGrid besides data: column widths and
// collapsed groups (localStorage), the `?<param>=<rowId>` URL state, focus requests from
// ⌘K (router state `{ focus: rowId }`), and the row panel's open state.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useSearchParams } from "react-router";
import type { Column, DataGridHandle, GridAction } from "../../components/grid/types";
import { type TabKey, tabInfo } from "../show/tabs";
import { useWorkspace } from "../show/workspace";
import { isStringArray, isWidthMap, prefKey, usePref } from "./prefs";

/** "Couldn't <this>: <reason>" for each grid action (the grid's onError). */
export const GRID_ACTIONS: Record<GridAction, string> = {
  edit: "save the change",
  insert: "add the row",
  duplicate: "duplicate the row",
  move: "move the row",
  delete: "delete",
};

const NO_WIDTHS: Record<string, number> = {};
const NO_IDS: string[] = [];

/** Router state that asks a tab to focus a row (set by the command palette). */
export interface FocusState {
  focus?: string;
}

export function useTableChrome<Row>(opts: {
  tab: TabKey;
  columns: Column<Row>[];
  /** Data has loaded (a URL/⌘K focus waits for it). */
  ready: boolean;
  hasRow: (id: string) => boolean;
  /** Collapsed group ids until the user changes them (keep the array constant). */
  defaultCollapsed?: string[];
}) {
  const { tab, ready } = opts;
  const { showId, userId } = useWorkspace();
  const { table, param } = tabInfo(tab);

  const [widths, setWidths] = usePref(prefKey.widths(showId, table), NO_WIDTHS, isWidthMap);
  const columns = useMemo(
    () =>
      opts.columns.map((c) => {
        const w = widths[c.key];
        return w ? { ...c, width: w } : c;
      }),
    [opts.columns, widths],
  );
  const onColumnResize = useCallback(
    (key: string, width: number) => setWidths({ ...widths, [key]: Math.round(width) }),
    [widths, setWidths],
  );

  const [collapsed, onCollapsedChange] = usePref(
    prefKey.collapsed(userId, showId, table),
    opts.defaultCollapsed ?? NO_IDS,
    isStringArray,
  );

  // --- URL state: ?<param>=<active row id> ---
  const grid = useRef<DataGridHandle>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const urlRow = searchParams.get(param);
  const pendingFocus = useRef<string | null>(urlRow);
  const lastWritten = useRef<string | null>(urlRow);
  const focusState = (location.state as FocusState | null)?.focus;
  // A ⌘K jump (router state), or a URL row we didn't write ourselves (back/forward).
  // biome-ignore lint/correctness/useExhaustiveDependencies: location.key marks a new navigation
  useEffect(() => {
    if (focusState) pendingFocus.current = focusState;
    else if (urlRow && urlRow !== lastWritten.current) pendingFocus.current = urlRow;
  }, [location.key]);
  const hasRow = opts.hasRow;
  useEffect(() => {
    const id = pendingFocus.current;
    if (!ready || !id) return;
    if (!hasRow(id)) {
      pendingFocus.current = null; // deleted meanwhile, or a stale link
      return;
    }
    pendingFocus.current = null;
    grid.current?.focusRow(id);
  });

  const [activeRow, setActiveRow] = useState<string | null>(urlRow);
  const onActiveRowChange = useCallback(
    (id: string | null) => {
      setActiveRow(id);
      if (id === null) return; // keep the last row in the URL when on a group header
      if (id === lastWritten.current) return;
      lastWritten.current = id;
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set(param, id);
          return next;
        },
        { replace: true, preventScrollReset: true },
      );
    },
    [param, setSearchParams],
  );

  // --- Row panel (Space / expand icon); it follows the active row while open ---
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelRow, setPanelRow] = useState<string | null>(null);
  const onOpenRow = useCallback((id: string) => {
    setPanelRow(id);
    setPanelOpen(true);
  }, []);
  const closePanel = useCallback(() => {
    setPanelOpen(false);
    const id = activeRow ?? panelRow;
    if (id) grid.current?.focusRow(id); // never lose your place
  }, [activeRow, panelRow]);
  const shownRow = panelOpen ? (activeRow ?? panelRow) : null;

  return {
    grid,
    columns,
    onColumnResize,
    collapsed,
    onCollapsedChange,
    onActiveRowChange,
    activeRow,
    onOpenRow,
    closePanel,
    panelRow: shownRow && hasRow(shownRow) ? shownRow : null,
  };
}
