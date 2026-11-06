import { describe, expect, it } from "vitest";
import { cueRow } from "../testData";
import { layoutMargin, leaderLabel, type MarginItem, shortText } from "./pdfMargin";

/** No two entries overlap (with the gap), in wanted order. */
function expectNoOverlap(items: MarginItem[], tops: Map<string, number>, gap: number) {
  const placed = items
    .map((it, i) => ({ ...it, i, top: tops.get(it.key) as number }))
    .sort((a, b) => a.want - b.want || a.i - b.i);
  for (let k = 1; k < placed.length; k++) {
    const prev = placed[k - 1] as (typeof placed)[number];
    const cur = placed[k] as (typeof placed)[number];
    expect(cur.top, `${cur.key} after ${prev.key}`).toBeGreaterThanOrEqual(
      prev.top + prev.height + gap - 1e-9,
    );
  }
}

describe("layoutMargin", () => {
  it("keeps entries at their targets when there's room", () => {
    const items = [
      { key: "a", want: 100, height: 20 },
      { key: "b", want: 200, height: 20 },
    ];
    expect([...layoutMargin(items, { gap: 2, max: 800 })]).toEqual([
      ["a", 100],
      ["b", 200],
    ]);
  });

  it("stacks cues at the same spot in input order, without overlaps", () => {
    const items = [
      { key: "7.10", want: 300, height: 20 },
      { key: "7.11", want: 300, height: 20 },
      { key: "7.12", want: 305, height: 20 },
    ];
    const tops = layoutMargin(items, { gap: 2, max: 800 });
    expect(tops.get("7.10")).toBe(300);
    expect(tops.get("7.11")).toBe(322);
    expect(tops.get("7.12")).toBe(344);
    expectNoOverlap(items, tops, 2);
  });

  it("pushes a crowded page bottom back up instead of off the page", () => {
    const items = [0, 1, 2, 3].map((k) => ({ key: `q${k}`, want: 780, height: 20 }));
    const tops = layoutMargin(items, { gap: 2, max: 800 });
    expect(Math.max(...[...tops.values()]) + 20).toBeLessThanOrEqual(800);
    expect(tops.get("q3")).toBe(780);
    expect(tops.get("q0")).toBe(780 - 3 * 22);
    expectNoOverlap(items, tops, 2);
  });

  it("never overlaps, even when the page can't hold them all", () => {
    const items = Array.from({ length: 60 }, (_, k) => ({
      key: `q${k}`,
      want: (k * 37) % 500,
      height: 20,
    }));
    const tops = layoutMargin(items, { gap: 2, max: 600 });
    expectNoOverlap(items, tops, 2);
    for (const t of tops.values()) expect(t).toBeGreaterThanOrEqual(0);
  });

  it("keeps entries below the top limit", () => {
    const tops = layoutMargin([{ key: "a", want: -40, height: 20 }], { min: 0 });
    expect(tops.get("a")).toBe(0);
  });
});

describe("leader labels", () => {
  it("shortens a description to its lead-in or first clause", () => {
    expect(shortText("PRESHOW: Title card on the scroll at rest")).toBe("PRESHOW");
    expect(shortText("800-010 IN: Wind kicks up")).toBe("800-010 IN");
    expect(shortText("Lights fade. Then a long beat.")).toBe("Lights fade");
    expect(shortText("The soldier walks slowly to the river bank and sits")).toBe(
      "The soldier walks slowly to…",
    );
    expect(shortText("  ")).toBe("");
  });

  it("is the trigger badge plus what triggers the cue", () => {
    const l = (p: Parameters<typeof cueRow>[0], quote?: string) => leaderLabel(cueRow(p), quote);
    expect(l({ id: "a", trigger_type: "Visual", description: "PRESHOW: Title card" })).toBe(
      "VISUAL · PRESHOW",
    );
    expect(
      l({ id: "a", trigger_type: "Visual", trigger_value: "He sits", description: "X: y" }),
    ).toBe("VISUAL · He sits");
    expect(l({ id: "a", trigger_type: "LX", lx_cue: "117", description: "Steam wash" })).toBe(
      "LX 117 · Steam wash",
    );
    expect(l({ id: "a", trigger_type: "Timecode", timecode: "1:00:00" })).toBe("TC 1:00:00");
    expect(l({ id: "a", trigger_type: "Visual", sm_call: "[CUE 1 - THE MARCH]" })).toBe(
      "VISUAL · CUE 1 - THE MARCH",
    );
    // Nothing on the cue: the words at the line.
    expect(l({ id: "a" }, "The curtain rises")).toBe("The curtain rises");
  });
});
