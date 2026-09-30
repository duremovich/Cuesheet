// The Shots tab (R14): a shot-list picker (create / rename / delete lists) above the list's
// shots, grouped by `group` (a scene or setup) with the cue list's ordering behaviors:
// show order, insert / drag (across groups re-sets the group), ghost numbers between
// numbered neighbours and duplicate warnings. Prints through the generic Print view; the
// "Shot list" view preset is the print layout.
import { useCallback, useMemo, useRef } from "react";
import { newId } from "../../../shared/ids";
import type { Op } from "../../../shared/ops";
import type { ShotListRow } from "../../../shared/tables";
import { defaultViewConfig, type ViewConfig } from "../../../shared/views";
import type { CellDecoration, Group, InsertPosition } from "../../components/grid/types";
import { ViewCache } from "../../lib/show-selectors";
import { useShowStore, useShowStoreInstance } from "../../lib/show-store";
import { attachmentsOf } from "../attachments/selectors";
import { cueNumberHints, hintsEqual } from "../cues/cueNumbers";
import { usePrintMode } from "../print/PrintShell";
import { MenuButton, type MenuEntry } from "../shared/MenuButton";
import { groupOrder, placementFor } from "../shared/ops";
import { contentItem, personItem } from "../shared/pickers";
import { usePref } from "../shared/prefs";
import frame from "../shared/TableFrame.module.css";
import { TableGrid } from "../shared/TableGrid";
import { useWorkspace } from "../show/workspace";
import { type ShotView, shotColumns, shotEditOps } from "./columns";
import styles from "./Shots.module.css";

const NONE: string[] = [];
/** Group ids: `g:<group text>`; `g:` holds shots without a group. */
const GROUP_PREFIX = "g:";
export const groupIdOf = (group: string | null | undefined) =>
  `${GROUP_PREFIX}${group?.trim() ?? ""}`;
export const groupTextOf = (groupId: string | undefined): string | null | undefined =>
  groupId?.startsWith(GROUP_PREFIX) ? groupId.slice(GROUP_PREFIX.length) || null : undefined;

/** Shots grouped by `group`: no group first, then each group in order of its first shot. */
export function shotGroups(views: readonly ShotView[]): Group<ShotView>[] {
  const by = new Map<string, ShotView[]>([[groupIdOf(null), []]]);
  for (const v of views) {
    const id = groupIdOf(v.shot.group);
    const list = by.get(id);
    if (list) list.push(v);
    else by.set(id, [v]);
  }
  return [...by].flatMap(([id, rows]) => {
    const text = groupTextOf(id);
    if (!text && rows.length === 0 && by.size > 1) return [];
    return [{ id, title: text ?? "No group", rows }];
  });
}

/** The "Shot list" view preset: the columns a shoot day prints. */
export const SHOT_LIST_PRESET: { name: string; config: ViewConfig } = {
  name: "Shot list",
  config: {
    ...defaultViewConfig("shots"),
    fields: [
      { key: "number" },
      { key: "description", width: 320 },
      { key: "framing" },
      { key: "lens" },
      { key: "talent" },
      { key: "duration" },
      { key: "status" },
      { key: "group", hidden: true },
      { key: "reference", hidden: true },
      { key: "camera", hidden: true },
      { key: "resolution", hidden: true },
      { key: "frame_rate", hidden: true },
      { key: "content", hidden: true },
    ],
  },
};
const PRESETS = [SHOT_LIST_PRESET];

const byPosition = (a: ShotListRow, b: ShotListRow) =>
  (a.position ?? 0) - (b.position ?? 0) || a.created_at - b.created_at || (a.id < b.id ? -1 : 1);
const isId = (v: unknown): v is string | null => typeof v === "string" || v === null;

