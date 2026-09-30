// "Sort now by cue number" (R2, ux.md §Ordering): rewrite show order to match cue numbers.
// A data-layer command: the plan is a list of `move` ops sent as one batch.

import type { MoveOp } from "../../../shared/ops";
import { compareValues } from "../../components/grid/ordering";

export interface SortableCue {
  id: string;
  number: string | null;
  is_section: boolean;
}

export interface SortNowPlan {
  /** Ids in the new show order. */
  order: string[];
  /** Moves that produce `order` when applied in sequence (empty: already sorted). */
  ops: MoveOp[];
  /** Cues without a number; they go last, in their current relative order. */
  unnumbered: number;
}

/**
 * The target order: numbered cues by number (decimals numerically, 14.2 < 14.25 < 14.3;
 * other text in natural order; ties keep show order), then unnumbered cues in show order.
 * A section row (divider) stays directly above the numbered cue that followed it; a
 * section with no numbered cue after it stays at the end.
 *
 * The ops move each row that isn't already in place **to the end of the table**, in target
 * order, after the longest prefix that's already right. Appending gives short, evenly
 * spaced order keys (it doubles as a rebalance, decision 0003), and each move is a single
 * row's key, so the batch replays like any other on every client.
 */
export function planSortNow(cues: readonly SortableCue[]): SortNowPlan {
  const numbered: { cue: SortableCue; i: number }[] = [];
  const unnumbered: SortableCue[] = [];
  const sectionsBefore = new Map<string, SortableCue[]>();
  const trailing: SortableCue[] = [];
  let pendingSections: SortableCue[] = [];
  cues.forEach((cue, i) => {
    if (cue.is_section) {
      pendingSections.push(cue);
      return;
    }
    if (cue.number?.trim()) {
      numbered.push({ cue, i });
      if (pendingSections.length) {
        sectionsBefore.set(cue.id, pendingSections);
        pendingSections = [];
      }
    } else unnumbered.push(cue);
  });
  trailing.push(...pendingSections);
  numbered.sort((x, y) => compareValues(x.cue.number?.trim(), y.cue.number?.trim()) || x.i - y.i);
  const order: string[] = [];
  for (const { cue } of numbered) {
    for (const s of sectionsBefore.get(cue.id) ?? []) order.push(s.id);
    order.push(cue.id);
  }
  for (const c of unnumbered) order.push(c.id);
  for (const s of trailing) order.push(s.id);

  let prefix = 0;
  while (prefix < order.length && order[prefix] === cues[prefix]?.id) prefix++;
  const ops: MoveOp[] =
    prefix === order.length
      ? []
      : order.slice(prefix).map((id) => ({ op: "move", table: "cues", id }));
  return { order, ops, unnumbered: unnumbered.length };
}
