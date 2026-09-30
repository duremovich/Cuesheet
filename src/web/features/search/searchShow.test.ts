import { describe, expect, it } from "vitest";
import { emptyData } from "../../lib/show-state";
import { searchShow } from "./searchShow";

function data() {
  const d = emptyData();
  const cue = (id: string, number: string, description: string) =>
    d.tables.cues.set(id, { id, number, description, is_section: false } as never);
  cue("c1", "14.20", "Slow fade on the C WALL flat");
  cue("c2", "101", "Opening");
  d.order.cues = ["c1", "c2"];
  d.tables.surfaces.set("s1", { id: "s1", name: "C WALL", channel: "CH03" } as never);
  d.tables.surfaces.set("s2", { id: "s2", name: "L PRO", channel: "CH02" } as never);
  d.order.surfaces = ["s1", "s2"];
  d.tables.persons.set("p1", { id: "p1", name: "Wallace" } as never);
  return d;
}

describe("⌘K group order", () => {
  it("an exact or prefix name match on any table ranks above partial matches in cues", () => {
    expect(searchShow(data(), "C WALL").map((g) => g.tab)).toEqual(["surfaces", "cues", "people"]);
    expect(searchShow(data(), "CH02").map((g) => g.tab)).toEqual(["surfaces"]);
    // "wall": a prefix of a person's name, only a partial match elsewhere.
    expect(searchShow(data(), "wall").map((g) => g.tab)).toEqual(["people", "cues", "surfaces"]);
  });

  it("cue numbers still come first", () => {
    expect(searchShow(data(), "14.2")[0]?.tab).toBe("cues");
  });
});
