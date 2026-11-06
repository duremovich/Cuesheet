// A note's content is a multi-link (notes.content): the Notes grid column, its filters,
// sort and grouping, and both CSV exports handle several content items per note.
import { describe, expect, it } from "vitest";
import type { NoteRow } from "../../../shared/tables";
import { sortRows } from "../../components/grid/ordering";
import type { Column, PickerItem } from "../../components/grid/types";
import { emptyData, type ShowData } from "../../lib/show-state";
import type { ShowStore } from "../../lib/show-store";
import { exportAllTables } from "../export/exportAll";
import { exportRows } from "../export/exportView";
import { contentItem } from "../shared/pickers";
import { matchesFilter } from "../views/evaluate";
import { groupRows } from "../views/grouping";
import { type NoteView, noteColumns } from "./columns";

const common = { custom: {}, created_by: "u", updated_at: 0, updated_by: "u" };

function note(id: string, body: string): NoteRow {
  return {
    ...common,
    id,
    created_at: Number(id.slice(1)),
    body,
    type: [],
    priority: null,
    status: "Open",
    scene_id: null,
    session: null,
    completed_by: null,
    completed_at: null,
  };
}

function data(): ShowData {
  const d = emptyData();
  for (const [id, name] of [
    ["k1", "101-001-OVERTURE"],
    ["k2", "102-001-STREET"],
    ["k3", "103-001-MOON"],
  ] as const) {
    d.tables.content.set(id, { id, name, scene_id: null } as never);
    d.order.content.push(id);
  }
  for (const n of [note("n1", "both"), note("n2", "street only"), note("n3", "none")]) {
    d.tables.notes.set(n.id, n);
  }
  d.joins.noteContent.set("n1", ["k1", "k2"]);
  d.joins.noteContent.set("n2", ["k2"]);
  return d;
}

function views(d: ShowData): NoteView[] {
  return [...d.tables.notes.values()].map((n) => ({
    id: n.id,
    note: n,
    assignees: [],
    cues: [],
    content: (d.joins.noteContent.get(n.id) ?? []).flatMap((id) => {
      const c = d.tables.content.get(id);
      return c ? [contentItem(c, d.tables.scenes)] : [];
    }),
    scene: null,
    author: "",
    editable: true,
    files: [],
  }));
}

function contentColumn(d: ShowData): Column<NoteView> {
  const store = { getState: () => d } as unknown as ShowStore;
  const col = noteColumns({ store, fieldOptions: {}, canCreateRecords: false }).find(
    (c) => c.key === "content",
  );
  if (!col) throw new Error("no content column");
  return col;
}

describe("notes: several content items", () => {
  it("the Content column is a multi-link searching the show's content", () => {
    const d = data();
    const col = contentColumn(d);
    expect(col.type).toBe("multilink");
    const v = views(d)[0] as NoteView;
    expect(col.getValue(v)).toEqual([
      expect.objectContaining({ id: "k1", label: "101-001-OVERTURE" }),
      expect.objectContaining({ id: "k2", label: "102-001-STREET" }),
    ]);
    const found = (col.search ? col.search("moon", v) : []) as PickerItem[];
    expect(found.map((p) => p.id)).toEqual(["k3"]);
  });

  it("filters match any of a note's content; empty means none", () => {
    const d = data();
    const col = contentColumn(d);
    const ids = (op: Parameters<typeof matchesFilter>[2]) =>
      views(d)
        .filter((v) => matchesFilter(col, v, op))
        .map((v) => v.id);
    expect(ids({ key: "content", op: "is", value: "k2" })).toEqual(["n1", "n2"]);
    expect(ids({ key: "content", op: "is", value: "k1" })).toEqual(["n1"]);
    expect(ids({ key: "content", op: "isNot", value: "k1" })).toEqual(["n2", "n3"]);
    expect(ids({ key: "content", op: "anyOf", value: ["k1", "k3"] })).toEqual(["n1"]);
    expect(ids({ key: "content", op: "noneOf", value: ["k2"] })).toEqual(["n3"]);
    expect(ids({ key: "content", op: "contains", value: "street" })).toEqual(["n1", "n2"]);
    expect(ids({ key: "content", op: "isEmpty" })).toEqual(["n3"]);
  });

  it("groups by the set of content (like cues); sorts by the labels", () => {
    const d = data();
    const col = contentColumn(d);
    const { groups } = groupRows(views(d), col);
    expect(groups.map((g) => [g.title, g.rows.map((r) => r.id)])).toEqual([
      ["Unassigned", ["n3"]],
      ["101-001-OVERTURE, 102-001-STREET", ["n1"]],
      ["102-001-STREET", ["n2"]],
    ]);
    // By the joined labels; empty last either way.
    const desc = sortRows(views(d), [{ key: "content", dir: "desc" }], [col]);
    expect(desc.map((v) => v.id)).toEqual(["n2", "n1", "n3"]);
    const asc = sortRows(views(d), [{ key: "content", dir: "asc" }], [col]);
    expect(asc.map((v) => v.id)).toEqual(["n1", "n2", "n3"]);
  });

  it("CSV: the view export and the all-tables export list every content item", () => {
    const d = data();
    const col = contentColumn(d);
    const [header, ...rows] = exportRows({ columns: [col], rows: views(d) });
    expect(header).toEqual(["Content"]);
    expect(rows).toEqual([["101-001-OVERTURE, 102-001-STREET"], ["102-001-STREET"], [""]]);

    const notes = exportAllTables(d).find((t) => t.table === "notes");
    const [h, ...r] = notes?.rows ?? [];
    expect(h).not.toContain("content_id");
    const at = h?.indexOf("content") ?? -1;
    expect(at).toBeGreaterThan(0);
    expect(r.map((row) => row[at])).toEqual([
      "101-001-OVERTURE, 102-001-STREET",
      "102-001-STREET",
      "",
    ]);
  });
});
