import Papa from "papaparse";
import { describe, expect, it } from "vitest";
import { csvField, csvFileName, excelSafe, toCsv } from "./csv";

describe("CSV writer", () => {
  it("quotes only what needs quoting, doubling quotes", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("line 1\nline 2")).toBe('"line 1\nline 2"');
    expect(csvField("cr\r")).toBe('"cr\r"');
    expect(csvField(" padded ")).toBe('" padded "');
    expect(csvField("")).toBe("");
  });

  it("CRLF rows, optional BOM, unicode kept", () => {
    const rows = [
      ["Cue", "Description"],
      ["14.20", "Sweet Sue — “needs a sax”, 🎷"],
      ["8.5A", 'multi\nline "quoted"'],
    ];
    const text = toCsv(rows);
    expect(text).toBe(
      'Cue,Description\r\n14.20,"Sweet Sue — “needs a sax”, 🎷"\r\n8.5A,"multi\nline ""quoted"""\r\n',
    );
    expect(toCsv(rows, { bom: true }).charCodeAt(0)).toBe(0xfeff);
    // Round-trips through a real CSV parser.
    const parsed = Papa.parse<string[]>(text, { skipEmptyLines: true }).data;
    expect(parsed).toEqual(rows);
  });

  it("empty input and file names", () => {
    expect(toCsv([])).toBe("");
    expect(toCsv([], { bom: true })).toBe("﻿");
    expect(csvFileName("Cues", "All cues")).toBe("Cues - All cues.csv");
    expect(csvFileName("A/B: c?")).toBe("A B c.csv");
    expect(csvFileName("", null)).toBe("export.csv");
  });

  it("Excel-safe: formula-like cells get a leading quote; numbers don't", () => {
    expect(excelSafe('=HYPERLINK("x")')).toBe('\'=HYPERLINK("x")');
    expect(excelSafe("+1 555")).toBe("'+1 555");
    expect(excelSafe("-- cue")).toBe("'-- cue");
    expect(excelSafe("@sum")).toBe("'@sum");
    expect(excelSafe("-2.5")).toBe("-2.5");
    expect(excelSafe("a=b")).toBe("a=b");
    expect(toCsv([["=1+1", "ok"]], { excelSafe: true })).toBe("'=1+1,ok\r\n");
    expect(toCsv([["=1+1"]])).toBe("=1+1\r\n");
  });
});
