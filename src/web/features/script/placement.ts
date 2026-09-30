// Placing cues in the script (ux.md §Placing cues): the nearest anchored cues around a
// position (script order), the number suggestion between them, and the op batches for a
// new cue, attaching an existing cue and dragging a marker. Pure.
import type { Op } from "../../../shared/ops";
import type { CueRow } from "../../../shared/tables";
import { suggestCueNumber } from "../cues/cueNumbers";
import { textField } from "../shared/ops";
import type { Anchor, CueAnchorRow, ScriptText } from "./contract";
import { makeAnchor } from "./contract";
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
 * version). A cue without a trigger type takes Line + the quote (selection) or
 * `positionTrigger` (margin click).
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
    if (anchor.length > 0) {
      cueOps.push({
        op: "update",
        table: "cues",
        id: cue.id,
        fields: { trigger_type: "Line", trigger_value: cue.trigger_value ?? anchor.quote },
      });
    } else if (opts.positionTrigger) {
      cueOps.push({
        op: "update",
        table: "cues",
        id: cue.id,
        fields: { trigger_type: opts.positionTrigger },
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
 * A marker dragged onto `block`: the quote stays a quote when that block contains it (the
 * first occurrence), else the anchor becomes a position at the block's start. State: manual.
 */
export function moveAnchorOp(row: CueAnchorRow, text: ScriptText, block: number): AnchorOp {
  const target = text.blocks[block]?.text ?? "";
  const at = row.length > 0 && row.quote ? target.indexOf(row.quote) : -1;
  const a = at >= 0 ? makeAnchor(text, block, at, row.quote.length) : makeAnchor(text, block, 0, 0);
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

/**
 * The selected span as `{block, offset, length}` in the block's text: a selection across
 * blocks is cut at the end of its first block; whitespace at either end is dropped. Null
 * when it's not inside script text or selects nothing.
 */
export function rangeToSpan(
  range: Range,
): { block: number; offset: number; length: number } | null {
  const startText = textEl(range.startContainer);
  if (!startText) return null;
  const blockEl = startText.closest<HTMLElement>("[data-block]");
  const block = Number(blockEl?.dataset.block);
  if (!Number.isInteger(block)) return null;
  const full = startText.textContent ?? "";
  const inStart = startText.contains(range.startContainer);
  let start = inStart ? textOffsetIn(startText, range.startContainer, range.startOffset) : 0;
  const endText = textEl(range.endContainer);
  let end =
    endText === startText && startText.contains(range.endContainer)
      ? textOffsetIn(startText, range.endContainer, range.endOffset)
      : full.length;
  while (start < end && /\s/.test(full[start] ?? "")) start++;
  while (end > start && /\s/.test(full[end - 1] ?? "")) end--;
  if (end <= start) return null;
  return { block, offset: start, length: end - start };
}
