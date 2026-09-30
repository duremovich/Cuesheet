import { describe, expect, it } from "vitest";
import type { SceneRow } from "../../shared/tables";
import {
  groupByScene,
  reverseJoin,
  sceneIdForGroup,
  sceneTitle,
  stableMap,
  UNASSIGNED,
  ViewCache,
} from "./show-selectors";

const scene = (id: string, number: string, name: string) =>
  ({ id, number, name, act: null }) as unknown as SceneRow;

describe("groupByScene", () => {
  const scenes = [scene("s1", "101", "Scene One"), scene("s2", "102", "Scene Two")];
  const rows = [
    { id: "a", s: "s2" },
    { id: "b", s: null },
    { id: "c", s: "s1" },
    { id: "d", s: "gone" },
    { id: "e", s: "s2" },
  ];

  it("puts Unassigned (incl. unknown scenes) first, then scenes in order, rows in order", () => {
    const groups = groupByScene(scenes, rows, (r) => r.s);
    expect(groups.map((g) => [g.id, g.rows.map((r) => r.id)])).toEqual([
      [UNASSIGNED, ["b", "d"]],
      ["s1", ["c"]],
      ["s2", ["a", "e"]],
    ]);
  });

  it("keeps empty scenes; Unassigned only when it has rows or is asked for", () => {
    const groups = groupByScene(scenes, [{ id: "a", s: "s1" }], (r) => r.s);
    expect(groups.map((g) => g.id)).toEqual(["s1", "s2"]);
    const kept = groupByScene(scenes, [], (r: { s: string }) => r.s, { keepUnassigned: true });
    expect(kept.map((g) => g.id)).toEqual([UNASSIGNED, "s1", "s2"]);
  });

  it("maps group ids back to scene ids and titles scenes", () => {
    expect(sceneIdForGroup(UNASSIGNED)).toBeNull();
    expect(sceneIdForGroup("s1")).toBe("s1");
    expect(sceneIdForGroup(undefined)).toBeUndefined();
    expect(sceneTitle(scenes[0])).toBe("101 Scene One");
    expect(sceneTitle(null)).toBe("Unassigned");
  });
});

describe("reverseJoin", () => {
  it("inverts from → targets", () => {
    const rev = reverseJoin(
      new Map([
        ["c1", ["x", "y"]],
        ["c2", ["x"]],
      ]),
    );
    expect(Object.fromEntries(rev)).toEqual({ x: ["c1", "c2"], y: ["c1"] });
  });
});

describe("ViewCache", () => {
  it("reuses a view while its deps are identical, rebuilds when one changes, drops gone rows", () => {
    const cache = new ViewCache<{ n: number }>();
    const a = { v: 1 };
    const first = cache.pass((get) => [
      get("a", [a], () => ({ n: 1 })),
      get("b", [], () => ({ n: 2 })),
    ]);
    const again = cache.pass((get) => [
      get("a", [a], () => ({ n: 99 })),
      get("b", [], () => ({ n: 99 })),
    ]);
    expect(again[0]).toBe(first[0]);
    expect(again[1]).toBe(first[1]);
    const changed = cache.pass((get) => [get("a", [{ v: 1 }], () => ({ n: 3 }))]);
    expect(changed[0]).not.toBe(first[0]);
    expect(changed[0]?.n).toBe(3);
    expect(cache.size).toBe(1);
  });

  it("stableMap returns the previous map when entries are the same", () => {
    const prev = new Map([["a", 1]]);
    expect(stableMap(prev, new Map([["a", 1]]))).toBe(prev);
    const next = new Map([["a", 2]]);
    expect(stableMap(prev, next)).toBe(next);
  });
});
