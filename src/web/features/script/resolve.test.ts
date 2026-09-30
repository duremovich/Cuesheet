import { describe, expect, it } from "vitest";
import type { ReanchorResult } from "./contract";
import {
  allDone,
  buildResolveItems,
  initResolve,
  nextPending,
  type ResolveItem,
  reportCounts,
  reportText,
  resolveReducer,
} from "./resolve";
import { anchorRow } from "./testData";

describe("report", () => {
  it("counts states (manual counts as matched)", () => {
    const c = reportCounts(["matched", "moved", "changed", "missing", "missing", "manual"]);
    expect(c).toEqual({ matched: 2, moved: 1, changed: 1, missing: 2 });
    expect(reportText(c)).toBe("2 matched · 1 moved · 1 changed · 2 missing");
  });
});

const prev = [
  anchorRow({ id: "p1", cue_id: "a", block: 1, script_version_id: "v1" }),
  anchorRow({ id: "p2", cue_id: "b", block: 2, script_version_id: "v1" }),
  anchorRow({ id: "p3", cue_id: "c", block: 3, script_version_id: "v1" }),
  anchorRow({ id: "p4", cue_id: "d", block: 4, script_version_id: "v1" }),
];

describe("buildResolveItems", () => {
  it("from anchor rows: changed and missing rows, and cues with no row, in old script order", () => {
    const anchors = [
      anchorRow({ id: "n1", cue_id: "a", state: "matched", script_version_id: "v2" }),
      anchorRow({
        id: "n2",
        cue_id: "b",
        state: "changed",
        confidence: 0.7,
        block: 9,
        script_version_id: "v2",
      }),
      anchorRow({ id: "n4", cue_id: "d", state: "missing", script_version_id: "v2" }),
    ];
    const items = buildResolveItems({
      results: null,
      anchors,
      prevAnchors: prev,
      cueExists: () => true,
    });
    expect(items.map((i) => [i.cueId, i.state, i.anchorId])).toEqual([
      ["b", "changed", "n2"],
      ["c", "missing", null],
      ["d", "missing", "n4"],
    ]);
    expect(items[0]?.candidates).toEqual([{ anchor: anchors[1], score: 0.7 }]);
    expect(items[1]?.candidates).toEqual([]);
  });

  it("prefers the import's candidates; skips resolved (manual) rows and deleted cues", () => {
    const cand = { block: 5, offset: 0, length: 3, quote: "abc", prefix: "", suffix: "" };
    const results: ReanchorResult[] = [
      {
        cueId: "c",
        from: prev[2] as never,
        to: null,
        state: "missing",
        confidence: 0,
        candidates: [{ anchor: cand, score: 0.3 }],
      },
    ];
    const anchors = [
      anchorRow({ id: "n1", cue_id: "a", state: "manual", script_version_id: "v2" }),
      anchorRow({ id: "n2", cue_id: "b", state: "moved", script_version_id: "v2" }),
      anchorRow({ id: "n4", cue_id: "d", state: "matched", script_version_id: "v2" }),
    ];
    const items = buildResolveItems({
      results,
      anchors,
      prevAnchors: prev,
      cueExists: (id) => id !== "zzz",
    });
    expect(items.map((i) => i.cueId)).toEqual(["c"]);
    expect(items[0]?.candidates[0]?.anchor).toBe(cand);
    expect(
      buildResolveItems({ results, anchors, prevAnchors: prev, cueExists: (id) => id !== "c" }),
    ).toEqual([]);
  });
});

const item = (cueId: string, state: "changed" | "missing" = "missing"): ResolveItem => ({
  cueId,
  state,
  from: null,
  candidates:
    state === "changed"
      ? [
          {
            anchor: { block: 1, offset: 0, length: 1, quote: "a", prefix: "", suffix: "" },
            score: 0.9,
          },
          {
            anchor: { block: 2, offset: 0, length: 1, quote: "b", prefix: "", suffix: "" },
            score: 0.5,
          },
        ]
      : [],
  anchorId: null,
  status: "pending",
});

describe("resolveReducer", () => {
  it("walks the pending items: done moves to the next pending one, wrapping", () => {
    let s = initResolve([item("a", "changed"), item("b"), item("c")]);
    s = resolveReducer(s, { type: "candidate", index: 1 });
    expect(s.candidate).toBe(1);
    s = resolveReducer(s, { type: "done", status: "accepted" });
    expect(s).toMatchObject({ index: 1, candidate: 0, placing: false });
    s = resolveReducer(s, { type: "select", index: 2 });
    s = resolveReducer(s, { type: "done", status: "skipped" });
    expect(s.index).toBe(1); // wrapped back to b
    s = resolveReducer(s, { type: "place" });
    expect(s.placing).toBe(true);
    s = resolveReducer(s, { type: "cancelPlace" });
    expect(s.placing).toBe(false);
    s = resolveReducer(s, { type: "place" });
    s = resolveReducer(s, { type: "done", status: "placed" });
    expect(allDone(s)).toBe(true);
    expect(s.items.map((i) => i.status)).toEqual(["accepted", "placed", "skipped"]);
    expect(nextPending(s.items, 0)).toBe(-1);
  });

  it("ignores bad indexes, doesn't place a finished item, and appends newly flagged cues", () => {
    let s = initResolve([item("a")]);
    expect(resolveReducer(s, { type: "select", index: 5 })).toBe(s);
    expect(resolveReducer(s, { type: "candidate", index: 0 })).toBe(s);
    s = resolveReducer(s, { type: "done", status: "cut" });
    expect(resolveReducer(s, { type: "place" })).toBe(s);
    const synced = resolveReducer(s, { type: "sync", items: [item("b")] });
    expect(synced.items.map((i) => [i.cueId, i.status])).toEqual([
      ["a", "cut"],
      ["b", "pending"],
    ]);
    // Resolved items leaving the fresh list stay; nothing new → same state.
    expect(resolveReducer(synced, { type: "sync", items: [] })).toBe(synced);
  });
});
