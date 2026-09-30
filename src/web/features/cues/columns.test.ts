import { describe, expect, it } from "vitest";
import type { CueRow } from "../../../shared/tables";
import { cueEditOps } from "./columns";
import type { CueView } from "./cueViews";

const view: CueView = {
  id: "c1",
  cue: { id: "c1", scene_id: "s1" } as CueRow,
  scene: { id: "s1", label: "101 Scene One" },
  content: [{ id: "k1", label: "101-001-A" }],
  assignees: [],
};

describe("cueEditOps", () => {
  it("text fields: cleared → null", () => {
    expect(cueEditOps(view, "number", "14.22")).toEqual([
      { op: "update", table: "cues", id: "c1", fields: { number: "14.22" } },
    ]);
    expect(cueEditOps(view, "sm_call", "")).toEqual([
      { op: "update", table: "cues", id: "c1", fields: { sm_call: null } },
    ]);
  });

  it("selects, the scene link and link lists", () => {
    expect(cueEditOps(view, "status", "Cued")).toEqual([
      { op: "update", table: "cues", id: "c1", fields: { status: "Cued" } },
    ]);
    expect(cueEditOps(view, "scene", null)).toEqual([
      { op: "update", table: "cues", id: "c1", fields: { scene_id: null } },
    ]);
    expect(
      cueEditOps(view, "content", [
        { id: "k1", label: "101-001-A" },
        { id: "k2", label: "101-002-B" },
      ]),
    ).toEqual([
      { op: "link", table: "cues", id: "c1", field: "content", targetId: "k2", position: 1 },
    ]);
    expect(cueEditOps(view, "assignees", [{ id: "p1", label: "Casey" }])).toEqual([
      { op: "link", table: "cues", id: "c1", field: "assignees", targetId: "p1", position: 0 },
    ]);
    expect(cueEditOps(view, "nope", "x")).toEqual([]);
  });
});
