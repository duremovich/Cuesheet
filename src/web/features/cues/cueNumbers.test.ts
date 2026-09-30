import { describe, expect, it } from "vitest";
import {
  cueNumberHints,
  cueNumberKey,
  hintsEqual,
  type NumberedRow,
  parseCueNumber,
  suggestCueNumber,
} from "./cueNumbers";

describe("suggestCueNumber", () => {
  it("takes the midpoint with the neighbours' precision, adding digits when needed", () => {
    expect(suggestCueNumber("14.2", "14.4")).toBe("14.3");
    expect(suggestCueNumber("14.20", "14.25")).toBe("14.22");
    expect(suggestCueNumber("14.2", "14.25")).toBe("14.22");
    expect(suggestCueNumber("14.20", "14.40")).toBe("14.30");
    expect(suggestCueNumber("14", "15")).toBe("14.5");
    expect(suggestCueNumber("2.00", "3.00")).toBe("2.50");
    expect(suggestCueNumber("0.90", "1.00")).toBe("0.95");
    expect(suggestCueNumber("14.22", "14.23")).toBe("14.225");
  });

  it("after the last cue: the next whole number, keeping the decimals", () => {
    expect(suggestCueNumber("14.20", undefined)).toBe("15.00");
    expect(suggestCueNumber("7", undefined)).toBe("8");
    expect(suggestCueNumber("7.5", undefined)).toBe("8.0");
  });

  it("before the first cue: the midpoint from zero; no cues at all: 1", () => {
    expect(suggestCueNumber(undefined, "0.10")).toBe("0.05");
    expect(suggestCueNumber(undefined, "1")).toBe("0.5");
    expect(suggestCueNumber(undefined, undefined)).toBe("1");
  });

  it("nothing when a neighbour isn't a plain decimal or there's no room", () => {
    expect(suggestCueNumber("8.5A", "9")).toBeUndefined();
    expect(suggestCueNumber("8", "PRESET")).toBeUndefined();
    expect(suggestCueNumber("1.2.3", undefined)).toBeUndefined();
    expect(suggestCueNumber("5", "5")).toBeUndefined();
    expect(suggestCueNumber("6", "5")).toBeUndefined();
    expect(suggestCueNumber("1.0000", "1.0001")).toBeUndefined();
  });

  it("parses only plain decimals", () => {
    expect(parseCueNumber("14.25")).toBe(14.25);
    expect(parseCueNumber(" 3 ")).toBe(3);
    expect(parseCueNumber("8.5A")).toBeNull();
    expect(parseCueNumber("")).toBeNull();
    expect(parseCueNumber(null)).toBeNull();
    expect(cueNumberKey("14.2")).toBe(cueNumberKey("14.20"));
    expect(cueNumberKey("8.5a")).toBe(cueNumberKey("8.5A "));
  });
});

const row = (id: string, number: string | null, extra: Partial<NumberedRow> = {}): NumberedRow => ({
  id,
  number,
  isSection: false,
  ...extra,
});

describe("cueNumberHints", () => {
  it("ghosts the midpoint between the displayed numbered neighbours", () => {
    const hints = cueNumberHints([
      row("a", "14.20"),
      row("new", null),
      row("sec", null, { isSection: true, description: "INTERMISSION" }),
      row("b", "14.25"),
      row("end", ""),
    ]);
    expect(hints.get("new")).toEqual({ ghost: "14.22" });
    expect(hints.has("sec")).toBe(false);
    expect(hints.get("end")).toEqual({ ghost: "15.00" });
    expect(hints.has("a")).toBe(false);
  });

  it("two empty rows in a row get the same suggestion; unparseable neighbours give none", () => {
    const hints = cueNumberHints([row("a", "1"), row("x", null), row("y", null), row("b", "2")]);
    expect(hints.get("x")?.ghost).toBe("1.5");
    expect(hints.get("y")?.ghost).toBe("1.5");
    const none = cueNumberHints([row("a", "8.5A"), row("x", null), row("b", "9")]);
    expect(none.get("x")).toBeUndefined();
  });

  it("uses the insert anchor for a row held in place under a live sort", () => {
    // Live sort shows empty numbers last, but the grid holds the new row after 14.20.
    const display = [row("a", "14.20"), row("b", "14.25"), row("c", "15.00"), row("new", null)];
    const plain = cueNumberHints(display);
    expect(plain.get("new")?.ghost).toBe("16.00");
    const anchored = cueNumberHints(display, new Map([["new", { after: "a" }]]));
    expect(anchored.get("new")?.ghost).toBe("14.22");
    const before = cueNumberHints(display, new Map([["new", { before: "c" }]]));
    expect(before.get("new")?.ghost).toBe("14.62");
  });

  it("warns about duplicates, naming the other cue, and about unusual numbers", () => {
    const hints = cueNumberHints([
      row("a", "14.2", { description: "Sweet Sue needs a sax" }),
      row("b", "14.20"),
      row("c", "8.5A"),
      row("d", "cue five"),
      row("e", "1.2.3"),
    ]);
    expect(hints.get("a")?.warning).toBe("Duplicate of cue 14.20");
    expect(hints.get("b")?.warning).toBe("Duplicate of cue 14.2 (Sweet Sue needs a sax)");
    expect(hints.has("c")).toBe(false);
    expect(hints.get("d")?.warning).toMatch(/Unusual cue number/);
    expect(hints.has("e")).toBe(false);
  });

  it("sections never count as duplicates or neighbours", () => {
    const hints = cueNumberHints([
      row("a", "1"),
      row("s", "1", { isSection: true }),
      row("x", null),
      row("b", "2"),
    ]);
    expect(hints.has("a")).toBe(false);
    expect(hints.get("x")?.ghost).toBe("1.5");
  });

  it("hintsEqual compares by value", () => {
    const a = cueNumberHints([row("a", "1"), row("x", null)]);
    const b = cueNumberHints([row("a", "1"), row("x", null)]);
    expect(a).not.toBe(b);
    expect(hintsEqual(a, b)).toBe(true);
    expect(hintsEqual(a, cueNumberHints([row("a", "2"), row("x", null)]))).toBe(false);
  });
});
