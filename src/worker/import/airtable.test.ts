import { describe, expect, it } from "vitest";
import {
  buildAirtableImport,
  detectKind,
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
    expect(detectKind("Surfaces-Gallery.csv", ["Name"])).toBeNull();
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
});
