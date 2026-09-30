// A table tab built from a small per-table config (columns + how edits, inserts, moves and
// deletes become ops). Scenes, Content, Notes and People use it; the cue list has its own
// component (ghost numbers, sort menu) but the same pieces.
import { type ReactNode, useCallback, useMemo, useRef } from "react";
import { newId } from "../../../shared/ids";
import type { Op } from "../../../shared/ops";
import { DataGrid } from "../../components/grid";
import type { Column, Group, InsertPosition } from "../../components/grid/types";
import { useShowStore, useShowStoreInstance } from "../../lib/show-store";
import { type TabKey, tabInfo } from "../show/tabs";
import { useWorkspace } from "../show/workspace";
import { type PanelSection, RowPanel } from "./RowPanel";
import { TableFrame, ToolbarButton } from "./TableFrame";
import { GRID_ACTIONS, useTableChrome } from "./useTableChrome";

export interface TableConfig<V> {
  tab: TabKey;
  title: string;
  /** Grid name for screen readers ("Scene list"). */
  label: string;
  /** Singular noun for messages and the add button ("scene"). */
  noun: string;
  /** Plural for the row count (default: noun + "s"). */
  plural?: string;
  columns: Column<V>[];
  rowId: (v: V) => string;
  /** Exactly one of rows / groups. */
  rows?: V[];
  groups?: Group<V>[];
  /** The ops for a grid edit. */
  editOps: (view: V, key: string, value: unknown) => Op[];
  /** The create op(s) for a new row with id `id` (omit: no inserting). */
  createOps?: (id: string, pos: InsertPosition) => Op[];
  /** The ops for a drag (omit: no dragging, e.g. unordered tables). */
  moveOps?: (view: V, pos: InsertPosition) => Op[];
  /** Delete ops (omit: no deleting). Return a string to refuse with that message. */
  deleteOps?: (views: V[]) => Op[] | string;
  panelTitle: (v: V) => string;
  panelSections?: (v: V) => PanelSection[];
  toolbar?: ReactNode;
  empty?: ReactNode;
  /** Groups collapsed until the user expands them (a constant array). */
  defaultCollapsed?: string[];
  /** Where the toolbar's "+ Add" button inserts (default: the end of the last group). */
  addPosition?: InsertPosition;
  testId?: string;
}

export function TableGrid<V>(config: TableConfig<V>) {
  const ws = useWorkspace();
  const store = useShowStoreInstance();
  const status = useShowStore((s) => s.status);
  const all = useMemo(
    () => config.rows ?? config.groups?.flatMap((g) => g.rows) ?? [],
    [config.rows, config.groups],
  );
  const byId = useMemo(() => new Map(all.map((v) => [config.rowId(v), v])), [all, config.rowId]);
  const byIdRef = useRef(byId);
  byIdRef.current = byId;
  const cfg = useRef(config);
  cfg.current = config;

  const chrome = useTableChrome({
    tab: config.tab,
    columns: config.columns,
    ready: status === "ready",
    hasRow: useCallback((id: string) => byIdRef.current.has(id), []),
    ...(config.defaultCollapsed ? { defaultCollapsed: config.defaultCollapsed } : {}),
  });

  const report = ws.reportError;
  const send = useCallback(
    (ops: Op[], what: string) => {
      if (ops.length === 0) return;
      store.mutate(ops).catch((e: unknown) => report(e, what));
    },
    [store, report],
  );

  const onEdit = useCallback(
    (id: string, key: string, value: unknown) => {
      const v = byIdRef.current.get(id);
      if (!v) return;
      return store.mutate(cfg.current.editOps(v, key, value));
    },
    [store],
  );

  const insert = useCallback(
    (pos: InsertPosition) => {
      const id = newId();
      send(cfg.current.createOps?.(id, pos) ?? [], `add the ${cfg.current.noun}`);
      return id;
    },
    [send],
  );

  const onMove = useCallback(
    (id: string, pos: InsertPosition) => {
      const v = byIdRef.current.get(id);
      if (v) send(cfg.current.moveOps?.(v, pos) ?? [], `move the ${cfg.current.noun}`);
    },
    [send],
  );

  const onDelete = useCallback(
    (ids: string[]) => {
      const views = ids.flatMap((id) => byIdRef.current.get(id) ?? []);
      const ops = cfg.current.deleteOps?.(views) ?? [];
      if (typeof ops === "string") {
        ws.toast(ops, "error");
        return;
      }
      send(ops, `delete ${ids.length === 1 ? `the ${cfg.current.noun}` : "the rows"}`);
    },
    [send, ws],
  );

  const addAtEnd = () => {
    const last = config.groups?.at(-1);
    const id = insert(config.addPosition ?? (last ? { groupId: last.id } : {}));
    requestAnimationFrame(() => chrome.grid.current?.focusRow(id));
  };

  const panelView = chrome.panelRow ? byId.get(chrome.panelRow) : undefined;
  const canInsert = !!config.createOps;
  const count = all.length;

  return (
    <TableFrame
      title={config.title}
      testId={config.testId}
      toolbar={
        <>
          <span className="muted">
            {count} {count === 1 ? config.noun : (config.plural ?? `${config.noun}s`)}
          </span>
          {config.toolbar}
          {canInsert && <ToolbarButton onClick={addAtEnd}>+ Add {config.noun}</ToolbarButton>}
        </>
      }
      notice={count === 0 ? config.empty : null}
      panel={
        panelView ? (
          <RowPanel
            title={config.panelTitle(panelView)}
            row={panelView}
            columns={chrome.columns}
            table={tabInfo(config.tab).table}
            recordId={config.rowId(panelView)}
            onEdit={(key, value) => onEdit(config.rowId(panelView), key, value)}
            sections={config.panelSections?.(panelView) ?? []}
            onClose={chrome.closePanel}
            onStep={chrome.stepPanel}
          />
        ) : null
      }
    >
      <DataGrid<V>
        ref={chrome.grid}
        aria-label={config.label}
        columns={chrome.columns}
        rowId={config.rowId}
        {...(config.groups ? { groups: config.groups } : { rows: config.rows ?? [] })}
        collapsed={chrome.collapsed}
        onCollapsedChange={chrome.onCollapsedChange}
        onColumnResize={chrome.onColumnResize}
        onActiveRowChange={chrome.onActiveRowChange}
        onOpenRow={chrome.onOpenRow}
        {...(chrome.onEscape ? { onEscape: chrome.onEscape } : {})}
        addRowLabel={`Add ${config.noun}`}
        onEdit={onEdit}
        {...(canInsert ? { onInsert: insert } : {})}
        {...(config.moveOps ? { onMove } : {})}
        {...(config.deleteOps ? { onDelete } : {})}
        onError={(e, action) => report(e, GRID_ACTIONS[action])}
      />
    </TableFrame>
  );
}
