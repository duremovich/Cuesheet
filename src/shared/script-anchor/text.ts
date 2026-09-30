// A version's text as one string ("joined text"): block texts joined by a single space.
// Anchors are positions in it (block + offset, length possibly spanning blocks), so a
// quote survives a line being split or joined differently in the next version.
import {
  ANCHOR_CONTEXT,
  type Anchor,
  normalizeText,
  type ScriptBlock,
  type ScriptText,
} from "../script";

export const SEPARATOR = " ";

export interface Joined {
  text: string;
  /** Start of each block's text in `text`. */
  starts: number[];
  /** End (exclusive) of each block's text. */
  ends: number[];
  blocks: readonly ScriptBlock[];
  /** Page label per physical page. */
  labels: Map<number, string>;
}

const cache = new WeakMap<ScriptText, Joined>();

/** The joined text of a version (cached per ScriptText object). */
export function joinBlocks(text: ScriptText): Joined {
  const hit = cache.get(text);
  if (hit) return hit;
  const starts: number[] = [];
  const ends: number[] = [];
  const parts: string[] = [];
  let pos = 0;
  text.blocks.forEach((b, i) => {
    if (i > 0) pos += SEPARATOR.length;
    starts.push(pos);
    pos += b.text.length;
    ends.push(pos);
    parts.push(b.text);
  });
  const joined: Joined = {
    text: parts.join(SEPARATOR),
    starts,
    ends,
    blocks: text.blocks,
    labels: new Map(text.pages.map((p) => [p.page, p.label])),
  };
  cache.set(text, joined);
  return joined;
}

/** Index of the block containing joined position `pos` (a separator counts to the block before). */
export function blockAt(j: Joined, pos: number): number {
  let lo = 0;
  let hi = j.starts.length - 1;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((j.starts[mid] as number) <= pos) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** The printed label of a block's page. */
export function pageLabel(j: Joined, block: number): string {
  const b = j.blocks[block];
  if (!b) return "";
  return j.labels.get(b.page) ?? String(b.page);
}

/** An anchor covering joined positions [start, end), with its quote and context. */
export function anchorAt(j: Joined, start: number, end: number): Anchor {
  let s = Math.max(0, Math.min(start, j.text.length));
  let block = blockAt(j, s);
  // A start on the separator after a block belongs to the next block.
  if (s >= (j.ends[block] as number) && block + 1 < j.starts.length) {
    block++;
    s = j.starts[block] as number;
  }
  const e = Math.max(s, Math.min(end, j.text.length));
  return {
    block,
    offset: s - (j.starts[block] as number),
    length: e - s,
    quote: j.text.slice(s, e),
    prefix: j.text.slice(Math.max(0, s - ANCHOR_CONTEXT), s),
    suffix: j.text.slice(e, e + ANCHOR_CONTEXT),
  };
}

/** Joined start position of an anchor, or null if its block/offset is outside the text. */
export function anchorStart(j: Joined, anchor: Pick<Anchor, "block" | "offset">): number | null {
  const start = j.starts[anchor.block];
  const end = j.ends[anchor.block];
  if (start === undefined || end === undefined) return null;
  if (!Number.isInteger(anchor.offset) || anchor.offset < 0 || start + anchor.offset > end) {
    return null;
  }
  return start + anchor.offset;
}

/**
 * An anchor on `length` characters from `offset` in `block` (a text selection), with quote
 * and context computed. Throws RangeError when the position is outside the text.
 */
export function makeAnchor(
  text: ScriptText,
  block: number,
  offset: number,
  length: number,
): Anchor {
  const j = joinBlocks(text);
  const start = anchorStart(j, { block, offset });
  if (start === null || !Number.isInteger(length) || length < 0) {
    throw new RangeError(`No text at block ${block}, offset ${offset}`);
  }
  return anchorAt(j, start, start + length);
}

/** Longest `quote` of a positional anchor (the nearest words). */
export const POSITION_QUOTE_MAX = 48;

/**
 * A positional anchor (LX / timecode / visual cue) at the start of `block`: its quote is
 * the block's first words (at most POSITION_QUOTE_MAX characters, cut at a word
 * boundary), used only for re-anchoring.
 */
export function makePositionAnchor(text: ScriptText, block: number): Anchor {
  const b = text.blocks[block];
  if (!b) throw new RangeError(`No block ${block}`);
  let n = Math.min(b.text.length, POSITION_QUOTE_MAX);
  if (n < b.text.length) {
    const cut = b.text.lastIndexOf(" ", n);
    if (cut > 0) n = cut;
  }
  return makeAnchor(text, block, 0, n);
}

export interface AnchorSpan {
  /** Joined positions. */
  start: number;
  end: number;
  /** Physical page of the start block. */
  page: number;
  label: string;
  /** Per block: the character range to underline in that block's text. */
  segments: { block: number; start: number; end: number }[];
  /** False when the text there no longer equals the anchor's quote. */
  exact: boolean;
}

/**
 * Where an anchor is in a version's text, split into per-block ranges for highlighting;
 * null when its block/offset is outside the text.
 */
export function anchorPosition(text: ScriptText, anchor: Anchor): AnchorSpan | null {
  const j = joinBlocks(text);
  const start = anchorStart(j, anchor);
  if (start === null) return null;
  const end = Math.min(j.text.length, start + Math.max(0, anchor.length));
  const segments: AnchorSpan["segments"] = [];
  for (let b = anchor.block; b < j.starts.length; b++) {
    const bs = j.starts[b] as number;
    const be = j.ends[b] as number;
    if (bs > end || (bs === end && end > start)) break;
    const s = Math.max(start, bs) - bs;
    const e = Math.min(end, be) - bs;
    if (e > s || (start === end && b === anchor.block))
      segments.push({ block: b, start: s, end: e });
    if (be >= end) break;
  }
  const block = j.blocks[anchor.block] as ScriptBlock;
  return {
    start,
    end,
    page: block.page,
    label: pageLabel(j, anchor.block),
    segments,
    exact: j.text.slice(start, end) === normalizeText(anchor.quote),
  };
}

/**
 * Where a positional cue with no anchor should go, from the anchors of its neighbours in
 * show order: the block after the previous cue's anchor (but not past the next cue's), else
 * the next cue's block, else the first block.
 */
export function suggestSlot(
  text: ScriptText,
  neighbours: { before?: Anchor | null; after?: Anchor | null },
): number {
  const j = joinBlocks(text);
  const last = j.starts.length - 1;
  if (last < 0) return 0;
  const endBlock = (a: Anchor) => {
    const s = anchorStart(j, a);
    return s === null ? null : blockAt(j, s + Math.max(0, a.length - 1));
  };
  const after = neighbours.after ? anchorStart(j, neighbours.after) : null;
  const afterBlock = after === null ? null : blockAt(j, after);
  if (neighbours.before) {
    const b = endBlock(neighbours.before);
    if (b !== null) {
      const next = Math.min(b + 1, last);
      return afterBlock !== null && next > afterBlock ? Math.max(b, afterBlock) : next;
    }
  }
  return afterBlock ?? 0;
}
