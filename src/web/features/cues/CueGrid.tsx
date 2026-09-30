// The Cues tab: the cue list on the live store (R1–R5a). Grouped by scene, show order by
// default, optional live sort by number, "Sort now", ghost numbers and duplicate warnings.
import { useCallback, useMemo, useRef } from "react";
import { newId } from "../../../shared/ids";
import type { Op } from "../../../shared/ops";
import { DataGrid, sortRows } from "../../components/grid";
import type { CellDecoration, Column, InsertPosition, MenuItem } from "../../components/grid/types";
import { sceneIdForGroup, UNASSIGNED, ViewCache } from "../../lib/show-selectors";
import type { ShowState } from "../../lib/show-store";
import { useShowStore, useShowStoreInstance } from "../../lib/show-store";
import { MenuButton } from "../shared/MenuButton";
import { groupOrder, placementFor } from "../shared/ops";
import { RowPanel } from "../shared/RowPanel";
import { TableFrame, ToolbarButton } from "../shared/TableFrame";
import styles from "../shared/TableFrame.module.css";
import { GRID_ACTIONS, useTableChrome } from "../shared/useTableChrome";
import { useWorkspace } from "../show/workspace";
import { useTechShortcut } from "../tech/useTechShortcut";
import { cueColumns, cueEditOps } from "./columns";
import { cueNumberHints, hintsEqual, type InsertAnchor } from "./cueNumbers";
import { buildCueViews, type CueView, cueGroups, openNotesByScene } from "./cueViews";

const NUMBER_SORT = [{ key: "number", dir: "asc" as const }];

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
  const chrome = useTableChrome({
    tab: "cues",
    columns: baseColumns,
    ready: state.status === "ready",
    hasRow: useCallback((id: string) => viewsRef.current.has(id), []),
  });

  // --- Cue number hints (ghost midpoint, duplicates) ---
  const sort = ws.cueSort;
  const anchors = useRef(new Map<string, InsertAnchor>());
  const prevHints = useRef<Map<string, CellDecoration>>(new Map());
  const hints = useMemo(() => {
    const display = groups.flatMap((g) => (sort ? sortRows(g.rows, sort, baseColumns) : g.rows));
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
    (pos: InsertPosition, fields: Record<string, unknown> = {}) => {
      const id = newId();
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
        ],
        "add the cue",
      ).catch(() => undefined);
      return id;
    },
    [send, sort],
  );
  const onInsert = useCallback((pos: InsertPosition) => insert(pos), [insert]);

  const onMove = useCallback(
    (id: string, pos: InsertPosition) => {
      const view = viewsRef.current.get(id);
      if (!view) return;
      const ops: Op[] = [
        { op: "move", table: "cues", id, ...placementFor(pos, groupOrder(groupsRef.current), id) },
      ];
      const sceneId = sceneIdForGroup(pos.groupId);
      if (sceneId !== undefined && sceneId !== (view.cue.scene_id ?? null)) {
        ops.push({ op: "update", table: "cues", id, fields: { scene_id: sceneId } });
      }
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

  // T (not editing): tech mode at the active cue.
  useTechShortcut(chrome.activeRow);

  const onActiveRowChange = chrome.onActiveRowChange;
  const lastActive = useRef<string | null>(null);
  const onActive = useCallback(
    (id: string | null) => {
      // A held insert settles once you leave it; its anchor no longer says where it is.
      const prev = lastActive.current;
      if (prev && prev !== id) anchors.current.delete(prev);
      lastActive.current = id;
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
    const last = groups.at(-1);
    const id = insert(last ? { groupId: last.id } : {});
    requestAnimationFrame(() => chrome.grid.current?.focusRow(id));
  };

  const cueCount = views.filter((v) => !v.cue.is_section).length;
  const panelView = chrome.panelRow ? viewsById.get(chrome.panelRow) : undefined;

  return (
    <TableFrame
      title="Cues"
      testId="cue-list"
      toolbar={
        <>
          <span className="muted" data-testid="cue-count">
            {cueCount} {cueCount === 1 ? "cue" : "cues"}
          </span>
          <MenuButton
            label="Sort"
            pressed={!!sort}
            items={[
              {
                label: "Sort by cue number (live)",
                checked: !!sort,
                onSelect: () => ws.setCueSort(NUMBER_SORT),
              },
              { label: "Remove sort", disabled: !sort, onSelect: () => ws.setCueSort(undefined) },
              ...(editable
                ? [{ label: "Sort now by cue number", onSelect: () => void ws.sortCuesNow() }]
                : []),
            ]}
          >
            {sort ? "Sorted by cue number" : "Sort"} ▾
          </MenuButton>
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
      <DataGrid<CueView>
        ref={chrome.grid}
        aria-label="Cue list"
        columns={chrome.columns}
        rowId={(v) => v.id}
        groups={groups}
        isSection={(v) => v.cue.is_section}
        sectionLabelKey="description"
        sort={sort}
        cellDecoration={cellDecoration}
        collapsed={chrome.collapsed}
        onCollapsedChange={chrome.onCollapsedChange}
        onColumnResize={chrome.onColumnResize}
        onActiveRowChange={onActive}
        onOpenRow={chrome.onOpenRow}
        {...(chrome.onEscape ? { onEscape: chrome.onEscape } : {})}
        addRowLabel="Add cue"
        onEdit={onEdit}
        {...(editable ? { onInsert, onMove, onDelete, extraMenuItems } : {})}
        onError={(e, action) => report(e, GRID_ACTIONS[action])}
      />
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
