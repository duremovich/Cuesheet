// The Cues tab: the cue list on the live store (R1–R5a). Grouped by scene, show order by
// default, optional live sort by number, "Sort now", ghost numbers and duplicate warnings.
import { useCallback, useMemo, useRef } from "react";
import { newId } from "../../../shared/ids";
import type { Op } from "../../../shared/ops";
import { DataGrid } from "../../components/grid";
import type { CellDecoration, Column, InsertPosition, MenuItem } from "../../components/grid/types";
import { sceneIdForGroup, UNASSIGNED, ViewCache } from "../../lib/show-selectors";
import type { ShowState } from "../../lib/show-store";
import { useShowStore, useShowStoreInstance } from "../../lib/show-store";
import { groupOrder, placementFor } from "../shared/ops";
import { RowPanel } from "../shared/RowPanel";
import { TableFrame, ToolbarButton } from "../shared/TableFrame";
import styles from "../shared/TableFrame.module.css";
import { GRID_ACTIONS, useTableChrome } from "../shared/useTableChrome";
import { useWorkspace } from "../show/workspace";
import type { FieldDef } from "../views/evaluate";
import { type SortPreset, useViewConfig } from "../views/useViewConfig";
import { cueColumns, cueEditOps } from "./columns";
import { cueNumberHints, hintsEqual, type InsertAnchor } from "./cueNumbers";
import {
  buildCueViews,
  type CueView,
  cueGroups,
  hintOrder,
  openNotesByCue,
  openNotesByScene,
} from "./cueViews";

const SORT_PRESETS: SortPreset[] = [
  { label: "Sort by cue number (live)", sorts: [{ key: "number", dir: "asc" }] },
];

const selectState = (s: ShowState) => s;

