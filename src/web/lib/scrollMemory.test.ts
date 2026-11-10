import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  anchorTarget,
  captureAnchors,
  FRESH_LOAD_KEY,
  MAX_ENTRIES,
  restoreFor,
  ScrollMemory,
  type ScrollPosition,
  scrollKey,
  shouldRestore,
} from "./scrollMemory";

/** Rows 40 px tall except r:c (120), from 0. */
const LAYOUT = [
  { key: "g:1", start: 0, size: 40 },
  { key: "r:a", start: 40, size: 40 },
  { key: "r:b", start: 80, size: 40 },
  { key: "r:c", start: 120, size: 120 },
  { key: "r:d", start: 240, size: 40 },
  { key: "r:e", start: 280, size: 40 },
];
const byKey = (items: typeof LAYOUT) => (k: string) => items.find((i) => i.key === k);

describe("captureAnchors", () => {
  it("starts at the item the view's top edge is in", () => {
    const a = captureAnchors(LAYOUT, 150, 3);
    expect(a.map((x) => x.key)).toEqual(["r:c", "r:d", "r:e"]);
    expect(a[0]).toEqual({ key: "r:c", at: -30, frac: 0.25 });
    expect(a[1]).toEqual({ key: "r:d", at: 90 });
  });

  it("an item ending exactly at the top is above the view", () => {
    expect(captureAnchors(LAYOUT, 80, 1)[0]).toMatchObject({ key: "r:b", at: 0, frac: 0 });
  });

  it("at the top, and past the end", () => {
    expect(captureAnchors(LAYOUT, 0, 2).map((x) => x.key)).toEqual(["g:1", "r:a"]);
    expect(captureAnchors(LAYOUT, 999)).toEqual([]);
    expect(captureAnchors([], 0)).toEqual([]);
  });
});

describe("anchorTarget", () => {
  it("lands on the same row at the same offset when heights were re-estimated", () => {
    const anchors = captureAnchors(LAYOUT, 150);
    // Rows above c got taller (measured): c now starts at 300.
    const relaid = LAYOUT.map((i, n) => ({ ...i, start: i.start + (n <= 2 ? 60 * n : 180) }));
    expect(byKey(relaid)("r:c")?.start).toBe(300);
    expect(anchorTarget(anchors, byKey(relaid))).toBe(330);
  });

  it("falls back to the next anchor still there, at its own offset", () => {
    const anchors = captureAnchors(LAYOUT, 150);
    const without = LAYOUT.filter((i) => i.key !== "r:c").map((i) =>
      i.key === "r:d" ? { ...i, start: 500 } : i,
    );
    // d was 90 px below the top: it still is.
    expect(anchorTarget(anchors, byKey(without))).toBe(410);
  });

  it("null when nothing is left; never negative", () => {
    expect(anchorTarget(captureAnchors(LAYOUT, 150), () => undefined)).toBeNull();
    expect(anchorTarget([{ key: "r:a", at: 50 }], byKey(LAYOUT))).toBe(0);
  });

  it("keeps a shrunk row in view: the same fraction into it once its offset would hide it", () => {
    // The view's top is 30 px into c (120 px): c stays at -30 while it's taller than that.
    const anchors = captureAnchors(LAYOUT, 150);
    expect(anchors[0]).toMatchObject({ key: "r:c", at: -30, frac: 0.25 });
    const shorter = LAYOUT.map((i) => (i.key === "r:c" ? { ...i, size: 31 } : i));
    expect(anchorTarget(anchors, byKey(shorter))).toBe(150);
    // 30 px or less (compact rows): -30 would put the view's top at c's bottom or below it.
    const compact = LAYOUT.map((i) => (i.key === "r:c" ? { ...i, size: 30 } : i));
    expect(anchorTarget(anchors, byKey(compact))).toBe(120 + 0.25 * 30);
  });

  it("frac mode keeps the same fraction of a page whose size changed (zoom)", () => {
    const pages = [
      { key: "p:1", start: 0, size: 800 },
      { key: "p:2", start: 800, size: 800 },
    ];
    const anchors = captureAnchors(pages, 1000); // a quarter into page 2
    const zoomed = [
      { key: "p:1", start: 0, size: 1600 },
      { key: "p:2", start: 1600, size: 1600 },
    ];
    expect(anchorTarget(anchors, byKey(zoomed), "frac")).toBe(2000);
    expect(anchorTarget(anchors, byKey(zoomed), "px")).toBe(1800);
  });
});

describe("restoreFor", () => {
  const saved: ScrollPosition = { anchors: [{ key: "r:a", at: 0 }], top: 500, left: 20, sig: "x" };
  it("keeps the pixel fallback for the same layout only", () => {
    expect(restoreFor(saved, "x").top).toBe(500);
    expect(restoreFor(saved, "y")).toEqual({ ...saved, top: 0 });
  });
});

