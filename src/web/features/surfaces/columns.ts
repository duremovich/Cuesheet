// Surface list columns (data-model.md §Surface) and edit → ops. Width, height and throw
// distance are measurement columns (meters, shown in the active unit); "Pixels" edits
// pixel_width + pixel_height together; PPI, pitch, aspect and image width are formulas
// (./formulas.ts).
import type { Value } from "../../../shared/formula";
import type { Op } from "../../../shared/ops";
import type { SurfaceRow } from "../../../shared/tables";
import { type PixelSize, parseLensRatio } from "../../../shared/units";
import type { Column, PickerItem } from "../../components/grid/types";
import type { ShowStore } from "../../lib/show-store";
import { linkDiffOps, textField } from "../shared/ops";
import {
  createScene,
  createSurface,
  searchContent,
  searchScenes,
  searchSurfaces,
} from "../shared/pickers";
import { SURFACE_FORMULAS, type SurfaceComputed, type SurfaceFormulaKey } from "./formulas";

export interface SurfaceView {
  id: string;
  surface: SurfaceRow;
  parent: PickerItem | null;
  /** Scenes and content linking this surface (reverse links), in show order. */
  scenes: PickerItem[];
  content: PickerItem[];
  computed: SurfaceComputed;
}

const TEXT = ["name", "channel", "description"] as const;
const LENGTHS = ["width", "height", "throw_distance"] as const;

/** A surface and every region under it (a parent can't be any of these). */
export function descendantsOf(surfaces: ReadonlyMap<string, SurfaceRow>, id: string): Set<string> {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of surfaces.values()) {
      if (s.parent_id && out.has(s.parent_id) && !out.has(s.id)) {
        out.add(s.id);
        grew = true;
      }
    }
  }
  return out;
}

function formulaColumn(key: SurfaceFormulaKey, width: number): Column<SurfaceView> {
  const f = SURFACE_FORMULAS[key];
  return {
    key,
    title: f.title,
    type: "formula",
    resultType: f.resultType,
    width,
    getValue: (v) => v.computed[key] as Value,
  };
}

export function surfaceColumns(opts: {
  store: ShowStore;
  editable: boolean;
}): Column<SurfaceView>[] {
  const { store } = opts;
  const text = (key: (typeof TEXT)[number]) => (v: SurfaceView) => v.surface[key] ?? "";
  const cols: Column<SurfaceView>[] = [
    { key: "name", title: "Name", type: "text", width: 140, frozen: true, getValue: text("name") },
    { key: "channel", title: "Channel", type: "text", width: 100, getValue: text("channel") },
    {
      key: "parent",
      title: "Region of",
      type: "link",
      width: 150,
      getValue: (v) => v.parent,
      search: (q, v) => {
        const data = store.getState();
        return searchSurfaces(data, q, descendantsOf(data.tables.surfaces, v.id));
      },
      create: (name) => createSurface(store, name),
    },
    {
      key: "width",
      title: "Width",
      type: "measurement",
      width: 110,
      getValue: (v) => v.surface.width,
    },
    {
      key: "height",
      title: "Height",
      type: "measurement",
      width: 110,
      getValue: (v) => v.surface.height,
    },
    {
      key: "pixels",
      title: "Pixels",
      type: "pixelsize",
      width: 120,
      getValue: (v): PixelSize | null =>
        v.surface.pixel_width && v.surface.pixel_height
          ? { w: v.surface.pixel_width, h: v.surface.pixel_height }
          : null,
    },
    formulaColumn("ppi", 80),
    formulaColumn("pixel_pitch", 100),
    formulaColumn("aspect_ratio", 90),
    {
      key: "throw_distance",
      title: "Throw",
      type: "measurement",
      width: 110,
      getValue: (v) => v.surface.throw_distance,
    },
    {
      key: "lens_ratio",
      title: "Lens ratio",
      type: "number",
      width: 90,
      getValue: (v) => v.surface.lens_ratio,
      // "1.5" or "1.5:1"; above 0, up to 100.
      parse: (t) => {
        const r = parseLensRatio(t);
        return r !== null && typeof r === "object" ? r : { value: r };
      },
    },
    formulaColumn("throw_width", 120),
    {
      key: "description",
      title: "Description",
      type: "longtext",
      width: 220,
      getValue: text("description"),
    },
    {
      key: "scenes",
      title: "Scenes",
      type: "multilink",
      width: 200,
      getValue: (v) => v.scenes,
      search: (q) => searchScenes(store.getState(), q),
      create: (name) => createScene(store, name),
    },
    {
      key: "content",
      title: "Content",
      type: "multilink",
      width: 200,
      getValue: (v) => v.content,
      search: (q) => searchContent(store.getState(), q, null),
    },
  ];
  return opts.editable ? cols : cols.map((c) => ({ ...c, editable: false }));
}

/** Reverse-link edits: link/unlink from the other side (scenes.surfaces, content.surfaces). */
function reverseLinkOps(
  table: "scenes" | "content",
  surfaceId: string,
  current: readonly PickerItem[],
  next: readonly PickerItem[],
): Op[] {
  const had = new Set(current.map((p) => p.id));
  const want = new Set(next.map((p) => p.id));
  const ops: Op[] = [];
  for (const p of current) {
    if (!want.has(p.id)) {
      ops.push({ op: "unlink", table, id: p.id, field: "surfaces", targetId: surfaceId });
    }
  }
  for (const p of next) {
    if (!had.has(p.id)) {
      ops.push({ op: "link", table, id: p.id, field: "surfaces", targetId: surfaceId });
    }
  }
  return ops;
}

export function surfaceEditOps(view: SurfaceView, key: string, value: unknown): Op[] {
  const id = view.id;
  const update = (fields: Record<string, unknown>): Op[] => [
    { op: "update", table: "surfaces", id, fields },
  ];
  if ((TEXT as readonly string[]).includes(key)) return update({ [key]: textField(value) });
  if ((LENGTHS as readonly string[]).includes(key)) {
    return update({ [key]: typeof value === "number" ? value : null });
  }
  switch (key) {
    case "lens_ratio":
      return update({ lens_ratio: typeof value === "number" ? value : null });
    case "pixels": {
      const p = value as PixelSize | null;
      return update({ pixel_width: p?.w ?? null, pixel_height: p?.h ?? null });
    }
    case "parent":
      return update({ parent_id: (value as PickerItem | null)?.id ?? null });
    case "scenes":
      return reverseLinkOps("scenes", id, view.scenes, value as PickerItem[]);
    case "content":
      return reverseLinkOps("content", id, view.content, value as PickerItem[]);
    default:
      return [];
  }
}

/** Scene/content link cells on those tables: the surfaces a row links (chip order kept). */
export function surfaceLinkColumn<V>(opts: {
  store: ShowStore;
  getValue: (v: V) => PickerItem[];
}): Column<V> {
  return {
    key: "surfaces",
    title: "Surfaces",
    type: "multilink",
    width: 200,
    getValue: opts.getValue,
    search: (q) => searchSurfaces(opts.store.getState(), q),
    create: (name) => createSurface(opts.store, name),
  };
}

/** Edit ops for a `surfaces` link cell on scenes or content. */
export function surfaceLinkOps(
  table: "scenes" | "content",
  id: string,
  current: readonly PickerItem[],
  next: readonly PickerItem[],
): Op[] {
  return linkDiffOps(
    table,
    id,
    "surfaces",
    current.map((p) => p.id),
    next.map((p) => p.id),
  );
}