export function CueGrid() {
  const ws = useWorkspace();
  const store = useShowStoreInstance();
  const state = useShowStore(selectState);
  const { tables, order, joins, fieldOptions } = state;
  const editable = ws.canEdit;

  // --- Rows and groups ---
  const cache = useRef(new ViewCache<CueView>()).current;
  // biome-ignore lint/correctness/useExhaustiveDependencies: recomputed when the inputs change
  const views = useMemo(
    () => buildCueViews(state, cache),
    [
      tables.cues,
      tables.content,
      tables.persons,
      tables.scenes,
      order.cues,
      joins.cueContent,
      joins.cueAssignees,
    ],
  );
  const viewsById = useMemo(() => new Map(views.map((v) => [v.id, v])), [views]);
  const viewsRef = useRef(viewsById);
  viewsRef.current = viewsById;
  const scenes = useMemo(
    () => order.scenes.flatMap((id) => tables.scenes.get(id) ?? []),
    [order.scenes, tables.scenes],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: recomputed when notes / links change
  const openNotes = useMemo(
    () => openNotesByScene(state),
    [tables.notes, joins.noteCues, tables.cues],
  );
  const groups = useMemo(() => cueGroups(scenes, views, openNotes), [scenes, views, openNotes]);
  const groupsRef = useRef(groups);
  groupsRef.current = groups;

  const baseColumns = useMemo(
    () => cueColumns({ store, fieldOptions, editable }),
    [store, fieldOptions, editable],
  );
  // The saved view (below) decides whether a row is shown; the chrome asks it first.
  const revealRef = useRef<((id: string) => "shown" | "pending" | "missing") | null>(null);
  const chrome = useTableChrome({
    tab: "cues",
    columns: baseColumns,
    ready: state.status === "ready",
    hasRow: useCallback((id: string) => viewsRef.current.has(id), []),
    reveal: useCallback((id: string) => revealRef.current?.(id) ?? "shown", []),
  });

  // --- The saved view: filters, grouping, sort, fields, colors ---
  // biome-ignore lint/correctness/useExhaustiveDependencies: recomputed when notes / links change
  const openByCue = useMemo(() => openNotesByCue(state), [tables.notes, joins.noteCues]);
  const extraFields = useMemo<FieldDef<CueView>[]>(
    () => [
      {
        key: "open_notes",
        title: "Open notes",
        type: "number",
        getValue: (v) => openByCue.get(v.id) ?? 0,
      },
    ],
    [openByCue],
  );
  const sortNow = useMemo(
    () => ({ label: "Sort now by cue number", run: ws.sortCuesNow }),
    [ws.sortCuesNow],
  );
  const vc = useViewConfig<CueView>({
    table: "cues",
    focusRow: useCallback((id: string) => chrome.grid.current?.focusRow(id), [chrome.grid]),
    columns: baseColumns,
    extraFields,
    rowId: (v) => v.id,
    rows: views,
    groups,
    nativeGroupKey: "scene",
    editOps: cueEditOps,
    sortPresets: SORT_PRESETS,
    sortNow,
  });
  const vcRef = useRef(vc);
  vcRef.current = vc;
  revealRef.current = vc.reveal;
  const shownGroups = vc.groups;
  const shownRows = vc.rows;

  // --- Cue number hints (ghost midpoint, duplicates) ---
  const sort = vc.sort;
  const anchors = useRef(new Map<string, InsertAnchor>());
  const prevHints = useRef<Map<string, CellDecoration>>(new Map());
  // Over ALL cues (show order, or the full sorted order under a live sort), never the
  // filtered display: a filter mustn't change the suggested number or hide a duplicate.
  const hints = useMemo(() => {
    const display = hintOrder(groups, sort, baseColumns);
    const next = cueNumberHints(
      display.map((v) => ({
        id: v.id,
        number: v.cue.number,
        isSection: v.cue.is_section,
        description: v.cue.description,
      })),
      sort ? anchors.current : undefined,
    );
    if (hintsEqual(prevHints.current, next)) return prevHints.current;
    prevHints.current = next;
    return next;
  }, [groups, sort, baseColumns]);
  const cellDecoration = useCallback(
    (v: CueView, key: string) => (key === "number" ? hints.get(v.id) : undefined),
    [hints],
  );

  // --- Callbacks → ops ---
  const report = ws.reportError;
  const send = useCallback(
    (ops: Op[], what: string) => {
      if (ops.length === 0) return Promise.resolve();
      return store.mutate(ops).catch((e: unknown) => {
        report(e, what);
        throw e;
      });
    },
    [store, report],
  );

  const onEdit = useCallback(
    (id: string, key: string, value: unknown) => {
      const view = viewsRef.current.get(id);
      if (!view) return;
      const ops = cueEditOps(view, key, value);
      if (key === "scene") {
        // A new scene also puts the cue at the end of that scene's group (one batch), so it
        // lands somewhere predictable when focus leaves it.
        const sceneId = (value as { id: string } | null)?.id ?? null;
        if (sceneId !== (view.cue.scene_id ?? null)) {
          const groups = groupOrder(groupsRef.current);
          const groupId = sceneId ?? UNASSIGNED;
          // A scene the groups don't know yet was just created (last in scene order): the
          // end of the show is the end of its group.
          const placement = groups.some((g) => g.id === groupId)
            ? placementFor({ groupId }, groups, id)
            : {};
          ops.push({ op: "move", table: "cues", id, ...placement });
        }
      }
      // Rejections reach the grid's onError (toast below).
      return store.mutate(ops);
    },
    [store],
  );

  const insert = useCallback(
    (at: InsertPosition, fields: Record<string, unknown> = {}) => {
      const id = newId();
      const v = vcRef.current;
      // An insert that doesn't match the view's filter stays until you leave it.
      v.hold(id);
      const pos = v.mapPosition(at);
      let sceneId = sceneIdForGroup(pos.groupId);
      if (sceneId === undefined) {
        const n = viewsRef.current.get(pos.afterRowId ?? pos.beforeRowId ?? "");
        sceneId = n?.cue.scene_id ?? null;
      }
      if (sort && (pos.afterRowId || pos.beforeRowId)) {
        anchors.current.set(id, {
          ...(pos.afterRowId ? { after: pos.afterRowId } : {}),
          ...(pos.beforeRowId ? { before: pos.beforeRowId } : {}),
        });
      }
      void send(
        [
          {
            op: "create",
            table: "cues",
            id,
            fields: { scene_id: sceneId, ...fields },
            ...placementFor(pos, groupOrder(groupsRef.current)),
          },
          ...v.groupOps(id, at),
        ],
        "add the cue",
      ).catch(() => undefined);
      return id;
    },
    [send, sort],
  );
  const onInsert = useCallback((pos: InsertPosition) => insert(pos), [insert]);

  const onMove = useCallback(
    (id: string, at: InsertPosition) => {
      const view = viewsRef.current.get(id);
      if (!view) return;
      const pos = vcRef.current.mapPosition(at);
      const ops: Op[] = [
        { op: "move", table: "cues", id, ...placementFor(pos, groupOrder(groupsRef.current), id) },
      ];
      const sceneId = sceneIdForGroup(pos.groupId);
      if (sceneId !== undefined && sceneId !== (view.cue.scene_id ?? null)) {
        ops.push({ op: "update", table: "cues", id, fields: { scene_id: sceneId } });
      }
      ops.push(...vcRef.current.groupOps(id, at, view));
      void send(ops, "move the cue").catch(() => undefined);
    },
    [send],
  );

  const onDelete = useCallback(
    (ids: string[]) => {
      const ops: Op[] = ids
        .filter((id) => viewsRef.current.has(id))
        .map((id) => ({ op: "delete", table: "cues", id }));
      void send(ops, ids.length === 1 ? "delete the cue" : "delete the cues").catch(
        () => undefined,
      );
    },
    [send],
  );

  const onActiveRowChange = chrome.onActiveRowChange;
  const lastActive = useRef<string | null>(null);
  const onActive = useCallback(
    (id: string | null) => {
      // A held insert settles once you leave it; its anchor no longer says where it is.
      const prev = lastActive.current;
      if (prev && prev !== id) anchors.current.delete(prev);
      lastActive.current = id;
      vcRef.current.trackActive(id);
      onActiveRowChange(id);
    },
    [onActiveRowChange],
  );

  const extraMenuItems = useCallback(
    ({ rowId }: { rowId: string }): MenuItem[] => {
      if (!viewsRef.current.has(rowId)) return [];
      return [
        {
          label: "Insert section divider below",
          onSelect: () => {
            const id = insert({ afterRowId: rowId }, { is_section: true, description: "SECTION" });
            requestAnimationFrame(() => chrome.grid.current?.focusRow(id, "description"));
          },
        },
      ];
    },
    [insert, chrome.grid],
  );

  const addCueAtEnd = () => {
    const last = vc.groups?.at(-1);
    const id = insert(last ? { groupId: last.id } : {});
    requestAnimationFrame(() => chrome.grid.current?.focusRow(id));
  };

  const cueCount = views.filter((v) => !v.cue.is_section).length;
  const shownCues = (shownGroups?.flatMap((g) => g.rows) ?? shownRows ?? []).filter(
    (v) => !v.cue.is_section,
  ).length;
  const panelView = chrome.panelRow ? viewsById.get(chrome.panelRow) : undefined;

  return (
    <TableFrame
      title="Cues"
      testId="cue-list"
      toolbar={
        <>
          <span className="muted" data-testid="cue-count">
            {vc.filtered ? `${shownCues} of ` : ""}
            {cueCount} {cueCount === 1 ? "cue" : "cues"}
          </span>
          {vc.toolbar}
          {editable && (
            <ToolbarButton onClick={addCueAtEnd} title="Add a cue at the end of the show">
              + Add cue
            </ToolbarButton>
          )}
        </>
      }
      notice={
        cueCount === 0 ? (
          <p className={styles.empty} data-testid="cue-empty">
            No cues yet.{" "}
            {editable ? "Add one with + Add cue, or import Airtable CSVs from Show settings." : ""}
          </p>
        ) : null
      }
      panel={
        panelView ? (
          <CuePanel
            view={panelView}
            columns={chrome.columns}
            onClose={chrome.closePanel}
            onStep={chrome.stepPanel}
            onEdit={(key, value) => onEdit(panelView.id, key, value)}
          />
        ) : null
      }
    >
      <div {...vc.wrapProps}>
        <DataGrid<CueView>
          ref={chrome.grid}
          aria-label="Cue list"
          columns={vc.columns}
          rowId={(v) => v.id}
          {...(shownGroups ? { groups: shownGroups } : { rows: shownRows ?? [] })}
          isSection={(v) => v.cue.is_section}
          sectionLabelKey="description"
          sort={sort}
          sortColumns={vc.sortColumns}
          rowHeight={vc.rowHeight}
          colorRules={vc.colorRules}
          cellDecoration={cellDecoration}
          collapsed={vc.collapsed}
          onCollapsedChange={vc.onCollapsedChange}
          onColumnResize={vc.onColumnResize}
          onActiveRowChange={onActive}
          onOpenRow={chrome.onOpenRow}
          {...(chrome.onEscape ? { onEscape: chrome.onEscape } : {})}
          addRowLabel="Add cue"
          onEdit={onEdit}
          {...(editable ? { onInsert, onMove, onDelete, extraMenuItems } : {})}
          onError={(e, action) => report(e, GRID_ACTIONS[action])}
        />
      </div>
    </TableFrame>
  );
}

function CuePanel({
  view,
  columns,
  onClose,
  onStep,
  onEdit,
}: {
  view: CueView;
  columns: Column<CueView>[];
  onClose: () => void;
  onStep: (delta: number) => void;
  onEdit: (key: string, value: unknown) => Promise<void> | undefined;
}) {
  const title = view.cue.is_section
    ? `Section: ${view.cue.description ?? ""}`
    : view.cue.number
      ? `Cue ${view.cue.number}`
      : "Cue (no number)";
  return (
    <RowPanel
      title={title}
      row={view}
      columns={columns}
      table="cues"
      recordId={view.id}
      onEdit={onEdit}
      onClose={onClose}
      onStep={onStep}
    />
  );
}
