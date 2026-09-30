import { describe, expect, it } from "vitest";
import type { Op } from "../../../shared/ops";
import { UNASSIGNED, ViewCache } from "../../lib/show-selectors";
import { applyResolved, emptyData, resolveLocal, type ShowData } from "../../lib/show-state";
import { searchShow } from "../search/searchShow";
import { buildCueViews, type CueView, cueGroups, openNotesByScene } from "./cueViews";

// Ids must look like UUIDv7 only for the server; the local resolver doesn't care.
function build(ops: Op[], data: ShowData = emptyData()): ShowData {
  return applyResolved(data, resolveLocal(data, ops, { userId: "u1", now: 1 }));
}

const base = () =>
  build([
    { op: "create", table: "scenes", id: "s1", fields: { number: "101", name: "Scene One" } },
    {
      op: "create",
      table: "scenes",
      id: "s2",
      fields: { number: "102", name: "Scene Two", act: "Act 1" },
    },
    { op: "create", table: "content", id: "k1", fields: { name: "101-001-OPEN", scene_id: "s1" } },
    { op: "create", table: "persons", id: "p1", fields: { name: "Casey" } },
    { op: "create", table: "cues", id: "c1", fields: { number: "1", scene_id: "s1" } },
    { op: "create", table: "cues", id: "c2", fields: { number: "2", scene_id: "s2" } },
    {
      op: "create",
      table: "cues",
      id: "c3",
      fields: { number: "14.20", description: "Sweet Sue" },
    },
    { op: "link", table: "cues", id: "c1", field: "content", targetId: "k1" },
    { op: "link", table: "cues", id: "c1", field: "assignees", targetId: "p1" },
    { op: "create", table: "notes", id: "n1", fields: { body: "fix the fade", status: "Open" } },
    { op: "link", table: "notes", id: "n1", field: "cues", targetId: "c2" },
    {
      op: "create",
      table: "notes",
      id: "n2",
      fields: { body: "done", status: "Done", scene_id: "s2" },
    },
  ]);

describe("buildCueViews + cueGroups", () => {
  it("resolves links to labels and groups by scene with Unassigned first", () => {
    const data = base();
    const views = buildCueViews(data, new ViewCache<CueView>());
    const c1 = views.find((v) => v.id === "c1");
    expect(c1?.content).toEqual([
      { id: "k1", label: "101-001-OPEN", secondary: "101 Scene One", aliases: ["OPEN"] },
    ]);
    expect(c1?.assignees).toEqual([{ id: "p1", label: "Casey" }]);
    expect(c1?.scene?.label).toBe("101 Scene One");

    const scenes = data.order.scenes.map((id) => data.tables.scenes.get(id) as never);
    const groups = cueGroups(scenes, views, openNotesByScene(data));
    expect(groups.map((g) => [g.id, g.title, g.rows.map((r) => r.id)])).toEqual([
      [UNASSIGNED, "Unassigned", ["c3"]],
      ["s1", "101 Scene One", ["c1"]],
      ["s2", "102 Scene Two", ["c2"]],
    ]);
    // Any act → acts lead the subtitle; open notes (via the note's cue) are counted.
    expect(groups[2]?.subtitle).toBe("Act 1 · 1 open note");
  });

  it("keeps view identity for untouched cues and rebuilds the ones whose links changed", () => {
    const cache = new ViewCache<CueView>();
    const data = base();
    const before = buildCueViews(data, cache);
    const renamed = build(
      [{ op: "update", table: "content", id: "k1", fields: { name: "101-001-NEW" } }],
      data,
    );
    const after = buildCueViews(renamed, cache);
    const byId = (vs: CueView[], id: string) => vs.find((v) => v.id === id);
    expect(byId(after, "c2")).toBe(byId(before, "c2"));
    expect(byId(after, "c3")).toBe(byId(before, "c3"));
    expect(byId(after, "c1")).not.toBe(byId(before, "c1"));
    expect(byId(after, "c1")?.content[0]?.label).toBe("101-001-NEW");
  });
});

describe("searchShow", () => {
  it("finds a cue by number (14.2 = 14.20) and records by name/body", () => {
    const data = base();
    const byNumber = searchShow(data, "14.2");
    expect(byNumber[0]?.label).toBe("Cues");
    expect(byNumber[0]?.hits[0]).toMatchObject({ tab: "cues", id: "c3", title: "Cue 14.20" });

    const text = searchShow(data, "sweet");
    expect(text.find((g) => g.tab === "cues")?.hits[0]?.id).toBe("c3");
    expect(searchShow(data, "open").find((g) => g.tab === "content")?.hits[0]?.id).toBe("k1");
    expect(searchShow(data, "scene two").find((g) => g.tab === "scenes")?.hits[0]?.id).toBe("s2");
    expect(searchShow(data, "fade").find((g) => g.tab === "notes")?.hits[0]?.id).toBe("n1");
    expect(searchShow(data, "casey").find((g) => g.tab === "people")?.hits[0]?.id).toBe("p1");
    expect(searchShow(data, "  ")).toEqual([]);
  });
});
