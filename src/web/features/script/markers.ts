// Cue markers in the script margin (ux.md §Script view): what a marker says, which anchors
// are shown where, the stacking math, and splitting a block's text around quoted lines.
// Pure; the reader (Reader.tsx) measures the DOM and calls these.
import type { CueRow } from "../../../shared/tables";
import type { CellDecoration } from "../../components/grid/types";
import {
  type Anchor,
  type AnchorState,
  anchorPosition,
  type CueAnchorRow,
  type ScriptBlock,
  type ScriptText,
} from "./contract";

/** Height of one marker in the margin, px (fixed, so layout is arithmetic). */
export const MARKER_HEIGHT = 44;
/** Height of a faint other-department marker (LX / SQ), px. */
export const FAINT_HEIGHT = 20;
/** Vertical gap between stacked markers, px. */
export const MARKER_GAP = 4;

/**
 * The trigger badge: `LINE`, `LX 117`, `SQ 12`, `TC 1:00:00`, `VISUAL`, `FOLLOW`,
 * `MANUAL`; empty when the cue has no trigger type.
 */
export function triggerBadge(cue: CueRow): string {
  const v = (s: string | null | undefined) => s?.trim() ?? "";
  switch (cue.trigger_type) {
    case "Line":
      return "LINE";
    case "LX":
      return `LX ${v(cue.lx_cue) || v(cue.trigger_value)}`.trim();
    case "SQ":
      return `SQ ${v(cue.sq_cue) || v(cue.trigger_value)}`.trim();
    case "Timecode":
      return `TC ${v(cue.timecode) || v(cue.trigger_value)}`.trim();
    case "Visual":
      return "VISUAL";
    case "Follow":
      return "FOLLOW";
    case "Manual":
      return "MANUAL";
    default:
      return cue.trigger_type ? cue.trigger_type.toUpperCase() : "";
  }
}

/**
 * The marker's text: a Line cue's trigger text, a Visual cue's description of the visual,
 * else the cue's description.
 */
export function markerText(cue: CueRow): string {
  const tv = cue.trigger_value?.trim();
  const desc = cue.description?.trim() ?? "";
  if (cue.trigger_type === "Line") return tv ? `“${tv}”` : desc;
  if (cue.trigger_type === "Visual") return tv || desc;
  return desc;
}

/**
 * A cue anchored at a position (LX / timecode / visual…: a tick at its line) rather than
 * on quoted text (Line cues, and cues with no trigger type, are underlined).
 */
export function isPositionalCue(cue: CueRow | undefined): boolean {
  return !!cue?.trigger_type && cue.trigger_type !== "Line";
}

/** A range of one block's text to underline, tagged with its anchor id. */
export interface QuoteRange {
  id: string;
  start: number;
  end: number;
}

/**
 * Per block, the ranges to underline for `anchors` in `text` (a quote may run across
 * blocks: the engine's `anchorPosition` splits it). Anchors outside the text are skipped.
 */
export function quoteRanges(
  text: ScriptText,
  anchors: readonly (Anchor & { id: string })[],
): Map<number, QuoteRange[]> {
  const out = new Map<number, QuoteRange[]>();
  for (const a of anchors) {
    if (a.block < 0 || a.length <= 0) continue;
    const span = anchorPosition(text, a);
    for (const s of span?.segments ?? []) {
      if (s.end <= s.start) continue;
      const list = out.get(s.block);
      const r = { id: a.id, start: s.start, end: s.end };
      if (list) list.push(r);
      else out.set(s.block, [r]);
    }
  }
  return out;
}

/** "Q 14.22" (or "Q –" when unnumbered). */
export function cueLabel(cue: CueRow | undefined): string {
  const n = cue?.number?.trim();
  return n ? `Q ${n}` : "Q –";
}

export const NEEDS_LOOK: readonly AnchorState[] = ["changed", "missing"];

/** An anchor that has a place on its version's text (a `missing` one has none). */
export function isPlaced(a: CueAnchorRow): boolean {
  return a.state !== "missing" && a.block >= 0;
}

/** Anchors of one version whose cue still exists, in script order (block, offset). */
export function versionAnchors(
  anchors: ReadonlyMap<string, CueAnchorRow>,
  versionId: string | null,
  cues: ReadonlyMap<string, CueRow>,
): CueAnchorRow[] {
  if (!versionId) return [];
  return [...anchors.values()]
    .filter((a) => a.script_version_id === versionId && cues.has(a.cue_id))
    .sort(compareAnchors);
}

export function compareAnchors(
  a: { block: number; offset: number; id?: string },
  b: { block: number; offset: number; id?: string },
): number {
  return (
    a.block - b.block ||
    a.offset - b.offset ||
    ((a.id ?? "") < (b.id ?? "") ? -1 : (a.id ?? "") > (b.id ?? "") ? 1 : 0)
  );
}

/** Placed anchors by block, each list in offset order. */
export function anchorsByBlock(anchors: readonly CueAnchorRow[]): Map<number, CueAnchorRow[]> {
  const out = new Map<number, CueAnchorRow[]>();
  for (const a of anchors) {
    if (!isPlaced(a)) continue;
    const list = out.get(a.block);
    if (list) list.push(a);
    else out.set(a.block, [a]);
  }
  for (const list of out.values()) list.sort(compareAnchors);
  return out;
}

export interface StackItem {
  key: string;
  /** Where the item wants to be (its block's top), px from the page top. */
  top: number;
  height: number;
}

