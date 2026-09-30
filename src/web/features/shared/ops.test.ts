import { describe, expect, it } from "vitest";
import type { Op } from "../../../shared/ops";
import { linkDiffOps, placementFor, textField } from "./ops";

/** Applies link/unlink ops to a list like the store does. */
function replay(start: string[], ops: Op[]): string[] {
  const list = [...start];
  for (const op of ops) {
    if (op.op === "unlink") list.splice(list.indexOf(op.targetId), 1);
    else if (op.op === "link")
      list.splice(Math.min(op.position ?? list.length, list.length), 0, op.targetId);
  }
  return list;
}

describe("linkDiffOps", () => {
  const cases: [string[], string[]][] = [
    [[], ["a"]],
    [["a"], []],
    [
      ["a", "b"],
      ["a", "b", "c"],
    ],
    [
      ["a", "b", "c"],
      ["a", "c"],
    ],
    [
      ["a", "b", "c"],
      ["c", "a", "b"],
    ],
    [
      ["a", "b"],
      ["x", "b", "y"],
    ],
    [
      ["a", "b", "c", "d"],
      ["d", "c", "b", "a"],
    ],
  ];
  it.each(cases)("%j → %j", (from, to) => {
    const ops = linkDiffOps("cues", "c1", "content", from, to);
    expect(replay(from, ops)).toEqual(to);
    for (const o of ops) expect(o).toMatchObject({ table: "cues", id: "c1", field: "content" });
  });

  it("does nothing when nothing changed", () => {
    expect(linkDiffOps("cues", "c1", "content", ["a", "b"], ["a", "b"])).toEqual([]);
  });

  it("only touches what changed", () => {
    expect(linkDiffOps("cues", "c1", "content", ["a", "b"], ["a", "b", "c"])).toEqual([
      { op: "link", table: "cues", id: "c1", field: "content", targetId: "c", position: 2 },
    ]);
  });
});

describe("placementFor", () => {
  const groups = [
    { id: "unassigned", rowIds: ["u1"] },
    { id: "s1", rowIds: ["a", "b"] },
    { id: "s2", rowIds: [] },
    { id: "s3", rowIds: ["c"] },
  ];

  it("uses the display neighbour", () => {
    expect(placementFor({ afterRowId: "a", groupId: "s1" }, groups)).toEqual({ after: "a" });
    expect(placementFor({ beforeRowId: "c", groupId: "s3" }, groups)).toEqual({ before: "c" });
  });

  it("group only: after the group's last row, else the nearest earlier group's, else before a later one", () => {
    expect(placementFor({ groupId: "s1" }, groups)).toEqual({ after: "b" });
    expect(placementFor({ groupId: "s2" }, groups)).toEqual({ after: "b" });
    expect(placementFor({ groupId: "s2" }, [groups[2] as never, groups[3] as never])).toEqual({
      before: "c",
    });
    expect(placementFor({ groupId: "s2" }, [groups[2] as never])).toEqual({});
    expect(placementFor({}, groups)).toEqual({});
  });

  it("a moved row isn't its own neighbour", () => {
    expect(placementFor({ groupId: "s1" }, groups, "b")).toEqual({ after: "a" });
    expect(placementFor({ afterRowId: "a" }, groups, "a")).toEqual({});
  });

  it("textField stores cleared text as null", () => {
    expect(textField("")).toBeNull();
    expect(textField("  ")).toBeNull();
    expect(textField("x")).toBe("x");
    expect(textField(null)).toBeNull();
  });
});
