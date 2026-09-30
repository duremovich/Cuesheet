// Units in views and the grid (R11): the active unit, measurement/pixel-size cells, and
// filters/color rules over measurements and formula columns.
import { describe, expect, it } from "vitest";
import { qty, type Value } from "../../../shared/formula";
import type { Filter } from "../../../shared/views";
import { sortRows } from "../../components/grid/ordering";
import type { Column } from "../../components/grid/types";
import {
  editTextOf,
  formatValue,
  NOT_PARSED,
  parseText,
  valuesEqual,
} from "../../components/grid/values";
import {
  compileFilters,
  type FieldDef,
  fieldKind,
  gridColorRules,
  matchesFilter,
  opsFor,
} from "./evaluate";
import { hasMeasurements, resolveUnit, withUnit, withUnitFields } from "./units";

interface S {
  id: string;
  width: number | null;
  ppi: Value;
  throw_width: Value;
}

const width: FieldDef<S> = {
  key: "width",
  title: "Width",
  type: "measurement",
  getValue: (s) => s.width,
};
const ppi: FieldDef<S> = {
  key: "ppi",
  title: "PPI",
  type: "formula",
  resultType: "number",
  getValue: (s) => s.ppi,
};
const throwWidth: FieldDef<S> = {
  key: "throw_width",
  title: "Image width",
  type: "formula",
  resultType: "measurement",
  getValue: (s) => s.throw_width,
};

const rows: S[] = [
  { id: "a", width: 4.5, ppi: 10.84, throw_width: qty(6) },
  { id: "b", width: 0.5, ppi: 45, throw_width: null },
  { id: "c", width: null, ppi: null, throw_width: { error: "Division by zero", code: "#DIV/0" } },
  { id: "d", width: 16.5, ppi: { error: "x", code: "#UNIT" }, throw_width: qty(2) },
];
const fields = new Map<string, FieldDef<S>>([
  ["width", width],
  ["ppi", ppi],
  ["throw_width", throwWidth],
]);
const ids = (pred: ((s: S) => boolean) | null) =>
  (pred ? rows.filter(pred) : rows).map((r) => r.id);

describe("active unit", () => {
  it("view → user → show → meters", () => {
    expect(resolveUnit("cm", "ft-in", "mm")).toBe("cm");
    expect(resolveUnit(undefined, "ft-in", "mm")).toBe("ft-in");
    expect(resolveUnit(undefined, null, "mm")).toBe("mm");
    expect(resolveUnit(undefined, null, null)).toBe("m");
  });

  it("sets the unit on length columns only, keeping identity when nothing changes", () => {
    const cols = [width, ppi, throwWidth] as Column<S>[];
    const out = withUnit(cols, "ft-in");
    expect(out.map((c) => c.unit)).toEqual(["ft-in", undefined, "ft-in"]);
    expect(withUnit(out, "ft-in")).toBe(out);
    expect(withUnit([ppi], "cm")).toEqual([ppi]);
    expect(hasMeasurements(cols)).toBe(true);
    expect(hasMeasurements([ppi] as Column<unknown>[])).toBe(false);
    const f = withUnitFields(fields, "cm");
    expect(f.get("width")?.unit).toBe("cm");
    expect(withUnitFields(f, "cm")).toBe(f);
  });
});

