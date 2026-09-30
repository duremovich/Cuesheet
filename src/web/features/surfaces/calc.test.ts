import { describe, expect, it } from "vitest";
import {
  applyCalcEdit,
  type CalcState,
  defaultLock,
  distanceFor,
  imageWidth,
  pitchOf,
  ppiOf,
  ratioFor,
  regionShare,
} from "./calc";

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
    expect(applyCalcEdit(base, "pixel_width", 3840, "physical", false)).toEqual({
      pixel_width: 3840,
    });
  });

  it("lock physical: editing PPI changes the pixels", () => {
    expect(applyCalcEdit(base, "ppi", 12, "physical", false)).toEqual({
      pixel_width: 960,
      pixel_height: 540,
    });
  });

  it("lock physical: editing the width keeps the pixels", () => {
    expect(applyCalcEdit(base, "width", 2, "physical", false)).toEqual({ width: 2 });
  });

  it("lock pixels: editing the width keeps the pixels (PPI changes)", () => {
    expect(applyCalcEdit(base, "width", 160 * IN, "pixels", false)).toEqual({ width: 160 * IN });
  });

  it("lock pixels: editing PPI changes the size", () => {
    const out = applyCalcEdit(base, "ppi", 48, "pixels", false);
    expect(out.width).toBeCloseTo(40 * IN);
    expect(out.height).toBeCloseTo(22.5 * IN);
    expect(out.pixel_width).toBeUndefined();
  });

  it("lock pixels: editing the pixels keeps the size", () => {
    expect(applyCalcEdit(base, "pixel_height", 1200, "pixels", false)).toEqual({
      pixel_height: 1200,
    });
  });

  it("lock PPI: editing the width recomputes the pixel width", () => {
    expect(applyCalcEdit(base, "width", 160 * IN, "ppi", false)).toEqual({
      width: 160 * IN,
      pixel_width: 3840,
    });
  });

  it("lock PPI: editing the pixel width recomputes the width", () => {
    const out = applyCalcEdit(base, "pixel_width", 960, "ppi", false);
    expect(out.pixel_width).toBe(960);
    expect(out.width).toBeCloseTo(40 * IN);
    expect(out.height).toBeUndefined();
  });

  it("lock PPI: editing the height recomputes the pixel height", () => {
    expect(applyCalcEdit(base, "height", 90 * IN, "ppi", false)).toEqual({
      height: 90 * IN,
      pixel_height: 2160,
    });
  });

  it("lock PPI: editing PPI itself changes the pixels", () => {
    expect(applyCalcEdit(base, "ppi", 12, "ppi", false)).toEqual({
      pixel_width: 960,
      pixel_height: 540,
    });
  });

  it("aspect lock: height follows width (and pixels too under a PPI lock)", () => {
    const phys = applyCalcEdit(base, "width", 160 * IN, "physical", true);
    expect(phys.width).toBeCloseTo(160 * IN);
    expect(phys.height).toBeCloseTo(90 * IN);
    expect(phys.pixel_width).toBeUndefined();
    const ppi = applyCalcEdit(base, "width", 160 * IN, "ppi", true);
    expect(ppi).toMatchObject({ pixel_width: 3840, pixel_height: 2160 });
    expect(ppi.height).toBeCloseTo(90 * IN);
  });

  it("aspect lock: pixel height follows pixel width; width follows height", () => {
    expect(applyCalcEdit(base, "pixel_width", 3840, "physical", true)).toEqual({
      pixel_width: 3840,
      pixel_height: 2160,
    });
    const h = applyCalcEdit(base, "height", 90 * IN, "pixels", true);
    expect(h.width).toBeCloseTo(160 * IN);
    const ppi = applyCalcEdit(base, "pixel_width", 960, "ppi", true);
    expect(ppi).toMatchObject({ pixel_width: 960, pixel_height: 540 });
    expect(ppi.width).toBeCloseTo(40 * IN);
    expect(ppi.height).toBeCloseTo(22.5 * IN);
  });

  it("rounds pixels to whole numbers, never below 1", () => {
    expect(applyCalcEdit(base, "pixel_width", 1000.6, "physical", false)).toEqual({
      pixel_width: 1001,
    });
    expect(applyCalcEdit(base, "ppi", 0.001, "physical", false)).toEqual({
      pixel_width: 1,
      pixel_height: 1,
    });
  });

  it("handles missing values and clears", () => {
    const empty: CalcState = { width: 4.5, height: null, pixel_width: null, pixel_height: null };
    expect(applyCalcEdit(empty, "width", 5, "ppi", true)).toEqual({ width: 5 });
    expect(applyCalcEdit(empty, "ppi", 10, "physical", false)).toEqual({
      pixel_width: Math.round(10 * (4.5 / IN)),
    });
    expect(applyCalcEdit(empty, "ppi", null, "physical", false)).toEqual({});
    expect(applyCalcEdit(base, "width", null, "ppi", true)).toEqual({ width: null });
    // No physical size: PPI derives it from the pixels.
    const pixelsOnly: CalcState = {
      width: null,
      height: null,
      pixel_width: 1920,
      pixel_height: 1080,
    };
    const out = applyCalcEdit(pixelsOnly, "ppi", 24, "physical", false);
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
