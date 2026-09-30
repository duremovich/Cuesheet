// Placing cues in the script (ux.md §Placing cues): the nearest anchored cues around a
// position (script order), the number suggestion between them, and the op batches for a
// new cue, attaching an existing cue and dragging a marker. Pure.
import type { Op } from "../../../shared/ops";
import type { CueRow } from "../../../shared/tables";
import { suggestCueNumber } from "../cues/cueNumbers";
import { textField } from "../shared/ops";
import type { Anchor, CueAnchorRow, ScriptText } from "./contract";
import { makeAnchor, makePositionAnchor, SEPARATOR } from "./contract";
import { compareAnchors, isPlaced } from "./markers";
import type { AnchorOp } from "./source";

export interface Neighbours {
  before: CueRow | null;
  after: CueRow | null;
}

/**
 * The nearest anchored cues before and after `at` in script order, among `anchors` (one
 * version's). An anchor at exactly `at` counts as before. Sections, cues without a row and
 * `exclude` are skipped.
 */
export function scriptNeighbours(
  anchors: readonly CueAnchorRow[],
  cues: ReadonlyMap<string, CueRow>,
  at: { block: number; offset: number },
  exclude?: string,
): Neighbours {
  let before: CueRow | null = null;
  let after: CueRow | null = null;
  const sorted = anchors.filter(isPlaced).sort(compareAnchors);
  for (const a of sorted) {
    if (a.cue_id === exclude) continue;
    const cue = cues.get(a.cue_id);
    if (!cue || cue.is_section) continue;
    if (a.block < at.block || (a.block === at.block && a.offset <= at.offset)) before = cue;
    else if (!after) after = cue;
  }
  return { before, after };
}

/** The number suggestion between the neighbours (M1c midpoint), "" when there's none. */
export function suggestNumber(n: Neighbours): string {
  const prev = n.before?.number?.trim() || undefined;
  const next = n.after?.number?.trim() || undefined;
  if (n.before && !prev) return "";
  if (n.after && !next && !prev) return "";
  return suggestCueNumber(prev, n.after ? next : undefined) ?? "";
}

export interface NewCueInput {
  number: string;
  description: string;
  trigger_type: string | null;
  trigger_value: string;
}

export interface Batch {
  cueOps: Op[];
  anchorOps: AnchorOp[];
}

function anchorFields(
  cueId: string,
  versionId: string,
  anchor: Anchor,
): Extract<AnchorOp, { op: "create" }>["fields"] {
  return {
    cue_id: cueId,
    script_version_id: versionId,
    block: anchor.block,
    offset: anchor.offset,
    length: anchor.length,
    quote: anchor.quote,
    prefix: anchor.prefix,
    suffix: anchor.suffix,
    state: "manual",
    confidence: 1,
  };
}

/**
 * A new cue at `anchor`: in the scene of the cue before it (else after it), in show order
 * right after that cue (else right before the next one, else at the end), plus its anchor.
 */
export function newCueBatch(opts: {
  cueId: string;
  anchorId: string;
  versionId: string;
  anchor: Anchor;
  input: NewCueInput;
  neighbours: Neighbours;
}): Batch {
  const { before, after } = opts.neighbours;
  const placement = before ? { after: before.id } : after ? { before: after.id } : {};
  return {
    cueOps: [
      {
        op: "create",
        table: "cues",
        id: opts.cueId,
        fields: {
          scene_id: before?.scene_id ?? after?.scene_id ?? null,
          number: textField(opts.input.number),
          description: textField(opts.input.description),
          trigger_type: opts.input.trigger_type,
          trigger_value: textField(opts.input.trigger_value),
        },
        ...placement,
      },
    ],
    anchorOps: [
      {
        op: "create",
        id: opts.anchorId,
        fields: anchorFields(opts.cueId, opts.versionId, opts.anchor),
      },
    ],
  };
}

/**
 * Attach an existing cue at `anchor` (moving its anchor if it already has one on this
 * version). `positionTrigger` set = a margin click (a position), else a selection. A cue
 * without a trigger type takes `positionTrigger`, or Line + the quote.
 */
export function attachBatch(opts: {
  cue: CueRow;
  existing: CueAnchorRow | undefined;
  anchorId: string;
  versionId: string;
  anchor: Anchor;
  positionTrigger?: string | null;
}): Batch {
  const { cue, anchor } = opts;
  const cueOps: Op[] = [];
  if (!cue.trigger_type) {
    if (opts.positionTrigger) {
      cueOps.push({
        op: "update",
        table: "cues",
        id: cue.id,
        fields: { trigger_type: opts.positionTrigger },
      });
    } else {
      cueOps.push({
        op: "update",
        table: "cues",
        id: cue.id,
        fields: { trigger_type: "Line", trigger_value: cue.trigger_value ?? anchor.quote },
      });
    }
  }
  const fields = anchorFields(cue.id, opts.versionId, anchor);
  const anchorOps: AnchorOp[] = opts.existing
    ? [{ op: "update", id: opts.existing.id, fields }]
    : [{ op: "create", id: opts.anchorId, fields }];
  return { cueOps, anchorOps };
}

/**
 * A marker dragged onto `block`: a Line cue's quote stays a quote when that block contains
 * it (the first occurrence); otherwise (and for positional cues) the anchor becomes a
 * position at the block's start. State: manual.
 */
