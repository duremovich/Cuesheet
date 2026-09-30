import { describe, expect, it } from "vitest";
import {
  buildAirtableImport,
  detectKind,
  parseAirtableTime,
  splitMulti,
  splitSceneName,
  versionLabel,
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

  it("turns Airtable versions into version labels", () => {
    expect(versionLabel("2.0")).toBe("V02");
    expect(versionLabel("4")).toBe("V04");
    expect(versionLabel("v3")).toBe("V03");
    expect(versionLabel("12.0")).toBe("V12");
    expect(versionLabel("2.5")).toBe("V02.5");
    expect(versionLabel("final")).toBe("final");
    expect(versionLabel("")).toBeNull();
    expect(versionLabel(null)).toBeNull();
  });

  it("imports a content row's Version as its current version", () => {
    const csv = [
      "Name,Version,Scene,Cue List,Content Notes,Creator,LOOP IN,LOOP OUT",
      "105-001-VAMP,2.0,,,,,,",
      "105-002-X,,,,,,,",
    ].join("\n");
    const plan = buildAirtableImport([{ name: "Content-Grid view.csv", text: csv }], {
      "content_versions.status": [{ value: "Available", color: "green" }],
    });
    expect(plan.created).toMatchObject({ content: 2, content_versions: 1 });
    const vamp = plan.ops.find((o) => o.op === "create" && o.table === "content");
    const version = plan.ops.find((o) => o.op === "create" && o.table === "content_versions");
    expect(version).toMatchObject({
      fields: { content_id: vamp?.id, version: "V02", is_current: true, status: "Available" },
    });
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
