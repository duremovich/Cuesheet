import { describe, expect, it } from "vitest";
import { filterFromParam, filterToParam, markerColor, matchesMarker, NO_FILTER } from "./filters";
import {
  anchorsByBlock,
  anchorWarnings,
  cueLabel,
  findBlocks,
  findPage,
  headingsOf,
  markerText,
  pageLabelOf,
  pagesOf,
  segmentText,
  stackMarkers,
  triggerBadge,
  versionAnchors,
} from "./markers";
import { anchorRow, cueRow, SAMPLE } from "./testData";

describe("triggerBadge / markerText", () => {
  it("names the trigger the way the margin shows it", () => {
    const c = (p: Parameters<typeof cueRow>[0]) => triggerBadge(cueRow(p));
    expect(c({ id: "a", trigger_type: "Line" })).toBe("LINE");
    expect(c({ id: "a", trigger_type: "LX", lx_cue: "117" })).toBe("LX 117");
    expect(c({ id: "a", trigger_type: "LX", trigger_value: "42" })).toBe("LX 42");
    expect(c({ id: "a", trigger_type: "SQ", sq_cue: "12" })).toBe("SQ 12");
    expect(c({ id: "a", trigger_type: "Timecode", trigger_value: "1:00:00" })).toBe("TC 1:00:00");
    expect(c({ id: "a", trigger_type: "Visual" })).toBe("VISUAL");
    expect(c({ id: "a", trigger_type: "Follow" })).toBe("FOLLOW");
    expect(c({ id: "a", trigger_type: "Manual" })).toBe("MANUAL");
    expect(c({ id: "a" })).toBe("");
  });

  it("shows a Line cue's text quoted, a Visual's description of the visual, else the description", () => {
    expect(markerText(cueRow({ id: "a", trigger_type: "Line", trigger_value: "Hi" }))).toBe("“Hi”");
    expect(
      markerText(cueRow({ id: "a", trigger_type: "Visual", trigger_value: "dance break" })),
    ).toBe("dance break");
    expect(markerText(cueRow({ id: "a", trigger_type: "LX", description: "Wash" }))).toBe("Wash");
    expect(cueLabel(cueRow({ id: "a", number: "14.2" }))).toBe("Q 14.2");
    expect(cueLabel(cueRow({ id: "a" }))).toBe("Q –");
  });
});

describe("stackMarkers", () => {
  it("keeps markers at their block unless the one above would overlap", () => {
    const { tops, bottom } = stackMarkers(
      [
        { key: "a", top: 0, height: 44 },
        { key: "b", top: 0, height: 44 },
        { key: "c", top: 60, height: 44 },
        { key: "d", top: 300, height: 20 },
      ],
      4,
    );
    expect([...tops]).toEqual([
      ["a", 0],
      ["b", 48],
      ["c", 96],
      ["d", 300],
    ]);
    expect(bottom).toBe(320);
  });

  it("orders by wanted top, ties in input order", () => {
    const { tops } = stackMarkers([
      { key: "late", top: 100, height: 10 },
      { key: "x", top: 10, height: 10 },
      { key: "y", top: 10, height: 10 },
    ]);
    expect(tops.get("x")).toBe(10);
    expect(tops.get("y")).toBe(24);
    expect(tops.get("late")).toBe(100);
    expect(stackMarkers([]).bottom).toBe(0);
  });
});

describe("segmentText", () => {
  it("cuts text at quote boundaries, overlapping quotes carry both ids", () => {
    expect(
      segmentText("abcdefghij", [
        { id: "q1", start: 2, end: 6 },
        { id: "q2", start: 4, end: 8 },
      ]),
    ).toEqual([
      { text: "ab", ids: [] },
      { text: "cd", ids: ["q1"] },
      { text: "ef", ids: ["q1", "q2"] },
      { text: "gh", ids: ["q2"] },
      { text: "ij", ids: [] },
    ]);
  });
  it("clamps ranges and ignores empty ones", () => {
    expect(segmentText("abc", [{ id: "x", start: 1, end: 99 }])).toEqual([
      { text: "a", ids: [] },
      { text: "bc", ids: ["x"] },
    ]);
    expect(segmentText("abc", [{ id: "x", start: 2, end: 2 }])).toEqual([{ text: "abc", ids: [] }]);
  });
});