export function moveAnchorOp(
  row: CueAnchorRow,
  text: ScriptText,
  block: number,
  positional: boolean,
): AnchorOp {
  const target = text.blocks[block]?.text ?? "";
  const at = !positional && row.quote ? target.indexOf(row.quote) : -1;
  const a =
    at >= 0 ? makeAnchor(text, block, at, row.quote.length) : makePositionAnchor(text, block);
  return {
    op: "update",
    id: row.id,
    fields: {
      block: a.block,
      offset: a.offset,
      length: a.length,
      quote: a.quote,
      prefix: a.prefix,
      suffix: a.suffix,
      state: "manual",
      confidence: 1,
    },
  };
}

/**
 * Whether dragging this marker onto `block` needs a decision: a Line cue whose quote isn't
 * in that block would otherwise silently turn into a position (ux review: never convert
 * silently). Positional cues and blocks holding the quote move directly.
 */
export function moveNeedsChoice(
  row: CueAnchorRow,
  text: ScriptText,
  block: number,
  positional: boolean,
): boolean {
  if (positional) return false;
  const target = text.blocks[block]?.text ?? "";
  return !(row.quote && target.includes(row.quote));
}

function anchorUpdate(id: string, a: Anchor): AnchorOp {
  return {
    op: "update",
    id,
    fields: {
      block: a.block,
      offset: a.offset,
      length: a.length,
      quote: a.quote,
      prefix: a.prefix,
      suffix: a.suffix,
      state: "manual",
      confidence: 1,
    },
  };
}

/** "Make this a positional cue": the trigger type changes and the anchor is a position. */
export function moveAsPositionalBatch(
  row: CueAnchorRow,
  text: ScriptText,
  block: number,
  trigger: string,
): Batch {
  return {
    cueOps: [{ op: "update", table: "cues", id: row.cue_id, fields: { trigger_type: trigger } }],
    anchorOps: [anchorUpdate(row.id, makePositionAnchor(text, block))],
  };
}

/** "Re-anchor on this line": the whole line is the quote and the cue's trigger text. */
export function moveRequoteBatch(row: CueAnchorRow, text: ScriptText, block: number): Batch {
  const line = text.blocks[block]?.text ?? "";
  const a = makeAnchor(text, block, 0, line.length);
  return {
    cueOps: [
      {
        op: "update",
        table: "cues",
        id: row.cue_id,
        fields: { trigger_type: "Line", trigger_value: a.quote },
      },
    ],
    anchorOps: [anchorUpdate(row.id, a)],
  };
}

// ---- Selection → block span (DOM) ----

/** Characters of `container`'s text before (`node`, `offset`). */
export function textOffsetIn(container: Node, node: Node, offset: number): number {
  const range = container.ownerDocument?.createRange();
  if (!range) return 0;
  range.selectNodeContents(container);
  try {
    range.setEnd(node, offset);
  } catch {
    return 0;
  }
  return range.toString().length;
}

function textEl(node: Node): HTMLElement | null {
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  const block = el?.closest<HTMLElement>("[data-block]");
  return block?.querySelector<HTMLElement>("[data-text]") ?? null;
}

export interface Span {
  block: number;
  offset: number;
  /** Where the selection ends (the same block, or a later one: a quote over several lines). */
  endBlock: number;
  endOffset: number;
}

/**
 * The selected span in script text: start and end block with offsets in their texts
 * (a selection may run over several lines). Whitespace at either end is dropped; an end
 * outside script text (a badge) is the end of the start block. Null when it's not inside
 * script text or selects nothing.
 */
export function rangeToSpan(range: Range): Span | null {
  const startText = textEl(range.startContainer);
  if (!startText) return null;
  const block = Number(startText.closest<HTMLElement>("[data-block]")?.dataset.block);
  if (!Number.isInteger(block)) return null;
  const startFull = startText.textContent ?? "";
  let start = startText.contains(range.startContainer)
    ? textOffsetIn(startText, range.startContainer, range.startOffset)
    : 0;
  const endText = textEl(range.endContainer);
  let endBlock = block;
  let endFull = startFull;
  let end = startFull.length;
  if (endText?.contains(range.endContainer)) {
    const eb = Number(endText.closest<HTMLElement>("[data-block]")?.dataset.block);
    if (Number.isInteger(eb) && eb >= block) {
      endBlock = eb;
      endFull = endText.textContent ?? "";
      end = textOffsetIn(endText, range.endContainer, range.endOffset);
    }
  }
  while (start < startFull.length && /\s/.test(startFull[start] ?? "")) start++;
  while (end > 0 && /\s/.test(endFull[end - 1] ?? "")) end--;
  if (endBlock > block && end === 0) {
    // Ended at the very start of a later line: the quote ends with the line before.
    endBlock = block;
    end = startFull.length;
    while (end > start && /\s/.test(startFull[end - 1] ?? "")) end--;
  }
  if (endBlock === block && end <= start) return null;
  return { block, offset: start, endBlock, endOffset: end };
}

/** A span's length in the version's joined text (blocks joined by the engine's separator). */
export function spanLength(text: ScriptText, s: Span): number {
  if (s.endBlock === s.block) return s.endOffset - s.offset;
  let n = (text.blocks[s.block]?.text.length ?? 0) - s.offset;
  for (let b = s.block + 1; b < s.endBlock; b++) {
    n += SEPARATOR.length + (text.blocks[b]?.text.length ?? 0);
  }
  return n + SEPARATOR.length + s.endOffset;
}

/** The anchor for a selected span. */
export function spanAnchor(text: ScriptText, s: Span): Anchor {
  return makeAnchor(text, s.block, s.offset, spanLength(text, s));
}
