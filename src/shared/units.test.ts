import { describe, expect, it } from "vitest";
import {
  editLength,
  formatLength,
  formatLengthParts,
  formatPixelSize,
  isPixelSize,
  lengthsEqual,
  parseLength,
  parsePixelSize,
  UNITS,
} from "./units";

const m = (text: string, unit: Parameters<typeof parseLength>[1] = "m") => {
  const r = parseLength(text, unit);
  if (r === null || "error" in r) throw new Error(`no length: ${text} → ${JSON.stringify(r)}`);
  return r.m;
};

describe("parseLength", () => {
  it.each([
    ["4.5", "m", 4.5],
    ["4.5 m", "ft-in", 4.5],
    ["4.5m", "cm", 4.5],
    ["450cm", "m", 4.5],
    ["450 CM", "m", 4.5],
    ["1200 mm", "m", 1.2],
    ["1,200 mm", "m", 1.2],
    ["177in", "m", 177 * 0.0254],
    ["177 inches", "m", 177 * 0.0254],
    ["14.75ft", "m", 14.75 * 0.3048],
    ["14 feet", "m", 14 * 0.3048],
    ["14'", "m", 14 * 0.3048],
    ['9"', "m", 9 * 0.0254],
    ["14'9\"", "m", 177 * 0.0254],
    ["14' 9\"", "m", 177 * 0.0254],
    ["14' 9", "m", 177 * 0.0254],
    ["14 ft 9 in", "m", 177 * 0.0254],
    ["14ft9in", "m", 177 * 0.0254],
    ["14’ 9”", "m", 177 * 0.0254],
    ["4'6\"", "m", 54 * 0.0254],
    ["14' 9 1/2\"", "m", 177.5 * 0.0254],
    ['3/4"', "m", 0.75 * 0.0254],
    ["1 m 20 cm", "m", 1.2],
    [".5", "m", 0.5],
    // Unitless → the active unit (ft-in: decimal feet).
    ["450", "cm", 4.5],
    ["14.75", "ft-in", 14.75 * 0.3048],
    ["177", "in", 177 * 0.0254],
    ["1372", "mm", 1.372],
  ] as const)("%s (%s) → %f m", (text, unit, want) => {
    expect(m(text, unit)).toBeCloseTo(want, 9);
  });

  it("returns null for empty text", () => {
    expect(parseLength("", "m")).toBeNull();
    expect(parseLength("   ", "ft-in")).toBeNull();
  });

  it.each([
    "-4",
    "−4 m",
    "abc",
    "4 parsecs",
    "14 9",
    "4 m 4 m",
    "4..5",
    "9 cm 1 m",
    "1/0 in",
    "4,5",
  ])("rejects %s", (text) => {
    const r = parseLength(text, "m");
    expect(r && "error" in r).toBe(true);
  });

  it("rejects negatives with a clear message", () => {
    expect(parseLength("-4.5 m", "m")).toEqual({ error: "Lengths can't be negative" });
  });
});

describe("formatLength", () => {
  it("formats in each unit", () => {
    expect(formatLength(4.5, "m")).toBe("4.50 m");
    expect(formatLength(4.5, "cm")).toBe("450.0 cm");
    expect(formatLength(1.372, "mm")).toBe("1372 mm");
    expect(formatLength(4.5, "in")).toBe("177.2 in");
    expect(formatLength(4.5, "ft")).toBe("14.76 ft");
    expect(formatLength(4.5, "ft-in")).toBe(`14' 9 1/8"`);
    expect(formatLength(54 * 0.0254, "ft-in")).toBe(`4' 6"`);
    expect(formatLength(0.5 * 0.0254, "ft-in")).toBe(`0' 1/2"`);
    expect(formatLength(0, "ft-in")).toBe(`0' 0"`);
  });

  it('rounds ft-in to 1/8" by default, configurable, carrying into feet', () => {
    const inches = (n: number) => n * 0.0254;
    expect(formatLength(inches(9.06), "ft-in")).toBe(`0' 9"`);
    expect(formatLength(inches(9.07), "ft-in")).toBe(`0' 9 1/8"`);
    expect(formatLength(inches(9.07), "ft-in", { denominator: 16 })).toBe(`0' 9 1/16"`);
    expect(formatLength(inches(9.3), "ft-in", { denominator: 4 })).toBe(`0' 9 1/4"`);
    expect(formatLength(inches(11.97), "ft-in")).toBe(`1' 0"`);
    expect(formatLength(inches(23.99), "ft-in")).toBe(`2' 0"`);
  });

  it("splits the number from the muted unit label", () => {
    expect(formatLengthParts(4.5, "m")).toEqual({ value: "4.50", label: "m" });
    expect(formatLengthParts(4.5, "ft-in")).toEqual({ value: `14' 9 1/8"`, label: "" });
  });

  it("round-trips: display text parses back to within the display precision", () => {
    const samples = [0.5, 1.3716, 4.5, 6.5, 16.5, 0.0123, 9.999];
    const tolerance = { m: 0.005, cm: 0.0005, mm: 0.0005, in: 0.0013, ft: 0.0016, "ft-in": 0.0016 };
    for (const unit of UNITS) {
      for (const v of samples) {
        const back = m(formatLength(v, unit), "m");
        expect(Math.abs(back - v)).toBeLessThanOrEqual(tolerance[unit]);
      }
    }
  });

  it("editor text round-trips exactly (within LENGTH_EPSILON) in every unit", () => {
    const samples = [0.5, 1.3716, 4.5, 6.5, 16.5, 0.0123, 9.999, 123.456789];
    for (const unit of UNITS) {
      for (const v of samples) {
        const text = editLength(v, unit);
        // Parses back the same in any active unit, since it carries its unit.
        for (const active of UNITS) expect(lengthsEqual(m(text, active), v)).toBe(true);
      }
    }
    expect(editLength(54 * 0.0254, "ft-in")).toBe(`4' 6"`);
    expect(editLength(4.5, "m")).toBe("4.5 m");
    expect(editLength(4.5, "ft-in")).toBe(`14' 9.165"`);
  });
});

describe("pixel sizes", () => {
  it.each([
    "1920x1080",
    "1920 × 1080",
    "1920 X 1080",
    "1920*1080",
    "1920, 1080",
    "1920 1080",
    "1920px x 1080px",
  ])("parses %s", (text) => {
    expect(parsePixelSize(text)).toEqual({ w: 1920, h: 1080 });
  });

  it("rejects bad sizes and clears on empty", () => {
    expect(parsePixelSize("")).toBeNull();
    for (const bad of [
      "1920",
      "1920x",
      "0x1080",
      "1920.5x1080",
      "-1920x1080",
      "a x b",
      "200000x1",
    ]) {
      const r = parsePixelSize(bad);
      expect(r && "error" in r, bad).toBe(true);
    }
  });

  it("validates stored values and formats", () => {
    expect(isPixelSize({ w: 1920, h: 1080 })).toBe(true);
    expect(isPixelSize({ w: 1920, h: 1080, x: 1 })).toBe(false);
    expect(isPixelSize({ w: 0, h: 1080 })).toBe(false);
    expect(isPixelSize({ w: 1.5, h: 1080 })).toBe(false);
    expect(isPixelSize("1920x1080")).toBe(false);
    expect(formatPixelSize({ w: 1920, h: 1080 })).toBe("1920×1080");
  });
});
