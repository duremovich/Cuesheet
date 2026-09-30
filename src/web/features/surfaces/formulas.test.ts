import { describe, expect, it } from "vitest";
import { compile, qty, run } from "../../../shared/formula";
import type { SurfaceRow } from "../../../shared/tables";
import { applyResolved, emptyData, resolveLocal, type ShowData } from "../../lib/show-state";
import { descendantsOf, type SurfaceView, surfaceEditOps } from "./columns";
import { computeSurface, surfaceRecord } from "./formulas";

const row = (id: string, fields: Partial<SurfaceRow> = {}): SurfaceRow => ({
  id,
  custom: {},
  created_at: 0,
  created_by: "u",
  updated_at: 0,
  updated_by: "u",
  order_key: id,
  name: id,
  channel: null,
  parent_id: null,
  width: null,
  height: null,
  pixel_width: null,
  pixel_height: null,
  throw_distance: null,
  lens_ratio: null,
  description: null,
  ...fields,
});

function show(surfaces: SurfaceRow[], sceneLinks: Record<string, string[]> = {}): ShowData {
  const data = emptyData();
  for (const s of surfaces) data.tables.surfaces.set(s.id, s);
  data.order.surfaces = surfaces.map((s) => s.id);
  data.tables.scenes.set("s1", {
    id: "s1",
    custom: {},
    created_at: 0,
    created_by: "u",
    updated_at: 0,
    updated_by: "u",
    order_key: "a",
    number: "101",
    name: "One",
    act: null,
    location: null,
    time_of_day: null,
    song: null,
    stage_direction: null,
    description: null,
    video_overview: null,
  });
  data.order.scenes = ["s1"];
  for (const [scene, targets] of Object.entries(sceneLinks)) {
    data.joins.sceneSurfaces.set(scene, targets);
  }
  return data;
}

describe("surface formulas", () => {
  it("computes PPI, pitch, aspect and image width", () => {
    const s = row("a", {
      width: 4.5,
      height: 2.5,
      pixel_width: 1920,
      pixel_height: 1080,
      throw_distance: 9,
      lens_ratio: 1.5,
    });
    const c = computeSurface(show([s]), s);
    expect(c.ppi).toBeCloseTo(10.8373, 3);
    expect(c.pixel_pitch).toBeCloseTo(2.34375);
    expect(c.aspect_ratio).toBe("16:9");
    expect(c.throw_width).toEqual(qty(6));
  });

  it("blank inputs give blanks; physical aspect when there are no pixels; #DIV/0 shows", () => {
    const s = row("a", { width: 4.5, height: 2.5, throw_distance: 9, lens_ratio: 0 });
    const c = computeSurface(show([s]), s);
    expect(c.ppi).toBeNull();
    expect(c.pixel_pitch).toBeNull();
    expect(c.aspect_ratio).toBe("1.80:1");
    expect(c.throw_width).toMatchObject({ code: "#DIV/0" });
  });

  it("reads the parent, regions and linked scenes", () => {
    const parent = row("p", { name: "L PRO", pixel_width: 3840, width: 9 });
    const child = row("c", { name: "L PRO TOP", parent_id: "p", width: 4.5 });
    const data = show([parent, child], { s1: ["c"] });
    const rec = surfaceRecord(data, child);
    expect(run(compile("LOOKUP(parent.pixel_width) * width / LOOKUP(parent.width)"), rec)).toBe(
      1920,
    );
    expect(run(compile("COUNT(parent.regions)"), rec)).toBe(1);
    expect(run(compile("JOIN(scenes.name)"), rec)).toBe("One");
    expect(run(compile("COUNT(regions)"), surfaceRecord(data, parent))).toBe(1);
    expect(run(compile("pixels"), surfaceRecord(data, parent))).toBeNull();
  });

  it("descendants and edit ops", () => {
    const data = show([
      row("a"),
      row("b", { parent_id: "a" }),
      row("c", { parent_id: "b" }),
      row("d"),
    ]);
    expect([...descendantsOf(data.tables.surfaces, "a")].sort()).toEqual(["a", "b", "c"]);
    const view = {
      id: "a",
      surface: row("a"),
      parent: null,
      scenes: [{ id: "s1", label: "101 One" }],
      content: [],
    } as unknown as SurfaceView;
    expect(surfaceEditOps(view, "pixels", { w: 1920, h: 1080 })).toEqual([
      {
        op: "update",
        table: "surfaces",
        id: "a",
        fields: { pixel_width: 1920, pixel_height: 1080 },
      },
    ]);
    expect(surfaceEditOps(view, "pixels", null)).toEqual([
      {
        op: "update",
        table: "surfaces",
        id: "a",
        fields: { pixel_width: null, pixel_height: null },
      },
    ]);
    expect(surfaceEditOps(view, "width", 1.3716)).toEqual([
      { op: "update", table: "surfaces", id: "a", fields: { width: 1.3716 } },
    ]);
    expect(surfaceEditOps(view, "scenes", [{ id: "s2", label: "102" }])).toEqual([
      { op: "unlink", table: "scenes", id: "s1", field: "surfaces", targetId: "a" },
      { op: "link", table: "scenes", id: "s2", field: "surfaces", targetId: "a" },
    ]);
    expect(surfaceEditOps(view, "ppi", 3)).toEqual([]);
  });
});

describe("the meta op in the client store", () => {
  it("applies optimistically and from resolved ops", () => {
    const data = emptyData();
    expect(data.meta).toEqual({ default_unit: null });
    const ops = resolveLocal(data, [{ op: "meta", fields: { default_unit: "ft-in" } }], {
      userId: "u",
      now: 1,
    });
    expect(ops).toEqual([{ op: "meta", fields: { default_unit: "ft-in" } }]);
    const next = applyResolved(data, ops);
    expect(next.meta.default_unit).toBe("ft-in");
    expect(next.tables.cues).toBe(data.tables.cues);
  });
});
