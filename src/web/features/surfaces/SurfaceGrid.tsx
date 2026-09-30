// The Surfaces tab (R8, R11, R12): surfaces in show order (insert, drag), lengths in the
// active unit, computed PPI / pitch / aspect / image width, and the calculator in the row
// panel. TODO(M3a): the gallery view and `images` thumbnails arrive with attachments.
import { useMemo, useRef } from "react";
import { reverseJoin, ViewCache } from "../../lib/show-selectors";
import { type ShowState, useShowStore, useShowStoreInstance } from "../../lib/show-store";
import { placementFor } from "../shared/ops";
import { contentItem, sceneItem, surfaceItem } from "../shared/pickers";
import { TableGrid } from "../shared/TableGrid";
import { useWorkspace } from "../show/workspace";
import { resolveUnit, useUserUnit } from "../views/units";
import { SurfaceCalculator } from "./Calculator";
import { type SurfaceView, surfaceColumns, surfaceEditOps } from "./columns";
import { computeSurface } from "./formulas";

const NONE: string[] = [];
const selectState = (s: ShowState) => s;

export function SurfaceGrid() {
  const { canEdit, userId } = useWorkspace();
  const store = useShowStoreInstance();
  const state = useShowStore(selectState);
  const { tables, order, joins } = state;
  const cache = useRef(new ViewCache<SurfaceView>()).current;

  const scenesBySurface = useMemo(() => reverseJoin(joins.sceneSurfaces), [joins.sceneSurfaces]);
  const contentBySurface = useMemo(
    () => reverseJoin(joins.contentSurfaces),
    [joins.contentSurfaces],
  );
  const sceneRank = useMemo(() => new Map(order.scenes.map((id, i) => [id, i])), [order.scenes]);
  const contentRank = useMemo(
    () => new Map(order.content.map((id, i) => [id, i])),
    [order.content],
  );

  const rows = useMemo(
    () =>
      cache.pass((get) =>
        order.surfaces.flatMap((id) => {
          const surface = tables.surfaces.get(id);
          if (!surface) return [];
          const parent = surface.parent_id ? tables.surfaces.get(surface.parent_id) : undefined;
          const sceneIds = [...(scenesBySurface.get(id) ?? NONE)].sort(
            (a, b) => (sceneRank.get(a) ?? 0) - (sceneRank.get(b) ?? 0),
          );
          const contentIds = [...(contentBySurface.get(id) ?? NONE)].sort(
            (a, b) => (contentRank.get(a) ?? 0) - (contentRank.get(b) ?? 0),
          );
          const scenes = sceneIds.map((s) => tables.scenes.get(s));
          const content = contentIds.map((c) => tables.content.get(c));
          return [
            get(id, [surface, parent, ...scenes, "|", ...content], () => ({
              id,
              surface,
              parent: parent ? surfaceItem(parent) : null,
              scenes: scenes.flatMap((s) => (s ? [sceneItem(s)] : [])),
              content: content.flatMap((c) => (c ? [contentItem(c, tables.scenes)] : [])),
              computed: computeSurface(store.getState(), surface),
            })),
          ];
        }),
      ),
    [
      cache,
      order.surfaces,
      tables,
      scenesBySurface,
      contentBySurface,
      sceneRank,
      contentRank,
      store,
    ],
  );

  const columns = useMemo(() => surfaceColumns({ store, editable: canEdit }), [store, canEdit]);
  const userUnit = useUserUnit(userId);
  const panelUnit = resolveUnit(undefined, userUnit, state.meta.default_unit);

  return (
    <TableGrid<SurfaceView>
      tab="surfaces"
      title="Surfaces"
      label="Surface list"
      noun="surface"
      testId="surface-list"
      columns={columns}
      rowId={(v) => v.id}
      rows={rows}
      editOps={surfaceEditOps}
      {...(canEdit
        ? {
            createOps: (id, pos) => [
              { op: "create", table: "surfaces", id, fields: {}, ...placementFor(pos) },
            ],
            moveOps: (v, pos) => [
              { op: "move", table: "surfaces", id: v.id, ...placementFor(pos, undefined, v.id) },
            ],
            deleteOps: (views) => {
              const ids = new Set(views.map((v) => v.id));
              const regions = [...tables.surfaces.values()].filter(
                (s) => s.parent_id && ids.has(s.parent_id) && !ids.has(s.id),
              ).length;
              const what =
                views.length === 1
                  ? `Delete surface ${views[0]?.surface.name || "(unnamed)"}?`
                  : `Delete ${views.length} surfaces?`;
              const effect =
                regions > 0
                  ? ` ${regions} ${regions === 1 ? "region becomes a" : "regions become"} top-level ${regions === 1 ? "surface" : "surfaces"}.`
                  : "";
              if ((views.length === 1 || regions > 0) && !window.confirm(`${what}${effect}`)) {
                return [];
              }
              return views.map((v) => ({ op: "delete", table: "surfaces", id: v.id }));
            },
          }
        : {})}
      panelTitle={(v) => v.surface.name || v.surface.channel || "Surface"}
      panelTabs={(v) => [
        {
          id: "calculator",
          label: "Calculator",
          render: () => <SurfaceCalculator key={v.id} surfaceId={v.id} unit={panelUnit} />,
        },
      ]}
      empty={
        <p className="muted">
          No surfaces yet. Import Surfaces-Gallery.csv from Airtable, or add one.
        </p>
      }
    />
  );
}
