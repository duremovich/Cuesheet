// The cue marks of the PDF page view (pure): which anchors are drawn on which page and
// how (underlined quote or positional tick + label), and where their margin entries and
// leader lines go at a given zoom.
import type { CueRow } from "../../../../shared/tables";
import type { CueAnchorRow, ScriptText } from "../contract";
import { otherDeptLabels } from "../Marker";
import { isPositionalCue, NEEDS_LOOK } from "../markers";
import { type AnchorGeom, anchorGeom, type GlyphMap, type Measure, type PageGeom } from "./pdfMap";
import { layoutMargin, leaderLabel } from "./pdfMargin";

export interface PageMark {
  anchor: CueAnchorRow;
  cue: CueRow;
  /** LX / timecode / visual…: a tick at the line and a label on the leader, no underline. */
  positional: boolean;
  geom: AnchorGeom;
  /** The positional cue's leader label ("" for quoted text). */
  label: string;
  /** Other departments' numbers (the LX/SQ toggle). */
  others: string[];
  /** Changed in this version, or its text no longer matches the quote. */
  warn: boolean;
}

/**
 * Marks per page for the placed anchors given (already filtered), in reading order (ties
 * in show order). Placed anchors whose block couldn't be found in the PDF are `unlocated`
 * (listed beside the pages instead).
 */
export function buildMarks(opts: {
  anchors: readonly CueAnchorRow[];
  cues: ReadonlyMap<string, CueRow>;
  text: ScriptText;
  map: GlyphMap;
  geomOf: (page: number) => PageGeom | undefined;
  measure?: Measure;
  showOthers?: boolean;
}): { byPage: Map<number, PageMark[]>; unlocated: CueAnchorRow[] } {
  const byPage = new Map<number, PageMark[]>();
  const unlocated: CueAnchorRow[] = [];
  for (const a of opts.anchors) {
    const cue = opts.cues.get(a.cue_id);
    if (!cue || a.block < 0 || a.state === "missing") continue;
    const geom = anchorGeom(opts.map, opts.text, a, opts.geomOf, opts.measure);
    if (!geom) {
      unlocated.push(a);
      continue;
    }
    const positional = isPositionalCue(cue);
    const mark: PageMark = {
      anchor: a,
      cue,
      positional,
      geom,
      label: positional ? leaderLabel(cue, a.quote) : "",
      others: opts.showOthers ? otherDeptLabels(cue) : [],
      warn: NEEDS_LOOK.includes(a.state) || geom.stale,
    };
    const list = byPage.get(geom.page);
    if (list) list.push(mark);
    else byPage.set(geom.page, [mark]);
  }
  for (const list of byPage.values()) {
    list.sort(
      (x, y) =>
        x.geom.start.y - y.geom.start.y ||
        x.geom.start.x - y.geom.start.x ||
        (x.cue.order_key < y.cue.order_key ? -1 : x.cue.order_key > y.cue.order_key ? 1 : 0),
    );
  }
  return { byPage, unlocated };
}

/** Margin entry metrics, px. */
export const ENTRY_HEIGHT = 20;
/** The leader's height inside an entry (the label sits on it). */
export const ENTRY_LINE = 15;
export const ENTRY_GAP = 2;

export interface MarkLayout {
  key: string;
  /** Entry top in the margin, px from the page top. */
  top: number;
  /** Where the leader leaves the page: x, y in px (the underline's end, or the GO line). */
  fromX: number;
  fromY: number;
  /** The leader's height in the margin (`top + ENTRY_LINE`). */
  lineY: number;
}

/** Where a mark's leader starts on the page, in points. */
export function leaderStart(m: PageMark): { x: number; y: number } {
  const first = m.geom.segs[0];
  if (!m.positional && first) return { x: first.x1, y: first.y + first.size * 0.2 };
  const s = m.geom.start;
  // A positional cue's line runs just above its line, between it and the one before.
  return { x: Math.max(0, s.x - 3), y: Math.max(1, s.y - s.size * 0.95) };
}

/** Entries beside a page at `scale` (px per point), stacked without overlaps. */
export function layoutMarks(
  marks: readonly PageMark[],
  scale: number,
  pageHeight: number,
): Map<string, MarkLayout> {
  const starts = marks.map((m) => leaderStart(m));
  const tops = layoutMargin(
    marks.map((m, i) => ({
      key: m.anchor.id,
      want: (starts[i]?.y ?? 0) * scale - ENTRY_LINE,
      height: ENTRY_HEIGHT,
    })),
    { gap: ENTRY_GAP, min: 0, max: pageHeight * scale },
  );
  const out = new Map<string, MarkLayout>();
  marks.forEach((m, i) => {
    const top = tops.get(m.anchor.id) ?? 0;
    const s = starts[i] ?? { x: 0, y: 0 };
    out.set(m.anchor.id, {
      key: m.anchor.id,
      top,
      fromX: s.x * scale,
      fromY: s.y * scale,
      lineY: top + ENTRY_LINE,
    });
  });
  return out;
}
