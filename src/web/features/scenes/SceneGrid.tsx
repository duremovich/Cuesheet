// The Scenes tab: scenes in show order; insert and drag to reorder.
import { useMemo, useRef } from "react";
import { sceneTitle, ViewCache } from "../../lib/show-selectors";
import { useShowStore, useShowStoreInstance } from "../../lib/show-store";
import { placementFor } from "../shared/ops";
import { surfaceItem } from "../shared/pickers";
import { TableGrid } from "../shared/TableGrid";
import { useWorkspace } from "../show/workspace";
import { type SceneView, sceneColumns, sceneEditOps } from "./columns";

export function SceneGrid() {
  const { canEdit } = useWorkspace();
  const scenes = useShowStore((s) => s.tables.scenes);
  const order = useShowStore((s) => s.order.scenes);
  const cues = useShowStore((s) => s.tables.cues);
  const content = useShowStore((s) => s.tables.content);
  const fieldOptions = useShowStore((s) => s.fieldOptions);
  const surfaces = useShowStore((s) => s.tables.surfaces);
  const sceneSurfaces = useShowStore((s) => s.joins.sceneSurfaces);
  const store = useShowStoreInstance();
  const cache = useRef(new ViewCache<SceneView>()).current;

  const rows = useMemo(() => {
    const cueCount = new Map<string, number>();
    for (const c of cues.values()) {
      if (c.scene_id && !c.is_section)
        cueCount.set(c.scene_id, (cueCount.get(c.scene_id) ?? 0) + 1);
    }
    const contentCount = new Map<string, number>();
    for (const c of content.values()) {
      if (c.scene_id) contentCount.set(c.scene_id, (contentCount.get(c.scene_id) ?? 0) + 1);
    }
    return cache.pass((get) =>
      order.flatMap((id) => {
        const scene = scenes.get(id);
        if (!scene) return [];
        const n = cueCount.get(id) ?? 0;
        const m = contentCount.get(id) ?? 0;
        const linked = (sceneSurfaces.get(id) ?? []).map((s) => surfaces.get(s));
        return [
          get(id, [scene, n, m, ...linked], () => ({
            id,
            scene,
            cueCount: n,
            contentCount: m,
            surfaces: linked.flatMap((s) => (s ? [surfaceItem(s)] : [])),
          })),
        ];
      }),
    );
  }, [scenes, order, cues, content, cache, surfaces, sceneSurfaces]);

  const columns = useMemo(
    () => sceneColumns(fieldOptions, canEdit, store),
    [fieldOptions, canEdit, store],
  );

  return (
    <TableGrid<SceneView>
      tab="scenes"
      title="Scenes"
      label="Scene list"
      noun="scene"
      testId="scene-list"
      columns={columns}
      rowId={(v) => v.id}
      rows={rows}
      editOps={sceneEditOps}
      {...(canEdit
        ? {
            createOps: (id, pos) => [
              { op: "create", table: "scenes", id, fields: {}, ...placementFor(pos) },
            ],
            moveOps: (v, pos) => [
              { op: "move", table: "scenes", id: v.id, ...placementFor(pos, undefined, v.id) },
            ],
            deleteOps: (views) => {
              // Always ask for one scene (the grid asks for several); say what happens to
              // its cues.
              const cues = views.reduce((n, v) => n + v.cueCount, 0);
              const what =
                views.length === 1
                  ? `Delete scene ${sceneTitle(views[0]?.scene)}?`
                  : `Delete ${views.length} scenes?`;
              const effect =
                cues > 0
                  ? ` ${views.length === 1 ? "Its" : "Their"} ${cues} ${cues === 1 ? "cue moves" : "cues move"} to Unassigned.`
                  : "";
              if ((views.length === 1 || cues > 0) && !window.confirm(`${what}${effect}`)) {
                return [];
              }
              return views.map((v) => ({ op: "delete", table: "scenes", id: v.id }));
            },
          }
        : {})}
      panelTitle={(v) => sceneTitle(v.scene)}
      empty={<p className="muted">No scenes yet.</p>}
    />
  );
}
