// Everything a table tab wires around its DataGrid besides data and the saved view: the
// `?<param>=<rowId>` URL state, focus requests from ⌘K (router state `{ focus: rowId }`),
// the row panel's open state, and whether the tab opens where you left it (scroll memory,
// useGridScrollMemory). Column layout and collapsed groups come from the view
// (features/views/useViewConfig.ts).
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useLocation, useNavigationType, useSearchParams } from "react-router";
import type { Column, DataGridHandle, GridAction } from "../../components/grid/types";
import { scrollKey, scrollMemory, shouldRestore } from "../../lib/scrollMemory";
import { useShowStoreInstance } from "../../lib/show-store";
import { type AnyTabKey, tabInfo } from "../show/tabs";
import { useWorkspace } from "../show/workspace";

/** "Couldn't <this>: <reason>" for each grid action (the grid's onError). */
export const GRID_ACTIONS: Record<GridAction, string> = {
  edit: "save the change",
  insert: "add the row",
  duplicate: "duplicate the row",
  move: "move the row",
  delete: "delete",
};

/** Router state that asks a tab to focus a row (set by the command palette). */
export interface FocusState {
  focus?: string;
}

export function useTableChrome<Row>(opts: {
  tab: AnyTabKey;
  /** Every column (the row panel shows all fields, whatever the view hides). */
  columns: Column<Row>[];
  /** Data has loaded (a URL/⌘K focus waits for it). */
  ready: boolean;
  hasRow: (id: string) => boolean;
  /**
   * The saved view's check before focusing a row (`useViewConfig().reveal`): a row its
   * filter hides is held and shown first ("pending": focus on a later render).
   */
  reveal?: (id: string) => "shown" | "pending" | "missing";
}) {
  const { tab, ready } = opts;
  const { toast, showId } = useWorkspace();
  const { table, param, noun } = tabInfo(tab);
  const columns = opts.columns;

  // --- URL state: ?<param>=<active row id> ---
  const grid = useRef<DataGridHandle>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const urlRow = searchParams.get(param);
  const focusState = (location.state as FocusState | null)?.focus;
  // Opened by a tab click (or a reload / back to the URL you left): back where you were, so
  // the URL's row isn't jumped to (the grid restores it as the active row). A jump (⌘K,
  // "Show in list", a link to another row) goes where it points instead.
  const navigationType = useNavigationType();
  const [restoreScroll] = useState(() =>
    shouldRestore({
      focusState,
      urlRow,
      navigationType,
      locationKey: location.key,
      rememberedRow: scrollMemory.latest(scrollKey(showId, tab, ""))?.active?.rowId,
    }),
  );
  const mountRow = useRef(urlRow);
  const pendingFocus = useRef<string | null>(restoreScroll ? null : urlRow);
  const lastWritten = useRef<string | null>(urlRow);
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
      // Deleted meanwhile, or a stale link: say so and drop it from the URL.
      pendingFocus.current = null;
      toast(`That ${noun} no longer exists.`);
      if (searchParams.get(param) === id) {
        lastWritten.current = null;
        setSearchParams(
          (prev) => {
            const next = new URLSearchParams(prev);
            next.delete(param);
            return next;
          },
          { replace: true, preventScrollReset: true },
        );
      }
      return;
    }
    if (opts.reveal?.(id) === "pending") return; // shown on the next render
    pendingFocus.current = null;
    grid.current?.focusRow(id);
  });

  const [activeRow, setActiveRow] = useState<string | null>(urlRow);
  const activeRowRef = useRef(activeRow);
  activeRowRef.current = activeRow;

  // Someone deleted the row you're typing in: the grid drops the edit; tell the user.
  // (Runs in the store listener, before React re-renders, while the editor still has focus.)
  const store = useShowStoreInstance();
  useEffect(
    () =>
      store.subscribe(() => {
        const id = activeRowRef.current;
        if (!id || store.getState().tables[table].has(id)) return;
        const el = document.activeElement as HTMLElement | null;
        if (el?.dataset.editor !== "true") return;
        activeRowRef.current = null;
        toast(`This ${noun} was deleted by someone else; your edit was discarded.`, "error");
      }),
    [store, table, noun, toast],
  );
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
  const stepPanel = useCallback((delta: number) => {
    grid.current?.stepRow(delta);
  }, []);
  /** The grid's `onEscape`: closes the panel when the grid had nothing else to cancel. */
  const onEscape = panelOpen ? closePanel : undefined;

  /** The scroll memory had nothing for this view: focus the URL's row the usual way. */
  const [, rerun] = useReducer((n: number) => n + 1, 0);
  const focusUrlRow = useCallback(() => {
    if (!mountRow.current) return;
    pendingFocus.current = mountRow.current;
    rerun(); // the focus effect above runs after every render
  }, []);

  return {
    grid,
    restoreScroll,
    urlRowAtMount: mountRow.current,
    focusUrlRow,
    columns,
    onActiveRowChange,
    activeRow,
    onOpenRow,
    closePanel,
    stepPanel,
    onEscape,
    panelRow: shownRow && hasRow(shownRow) ? shownRow : null,
  };
}
