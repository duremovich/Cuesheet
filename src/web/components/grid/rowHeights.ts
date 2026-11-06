// Row heights. Fixed modes ("compact" / "normal" / "tall") give every row the same height;
// "auto" (fit to content, the default) lets a row grow to show its cells' text wrapped, up
// to AUTO_MAX_LINES lines. Auto rows are measured in the DOM (the virtualizer's
// measureElement); the estimates here only place rows that haven't been rendered yet, so
// the scrollbar and jumps to far rows land close before the measurement corrects them.

import type { Column, PickerItem, RowHeight } from "./types";
import { formatValue } from "./values";

export type FixedRowHeight = Exclude<RowHeight, "auto">;

export const ROW_HEIGHTS: Record<FixedRowHeight, number> = { compact: 30, normal: 40, tall: 72 };

/** Body line height (DataGrid.module.css `.root`). */
export const LINE_HEIGHT = 18;
/** Auto rows: cell padding above / below the text, plus the 1 px bottom border. */
export const AUTO_PAD_TOP = 10;
export const AUTO_PAD_BOTTOM = 11;
export const AUTO_BORDER = 1;
/** A one-line auto row is as tall as a "normal" fixed row. */
export const AUTO_MIN_HEIGHT = AUTO_PAD_TOP + LINE_HEIGHT + AUTO_PAD_BOTTOM + AUTO_BORDER;
/** A cell shows at most this many lines (then an ellipsis; the row panel has the rest). */
export const AUTO_MAX_LINES = 12;
/** The tallest an auto row gets from text. */
export const AUTO_MAX_HEIGHT = AUTO_MAX_LINES * LINE_HEIGHT + AUTO_MIN_HEIGHT - LINE_HEIGHT;
/** While editing, the editor grows to this many lines, then scrolls inside. */
export const EDIT_MAX_LINES = 20;

/** Horizontal cell padding (8 px each side) and the right border. */
const CELL_INSET_X = 17;
/** Average glyph width of 13 px UI text; a slight overestimate, measurement corrects it. */
const CHAR_PX = 7;
/** Chips: 12 px text, 8 px padding each side, 4 px gap, 20 px tall (lines 4 px apart). */
const CHIP_CHAR_PX = 6.5;
const CHIP_PAD_PX = 16;
const CHIP_GAP = 4;
const CHIP_LINE = 20;

/** Wrapped lines for `text` in a cell of `width` px (newlines kept, as `pre-line` does). */
export function estimateLines(text: string, width: number): number {
  if (!text) return 1;
  const perLine = Math.max(1, Math.floor((width - CELL_INSET_X) / CHAR_PX));
  let lines = 0;
  for (const para of text.split("\n")) {
    const len = para.trim().length;
    lines += Math.max(1, Math.ceil(len / perLine));
    if (lines >= AUTO_MAX_LINES) return AUTO_MAX_LINES;
  }
  return Math.max(1, lines);
}

/** Lines of chips with these labels, wrapped in a cell of `width` px. */
export function estimateChipLines(labels: string[], width: number): number {
  if (labels.length === 0) return 1;
  const room = Math.max(1, width - CELL_INSET_X);
  let lines = 1;
  let used = 0;
  for (const label of labels) {
    const w = Math.min(room, label.length * CHIP_CHAR_PX + CHIP_PAD_PX);
    if (used > 0 && used + CHIP_GAP + w > room) {
      lines++;
      used = w;
    } else used += (used > 0 ? CHIP_GAP : 0) + w;
  }
  return lines;
}

/** Content height (px) of one cell in an auto row. */
function cellContentHeight<Row>(col: Column<Row>, row: Row, width: number): number {
  switch (col.type) {
    case "text":
      if (col.masked) return LINE_HEIGHT;
      return estimateLines(formatValue(col, col.getValue(row)), width) * LINE_HEIGHT;
    case "longtext":
      return estimateLines(formatValue(col, col.getValue(row)), width) * LINE_HEIGHT;
    case "multiselect":
    case "multilink": {
      const v = col.getValue(row);
      const list = Array.isArray(v) ? v : [];
      const labels = list.map((x) =>
        typeof x === "string"
          ? (col.options?.find((o) => o.value === x)?.label ?? x)
          : (x as PickerItem).label,
      );
      const lines = estimateChipLines(labels, width);
      // Chips sit in an 18 px line (a -1 px margin each side), so one line is LINE_HEIGHT.
      return lines * CHIP_LINE + (lines - 1) * CHIP_GAP - 2;
    }
    default:
      return LINE_HEIGHT;
  }
}

/**
 * The estimated height of an auto row: its tallest cell, at least AUTO_MIN_HEIGHT, at most
 * AUTO_MAX_HEIGHT (chips aside, which aren't clamped).
 */
export function estimateRowHeight<Row>(
  row: Row,
  cols: readonly { col: Column<Row>; width: number }[],
): number {
  let content = LINE_HEIGHT;
  for (const c of cols) {
    const h = cellContentHeight(c.col, row, c.width);
    if (h > content) content = h;
  }
  const h = content + AUTO_PAD_TOP + AUTO_PAD_BOTTOM + AUTO_BORDER;
  return Math.max(AUTO_MIN_HEIGHT, h);
}

/**
 * Where the grid should scroll (a new scrollTop) so an editor whose box is `editor` stays in
 * the visible part of the scroller (`viewTop`..`viewBottom`, in the same coordinates), or
 * null when no scroll is needed. Only a bottom edge past the view's bottom scrolls: with the
 * caret at the end (where you type) the bottom wins over the top; otherwise the editor's top
 * stays in view.
 */
export function editorScrollTarget(
  scrollTop: number,
  editor: { top: number; bottom: number },
  view: { top: number; bottom: number },
  caretAtEnd: boolean,
): number | null {
  if (editor.bottom <= view.bottom) return null;
  const below = editor.bottom - view.bottom;
  const room = Math.max(0, editor.top - view.top);
  const by = caretAtEnd ? below : Math.min(below, room);
  return by > 0 ? scrollTop + by : null;
}
