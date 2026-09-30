// A table tab built from a small per-table config (columns + how edits, inserts, moves and
// deletes become ops). Scenes, Content, Notes and People use it; the cue list has its own
// component (ghost numbers, sort menu) but the same pieces.
import { type ReactNode, useCallback, useMemo, useRef } from "react";
import { newId } from "../../../shared/ids";
import type { Op } from "../../../shared/ops";
import type { AttachmentRow } from "../../../shared/tables";
import type { Unit } from "../../../shared/units";
import { DataGrid } from "../../components/grid";
import type { Column, Group, InsertPosition } from "../../components/grid/types";
import { useShowStore, useShowStoreInstance } from "../../lib/show-store";
import { openLightbox } from "../attachments/state";
import { type TabKey, tabInfo } from "../show/tabs";
import { useWorkspace } from "../show/workspace";
import type { FieldDef } from "../views/evaluate";
import { Gallery } from "../views/Gallery";
import { DATE_FIELDS, NATIVE_GROUP_KEY } from "../views/tableDefaults";
import { useViewConfig } from "../views/useViewConfig";
import { type PanelSection, type PanelTab, RowPanel } from "./RowPanel";
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
  /**
   * All rows in the table's order (default: the groups' rows). `groups` is the tab's own
   * grouping, used when the saved view groups by `nativeGroupKey`; any other grouping,
   * filtering and sorting comes from the view (features/views/useViewConfig.tsx).
   */
  rows?: V[];
  groups?: Group<V>[];
  nativeGroupKey?: string;
  /** Extra fields a view can filter/color by (not columns). */
  extraFields?: FieldDef<V>[];
  /** Readonly timestamp columns (before/after filters). */
  dateFields?: readonly string[];
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
  /** Extra row panel tabs after Fields (e.g. a surface's Calculator). */
  panelTabs?: (v: V, ctx: { unit: Unit; viewUnit: Unit | undefined }) => PanelTab[];
  toolbar?: ReactNode;
  empty?: ReactNode;
  /** Native groups collapsed until the user expands them (a constant array). */
  defaultCollapsed?: string[];
  /** Columns hidden at phone width unless the view lists them (a constant array). */
  narrowHidden?: readonly string[];
  /** Where the toolbar's "+ Add" button inserts (default: the end of the last group). */
  addPosition?: InsertPosition;
  testId?: string;
  /**
   * The table can show as gallery cards (R19): a view's `layout: "gallery"`. `image` is the
   * card's picture (the first image attachment), `title` its heading.
   */
  gallery?: {
    presetName: string;
    titleKey: string;
    title: (v: V) => string;
    image: (v: V) => AttachmentRow | undefined;
  };
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

  // The saved view (below) decides whether a row is shown; the chrome asks it first.
  const revealRef = useRef<((id: string) => "shown" | "pending" | "missing") | null>(null);
  const chrome = useTableChrome({
    tab: config.tab,
    columns: config.columns,
    ready: status === "ready",
    hasRow: useCallback((id: string) => byIdRef.current.has(id), []),
    reveal: useCallback((id: string) => revealRef.current?.(id) ?? "shown", []),
  });

  const table = tabInfo(config.tab).table;
  const nativeGroupKey = config.nativeGroupKey ?? NATIVE_GROUP_KEY[table];
  const dateFields = config.dateFields ?? DATE_FIELDS[table];
  const view = useViewConfig<V>({
    table,
    focusRow: useCallback((id: string) => chrome.grid.current?.focusRow(id), [chrome.grid]),
    columns: config.columns,
    rowId: config.rowId,
    rows: all,
    editOps: useCallback(
      (v: V, key: string, value: unknown) => cfg.current.editOps(v, key, value),
      [],
    ),
    ...(config.groups ? { groups: config.groups } : {}),
    ...(nativeGroupKey ? { nativeGroupKey } : {}),
    ...(config.defaultCollapsed ? { defaultCollapsed: config.defaultCollapsed } : {}),
    ...(config.narrowHidden ? { narrowHidden: config.narrowHidden } : {}),
    ...(config.extraFields ? { extraFields: config.extraFields } : {}),
    ...(dateFields ? { dateFields } : {}),
    ...(config.gallery ? { gallery: { presetName: config.gallery.presetName } } : {}),
  });
  const viewRef = useRef(view);
  viewRef.current = view;
  revealRef.current = view.reveal;

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
      const v = viewRef.current;
      v.hold(id); // an insert that doesn't match the filter stays until you leave it
      send(
        [...(cfg.current.createOps?.(id, v.mapPosition(pos)) ?? []), ...v.groupOps(id, pos)],
        `add the ${cfg.current.noun}`,
      );
      return id;
    },
    [send],
  );

  const onMove = useCallback(
    (id: string, pos: InsertPosition) => {
      const v = byIdRef.current.get(id);
      const vc = viewRef.current;
      if (v) {
        send(
          [...(cfg.current.moveOps?.(v, vc.mapPosition(pos)) ?? []), ...vc.groupOps(id, pos, v)],
          `move the ${cfg.current.noun}`,
        );
      }
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
    const last = view.groups?.at(-1);
    const id = insert(config.addPosition ?? (last ? { groupId: last.id } : {}));
    requestAnimationFrame(() => chrome.grid.current?.focusRow(id));
  };

  const panelView = chrome.panelRow ? byId.get(chrome.panelRow) : undefined;
  const canInsert = !!config.createOps;
  const count = all.length;
  const onActiveRowChange = chrome.onActiveRowChange;
  const onActive = useCallback(
    (id: string | null) => {
      viewRef.current.trackActive(id);
      onActiveRowChange(id);
    },
    [onActiveRowChange],
  );

  return (
    <TableFrame
      title={config.title}
      testId={config.testId}
      toolbar={
        <>
          <span className="muted" data-testid="row-count">
            {view.filtered ? `${view.shownCount} of ` : ""}
            {count} {count === 1 ? config.noun : (config.plural ?? `${config.noun}s`)}
          </span>
          {view.toolbar}
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
            columns={view.sortColumns}
            table={tabInfo(config.tab).table}
            recordId={config.rowId(panelView)}
            onEdit={(key, value) => onEdit(config.rowId(panelView), key, value)}
            sections={config.panelSections?.(panelView) ?? []}
            extraTabs={config.panelTabs?.(panelView, { unit: view.unit, viewUnit: view.viewUnit })}
            onClose={chrome.closePanel}
            onStep={chrome.stepPanel}
          />
        ) : null
      }
    >
      <div {...view.wrapProps}>
        {view.layout === "gallery" && config.gallery ? (
          <Gallery<V>
            ref={chrome.grid}
            aria-label={`${config.label} (gallery)`}
            {...(view.groups ? { groups: view.groups } : { rows: view.rows ?? [] })}
            rowId={config.rowId}
            columns={view.columns}
            titleKey={config.gallery.titleKey}
            title={config.gallery.title}
            image={config.gallery.image}
            showId={ws.showId}
            colorRules={view.colorRules}
            onActiveRowChange={onActive}
            onOpenRow={chrome.onOpenRow}
            onOpenImage={(v, file) =>
              openLightbox({
                table,
                recordId: config.rowId(v),
                field: file.field,
                attachmentId: file.id,
              })
            }
            {...(chrome.onEscape ? { onEscape: chrome.onEscape } : {})}
          />
        ) : (
          <DataGrid<V>
            ref={chrome.grid}
            aria-label={config.label}
            columns={view.columns}
            rowId={config.rowId}
            {...(view.groups ? { groups: view.groups } : { rows: view.rows ?? [] })}
            sort={view.sort}
            sortColumns={view.sortColumns}
            rowHeight={view.rowHeight}
            colorRules={view.colorRules}
            collapsed={view.collapsed}
            onCollapsedChange={view.onCollapsedChange}
            onColumnResize={view.onColumnResize}
            onActiveRowChange={onActive}
            onOpenRow={chrome.onOpenRow}
            {...(chrome.onEscape ? { onEscape: chrome.onEscape } : {})}
            addRowLabel={`Add ${config.noun}`}
            onEdit={onEdit}
            {...(canInsert ? { onInsert: insert } : {})}
            {...(config.moveOps ? { onMove } : {})}
            {...(config.deleteOps ? { onDelete } : {})}
            onError={(e, action) => report(e, GRID_ACTIONS[action])}
          />
        )}
      </div>
    </TableFrame>
  );
}
