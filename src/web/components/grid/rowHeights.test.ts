import { describe, expect, it } from "vitest";
import {
  AUTO_MAX_HEIGHT,
  AUTO_MAX_LINES,
  AUTO_MIN_HEIGHT,
  editorScrollTarget,
  estimateChipLines,
  estimateLines,
  estimateRowHeight,
  LINE_HEIGHT,
  ROW_HEIGHTS,
} from "./rowHeights";
import type { Column } from "./types";

type R = { body: string; title: string; tags: string[]; n: number | null };
const body: Column<R> = { key: "body", title: "Note", type: "longtext", getValue: (r) => r.body };
const title: Column<R> = { key: "title", title: "Title", type: "text", getValue: (r) => r.title };
const tags: Column<R> = {
  key: "tags",
  title: "Tags",
  type: "multiselect",
  options: [{ value: "a", label: "Programming" }],
  getValue: (r) => r.tags,
};
const n: Column<R> = { key: "n", title: "N", type: "number", getValue: (r) => r.n };
const row = (p: Partial<R> = {}): R => ({ body: "", title: "", tags: [], n: 1, ...p });

describe("row heights", () => {
  it("a one-line auto row is a normal fixed row", () => {
    expect(AUTO_MIN_HEIGHT).toBe(ROW_HEIGHTS.normal);
    expect(AUTO_MAX_HEIGHT).toBe(AUTO_MIN_HEIGHT + (AUTO_MAX_LINES - 1) * LINE_HEIGHT);
  });

  it("estimates wrapped lines from the text length and the cell width", () => {
    expect(estimateLines("", 300)).toBe(1);
    expect(estimateLines("short", 300)).toBe(1);
    // 300 px cell: (300 - 17) / 7 = 40 characters a line.
    expect(estimateLines("x".repeat(40), 300)).toBe(1);
    expect(estimateLines("x".repeat(41), 300)).toBe(2);
    expect(estimateLines("x".repeat(120), 300)).toBe(3);
    // Newlines start lines; an empty line still takes one.
    expect(estimateLines("a\nb\n\nc", 300)).toBe(4);
    // Narrower cell, more lines; capped.
    expect(estimateLines("x".repeat(120), 160)).toBeGreaterThan(3);
    expect(estimateLines("x".repeat(100_000), 300)).toBe(AUTO_MAX_LINES);
    expect(estimateLines("a\n".repeat(500), 300)).toBe(AUTO_MAX_LINES);
  });

  it("packs chips into lines", () => {
    expect(estimateChipLines([], 200)).toBe(1);
    expect(estimateChipLines(["Programming"], 200)).toBe(1);
    expect(estimateChipLines(["Programming", "Programming", "Programming"], 200)).toBe(2);
    // A chip wider than the cell is cut to it, one per line.
    expect(estimateChipLines(["x".repeat(200), "y".repeat(200)], 200)).toBe(2);
  });

  it("a row is as tall as its tallest cell, between the min and the cap", () => {
    const cols = [
      { col: body, width: 300 },
      { col: title, width: 160 },
      { col: tags, width: 200 },
      { col: n, width: 70 },
    ];
    expect(estimateRowHeight(row(), cols)).toBe(AUTO_MIN_HEIGHT);
    expect(estimateRowHeight(row({ body: "x".repeat(120) }), cols)).toBe(
      AUTO_MIN_HEIGHT + 2 * LINE_HEIGHT,
    );
    // The title wraps more than the body: it wins.
    const titled = estimateRowHeight(row({ body: "x".repeat(41), title: "y".repeat(100) }), cols);
    expect(titled).toBeGreaterThan(AUTO_MIN_HEIGHT + LINE_HEIGHT);
    expect(estimateRowHeight(row({ body: "x".repeat(50_000) }), cols)).toBe(AUTO_MAX_HEIGHT);
    // Two lines of chips: 20 + 4 + 20 in the cell (the first line counts as 18).
    expect(estimateRowHeight(row({ tags: ["a", "a", "a", "a"] }), cols)).toBe(AUTO_MIN_HEIGHT + 24);
    // Wider column, fewer lines.
    const wide = [{ col: body, width: 600 }];
    expect(estimateRowHeight(row({ body: "x".repeat(120) }), wide)).toBe(
      AUTO_MIN_HEIGHT + LINE_HEIGHT,
    );
  });

  it("masked text never wraps", () => {
    const secret: Column<R> = { ...title, masked: true };
    expect(estimateRowHeight(row({ title: "s".repeat(500) }), [{ col: secret, width: 100 }])).toBe(
      AUTO_MIN_HEIGHT,
    );
  });

  it("scrolls an editor's bottom into view, keeping its top unless the caret is at the end", () => {
    const view = { top: 74, bottom: 600 };
    // Inside the view: no scroll.
    expect(editorScrollTarget(100, { top: 200, bottom: 400 }, view, true)).toBeNull();
    // Grew past the bottom by 50: scroll 50 down.
    expect(editorScrollTarget(100, { top: 300, bottom: 650 }, view, true)).toBe(150);
    expect(editorScrollTarget(100, { top: 300, bottom: 650 }, view, false)).toBe(150);
    // Taller than the view: the caret (end) wins; elsewhere its top stays at the view top.
    expect(editorScrollTarget(100, { top: 100, bottom: 900 }, view, true)).toBe(400);
    expect(editorScrollTarget(100, { top: 100, bottom: 900 }, view, false)).toBe(126);
    // Its top is already at the view top and the caret is mid-text: nothing to gain.
    expect(editorScrollTarget(100, { top: 74, bottom: 900 }, view, false)).toBeNull();
  });
});
