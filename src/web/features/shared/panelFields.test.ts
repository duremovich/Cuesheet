import { describe, expect, it } from "vitest";
import type { CueRow, NoteRow } from "../../../shared/tables";
import type { Column } from "../../components/grid/types";
import { NOT_PARSED } from "../../components/grid/values";
import type { ShowStore } from "../../lib/show-store";
import { cueColumns, cueEditOps } from "../cues/columns";
import type { CueView } from "../cues/cueViews";
import { type NoteView, noteColumns, noteEditOps } from "../notes/columns";
import { isFieldEditable, panelCommit, valueFromText } from "./panelFields";

const store = {} as ShowStore;
const fieldOptions = {
  "notes.status": [
    { value: "Open", color: "blue" },
    { value: "Done", color: "green" },
  ],
  "cues.status": [{ value: "Cued", color: "green" }],
};

const cueView: CueView = {
  id: "c1",
  cue: { id: "c1", number: "14.20", description: "no change", status: null } as CueRow,
  scene: null,
  content: [{ id: "k1", label: "105-001-VAMP" }],
  assignees: [],
};
const col = <V>(cols: Column<V>[], key: string) => cols.find((c) => c.key === key) as Column<V>;

/** What the panel sends for typing/picking `next` into `key` (the grid's edit ops). */
function cueCommit(key: string, next: unknown, editable = true) {
  const cols = cueColumns({ store, fieldOptions, editable });
  const v = panelCommit(col(cols, key), cueView, next);
  return v === undefined ? null : cueEditOps(cueView, key, v);
}

describe("row panel fields → ops", () => {
  it("text: a changed value is an update (empty → null); unchanged sends nothing", () => {
    expect(cueCommit("description", "dim the room")).toEqual([
      { op: "update", table: "cues", id: "c1", fields: { description: "dim the room" } },
    ]);
    expect(cueCommit("description", "no change")).toBeNull();
    expect(cueCommit("number", "")).toEqual([
      { op: "update", table: "cues", id: "c1", fields: { number: null } },
    ]);
  });

  it("select and multilink use the grid's value shapes", () => {
    expect(cueCommit("status", "Cued")).toEqual([
      { op: "update", table: "cues", id: "c1", fields: { status: "Cued" } },
    ]);
    expect(cueCommit("content", [])).toEqual([
      { op: "unlink", table: "cues", id: "c1", field: "content", targetId: "k1" },
    ]);
    expect(
      cueCommit("content", [
        { id: "k1", label: "a" },
        { id: "k2", label: "b" },
      ]),
    ).toEqual([
      { op: "link", table: "cues", id: "c1", field: "content", targetId: "k2", position: 1 },
    ]);
    expect(cueCommit("scene", { id: "s1", label: "105" })).toEqual([
      { op: "update", table: "cues", id: "c1", fields: { scene_id: "s1" } },
    ]);
  });

  it("read-only columns and non-editors send nothing", () => {
    expect(cueCommit("description", "x", false)).toBeNull();
    const notes = noteColumns({ store, fieldOptions, canCreateRecords: false });
    const other: NoteView = {
      id: "n1",
      note: { id: "n1", body: "b", status: "Open" } as NoteRow,
      assignees: [],
      cues: [],
      content: null,
      scene: null,
      author: "Someone",
      editable: false,
      files: [],
    };
    expect(isFieldEditable(col(notes, "status"), other)).toBe(false);
    expect(panelCommit(col(notes, "status"), other, "Done")).toBeUndefined();
    expect(panelCommit(col(notes, "created_at"), { ...other, editable: true }, 5)).toBeUndefined();
    const mine = { ...other, editable: true };
    const v = panelCommit(col(notes, "status"), mine, "Done");
    expect(noteEditOps(mine, "status", v)).toEqual([
      { op: "update", table: "notes", id: "n1", fields: { status: "Done" } },
    ]);
  });

  it("parses typed numbers; junk isn't sent", () => {
    const num: Column<{ n: number | null }> = {
      key: "n",
      title: "N",
      type: "number",
      getValue: (r) => r.n,
    };
    expect(valueFromText(num, "1,250.5")).toBe(1250.5);
    expect(valueFromText(num, "")).toBeNull();
    expect(valueFromText(num, "abc")).toBe(NOT_PARSED);
    expect(panelCommit(num, { n: 2 }, NOT_PARSED)).toBeUndefined();
    expect(panelCommit(num, { n: 2 }, 3)).toBe(3);
  });
});