describe("pages, headings, find", () => {
  it("groups blocks into labelled pages", () => {
    const pages = pagesOf(SAMPLE);
    expect(pages.map((p) => [p.label, p.blocks.length])).toEqual([
      ["12", 6],
      ["13", 3],
    ]);
    expect(pageLabelOf(SAMPLE, 7)).toBe("13");
    expect(headingsOf(SAMPLE)).toEqual([{ block: 0, text: "ACT ONE, SCENE 5", label: "12" }]);
    expect(findBlocks(SAMPLE, "bass")).toEqual([5, 7]);
    expect(findBlocks(SAMPLE, " ")).toEqual([]);
    expect(findPage(pages, "13")).toBe(1);
    expect(findPage(pages, "1")).toBe(0);
    expect(findPage(pages, "99")).toBe(-1);
  });
});

describe("anchors", () => {
  const cues = new Map([
    ["c1", cueRow({ id: "c1" })],
    ["c2", cueRow({ id: "c2" })],
  ]);
  const anchors = new Map([
    ["a2", anchorRow({ id: "a2", cue_id: "c2", block: 5, offset: 3 })],
    ["a1", anchorRow({ id: "a1", cue_id: "c1", block: 5, offset: 0 })],
    ["gone", anchorRow({ id: "gone", cue_id: "deleted", block: 1 })],
    ["other", anchorRow({ id: "other", cue_id: "c1", script_version_id: "v2", state: "changed" })],
    ["miss", anchorRow({ id: "miss", cue_id: "c2", script_version_id: "v2", state: "missing" })],
  ]);
  it("lists a version's anchors in script order, dropping deleted cues", () => {
    const list = versionAnchors(anchors, "v1", cues);
    expect(list.map((a) => a.id)).toEqual(["a1", "a2"]);
    expect([
      ...(anchorsByBlock(list)
        .get(5)
        ?.map((a) => a.id) ?? []),
    ]).toEqual(["a1", "a2"]);
    expect(versionAnchors(anchors, null, cues)).toEqual([]);
  });
  it("stacks markers on one block by offset, ties in show order", () => {
    const list = [
      anchorRow({ id: "x", cue_id: "late", block: 2, offset: 0 }),
      anchorRow({ id: "y", cue_id: "early", block: 2, offset: 0 }),
      anchorRow({ id: "z", cue_id: "mid", block: 2, offset: 9 }),
    ];
    const order: Record<string, string> = { late: "a5", early: "a1", mid: "a0" };
    expect(
      anchorsByBlock(list, (id) => order[id] ?? "")
        .get(2)
        ?.map((a) => a.cue_id),
    ).toEqual(["early", "late", "mid"]);
  });

  it("warns in the cue list about changed and missing anchors on the current version", () => {
    const w = anchorWarnings(anchors, "v2");
    expect([...w.keys()].sort()).toEqual(["c1", "c2"]);
    expect(w.get("c1")?.warning).toMatch(/changed/);
    expect(w.get("c1")?.warningStyle).toBe("dashed");
    expect(anchorWarnings(anchors, "v1").size).toBe(0);
  });
});

describe("filters", () => {
  it("matches status, trigger and assignee and round-trips through ?filter=", () => {
    const c = cueRow({ id: "c", status: "Cued", trigger_type: "LX" });
    expect(matchesMarker(c, [], NO_FILTER)).toBe(true);
    const f = { status: "Cued", assignee: "p1", trigger: "LX" };
    expect(matchesMarker(c, ["p1"], f)).toBe(true);
    expect(matchesMarker(c, ["p2"], f)).toBe(false);
    expect(matchesMarker(c, ["p1"], { ...f, status: "Rendered" })).toBe(false);
    expect(filterFromParam(filterToParam(f))).toEqual(f);
    expect(filterToParam(NO_FILTER)).toBe("");
    expect(filterFromParam(null)).toEqual(NO_FILTER);
  });
  it("colors by the status or trigger option", () => {
    const options = {
      "cues.status": [{ value: "Cued", color: "green" }],
      "cues.trigger_type": [{ value: "LX", color: "yellow" }],
    } as never;
    const c = cueRow({ id: "c", status: "Cued", trigger_type: "LX" });
    expect(markerColor(c, "status", options)).toBe("green");
    expect(markerColor(c, "trigger", options)).toBe("yellow");
    expect(markerColor(c, "none", options)).toBeUndefined();
  });
});
