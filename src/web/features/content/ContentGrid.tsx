// The Content tab: content grouped by scene, in show order (insert, drag across scenes).
import { useMemo, useRef } from "react";
import type { Op } from "../../../shared/ops";
import type { Group } from "../../components/grid/types";
import {
  groupByScene,
  reverseJoin,
  sceneIdForGroup,
  sceneTitle,
  UNASSIGNED,
  ViewCache,
} from "../../lib/show-selectors";
import { type ShowState, useShowStore, useShowStoreInstance } from "../../lib/show-store";
import { attachmentsOf, isImage } from "../attachments/selectors";
import { groupOrder, placementFor } from "../shared/ops";
import { cueItem, personItem, sceneItem, surfaceItem } from "../shared/pickers";
import { TableGrid } from "../shared/TableGrid";
import { useWorkspace } from "../show/workspace";
import { type ContentView, contentColumns, contentEditOps } from "./columns";
import { prefixedContentName, scenePrefix } from "./contentName";
import { currentVersions } from "./versions";

const NONE: string[] = [];
/** Gallery cards (R19): the first image attachment, titled by name. */
const GALLERY = {
  presetName: "Content gallery",
  titleKey: "name",
  title: (v: ContentView) => v.content.name || "(unnamed content)",
  image: (v: ContentView) => v.files.find(isImage),
};
const selectState = (s: ShowState) => s;

const CUSTOM = { fieldTable: "content", rowOf: (v: ContentView) => v.content };

export function ContentGrid() {
  const { canEdit, showId } = useWorkspace();
  const store = useShowStoreInstance();
  const state = useShowStore(selectState);
  const { tables, order, joins, fieldOptions } = state;
  const cache = useRef(new ViewCache<ContentView>()).current;

  const cuesByContent = useMemo(() => reverseJoin(joins.cueContent), [joins.cueContent]);
  const notesByContent = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const n of tables.notes.values()) {
      if (n.content_id) m.set(n.content_id, [...(m.get(n.content_id) ?? []), n.id]);
    }
    return m;
  }, [tables.notes]);

  const views = useMemo(() => {
    const versions = currentVersions(tables.content_versions);
    return cache.pass((get) =>
      order.content.flatMap((id) => {
        const content = tables.content.get(id);
        if (!content) return [];
        const scene = content.scene_id ? tables.scenes.get(content.scene_id) : undefined;
        const creator = content.creator_id ? tables.persons.get(content.creator_id) : undefined;
        const cueIds = cuesByContent.get(id) ?? NONE;
        const cues = cueIds.map((c) => tables.cues.get(c));
        const noteCount = notesByContent.get(id)?.length ?? 0;
        const surfaces = (joins.contentSurfaces.get(id) ?? NONE).map((s) => tables.surfaces.get(s));
        const version = versions.get(id) ?? null;
        const files = attachmentsOf(tables.attachments, "content", id);
        return [
          get(
            id,
            [content, scene, creator, noteCount, version, files, ...cues, "|", ...surfaces],
            () => ({
              id,
              content,
              scene: scene ? sceneItem(scene) : null,
              creator: creator ? personItem(creator) : null,
              cues: cues.flatMap((c) => (c ? [cueItem(c)] : [])),
              noteCount,
              surfaces: surfaces.flatMap((s) => (s ? [surfaceItem(s)] : [])),
              version,
              files,
            }),
          ),
        ];
      }),
    );
  }, [cache, order.content, tables, cuesByContent, notesByContent, joins.contentSurfaces]);

  const scenes = useMemo(
    () => order.scenes.flatMap((id) => tables.scenes.get(id) ?? []),
    [order.scenes, tables.scenes],
  );
  const groups = useMemo<Group<ContentView>[]>(
    () =>
      groupByScene(scenes, views, (v) => v.content.scene_id, { keepUnassigned: true }).map((g) => ({
        id: g.id,
        title: g.id === UNASSIGNED ? "Unassigned" : sceneTitle(g.scene),
        ...(g.id === UNASSIGNED ? { subtitle: "Content with no scene" } : {}),
        rows: g.rows,
      })),
    [scenes, views],
  );
  const groupsRef = useRef(groups);
  groupsRef.current = groups;

  const columns = useMemo(
    () => contentColumns({ store, fieldOptions, editable: canEdit, showId }),
    [store, fieldOptions, canEdit, showId],
  );

  return (
    <TableGrid<ContentView>
      tab="content"
      custom={CUSTOM}
      title="Content"
      label="Content list"
      noun="content item"
      testId="content-list"
      columns={columns}
      rowId={(v) => v.id}
      rows={views}
      groups={groups}
      editOps={contentEditOps}
      {...(canEdit
        ? {
            createOps: (id, pos) => {
              let sceneId = sceneIdForGroup(pos.groupId);
              if (sceneId === undefined) {
                const n = store
                  .getState()
                  .tables.content.get(pos.afterRowId ?? pos.beforeRowId ?? "");
                sceneId = n?.scene_id ?? null;
              }
              // Same naming convention as the picker: "105-003-" (type the rest).
              const state = store.getState();
              const scene = sceneId ? state.tables.scenes.get(sceneId) : undefined;
              const prefix = scenePrefix(scene?.number)
                ? prefixedContentName(
                    "",
                    scene?.number,
                    [...state.tables.content.values()].map((c) => c.name),
                  )
                : null;
              return [
                {
                  op: "create",
                  table: "content",
                  id,
                  fields: { scene_id: sceneId, name: prefix },
                  ...placementFor(pos, groupOrder(groupsRef.current)),
                },
              ];
            },
            moveOps: (v, pos) => {
              const ops: Op[] = [
                {
                  op: "move",
                  table: "content",
                  id: v.id,
                  ...placementFor(pos, groupOrder(groupsRef.current), v.id),
                },
              ];
              const sceneId = sceneIdForGroup(pos.groupId);
              if (sceneId !== undefined && sceneId !== (v.content.scene_id ?? null)) {
                ops.push({
                  op: "update",
                  table: "content",
                  id: v.id,
                  fields: { scene_id: sceneId },
                });
              }
              return ops;
            },
            deleteOps: (vs) => vs.map((v) => ({ op: "delete", table: "content", id: v.id })),
          }
        : {})}
      gallery={GALLERY}
      panelTitle={(v) => v.content.name || "Content"}
      panelSections={(v) => [
        {
          title: "Cues",
          empty: "Not used in any cue.",
          items: v.cues.map((c) => ({
            id: c.id,
            content: (
              <>
                <strong>{c.label}</strong>
                {c.secondary ? <div className="muted">{c.secondary}</div> : null}
              </>
            ),
          })),
        },
      ]}
    />
  );
}
