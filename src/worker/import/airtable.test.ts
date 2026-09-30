import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CreateOp, LinkOp, Op } from "../../shared/ops";
import {
  buildAirtableImport,
  detectKind,
  headerUnit,
  headerUnitOrNull,
  parentChannel,
  parseAirtableTime,
  splitMulti,
  splitSceneName,
} from "./airtable";

describe("Airtable import helpers", () => {
  it("splits multi-value cells, honouring Airtable's quoting", () => {
    expect(splitMulti("8.20,8.50")).toEqual(["8.20", "8.50"]);
    expect(splitMulti('a,"b, with comma",c')).toEqual(["a", "b, with comma", "c"]);
    expect(splitMulti("x,x")).toEqual(["x"]);
    expect(splitMulti("  ")).toEqual([]);
    expect(splitMulti(undefined)).toEqual([]);
  });

  it("parses Airtable times (as UTC)", () => {
    expect(parseAirtableTime("9/23/2026 1:47pm")).toBe(Date.UTC(2026, 8, 23, 13, 47));
    expect(parseAirtableTime("7/16/2026 12:07pm")).toBe(Date.UTC(2026, 6, 16, 12, 7));
    expect(parseAirtableTime("7/16/2026 12:07am")).toBe(Date.UTC(2026, 6, 16, 0, 7));
    expect(parseAirtableTime("yesterday")).toBeNull();
  });

  it("splits scene names into number and name", () => {
    expect(splitSceneName("99 Preshow")).toEqual({ number: "99", name: "Preshow" });
    expect(splitSceneName("101 Scene One: Hottest Speakeasy")).toEqual({
      number: "101",
      name: "Scene One: Hottest Speakeasy",
    });
    expect(splitSceneName("Intermission")).toEqual({ number: null, name: "Intermission" });
  });

  it("detects the table from the file name or headers", () => {
    expect(detectKind("Cue List-Video Cue List View.csv", [])).toBe("cues");
    expect(detectKind("Breakdown-Grid view.csv", [])).toBe("scenes");
    expect(detectKind("export.csv", ["Note", "Cue #"])).toBe("notes");
    expect(detectKind("export.csv", ["Name", "Role"])).toBe("persons");
    expect(detectKind("Surfaces-Gallery.csv", ["Name"])).toBe("surfaces");
    expect(detectKind("export.csv", ["Name", "Channel Name"])).toBe("surfaces");
    expect(detectKind("Calendar-Grid view.csv", ["Milestone"])).toBeNull();
  });

  it("turns spacer rows into nothing and text-only rows into sections", () => {
    const csv = [
      "Cue Number,PG,SM Call,LX,Timecode,AE Time,MSR,Description,STATUS,Assignee,Content",
      "1.00,1,Go,,,,,Red curtain,CUED,,",
      ",,,,,,,,,,",
      ",,ACT 2,,,,,,,,",
    ].join("\n");
    const plan = buildAirtableImport([{ name: "Cue List-x.csv", text: csv }], {
      "cues.status": [{ value: "Cued", color: "green" }],
    });
    expect(plan.created.cues).toBe(2);
    expect(plan.ops.map((o) => (o.op === "create" ? o.fields : null))).toMatchObject([
      { number: "1.00", status: "Cued", is_section: false },
      { number: null, sm_call: "ACT 2", is_section: true },
    ]);
  });

  it("reads units from headers and parents from channels", () => {
    expect(headerUnit("Width (Meters)")).toBe("m");
    expect(headerUnit("Width (Feet)")).toBe("ft");
    expect(headerUnit("Height (in)")).toBe("in");
    expect(headerUnit("Width")).toBe("m");
    expect(headerUnitOrNull("Width (Furlongs)")).toBeNull();
    expect(headerUnit("Width (Furlongs)")).toBe("m");
    expect(parentChannel("CH02.1")).toBe("CH02");
    expect(parentChannel("CH02")).toBeNull();
  });
});

const creates = (ops: Op[], table: string) =>
  ops.filter((o): o is CreateOp => o.op === "create" && o.table === table);

describe("Airtable import: surfaces", () => {
  it("imports Surfaces-Gallery.csv: widths in meters, regions under their channel's parent", () => {
    const text = readFileSync("examples/Surfaces-Gallery.csv", "utf8");
    const plan = buildAirtableImport([{ name: "Surfaces-Gallery.csv", text }], {});
    // 16 CSV rows: 15 surfaces and a blank trailing row.
    expect(plan.created.surfaces).toBe(15);
    const rows = creates(plan.ops, "surfaces");
    const byChannel = new Map(rows.map((o) => [o.fields.channel, o]));
    expect(byChannel.get("CH02")?.fields).toMatchObject({
      name: "L PRO",
      width: 4.5,
      height: 4,
    });
    expect(byChannel.get("CH02")?.fields.parent_id).toBeUndefined();
    expect(byChannel.get("CH02.1")?.fields).toMatchObject({
      name: "L PRO TOP",
      width: 4.5,
      height: 2.5,
      parent_id: byChannel.get("CH02")?.id,
    });
    expect(byChannel.get("CH11.2")?.fields.parent_id).toBe(byChannel.get("CH11")?.id);
    expect(rows.filter((o) => o.fields.parent_id).length).toBe(7);
    expect(plan.warnings).toEqual([]);
  });

  it("warns about header units it doesn't know", () => {
    const text = ["Name,Channel Name,Width (Cubits),Height", "A,CH01,2,1"].join("\n");
    const plan = buildAirtableImport([{ name: "Surfaces-x.csv", text }], {});
    expect(plan.warnings).toEqual([
      'Surfaces: "Width (Cubits)" names no unit Cuesheet knows; read as meters',
    ]);
    expect(creates(plan.ops, "surfaces")[0]?.fields.width).toBe(2);
  });

  it("links Breakdown.Surfaces by name or channel, parents listed after children, feet headers", () => {
    const surfaces = [
      "Name,Channel Name,Width (Feet),Height (Feet)",
      "TOP,CH09.1,10,5",
      "WALL,CH09,20,x",
      "LOST,CH07.2,1,1",
    ].join("\n");
    const breakdown = [
      "Scene Name,Location,Surfaces",
      '101 One,Here,"WALL,CH09.1"',
      "102 Two,There,Nowhere",
    ].join("\n");
    const plan = buildAirtableImport(
      [
        { name: "Surfaces-Gallery.csv", text: surfaces },
        { name: "Breakdown-Grid view.csv", text: breakdown },
      ],
      {},
    );
    const [top, wall] = creates(plan.ops, "surfaces");
    expect(top?.fields.width).toBeCloseTo(3.048);
    expect(wall?.fields.height).toBeNull();
    // The parent comes later in the CSV: set by an update after both exist.
    expect(plan.ops).toContainEqual({
      op: "update",
      table: "surfaces",
      id: top?.id,
      fields: { parent_id: wall?.id },
    });
    const links = plan.ops.filter((o): o is LinkOp => o.op === "link");
    expect(links.map((l) => [l.table, l.field, l.targetId])).toEqual([
      ["scenes", "surfaces", wall?.id],
      ["scenes", "surfaces", top?.id],
    ]);
    expect(plan.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/"x" in Height \(Feet\) of WALL is not a length/),
        'Breakdown: surface "Nowhere" not found; link skipped',
        "Surfaces: CH07.2 looks like a region of CH07, which isn't in the file; left top-level",
      ]),
    );
  });
});
