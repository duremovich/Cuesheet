import { describe, expect, it } from "vitest";
import { applyHolds, buildLayout, compareValues, isEmptyValue, sortRows } from "./ordering";
import type { Column } from "./types";

interface R {
  id: string;
  num: string;
  status: string | null;
  group: string;
}

const cols: Column<R>[] = [
  { key: "num", title: "Cue", type: "text", getValue: (r) => r.num },
  {
    key: "status",
    title: "Status",
    type: "select",
    options: [{ value: "todo" }, { value: "doing" }, { value: "done" }],
    getValue: (r) => r.status,
  },
];
const r = (id: string, num: string, status: string | null = null, group = "g1"): R => ({
  id,
  num,
  status,
  group,
});
const ids = (rows: R[]) => rows.map((x) => x.id);

describe("compareValues", () => {
  it("compares decimal strings numerically (cue numbers)", () => {
    const nums = ["14.3", "14.25", "2", "14.2", "10"];
    expect([...nums].sort(compareValues)).toEqual(["2", "10", "14.2", "14.25", "14.3"]);
  });
  it("uses natural, case-insensitive order for other strings", () => {
    expect(["b10", "B2", "a"].sort(compareValues)).toEqual(["a", "B2", "b10"]);
  });
});

describe("isEmptyValue", () => {
  it("treats null, blank strings and empty arrays as empty", () => {
    expect([null, undefined, "", "  ", [], Number.NaN].every(isEmptyValue)).toBe(true);
    expect([0, false, "x", ["a"]].some(isEmptyValue)).toBe(false);
  });
});

describe("sortRows", () => {
  const rows = [r("a", "3"), r("b", ""), r("c", "1.5"), r("d", "12"), r("e", "")];
  it("sorts ascending with empty values last", () => {
    expect(ids(sortRows(rows, [{ key: "num", dir: "asc" }], cols))).toEqual([
      "c",
      "a",
      "d",
      "b",
      "e",
    ]);
  });
  it("keeps empty values last when descending, and is stable", () => {
    expect(ids(sortRows(rows, [{ key: "num", dir: "desc" }], cols))).toEqual([
      "d",
      "a",
      "c",
      "b",
      "e",
    ]);
  });
  it("sorts selects by option order, then by the next key", () => {
    const list = [r("a", "2", "done"), r("b", "1", "todo"), r("c", "1", "done"), r("d", "5", null)];
    const sorted = sortRows(
      list,
      [
        { key: "status", dir: "asc" },
        { key: "num", dir: "asc" },
      ],
      cols,
    );
    expect(ids(sorted)).toEqual(["b", "c", "a", "d"]);
  });
  it("ignores unknown sort keys", () => {
    expect(ids(sortRows(rows, [{ key: "nope", dir: "asc" }], cols))).toEqual(ids(rows));
  });
});

describe("applyHolds", () => {
  it("pins a held row at its slot in a sorted list, clamped", () => {
    const lists = [{ groupId: undefined, ids: ["a", "b", "c", "x"] }];
    expect(applyHolds(lists, [{ id: "x", index: 1 }], true)[0]?.ids).toEqual(["a", "x", "b", "c"]);
    expect(applyHolds(lists, [{ id: "x", index: 0 }], true)[0]?.ids).toEqual(["x", "a", "b", "c"]);
    expect(applyHolds(lists, [{ id: "a", index: 99 }], true)[0]?.ids).toEqual(["b", "c", "x", "a"]);
    expect(applyHolds(lists, [{ id: "a", index: Number.POSITIVE_INFINITY }], true)[0]?.ids).toEqual(
      ["b", "c", "x", "a"],
    );
  });
  it("does not reposition in show order, but keeps a row in its group", () => {
    const lists = [
      { groupId: "g1", ids: ["a", "b"] },
      { groupId: "g2", ids: ["x", "c"] },
    ];
    // Show order: a same-group hold is a no-op.
    expect(applyHolds(lists, [{ id: "c", groupId: "g2", index: 0 }], false)).toEqual(lists);
    // x's scene was edited to g2 while it was focused in g1: it stays in g1 until blur.
    const held = applyHolds(lists, [{ id: "x", groupId: "g1", index: 1 }], false);
    expect(held.map((l) => l.ids)).toEqual([["a", "x", "b"], ["c"]]);
  });
});

describe("buildLayout", () => {
  const rows = [
    r("a", "2"),
    r("b", "1", null, "g2"),
    r("s", "", null, "g2"),
    r("c", "3", null, "g2"),
  ];
  const groups = [
    { id: "g1", title: "One", rows: rows.filter((x) => x.group === "g1") },
    { id: "g2", title: "Two", rows: rows.filter((x) => x.group === "g2") },
  ];
  const isSection = (x: R) => x.id === "s";

  it("flattens groups with counts that exclude sections, numbering rows across groups", () => {
    const items = buildLayout({ groups, columns: cols, rowId: (x) => x.id, isSection });
    expect(
      items.map((i) => (i.kind === "group" ? `G:${i.group.id}:${i.count}` : `${i.id}#${i.number}`)),
    ).toEqual(["G:g1:1", "a#1", "G:g2:2", "b#2", "s#2", "c#3"]);
  });

  it("hides rows of collapsed groups but keeps the header", () => {
    const items = buildLayout({
      groups,
      columns: cols,
      rowId: (x) => x.id,
      collapsed: new Set(["g2"]),
    });
    expect(items.map((i) => (i.kind === "group" ? `G:${i.group.id}` : i.id))).toEqual([
      "G:g1",
      "a",
      "G:g2",
    ]);
  });

  it("sorts within groups and applies holds", () => {
    const items = buildLayout({
      groups,
      columns: cols,
      rowId: (x) => x.id,
      sort: [{ key: "num", dir: "desc" }],
      holds: [{ id: "b", groupId: "g2", index: 0 }],
    });
    // Sorted desc: c, b, s(empty last). b is held in the first slot.
    expect(
      items.filter((i) => i.kind === "row").map((i) => (i.kind === "row" ? i.id : "")),
    ).toEqual(["a", "b", "c", "s"]);
  });

  it("keeps a held row in its slot when its neighbor re-sorts away", () => {
    const list = [r("a", "1"), r("b", "2"), r("c", "3"), r("d", "4")];
    const layout = (rows: R[]) =>
      buildLayout({
        rows,
        columns: cols,
        rowId: (x) => x.id,
        sort: [{ key: "num", dir: "asc" }],
        holds: [{ id: "c", index: 2 }],
      }).map((i) => (i.kind === "row" ? i.id : ""));
    expect(layout(list)).toEqual(["a", "b", "c", "d"]);
    // b is edited to 9 and sorts to the end; c (held) stays in slot 2.
    const edited = list.map((x) => (x.id === "b" ? { ...x, num: "9" } : x));
    expect(layout(edited)).toEqual(["a", "d", "c", "b"]);
  });
});
