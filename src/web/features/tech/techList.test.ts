import { describe, expect, it } from "vitest";
import type { CueRow, SceneRow } from "../../../shared/tables";
import { goToCue, navOrder, stepCue, techRows } from "./techList";

const scene = (id: string, number: string, name: string) => ({ id, number, name }) as SceneRow;
const cue = (id: string, number: string | null, scene_id: string | null, is_section = false) =>
  ({ id, number, scene_id, is_section, description: is_section ? "ACT 2" : "d" }) as CueRow;

const SCENES = [scene("s1", "101", "Speakeasy"), scene("s2", "102", "Empty")];
const CUES = [
  cue("a", "1", "s1"),
  cue("sec", null, "s1", true),
  cue("b", "2.5", "s1"),
  cue("u", "0.5", null),
  cue("c", "14.20", "s1"),
];

describe("tech list", () => {
  it("groups by scene (Unassigned first, empty scenes left out), sections as dividers", () => {
    const rows = techRows(SCENES, CUES, new Map([["s1", 3]]));
    expect(rows.map((r) => (r.kind === "cue" ? r.cue.id : r.key))).toEqual([
      "scene:__unassigned__",
      "u",
      "scene:s1",
      "a",
      "sec",
      "b",
      "c",
    ]);
    expect(rows[2]).toMatchObject({ title: "101 Speakeasy", openNotes: 3 });
    expect(navOrder(rows)).toEqual(["u", "a", "b", "c"]);
  });

  it("steps and clamps", () => {
    const order = ["u", "a", "b", "c"];
    expect(stepCue(order, "a", 1)).toBe("b");
    expect(stepCue(order, "a", 2)).toBe("c");
    expect(stepCue(order, "c", 1)).toBe("c");
    expect(stepCue(order, "u", -1)).toBe("u");
    expect(stepCue(order, null, 1)).toBe("u");
    expect(stepCue(order, "gone", 1)).toBe("u");
    expect(stepCue([], null, 1)).toBeNull();
  });

  it("goes to a typed cue number: exact (14.2 = 14.20), else by prefix", () => {
    expect(goToCue(CUES, "14.2", null)?.id).toBe("c");
    expect(goToCue(CUES, "2.", null)?.id).toBe("b");
    expect(goToCue(CUES, "14", null)?.id).toBe("c");
    expect(goToCue(CUES, "99", null)).toBeUndefined();
    expect(goToCue(CUES, " ", null)).toBeUndefined();
  });
});
