import { describe, expect, it } from "vitest";
import { cueNavRows } from "./cueNav";
import { NO_FILTER } from "./filters";
import { anchorRow, cueRow, SAMPLE } from "./testData";

const cues = new Map([
  ["c1", cueRow({ id: "c1", number: " 14.20 ", trigger_type: "Line", trigger_value: "Daphne." })],
  ["c2", cueRow({ id: "c2", number: null, description: "Pre-show wash" })],
  ["c3", cueRow({ id: "c3", number: "16", sm_call: "[GO 16]", status: "Cued" })],
  ["s1", cueRow({ id: "s1", is_section: true, description: "ACT 2" })],
]);

const rows = (over: Partial<Parameters<typeof cueNavRows>[0]> = {}) =>
  cueNavRows({
    order: ["c2", "s1", "c1", "gone", "c3"],
    cues,
    assignees: new Map(),
    filter: NO_FILTER,
    anchors: [
      anchorRow({ id: "a1", cue_id: "c1", block: 7 }),
      anchorRow({ id: "a3", cue_id: "c3", block: -1, state: "missing" }),
    ],
    text: SAMPLE,
    ...over,
  });

describe("cueNavRows", () => {
  it("follows the given show order, skipping sections and unknown ids", () => {
    expect(rows().map((r) => r.id)).toEqual(["c2", "c1", "c3"]);
  });

  it("gives the number, the callout and the page label of the placed anchor", () => {
    const [c2, c1, c3] = rows();
    expect(c1).toMatchObject({ number: "14.20", text: "“Daphne.”", page: 2, label: "13" });
    expect(c1?.title).toBe("Q 14.20 · “Daphne.”\nPage 13");
    // Unnumbered, no anchor at all.
    expect(c2).toMatchObject({ number: "–", text: "Pre-show wash", page: null, label: null });
    // A missing anchor isn't placed.
    expect(c3).toMatchObject({ text: "GO 16", page: null });
    expect(c3?.title).toContain("Not placed in this version of the script");
  });

  it("applies the marker filter", () => {
    expect(rows({ filter: { ...NO_FILTER, status: "Cued" } }).map((r) => r.id)).toEqual(["c3"]);
  });
});
