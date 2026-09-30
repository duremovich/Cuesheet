import { describe, expect, it } from "vitest";
import {
  applyCalcEdit,
  aspectRefs,
  type CalcRefs,
  type CalcState,
  defaultLock,
  distanceFor,
  imageWidth,
  nonSquarePixels,
  pitchOf,
  pixelsAtPpi,
  ppiOf,
  ratioFor,
  regionShare,
} from "./calc";

/** applyCalcEdit, expecting a result in range. */
function edit(...args: Parameters<typeof applyCalcEdit>) {
  const r = applyCalcEdit(...args);
  if ("error" in r) throw new Error(r.error);
  return r;
}

const IN = 0.0254;
// 1920×1080 on 80"×45": 24 PPI.
const base: CalcState = { width: 80 * IN, height: 45 * IN, pixel_width: 1920, pixel_height: 1080 };

describe("derived values", () => {
  it("PPI and pitch", () => {
    expect(ppiOf(base)).toBeCloseTo(24);
    expect(pitchOf(base)).toBeCloseTo((80 * 25.4) / 1920);
    expect(ppiOf({ ...base, width: null })).toBeNull();
    expect(ppiOf({ ...base, pixel_width: 0 })).toBeNull();
  });
});

describe("applyCalcEdit", () => {
  it("lock physical: editing pixels keeps the size (PPI changes)", () => {
    expect(edit(base, "pixel_width", 3840, "physical", false)).toEqual({
      pixel_width: 3840,
    });
  });

  it("lock physical: editing PPI changes the pixels", () => {
    expect(edit(base, "ppi", 12, "physical", false)).toEqual({
      pixel_width: 960,
      pixel_height: 540,
    });
  });

  it("lock physical: editing the width keeps the pixels", () => {
    expect(edit(base, "width", 2, "physical", false)).toEqual({ width: 2 });
  });

  it("lock pixels: editing the width keeps the pixels (PPI changes)", () => {
    expect(edit(base, "width", 160 * IN, "pixels", false)).toEqual({ width: 160 * IN });
  });

  it("lock pixels: editing PPI changes the size", () => {
    const out = edit(base, "ppi", 48, "pixels", false);
    expect(out.width).toBeCloseTo(40 * IN);
    expect(out.height).toBeCloseTo(22.5 * IN);
    expect(out.pixel_width).toBeUndefined();
  });

  it("lock pixels: editing the pixels keeps the size", () => {
    expect(edit(base, "pixel_height", 1200, "pixels", false)).toEqual({
      pixel_height: 1200,
    });
  });

  it("lock PPI: editing the width recomputes the pixel width", () => {
    expect(edit(base, "width", 160 * IN, "ppi", false)).toEqual({
      width: 160 * IN,
      pixel_width: 3840,
    });
  });

  it("lock PPI: editing the pixel width recomputes the width", () => {
    const out = edit(base, "pixel_width", 960, "ppi", false);
    expect(out.pixel_width).toBe(960);
    expect(out.width).toBeCloseTo(40 * IN);
    expect(out.height).toBeUndefined();
  });

  it("lock PPI: editing the height recomputes the pixel height", () => {
    expect(edit(base, "height", 90 * IN, "ppi", false)).toEqual({
      height: 90 * IN,
      pixel_height: 2160,
    });
  });

  it("lock PPI: editing PPI itself changes the pixels", () => {
    expect(edit(base, "ppi", 12, "ppi", false)).toEqual({
      pixel_width: 960,
      pixel_height: 540,
    });
  });

  it("aspect lock: height follows width (and pixels too under a PPI lock)", () => {
    const phys = edit(base, "width", 160 * IN, "physical", true);
    expect(phys.width).toBeCloseTo(160 * IN);
    expect(phys.height).toBeCloseTo(90 * IN);
    expect(phys.pixel_width).toBeUndefined();
    const ppi = edit(base, "width", 160 * IN, "ppi", true);
    expect(ppi).toMatchObject({ pixel_width: 3840, pixel_height: 2160 });
    expect(ppi.height).toBeCloseTo(90 * IN);
  });

  it("aspect lock: pixel height follows pixel width; width follows height", () => {
    expect(edit(base, "pixel_width", 3840, "physical", true)).toEqual({
      pixel_width: 3840,
      pixel_height: 2160,
    });
    const h = edit(base, "height", 90 * IN, "pixels", true);
    expect(h.width).toBeCloseTo(160 * IN);
    const ppi = edit(base, "pixel_width", 960, "ppi", true);
    expect(ppi).toMatchObject({ pixel_width: 960, pixel_height: 540 });
    expect(ppi.width).toBeCloseTo(40 * IN);
    expect(ppi.height).toBeCloseTo(22.5 * IN);
  });

  it("rounds pixels to whole numbers, never below 1", () => {
    expect(edit(base, "pixel_width", 1000.6, "physical", false)).toEqual({
      pixel_width: 1001,
    });
    expect(edit(base, "ppi", 0.001, "physical", false)).toEqual({
      pixel_width: 1,
      pixel_height: 1,
    });
  });

  it("handles missing values and clears", () => {
    const empty: CalcState = { width: 4.5, height: null, pixel_width: null, pixel_height: null };
    expect(edit(empty, "width", 5, "ppi", true)).toEqual({ width: 5 });
    expect(edit(empty, "ppi", 10, "physical", false)).toEqual({
      pixel_width: Math.round(10 * (4.5 / IN)),
    });
    expect(edit(empty, "ppi", null, "physical", false)).toEqual({});
    expect(edit(base, "width", null, "ppi", true)).toEqual({ width: null });
    // No physical size: PPI derives it from the pixels.
    const pixelsOnly: CalcState = {
      width: null,
      height: null,
      pixel_width: 1920,
      pixel_height: 1080,
    };
    const out = edit(pixelsOnly, "ppi", 24, "physical", false);
    expect(out.width).toBeCloseTo(80 * IN);
    expect(out.height).toBeCloseTo(45 * IN);
  });

  it("default lock: pixels for a region of a parent with a pixel canvas", () => {
    expect(defaultLock(base)).toBe("pixels");
    expect(defaultLock({ ...base, pixel_height: null })).toBe("physical");
    expect(defaultLock(null)).toBe("physical");
  });
});

