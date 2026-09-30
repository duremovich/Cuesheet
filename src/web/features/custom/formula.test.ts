// Formula custom fields: names resolve to labels and keys (core and custom), links read
// linked records, formulas read other formulas, cycles are errors, dependencies are listed.
import { describe, expect, it } from "vitest";
import { qty } from "../../../shared/formula";
import type { CustomFieldRow, CustomValues } from "../../../shared/tables";
import type { Column } from "../../components/grid/types";
import type { ShowStore } from "../../lib/show-store";
import { emptyData } from "../../lib/show-state";
import { customColumns, customEditOps } from "./columns";
import { formulaDependencies, readsLinks } from "./formula";

interface Row {
  id: string;
  custom: CustomValues;
  width: number | null;
  name: string;
}

let seq = 0;
const field = (
  key: string,
  type: CustomFieldRow["type"],
  options: CustomFieldRow["options"] = {},
  label = key,
): CustomFieldRow => ({
  id: `f${seq++}`,
  table: "surfaces",
  key,
  label,
  type,
  options,
  position: seq,
  width: null,
  custom: {},
  created_at: 0,
  created_by: "u",
  updated_at: 0,
  updated_by: "u",
});

const base: Column<Row>[] = [
  { key: "name", title: "Name", type: "text", getValue: (r) => r.name },
  { key: "width", title: "Width", type: "measurement", getValue: (r) => r.width },
  { key: "ppi", title: "PPI", type: "formula", getValue: () => 10 },
];

const store = { getState: () => emptyData() } as unknown as ShowStore;
function build(fields: CustomFieldRow[], rows: Row[] = []) {
  return customColumns<Row>(fields, {
    store,
    table: "surfaces",
    rowOf: (r) => r,
    editable: true,
    showId: "s",
    baseColumns: base,
    sampleRows: rows,
    fallbackRecord: (r) => ({ get: (n) => (n === "pixel_width" ? r.width : undefined) }),
  });
}
const row: Row = { id: "r1", custom: { gain: 3, note: "hi" }, width: 4.5, name: "L PRO" };

describe("formula custom fields", () => {
  it("resolve core columns by title or key, custom fields by label or key", () => {
    const cols = build([
      field("gain", "number", {}, "Gain factor"),
      field("note", "text"),
      field("double_ppi", "formula", { formula: "{PPI} * 2" }),
      field("by_key", "formula", { formula: "ppi + gain" }),
      field("by_label", "formula", { formula: "{gain factor} * {Width}" }),
      field("text", "formula", { formula: '{Name} & " " & note' }),
      field("fallback", "formula", { formula: "pixel_width" }),
      field("missing", "formula", { formula: "{Nope} + 1" }),
    ]);
    const get = (key: string) => cols.find((c) => c.key === `custom.${key}`)?.getValue(row);
    expect(get("double_ppi")).toBe(20);
    expect(get("by_key")).toBe(13);
    expect(get("by_label")).toEqual(qty(13.5));
    expect(get("text")).toBe("L PRO hi");
    expect(get("fallback")).toBe(4.5);
    expect(get("missing")).toMatchObject({ code: "#NAME" });
  });

  it("formulas read formulas; cycles are errors, not hangs", () => {
    const cols = build([
      field("a", "formula", { formula: "{b} + 1" }),
      field("b", "formula", { formula: "{PPI} * 3" }),
      field("x", "formula", { formula: "{y} + 1" }),
      field("y", "formula", { formula: "{x} + 1" }),
    ]);
    const get = (key: string) => cols.find((c) => c.key === `custom.${key}`)?.getValue(row);
    expect(get("a")).toBe(31);
    expect(get("x")).toMatchObject({ code: "#ERROR", error: expect.stringMatching(/Circular/) });
  });

  it("result types from the values; dependencies listed", () => {
    const rows = [row];
    const cols = build(
      [
        field("n", "formula", { formula: "{PPI} * 2" }),
        field("l", "formula", { formula: "{Width} / 2" }),
        field("t", "formula", { formula: '"x"' }),
      ],
      rows,
    );
    expect(cols.map((c) => c.resultType)).toEqual(["number", "measurement", "text"]);
    expect(formulaDependencies("{Pixel width} / width + parent.ppi")).toEqual([
      "Pixel width",
      "parent",
      "parent.ppi",
      "width",
    ]);
    expect(readsLinks("parent.ppi * 2")).toBe(true);
    expect(readsLinks("{PPI} * 2")).toBe(false);
    expect(formulaDependencies("(((")).toEqual([]);
  });

  it("edit ops write the stored shape", () => {
    const fields = [field("gain", "number"), field("tags", "multiselect"), field("who", "link")];
    expect(customEditOps("surfaces", "r1", fields, "custom.gain", 2)).toEqual([
      { op: "update", table: "surfaces", id: "r1", fields: { custom: { gain: 2 } } },
    ]);
    expect(customEditOps("surfaces", "r1", fields, "custom.tags", [])).toEqual([
      { op: "update", table: "surfaces", id: "r1", fields: { custom: { tags: null } } },
    ]);
    expect(
      customEditOps("surfaces", "r1", fields, "custom.who", [{ id: "p1", label: "Casey" }]),
    ).toEqual([
      { op: "update", table: "surfaces", id: "r1", fields: { custom: { who: ["p1"] } } },
    ]);
    expect(customEditOps("surfaces", "r1", fields, "name", "x")).toBeNull();
  });
});