describe("shouldRestore", () => {
  const base = {
    focusState: undefined,
    urlRow: null,
    navigationType: "PUSH" as const,
    locationKey: "k1",
  };
  it("a tab click (no row in the URL) restores", () => {
    expect(shouldRestore({ ...base, rememberedRow: "a" })).toBe(true);
    expect(shouldRestore({ ...base, rememberedRow: null })).toBe(true);
  });
  it("⌘K (router focus) and links to a row don't", () => {
    expect(shouldRestore({ ...base, focusState: "a", rememberedRow: "a" })).toBe(false);
    expect(shouldRestore({ ...base, urlRow: "a", rememberedRow: "a" })).toBe(false);
    expect(shouldRestore({ ...base, urlRow: "b", navigationType: "POP", rememberedRow: "a" })).toBe(
      false,
    );
  });
  it("a reload or back/forward to the row you left does", () => {
    expect(shouldRestore({ ...base, urlRow: "a", navigationType: "POP", rememberedRow: "a" })).toBe(
      true,
    );
  });
  it("opening a link or typed URL (a fresh history entry) to that row doesn't", () => {
    expect(
      shouldRestore({
        ...base,
        urlRow: "a",
        navigationType: "POP",
        locationKey: FRESH_LOAD_KEY,
        rememberedRow: "a",
      }),
    ).toBe(false);
    // ...but without a row it's a plain "open the tab": back where you were.
    expect(
      shouldRestore({
        ...base,
        navigationType: "POP",
        locationKey: FRESH_LOAD_KEY,
        rememberedRow: "a",
      }),
    ).toBe(true);
  });
});

describe("ScrollMemory", () => {
  let data: Record<string, string>;
  const storage = {
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
  };
  const pos = (top: number, row?: string): ScrollPosition => ({
    anchors: [{ key: `r:${row ?? top}`, at: 0 }],
    top,
    left: 0,
    ...(row ? { active: { rowId: row } } : {}),
  });
  beforeEach(() => {
    data = {};
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("keeps positions per key and survives a reload through storage", () => {
    const m = new ScrollMemory(() => storage);
    m.set(scrollKey("s1", "cues", "v1"), pos(100));
    m.set(scrollKey("s1", "notes", null), pos(200));
    expect(m.get("s1|cues|v1")?.top).toBe(100);
    expect(m.get("s1|cues|v2")).toBeNull();
    expect(data["cuesheet.scroll"]).toBeUndefined(); // written after a short delay
    vi.advanceTimersByTime(400);
    const reloaded = new ScrollMemory(() => storage);
    expect(reloaded.get("s1|notes|")?.top).toBe(200);
    expect(reloaded.get("s1|cues|v1")?.top).toBe(100);
  });

  it("flush writes at once (page hidden)", () => {
    const m = new ScrollMemory(() => storage);
    m.set("k", pos(1));
    m.flush();
    expect(JSON.parse(data["cuesheet.scroll"] ?? "[]")).toHaveLength(1);
  });

  it("latest is the most recently saved entry under a prefix", () => {
    const m = new ScrollMemory(() => storage);
    m.set("s1|cues|v1", pos(1, "a"));
    m.set("s1|cues|v2", pos(2, "b"));
    m.set("s1|notes|", pos(3, "c"));
    expect(m.latest("s1|cues|")?.active?.rowId).toBe("b");
    m.set("s1|cues|v1", pos(4, "d"));
    expect(m.latest("s1|cues|")?.active?.rowId).toBe("d");
    expect(m.latest("s2|cues|")).toBeNull();
  });

  it(`drops the oldest entries past ${MAX_ENTRIES}`, () => {
    const m = new ScrollMemory(() => storage);
    for (let i = 0; i <= MAX_ENTRIES; i++) m.set(`k${i}`, pos(i));
    expect(m.get("k0")).toBeNull();
    expect(m.get("k1")?.top).toBe(1);
    expect(m.get(`k${MAX_ENTRIES}`)?.top).toBe(MAX_ENTRIES);
  });

  it("ignores unreadable storage and bad entries, and survives storage that throws", () => {
    data["cuesheet.scroll"] = JSON.stringify([
      { key: "ok", pos: pos(5) },
      { key: "bad", pos: { top: "x" } },
      null,
    ]);
    const m = new ScrollMemory(() => storage);
    expect(m.get("ok")?.top).toBe(5);
    expect(m.get("bad")).toBeNull();
    data["cuesheet.scroll"] = "{not json";
    expect(new ScrollMemory(() => storage).get("ok")).toBeNull();
    const throwing = new ScrollMemory(() => ({
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
    }));
    throwing.set("k", pos(1));
    expect(() => throwing.flush()).not.toThrow();
    expect(throwing.get("k")?.top).toBe(1);
  });
});