describe("projector and regions", () => {
  it("throw ratio ↔ image width", () => {
    expect(imageWidth(9, 1.5)).toBe(6);
    expect(distanceFor(6, 1.5)).toBe(9);
    expect(ratioFor(9, 6)).toBe(1.5);
    expect(imageWidth(null, 1.5)).toBeNull();
    expect(imageWidth(9, 0)).toBeNull();
  });

  it("a region's share of its parent", () => {
    const child: CalcState = {
      width: 40 * IN,
      height: 45 * IN,
      pixel_width: null,
      pixel_height: null,
    };
    expect(regionShare(child, base)).toEqual({
      width: 0.5,
      height: 1,
      pixel_width: 960,
      pixel_height: 1080,
    });
    expect(regionShare(child, { ...base, pixel_width: null })).toMatchObject({
      pixel_width: null,
      width: 0.5,
    });
  });
});

describe("locks don't drift", () => {
  it("10 edits under a PPI lock with the aspect lock come back to exactly 1920×1080 / 4.5 m", () => {
    let s: CalcState = {
      width: 4.5,
      height: 4.5 * (1080 / 1920),
      pixel_width: 1920,
      pixel_height: 1080,
    };
    const refs: CalcRefs = { ppi: ppiOf(s), aspect: aspectRefs(s) };
    const steps: [Parameters<typeof applyCalcEdit>[1], number][] = [
      ["width", 3.3],
      ["pixel_width", 1001],
      ["height", 1.17],
      ["pixel_height", 777],
      ["width", 7.77],
      ["pixel_width", 333],
      ["height", 2.999],
      ["pixel_width", 1234],
      ["width", 0.9],
      ["width", 4.5],
    ];
    for (const [field, v] of steps) s = { ...s, ...edit(s, field, v, "ppi", true, refs) };
    expect(s.pixel_width).toBe(1920);
    expect(s.pixel_height).toBe(1080);
    expect(s.width).toBe(4.5);
    expect(s.height).toBeCloseTo(2.53125, 12);
  });

  it("without captured refs, rounding would drift (why the lock captures them)", () => {
    let s: CalcState = { width: 4.5, height: 2.53125, pixel_width: 1920, pixel_height: 1080 };
    for (const w of [0.013, 4.5]) s = { ...s, ...edit(s, "width", w, "ppi", false) };
    expect(s.pixel_width).not.toBe(1920);
  });
});

describe("limits", () => {
  it("refuses results out of range instead of writing them", () => {
    expect(applyCalcEdit(base, "ppi", 5000, "physical", false)).toMatchObject({
      error: expect.stringMatching(/pixels/),
    });
    expect(applyCalcEdit(base, "ppi", 0.001, "pixels", false)).toMatchObject({
      error: expect.stringMatching(/at most 1000 m/),
    });
    expect(applyCalcEdit(base, "width", 900, "ppi", true)).toMatchObject({
      error: expect.stringMatching(/pixels/),
    });
  });

  it("partial pixel size: no PPI until both sides are set", () => {
    expect(ppiOf({ ...base, pixel_height: null })).toBeNull();
    expect(pitchOf({ ...base, pixel_height: null })).toBeNull();
  });

  it("square-pixel check allows 1%", () => {
    expect(nonSquarePixels(base)).toBe(false);
    expect(nonSquarePixels({ ...base, height: 45.3 * IN })).toBe(false);
    expect(nonSquarePixels({ ...base, height: 50 * IN })).toBe(true);
  });

  it("a region takes its parent's PPI", () => {
    const region: CalcState = {
      width: 40 * IN,
      height: 45 * IN,
      pixel_width: null,
      pixel_height: null,
    };
    expect(pixelsAtPpi(region, 24)).toEqual({ pixel_width: 960, pixel_height: 1080 });
    expect(pixelsAtPpi({ ...region, width: null }, 24)).toMatchObject({
      error: expect.any(String),
    });
  });
});