/**
 * Margin-note stacking: items keep their wanted top unless the previous item (in wanted
 * order; ties keep input order) would overlap, in which case they're pushed down just
 * below it. Returns each item's top, and the bottom of the last one.
 */
export function stackMarkers(
  items: readonly StackItem[],
  gap = MARKER_GAP,
): { tops: Map<string, number>; bottom: number } {
  const order = items.map((it, i) => ({ it, i })).sort((a, b) => a.it.top - b.it.top || a.i - b.i);
  const tops = new Map<string, number>();
  let bottom = Number.NEGATIVE_INFINITY;
  for (const { it } of order) {
    const top = Math.max(it.top, bottom === Number.NEGATIVE_INFINITY ? it.top : bottom + gap);
    tops.set(it.key, top);
    bottom = top + it.height;
  }
  return { tops, bottom: bottom === Number.NEGATIVE_INFINITY ? 0 : bottom };
}

export interface Segment {
  text: string;
  /** Ids (anchor ids) of the quotes covering this piece. */
  ids: string[];
}

/**
 * A block's text cut at quote boundaries, so each quoted range can be underlined
 * (overlapping quotes give pieces with several ids). Ranges outside the text are clamped;
 * empty ones ignored.
 */
export function segmentText(
  text: string,
  ranges: readonly { id: string; start: number; end: number }[],
): Segment[] {
  const clean = ranges
    .map((r) => ({
      id: r.id,
      start: Math.max(0, Math.min(r.start, text.length)),
      end: Math.max(0, Math.min(r.end, text.length)),
    }))
    .filter((r) => r.end > r.start);
  if (clean.length === 0) return text ? [{ text, ids: [] }] : [];
  const cuts = new Set<number>([0, text.length]);
  for (const r of clean) {
    cuts.add(r.start);
    cuts.add(r.end);
  }
  const points = [...cuts].sort((a, b) => a - b);
  const out: Segment[] = [];
  for (let k = 0; k < points.length - 1; k++) {
    const s = points[k] as number;
    const e = points[k + 1] as number;
    if (e <= s) continue;
    const ids = clean.filter((r) => r.start <= s && r.end >= e).map((r) => r.id);
    const prev = out.at(-1);
    if (prev && prev.ids.join() === ids.join()) prev.text += text.slice(s, e);
    else out.push({ text: text.slice(s, e), ids });
  }
  return out;
}

export interface PageBlocks {
  page: number;
  label: string;
  blocks: ScriptBlock[];
}

/** The text's pages with their blocks (pages without blocks included, in page order). */
export function pagesOf(text: ScriptText): PageBlocks[] {
  const byPage = new Map<number, ScriptBlock[]>();
  for (const b of text.blocks) {
    const list = byPage.get(b.page);
    if (list) list.push(b);
    else byPage.set(b.page, [b]);
  }
  const infos = [...text.pages];
  for (const p of byPage.keys()) {
    if (!infos.some((x) => x.page === p)) infos.push({ page: p, label: String(p) });
  }
  infos.sort((a, b) => a.page - b.page);
  return infos.map((p) => ({ page: p.page, label: p.label, blocks: byPage.get(p.page) ?? [] }));
}

/** Page index (into `pagesOf`) of a block. */
export function pageIndexOfBlock(pages: readonly PageBlocks[], block: number): number {
  return pages.findIndex((p) => p.blocks.some((b) => b.i === block));
}

/** The printed label of the page a block is on. */
export function pageLabelOf(text: ScriptText, block: number): string | null {
  const page = text.blocks[block]?.page;
  if (page === undefined) return null;
  return text.pages.find((p) => p.page === page)?.label ?? String(page);
}

/** Headings (for the navigator): block index, text and page label. */
export function headingsOf(text: ScriptText): { block: number; text: string; label: string }[] {
  return text.blocks
    .filter((b) => b.kind === "heading")
    .map((b) => ({ block: b.i, text: b.text, label: pageLabelOf(text, b.i) ?? "" }));
}

/** Find: blocks containing `query` (case-insensitive), in order. */
export function findBlocks(text: ScriptText, query: string): number[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return text.blocks.filter((b) => b.text.toLowerCase().includes(q)).map((b) => b.i);
}

/**
 * Cue list warnings (ux.md §New script version): cues whose anchor on the current version
 * is `changed` or `missing`, until resolved.
 */
export function anchorWarnings(
  anchors: ReadonlyMap<string, CueAnchorRow>,
  versionId: string | null,
): Map<string, CellDecoration> {
  const out = new Map<string, CellDecoration>();
  if (!versionId) return out;
  for (const a of anchors.values()) {
    if (a.script_version_id !== versionId) continue;
    if (a.state === "changed")
      out.set(a.cue_id, { warning: "The script line changed in the new version: check it" });
    else if (a.state === "missing")
      out.set(a.cue_id, { warning: "Not found in the new script version: place it" });
  }
  return out;
}

/** "g" go-to: the page index whose label matches (exact, then prefix; case-insensitive). */
export function findPage(pages: readonly PageBlocks[], label: string): number {
  const l = label.trim().toLowerCase();
  if (!l) return -1;
  const exact = pages.findIndex((p) => p.label.toLowerCase() === l);
  if (exact >= 0) return exact;
  return pages.findIndex((p) => p.label.toLowerCase().startsWith(l));
}