export function ShotGrid() {
  const ws = useWorkspace();
  const store = useShowStoreInstance();
  const print = usePrintMode();
  const canEdit = ws.canEdit;
  const lists = useShowStore((s) => s.tables.shot_lists);
  const shots = useShowStore((s) => s.tables.shots);
  const order = useShowStore((s) => s.order.shots);
  const persons = useShowStore((s) => s.tables.persons);
  const content = useShowStore((s) => s.tables.content);
  const scenes = useShowStore((s) => s.tables.scenes);
  const talent = useShowStore((s) => s.joins.shotTalent);
  const contentLinks = useShowStore((s) => s.joins.shotContent);
  const files = useShowStore((s) => s.tables.attachments);
  const fieldOptions = useShowStore((s) => s.fieldOptions);

  const sorted = useMemo(() => [...lists.values()].sort(byPosition), [lists]);
  const [picked, setPicked] = usePref<string | null>(
    `cuesheet.shotList.${ws.userId}.${ws.showId}`,
    null,
    isId,
  );
  const list = (picked && lists.get(picked)) || sorted[0] || null;
  const listId = list?.id ?? null;

  const cache = useRef(new ViewCache<ShotView>()).current;
  const views = useMemo(
    () =>
      cache.pass((get) =>
        order.flatMap((id) => {
          const shot = shots.get(id);
          if (!shot || shot.shot_list_id !== listId) return [];
          const personIds = talent.get(id) ?? NONE;
          const contentIds = contentLinks.get(id) ?? NONE;
          const people = personIds.map((p) => persons.get(p));
          const items = contentIds.map((c) => content.get(c));
          const refs = attachmentsOf(files, "shots", id, "reference");
          return [
            get(id, [shot, personIds, contentIds, refs, ...people, "|", ...items], () => ({
              id,
              shot,
              talent: people.flatMap((p) => (p ? [personItem(p)] : [])),
              content: items.flatMap((c) => (c ? [contentItem(c, scenes)] : [])),
              files: refs,
            })),
          ];
        }),
      ),
    [cache, order, shots, listId, talent, contentLinks, persons, content, scenes, files],
  );
  const groups = useMemo(() => shotGroups(views), [views]);
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const viewsById = useMemo(() => new Map(views.map((v) => [v.id, v])), [views]);
  const viewsRef = useRef(viewsById);
  viewsRef.current = viewsById;

  const columns = useMemo(
    () => shotColumns({ store, fieldOptions, editable: canEdit, showId: ws.showId }),
    [store, fieldOptions, canEdit, ws.showId],
  );

  // Ghost numbers and duplicate warnings over the list's shots in show order (R3's rules).
  const prevHints = useRef<Map<string, CellDecoration>>(new Map());
  const hints = useMemo(() => {
    const next = cueNumberHints(
      groups.flatMap((g) =>
        g.rows.map((v) => ({
          id: v.id,
          number: v.shot.number,
          isSection: false,
          description: v.shot.description,
        })),
      ),
      undefined,
      undefined,
      "shot",
    );
    if (hintsEqual(prevHints.current, next)) return prevHints.current;
    prevHints.current = next;
    return next;
  }, [groups]);
  const cellDecoration = useCallback(
    (v: ShotView, key: string) => (key === "number" ? hints.get(v.id) : undefined),
    [hints],
  );

  const createOps = useCallback(
    (id: string, pos: InsertPosition): Op[] => {
      if (!listId) return [];
      let group = groupTextOf(pos.groupId);
      if (group === undefined) {
        const n = viewsRef.current.get(pos.afterRowId ?? pos.beforeRowId ?? "");
        group = n?.shot.group ?? null;
      }
      return [
        {
          op: "create",
          table: "shots",
          id,
          fields: { shot_list_id: listId, group, status: "Planned" },
          ...placementFor(pos, groupOrder(groupsRef.current)),
        },
      ];
    },
    [listId],
  );
  const moveOps = useCallback((v: ShotView, pos: InsertPosition): Op[] => {
    const ops: Op[] = [
      {
        op: "move",
        table: "shots",
        id: v.id,
        ...placementFor(pos, groupOrder(groupsRef.current), v.id),
      },
    ];
    const group = groupTextOf(pos.groupId);
    if (group !== undefined && group !== (v.shot.group?.trim() || null)) {
      ops.push({ op: "update", table: "shots", id: v.id, fields: { group } });
    }
    return ops;
  }, []);

  const editOps = useCallback(
    (v: ShotView, key: string, value: unknown) => shotEditOps(v, key, value),
    [],
  );

  const mutate = (ops: Op[], what: string) =>
    store.mutate(ops).catch((e: unknown) => ws.reportError(e, what));
  const newList = () => {
    const name = window.prompt("Name of the new shot list", "Shoot day")?.trim();
    if (!name) return;
    const id = newId();
    const position = Math.max(0, ...sorted.map((l) => l.position ?? 0)) + 1;
    void mutate(
      [{ op: "create", table: "shot_lists", id, fields: { name, position } }],
      "add the shot list",
    );
    setPicked(id);
  };
  const renameList = () => {
    if (!list) return;
    const name = window.prompt("Rename the shot list", list.name ?? "")?.trim();
    if (!name || name === list.name) return;
    void mutate(
      [{ op: "update", table: "shot_lists", id: list.id, fields: { name } }],
      "rename the shot list",
    );
  };
  const deleteList = () => {
    if (!list) return;
    const n = views.length;
    const msg = `Delete the shot list "${list.name ?? "Untitled"}"${n ? ` and its ${n} ${n === 1 ? "shot" : "shots"}` : ""}?`;
    if (!window.confirm(msg)) return;
    void mutate([{ op: "delete", table: "shot_lists", id: list.id }], "delete the shot list");
    setPicked(null);
  };

  const menuItems: MenuEntry[] = [
    ...sorted.map((l) => ({
      label: l.name || "Untitled",
      checked: l.id === listId,
      onSelect: () => setPicked(l.id),
    })),
    ...(canEdit
      ? [
          { label: "+ New list…", onSelect: newList },
          ...(list
            ? [
                { label: "Rename…", onSelect: renameList },
                { label: "Delete list…", onSelect: deleteList },
              ]
            : []),
        ]
      : []),
  ];
  const picker = (
    <div className={styles.listBar} data-testid="shot-list-bar">
      <span className="muted">Shot list</span>
      <MenuButton label="Current shot list" items={menuItems}>
        <span data-testid="current-shot-list">
          {list ? list.name || "Untitled" : "No shot lists"}
        </span>{" "}
        ▾
      </MenuButton>
      {canEdit && !list && (
        <button type="button" className={frame.toolButton} onClick={newList}>
          + New list
        </button>
      )}
      {list && <ListDetails key={list.id} list={list} canEdit={canEdit} />}
    </div>
  );

  return (
    <div className={styles.page}>
      {!print && picker}
      <TableGrid<ShotView>
        tab="shots"
        title={print && list?.name ? `Shots: ${list.name}` : "Shots"}
        label="Shot list"
        noun="shot"
        testId="shot-grid"
        columns={columns}
        rowId={(v) => v.id}
        groups={groups}
        nativeGroupKey="group"
        editOps={editOps}
        custom={CUSTOM}
        cellDecoration={cellDecoration}
        viewPresets={PRESETS}
        {...(canEdit && listId
          ? {
              createOps,
              moveOps,
              deleteOps: (vs: ShotView[]) =>
                vs.map((v): Op => ({ op: "delete", table: "shots", id: v.id })),
            }
          : {})}
        panelTitle={(v) => (v.shot.number ? `Shot ${v.shot.number}` : "Shot (no number)")}
        empty={
          <p className={frame.empty} data-testid="shot-empty">
            {list
              ? "No shots in this list yet."
              : canEdit
                ? "No shot lists yet. Make one with + New list."
                : "No shot lists yet."}
          </p>
        }
      />
    </div>
  );
}

const CUSTOM = { fieldTable: "shots", rowOf: (v: ShotView) => v.shot };

/** The list's shoot date, location and notes, edited in place (Enter or leaving saves). */
function ListDetails({ list, canEdit }: { list: ShotListRow; canEdit: boolean }) {
  const ws = useWorkspace();
  const store = useShowStoreInstance();
  const save = (field: "shoot_date" | "location" | "notes", value: string) => {
    const v = value.trim() || null;
    if (v === (list[field] ?? null)) return;
    store
      .mutate([{ op: "update", table: "shot_lists", id: list.id, fields: { [field]: v } }])
      .catch((e: unknown) => ws.reportError(e, "save the shot list"));
  };
  const field = (name: "shoot_date" | "location" | "notes", label: string, type = "text") => (
    <label className={styles.detail}>
      <span className="muted">{label}</span>
      <input
        type={type}
        aria-label={label}
        defaultValue={list[name] ?? ""}
        readOnly={!canEdit}
        onBlur={(e) => save(name, e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
    </label>
  );
  return (
    <div className={styles.details} data-testid="shot-list-details">
      {field("shoot_date", "Shoot date", "date")}
      {field("location", "Location")}
      {field("notes", "Notes")}
    </div>
  );
}
