import { describe, expect, it } from "vitest";
import { parseTimecode } from "../../../shared/custom-values";
import type { Column } from "./types";
import {
  formatValue,
  NOT_PARSED,
  parseError,
  parseText,
  parseTsv,
  shortParseError,
  toTsv,
  UndoStack,
  valuesEqual,
} from "./values";

describe("shortParseError (the mark on a cell keeping a draft it can't store)", () => {
  const short = (c: Column<unknown>, text: string) => shortParseError(parseError(c, text) ?? "");
  it("says why in the column's terms, without the echoed text or the example", () => {
    expect(short(col("number"), "12 apples")).toBe("Not a number");
    expect(short(col("measurement"), "abc")).toBe("Not a length");
    expect(short(col("measurement"), "-3")).toBe("Lengths can't be negative");
    expect(short(col("measurement"), "12 apples")).toBe("Unknown unit");
    expect(short(col("pixelsize"), "big")).toBe("Not a pixel size");
    expect(short(col("select", { title: "Kind", options: [] }), "zzz")).toBe("Not a valid Kind");
    const tc = col("text", { parse: (t) => parseTimecode(t) ?? { value: "" } });
    expect(short(tc, "soon")).toBe("Not a timecode");
  });
});

const col = (
  type: Column<unknown>["type"],
  extra: Partial<Column<unknown>> = {},
): Column<unknown> => ({
  key: "k",
  title: "K",
  type,
  getValue: () => null,
  ...extra,
});

describe("TSV", () => {
  it("round-trips fields with tabs, quotes and newlines", () => {
    const grid = [
      ["plain", 'say "hi"', "two\nlines"],
      ["a\tb", "", "end"],
    ];
    expect(parseTsv(toTsv(grid))).toEqual(grid);
  });
  it("parses spreadsheet output with CRLF and a trailing newline", () => {
    expect(parseTsv("a\tb\r\nc\td\r\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });
});

describe("parseText", () => {
  it("parses numbers, rejecting junk", () => {
    expect(parseText(col("number"), " 1,234.5 ")).toBe(1234.5);
    expect(parseText(col("number"), "")).toBeNull();
    expect(parseText(col("number"), "abc")).toBe(NOT_PARSED);
  });
  it("matches select options by value or label, case-insensitively", () => {
    const c = col("select", { options: [{ value: "CUED", label: "Cued" }, { value: "x" }] });
    expect(parseText(c, "cued")).toBe("CUED");
    expect(parseText(c, "X")).toBe("x");
    expect(parseText(c, "nope")).toBe(NOT_PARSED);
  });
  it("doesn't parse into link or checkbox columns", () => {
    expect(parseText(col("link"), "a")).toBe(NOT_PARSED);
    expect(parseText(col("checkbox"), "true")).toBe(NOT_PARSED);
  });
});

describe("formatValue / valuesEqual", () => {
  it("formats option labels and link labels", () => {
    const c = col("multiselect", { options: [{ value: "a", label: "Alpha" }] });
    expect(formatValue(c, ["a", "b"])).toBe("Alpha, b");
    expect(formatValue(col("multilink"), [{ id: "1", label: "One" }])).toBe("One");
  });
  it("treats blank values as equal and compares links by id", () => {
    expect(valuesEqual(null, "")).toBe(true);
    expect(valuesEqual({ id: "1", label: "a" }, { id: "1", label: "b" })).toBe(true);
    expect(valuesEqual(["a"], ["a", "b"])).toBe(false);
  });
});

describe("UndoStack", () => {
  it("undoes batches in reverse and redoes them", () => {
    const u = new UndoStack();
    u.push([{ rowId: "r", key: "a", before: 1, after: 2 }]);
    u.push([
      { rowId: "r", key: "a", before: 2, after: 3 },
      { rowId: "r", key: "b", before: "x", after: "y" },
    ]);
    expect(u.undo()).toEqual([
      { rowId: "r", key: "b", value: "x", expect: "y" },
      { rowId: "r", key: "a", value: 2, expect: 3 },
    ]);
    expect(u.undo()).toEqual([{ rowId: "r", key: "a", value: 1, expect: 2 }]);
    expect(u.undo()).toBeNull();
    expect(u.redo()).toEqual([{ rowId: "r", key: "a", value: 2, expect: 1 }]);
    // A new edit clears the redo stack.
    u.push([{ rowId: "r", key: "c", before: 0, after: 1 }]);
    expect(u.canRedo).toBe(false);
  });
});
