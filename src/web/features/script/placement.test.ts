import { describe, expect, it } from "vitest";
import { makeAnchor } from "./contract";
import {
  attachBatch,
  moveAnchorOp,
  newCueBatch,
  scriptNeighbours,
  suggestNumber,
} from "./placement";
import { anchorRow, cueRow, SAMPLE } from "./testData";

const cues = new Map([
  ["c20", cueRow({ id: "c20", number: "14.20", scene_id: "s14" })],
  ["c25", cueRow({ id: "c25", number: "14.25", scene_id: "s14" })],
  ["sec", cueRow({ id: "sec", description: "ACT 2", is_section: true })],
  ["c850", cueRow({ id: "c850", number: "8.50", trigger_type: "LX" })],
]);
const anchors = [
  anchorRow({ id: "a20", cue_id: "c20", block: 3, offset: 5 }),
  anchorRow({ id: "sec", cue_id: "sec", block: 4 }),
  anchorRow({ id: "a25", cue_id: "c25", block: 7, offset: 0 }),
  anchorRow({ id: "gone", cue_id: "c850", block: 0, state: "missing" }),
];

describe("scriptNeighbours / suggestNumber", () => {
  it("finds the nearest anchored cues before and after a position in script order", () => {
    const n = scriptNeighbours(anchors, cues, { block: 5, offset: 2 });
    expect(n.before?.id).toBe("c20");
    expect(n.after?.id).toBe("c25");
    expect(suggestNumber(n)).toBe("14.22");
  });
  it("counts an anchor at the same position as before; skips sections, missing and `exclude`", () => {
    expect(scriptNeighbours(anchors, cues, { block: 3, offset: 5 }).before?.id).toBe("c20");
    expect(scriptNeighbours(anchors, cues, { block: 0, offset: 0 }).before).toBeNull();
    const n = scriptNeighbours(anchors, cues, { block: 5, offset: 0 }, "c20");
    expect(n.before).toBeNull();
    expect(suggestNumber(n)).toBe("7.12");
  });
  it("suggests after the last cue and nothing between unusual numbers", () => {
    expect(suggestNumber({ before: cues.get("c25") ?? null, after: null })).toBe("15.00");
    expect(
      suggestNumber({
        before: cueRow({ id: "x", number: "8.5A" }),
        after: cues.get("c25") ?? null,
      }),
    ).toBe("");
    expect(suggestNumber({ before: null, after: null })).toBe("1");
  });
});

describe("newCueBatch", () => {
  it("creates the cue after the previous anchored cue, in its scene, plus a manual anchor", () => {
    const anchor = makeAnchor(SAMPLE, 5, 0, 9);
    const b = newCueBatch({
      cueId: "new",
      anchorId: "an",
      versionId: "v1",
      anchor,
      input: {
        number: "14.22",
        description: " ",
        trigger_type: "Line",
        trigger_value: "Sweet Sue",
      },
      neighbours: { before: cues.get("c20") ?? null, after: cues.get("c25") ?? null },
    });
    expect(b.cueOps).toEqual([
      {
        op: "create",
        table: "cues",
        id: "new",
        fields: {
          scene_id: "s14",
          number: "14.22",
          description: null,
          trigger_type: "Line",
          trigger_value: "Sweet Sue",
        },
        after: "c20",
      },
    ]);
    expect(b.anchorOps).toEqual([
      {
        op: "create",
        id: "an",
        fields: {
          cue_id: "new",
          script_version_id: "v1",
          block: 5,
          offset: 0,
          length: 9,
          quote: "Sweet Sue",
          prefix: anchor.prefix,
          suffix: anchor.suffix,
          state: "manual",
          confidence: 1,
        },
      },
    ]);
  });
  it("goes before the next cue when there's none before", () => {
    const b = newCueBatch({
      cueId: "new",
      anchorId: "an",
      versionId: "v1",
      anchor: makeAnchor(SAMPLE, 0, 0, 0),
      input: { number: "", description: "", trigger_type: "LX", trigger_value: "" },
      neighbours: { before: null, after: cues.get("c25") ?? null },
    });
    expect(b.cueOps[0]).toMatchObject({ before: "c25", fields: { scene_id: "s14", number: null } });
  });
});

describe("attachBatch", () => {
  it("anchors an existing cue; a cue without a trigger takes Line + the quote", () => {
    const cue = cueRow({ id: "c", number: "3" });
    const b = attachBatch({
      cue,
      existing: undefined,
      anchorId: "an",
      versionId: "v1",
      anchor: makeAnchor(SAMPLE, 5, 0, 9),
    });
    expect(b.cueOps).toEqual([
      {
        op: "update",
        table: "cues",
        id: "c",
        fields: { trigger_type: "Line", trigger_value: "Sweet Sue" },
      },
    ]);
    expect(b.anchorOps[0]).toMatchObject({ op: "create", id: "an", fields: { cue_id: "c" } });
  });
  it("moves an anchor the cue already has; keeps an existing trigger; positions take the picked type", () => {
    const b = attachBatch({
      cue: cues.get("c850") as never,
      existing: anchors[3],
      anchorId: "unused",
      versionId: "v1",
      anchor: makeAnchor(SAMPLE, 8, 0, 0),
      positionTrigger: "Timecode",
    });
    expect(b.cueOps).toEqual([]);
    expect(b.anchorOps[0]).toMatchObject({
      op: "update",
      id: "gone",
      fields: { block: 8, state: "manual" },
    });
    const p = attachBatch({
      cue: cueRow({ id: "q" }),
      existing: undefined,
      anchorId: "an",
      versionId: "v1",
      anchor: makeAnchor(SAMPLE, 8, 0, 0),
      positionTrigger: "Visual",
    });
    expect(p.cueOps[0]).toMatchObject({ fields: { trigger_type: "Visual" } });
  });
});

describe("moveAnchorOp", () => {
  it("keeps a Line cue's quote found in the target block, else becomes a position", () => {
    const row = anchorRow({ id: "a", cue_id: "c", block: 5, offset: 0, length: 4, quote: "Bass" });
    expect(moveAnchorOp(row, SAMPLE, 7, false)).toMatchObject({
      op: "update",
      fields: { block: 7, offset: 8, length: 4, quote: "Bass", state: "manual" },
    });
    // Not there, or a positional cue: the block's first words (the engine's position anchor).
    const first = "Keep your head down and your case up.";
    expect(moveAnchorOp(row, SAMPLE, 3, false)).toMatchObject({
      fields: { block: 3, offset: 0, quote: first },
    });
    expect(moveAnchorOp(row, SAMPLE, 7, true)).toMatchObject({
      fields: { block: 7, offset: 0, quote: "Daphne. Bass. Classically trained." },
    });
  });
});
