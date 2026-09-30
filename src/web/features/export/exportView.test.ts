import { describe, expect, it } from "vitest";
import { qty } from "../../../shared/formula";
import type { Column, PickerItem } from "../../components/grid/types";
import { exportRows } from "./exportView";

interface Row {
  id: string;
  number: string;
  width: number | null;
  who: PickerItem[];
  date: string;
  ppi: unknown;
  secret: string;
  done: boolean;
  section?: boolean;
}

const columns: Column<Row>[] = [
  { key: "number", title: "Cue", type: "text", getValue: (r) => r.number },
  { key: "width", title: "Width", type: "measurement", unit: "cm", getValue: (r) => r.width },
  { key: "who", title: "Who", type: "multilink", getValue: (r) => r.who },
  { key: "date", title: "Date", type: "text", getValue: (r) => r.date },
  { key: "ppi", title: "PPI", type: "formula", getValue: (r) => r.ppi },
  { key: "secret", title: "Password", type: "text", masked: true, getValue: (r) => r.secret },
  { key: "done", title: "Done", type: "checkbox", getValue: (r) => r.done },
];

const rows: Row[] = [
  {
    id: "a",
    number: "2",
    width: 4.5,
    who: [
      { id: "p1", label: "Casey" },
      { id: "p2", label: "Riley, Jr." },
    ],
    date: "2026-09-30",
    ppi: 10.8373,
    secret: "hunter2",
    done: true,
  },
  {
    id: "b",
    number: "1",
    width: null,
    who: [],
    date: "",
    ppi: { error: "Divide by zero", code: "#DIV/0" },
    secret: "",
    done: false,
  },
  {
    id: "s",
    number: "",
    width: null,
    who: [],
    date: "",
    ppi: qty(1),
    secret: "",
    done: false,
    section: true,
  },
];

describe("view export mapping", () => {
  it("shows values as the grid does; sensitive columns left out", () => {
    const out = exportRows({ columns, rows, isSection: (r) => !!r.section });
    expect(out).toEqual([
      // Measurements: plain numbers in the active unit, the unit in the header.
      ["Cue", "Width (cm)", "Who", "Date", "PPI", "Done"],
      ["2", "450", "Casey, Riley, Jr.", "2026-09-30", "10.84", "true"],
      ["1", "", "", "", "#DIV/0", "false"],
    ]);
  });

  it("owners can include sensitive columns", () => {
    const out = exportRows({ columns, rows: rows.slice(0, 1) }, { includeSensitive: true });
    expect(out[0]).toContain("Password");
    expect(out[1]).toContain("hunter2");
  });

  it("groups become a leading column; a live sort applies within groups", () => {
    const out = exportRows({
      columns: columns.slice(0, 1),
      groups: [
        { id: "g1", title: "101 Open", rows: rows.slice(0, 2) },
        { id: "g2", title: "Unassigned", rows: [] },
      ],
      groupTitle: "Scene",
      sort: [{ key: "number", dir: "asc" }],
    });
    expect(out).toEqual([
      ["Scene", "Cue"],
      ["101 Open", "1"],
      ["101 Open", "2"],
    ]);
  });

  it("no duplicate group column when the grouped field is a visible column", () => {
    const out = exportRows({
      columns: columns.slice(0, 1),
      groups: [{ id: "g1", title: "2", rows: rows.slice(0, 1) }],
      groupTitle: "Cue",
      groupKey: "number",
    });
    expect(out).toEqual([["Cue"], ["2"]]);
  });
});
