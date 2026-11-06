import { describe, expect, it } from "vitest";
import { normalizeText, normalizeTextTraced } from "./script";

describe("normalizeTextTraced", () => {
  const cases = [
    "Plain text.",
    "  leading and trailing  ",
    "tabs\tand\n\nnewlines   collapse",
    "“Curly” ‘quotes’ – and — dashes",
    "ﬁne ﬂour",
    "soft­hyphen and zero​width",
    "NBSP space",
    "é composed",
    "emoji 😀 stays",
    "​",
    "",
  ];
  for (const s of cases) {
    it(`matches normalizeText: ${JSON.stringify(s)}`, () => {
      const { text, map } = normalizeTextTraced(s);
      expect(text).toBe(normalizeText(s));
      expect(map).toHaveLength(text.length);
      // Sources only move forward and stay inside the input.
      for (let k = 1; k < map.length; k++) expect(map[k]).toBeGreaterThanOrEqual(map[k - 1] ?? 0);
      for (const m of map) expect(m).toBeLessThan(Math.max(1, s.length));
    });
  }

  it("maps characters to where they came from", () => {
    const s = "  Hi  “there” ﬁ";
    const { text, map } = normalizeTextTraced(s);
    expect(text).toBe('Hi "there" fi');
    expect(map[0]).toBe(2); // H
    expect(map[2]).toBe(4); // the collapsed space: its first source character
    expect(map[3]).toBe(6); // the opening quote
    expect(map[11]).toBe(14); // f of the ligature
    expect(map[12]).toBe(14); // i of the ligature
  });
});
