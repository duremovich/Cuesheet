// The Surfaces tab (R8, R11, R12): surfaces in show order (insert, drag), lengths in the
// active unit, computed PPI / pitch / aspect / image width, and the calculator in the row
// panel; `images` (set photos) with thumbnails, and the gallery layout (R13, R19).
import { useMemo, useRef } from "react";
import { reverseJoin, ViewCache } from "../../lib/show-selectors";
import { useShowStore, useShowStoreInstance } from "../../lib/show-store";
import { attachmentsOf, isImage } from "../attachments/selectors";
import { placementFor } from "../shared/ops";
import { contentItem, sceneItem, surfaceItem } from "../shared/pickers";
import { TableGrid } from "../shared/TableGrid";
import { useWorkspace } from "../show/workspace";
import { SurfaceCalculator } from "./Calculator";
import { type SurfaceView, surfaceColumns, surfaceEditOps } from "./columns";
import { computeSurface, surfaceRecord } from "./formulas";

const NONE: string[] = [];
/** Channel hides at phone width unless the view shows it (Fields). */
const NARROW_HIDDEN = ["channel"] as const;
/** Gallery cards (R19): the first image (the set photo), titled by name or channel. */
const GALLERY = {
  presetName: "Surface gallery",
  titleKey: "name",
  title: (v: SurfaceView) => v.surface.name || v.surface.channel || "(unnamed surface)",
  image: (v: SurfaceView) => v.files.find(isImage),
};

export function SurfaceGrid() {
  const { canEdit, showId } = useWorkspace();
  const files = useShowStore((s) => s.tables.attachments);
  const store = useShowStoreInstance();
  const surfaces = useShowStore((s) => s.tables.surfaces);
  const scenesTable = useShowStore((s) => s.tables.scenes);
  const contentTable = useShowStore((s) => s.tables.content);
  const surfaceOrder = useShowStore((s) => s.order.surfaces);
  const sceneOrder = useShowStore((s) => s.order.scenes);
  const contentOrder = useShowStore((s) => s.order.content);
  const sceneSurfaces = useShowStore((s) => s.joins.sceneSurfaces);
  const contentSurfaces = useShowStore((s) => s.joins.contentSurfaces);
  const cache = useRef(new ViewCache<SurfaceView>()).current;

  const scenesBySurface = useMemo(() => reverseJoin(sceneSurfaces), [sceneSurfaces]);
  const contentBySurface = useMemo(() => reverseJoin(contentSurfaces), [contentSurfaces]);
  const sceneRank = useMemo(() => new Map(sceneOrder.map((id, i) => [id, i])), [sceneOrder]);
  const contentRank = useMemo(() => new Map(contentOrder.map((id, i) => [id, i])), [contentOrder]);

  const rows = useMemo(
    () =>
      cache.pass((get) =>
        surfaceOrder.flatMap((id) => {
          const surface = surfaces.get(id);
          if (!surface) return [];
          const parent = surface.parent_id ? surfaces.get(surface.parent_id) : undefined;
          const sceneIds = [...(scenesBySurface.get(id) ?? NONE)].sort(
            (a, b) => (sceneRank.get(a) ?? 0) - (sceneRank.get(b) ?? 0),
          );
          const contentIds = [...(contentBySurface.get(id) ?? NONE)].sort(
            (a, b) => (contentRank.get(a) ?? 0) - (contentRank.get(b) ?? 0),
          );
          const scenes = sceneIds.map((s) => scenesTable.get(s));
          const content = contentIds.map((c) => contentTable.get(c));
          const images = attachmentsOf(files, "surfaces", id, "images");
          return [
            // The built-in formulas read the surface and its parent only.
            get(id, [surface, parent, images, ...scenes, "|", ...content], () => ({
              id,
              surface,
              parent: parent ? surfaceItem(parent) : null,
              scenes: scenes.flatMap((s) => (s ? [sceneItem(s)] : [])),
              content: content.flatMap((c) => (c ? [contentItem(c, scenesTable)] : [])),
              computed: computeSurface(store.getState(), surface),
              files: images,
            })),
          ];
        }),
      ),
    [
      cache,
      surfaceOrder,
      surfaces,
      scenesTable,
      contentTable,
      scenesBySurface,
      contentBySurface,
      sceneRank,
      contentRank,
      store,
      files,
    ],
  );

  const columns = useMemo(
    () => surfaceColumns({ store, editable: canEdit, showId }),
    [store, canEdit, showId],
  );
  // Custom fields (R9); formulas may also read the storage fields (`pixel_width`, `parent`).
  const custom = useMemo(
    () => ({
      fieldTable: "surfaces",
      rowOf: (v: SurfaceView) => v.surface,
      fallbackRecord: (v: SurfaceView) => surfaceRecord(store.getState(), v.surface),
    }),
    [store],
  );

  return (
    <TableGrid<SurfaceView>
      tab="surfaces"
      custom={custom}
      title="Surfaces"
      label="Surface list"
      noun="surface"
      testId="surface-list"
      columns={columns}
      rowId={(v) => v.id}
      rows={rows}
      editOps={surfaceEditOps}
      narrowHidden={NARROW_HIDDEN}
      gallery={GALLERY}
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
              const regions = [...store.getState().tables.surfaces.values()].filter(
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
      panelTabs={(v, { unit, viewUnit }) => [
        {
          id: "calculator",
          label: "Calculator",
          render: () => (
            <SurfaceCalculator key={v.id} surfaceId={v.id} unit={unit} viewUnit={viewUnit} />
          ),
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
