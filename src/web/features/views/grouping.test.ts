import { describe, expect, it } from "vitest";
import type { PickerItem } from "../../components/grid/types";
import type { FieldDef } from "./evaluate";
import { filterGroups, groupRows, isGroupable } from "./grouping";

interface N {
  id: string;
  status: string | null;
  assignees: PickerItem[];
  scene: PickerItem | null;
  type: string[];
}

const status: FieldDef<N> = {
  key: "status",
  title: "Status",
  type: "select",
  options: [{ value: "Open" }, { value: "In progress" }, { value: "Done" }],
  getValue: (n) => n.status,
};
const assignees: FieldDef<N> = {
  key: "assignees",
  title: "Assignees",
  type: "multilink",
  getValue: (n) => n.assignees,
};
const scene: FieldDef<N> = { key: "scene", title: "Scene", type: "link", getValue: (n) => n.scene };
const type: FieldDef<N> = {
  key: "type",
  title: "Type",
  type: "multiselect",
  options: [{ value: "Content" }, { value: "Director" }],
  getValue: (n) => n.type,
};

const alice = { id: "p-a", label: "Alice" };
const bob = { id: "p-b", label: "Bob" };
const rows: N[] = [
  { id: "1", status: "Open", assignees: [bob], scene: { id: "s2", label: "102" }, type: [] },
  { id: "2", status: "Done", assignees: [], scene: null, type: ["Director", "Content"] },
  { id: "3", status: null, assignees: [alice, bob], scene: { id: "s1", label: "101" }, type: [] },
  { id: "4", status: "Open", assignees: [bob, alice], scene: null, type: ["Content"] },
  { id: "5", status: "Open", assignees: [alice], scene: { id: "s1", label: "101" }, type: [] },
];
const ids = (g: { rows: N[] }) => g.rows.map((r) => r.id);

describe("groupRows", () => {
  it("select: empty group first, then every option in order (empty options too)", () => {
    const { groups, values } = groupRows(rows, status);
    expect(groups.map((g) => g.title)).toEqual(["No status", "Open", "In progress", "Done"]);
    expect(groups.map(ids)).toEqual([["3"], ["1", "4", "5"], [], ["2"]]);
    expect(values.get(groups[1]?.id ?? "")).toBe("Open");
    expect(values.get(groups[0]?.id ?? "")).toBeNull();
    expect(groups.every((g) => g.id.startsWith("grp:status:"))).toBe(true);
  });

  it("multilink: Unassigned first, one group per combination (order-insensitive), by label", () => {
    const { groups, values } = groupRows(rows, assignees);
    expect(groups.map((g) => g.title)).toEqual(["Unassigned", "Alice", "Alice, Bob", "Bob"]);
    expect(groups.map(ids)).toEqual([["2"], ["5"], ["3", "4"], ["1"]]);
    expect(values.get(groups[2]?.id ?? "")).toEqual([alice, bob]);
    expect(values.get(groups[0]?.id ?? "")).toEqual([]);
  });

  it("link: records present, by label; the empty group kept on request", () => {
    const { groups } = groupRows(rows, scene);
    expect(groups.map((g) => g.title)).toEqual(["Unassigned", "101", "102"]);
    const none = groupRows(
      rows.filter((r) => r.scene),
      scene,
      { keepEmpty: true },
    );
    expect(none.groups[0]).toMatchObject({ title: "Unassigned", rows: [] });
  });

  it("multiselect: combinations in option order", () => {
    const { groups } = groupRows(rows, type);
    expect(groups.map((g) => g.title)).toEqual(["No type", "Content", "Content, Director"]);
  });

  it("isGroupable", () => {
    expect([status, assignees, scene, type].every(isGroupable)).toBe(true);
    expect(isGroupable({ type: "text" })).toBe(false);
  });
});

describe("filterGroups", () => {
  it("keeps group identity when nothing is filtered out, and empty groups", () => {
    const { groups } = groupRows(rows, status);
    expect(filterGroups(groups, () => true)).toBe(groups);
    const open = filterGroups(groups, (r) => r.id !== "4");
    expect(open.map(ids)).toEqual([["3"], ["1", "5"], [], ["2"]]);
    expect(open[0]).toBe(groups[0]);
  });
});