describe("measurement and pixel size cells", () => {
  const m = (unit: Column<unknown>["unit"]): Column<unknown> => ({
    key: "w",
    title: "W",
    type: "measurement",
    unit,
    getValue: () => null,
  });

  it("parses typed lengths in any unit, bare numbers in the active unit", () => {
    expect(parseText(m("m"), `4'6"`)).toBeCloseTo(1.3716);
    expect(parseText(m("m"), "450cm")).toBeCloseTo(4.5);
    expect(parseText(m("cm"), "450")).toBeCloseTo(4.5);
    expect(parseText(m("ft-in"), "14.75")).toBeCloseTo(4.4958);
    expect(parseText(m("m"), "")).toBeNull();
    expect(parseText(m("m"), "-3")).toBe(NOT_PARSED);
    expect(parseText(m("m"), "wide")).toBe(NOT_PARSED);
  });

  it("formats in the column's unit; editor text round-trips", () => {
    expect(formatValue(m("m"), 1.3716)).toBe("1.37 m");
    expect(formatValue(m("ft-in"), 1.3716)).toBe(`4' 6"`);
    expect(formatValue(m("ft-in"), 4.5)).toBe(`14' 9 1/8"`);
    expect(editTextOf(m("m"), 1.3716)).toBe("1.3716 m");
    const text = editTextOf(m("ft-in"), 4.5);
    expect(valuesEqual(parseText(m("ft-in"), text), 4.5, "measurement")).toBe(true);
    expect(valuesEqual(4.5, 4.500001, "measurement")).toBe(true);
    expect(valuesEqual(4.5, 4.500001)).toBe(false);
  });

  it("pixel sizes", () => {
    const p: Column<unknown> = { key: "p", title: "P", type: "pixelsize", getValue: () => null };
    expect(parseText(p, "1920 x 1080")).toEqual({ w: 1920, h: 1080 });
    expect(parseText(p, "1920")).toBe(NOT_PARSED);
    expect(formatValue(p, { w: 1920, h: 1080 })).toBe("1920×1080");
    expect(valuesEqual({ w: 1, h: 2 }, { w: 1, h: 2 })).toBe(true);
    expect(valuesEqual({ w: 1, h: 2 }, { w: 2, h: 1 })).toBe(false);
  });

  it("formula columns format lengths in the unit and errors as their code", () => {
    const f = { ...throwWidth, unit: "ft-in" as const } as Column<unknown>;
    expect(formatValue(f, qty(6))).toBe(`19' 8 1/4"`);
    expect(formatValue(f, { error: "x", code: "#UNIT" })).toBe("#UNIT");
  });
});

describe("filters over measurements and formulas", () => {
  const run = (filters: Filter[], f = fields) => ids(compileFilters(filters, "and", f, true));

  it("kinds and operators", () => {
    expect(fieldKind(width)).toBe("measurement");
    expect(fieldKind(ppi)).toBe("number");
    expect(fieldKind(throwWidth)).toBe("measurement");
    expect(opsFor(width)).toContain("gt");
    expect(opsFor(width)).not.toContain("contains");
  });

  it("compares in meters, values parsed with units or in the column's unit", () => {
    expect(run([{ key: "width", op: "gt", value: "4 m" }])).toEqual(["a", "d"]);
    expect(run([{ key: "width", op: "gt", value: "4" }])).toEqual(["a", "d"]);
    expect(run([{ key: "width", op: "lt", value: `2'` }])).toEqual(["b"]);
    expect(run([{ key: "width", op: "gte", value: "450cm" }])).toEqual(["a", "d"]);
    expect(run([{ key: "width", op: "is", value: "4.5m" }])).toEqual(["a"]);
    expect(run([{ key: "width", op: "isEmpty" }])).toEqual(["c"]);
    // A bare number in centimeters when the view shows cm.
    expect(run([{ key: "width", op: "gt", value: "400" }], withUnitFields(fields, "cm"))).toEqual([
      "a",
      "d",
    ]);
    expect(run([{ key: "width", op: "gt", value: "nonsense" }])).toEqual([]);
  });

  it("formula results filter as numbers / lengths; errors count as empty", () => {
    expect(run([{ key: "ppi", op: "lt", value: 30 }])).toEqual(["a"]);
    expect(run([{ key: "ppi", op: "isEmpty" }])).toEqual(["c", "d"]);
    expect(run([{ key: "throw_width", op: "gt", value: "5 m" }])).toEqual(["a"]);
    expect(matchesFilter(throwWidth, rows[2] as S, { key: "throw_width", op: "isEmpty" })).toBe(
      true,
    );
  });

  it("color rules on a formula (PPI < 30)", () => {
    const rules = gridColorRules(
      [{ when: [{ key: "ppi", op: "lt", value: 30 }], mode: "and", target: "row", color: "red" }],
      fields,
    );
    expect(rows.filter((r) => rules[0]?.when(r)).map((r) => r.id)).toEqual(["a"]);
  });

  it("sorts formula columns by value, errors and blanks last", () => {
    const sorted = sortRows(rows, [{ key: "ppi", dir: "asc" }], [ppi as Column<S>]);
    expect(sorted.map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
    const desc = sortRows(rows, [{ key: "throw_width", dir: "desc" }], [throwWidth as Column<S>]);
    expect(desc.map((r) => r.id)).toEqual(["a", "d", "b", "c"]);
  });
});
