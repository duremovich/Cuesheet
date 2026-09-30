// Turning DataGrid callbacks into show ops (decision 0006). Pure, so the table views stay
// thin and this is unit-tested.

import type { Op, Placement } from "../../../shared/ops";
import type { TableName } from "../../../shared/tables";
import type { InsertPosition } from "../../components/grid/types";

/** Text cells: "" (cleared) is stored as null. */
export function textField(v: unknown): string | null {
  if (typeof v !== "string") return v == null ? null : String(v);
  return v.trim() === "" ? null : v;
}

/**
 * link/unlink ops that turn the link list `current` into `next` (both in chip order):
 * removed targets are unlinked, added ones linked at their position. A pure reorder of
 * the same targets relinks the ones that moved.
 */
export function linkDiffOps(
  table: TableName,
  id: string,
  field: string,
  current: readonly string[],
  next: readonly string[],
): Op[] {
  const ops: Op[] = [];
  const keep = new Set(next);
  const kept = current.filter((t) => keep.has(t));
  for (const t of current)
    if (!keep.has(t)) ops.push({ op: "unlink", table, id, field, targetId: t });
  // Unlink any kept target that is out of place relative to `next`'s order of kept targets.
  const nextKept = next.filter((t) => kept.includes(t));
  const moved = new Set<string>();
  const remaining = [...kept];
  for (let i = 0; i < nextKept.length; i++) {
    const want = nextKept[i] as string;
    if (remaining[0] === want) {
      remaining.shift();
      continue;
    }
    moved.add(want);
    remaining.splice(remaining.indexOf(want), 1);
    ops.push({ op: "unlink", table, id, field, targetId: want });
  }
  const had = new Set(current);
  next.forEach((t, position) => {
    if (!had.has(t) || moved.has(t))
      ops.push({ op: "link", table, id, field, targetId: t, position });
  });
  return ops;
}

/** Each group's row ids, for `placementFor`. */
export function groupOrder(
  groups: readonly { id: string; rows: readonly { id: string }[] }[],
): { id: string; rowIds: string[] }[] {
  return groups.map((g) => ({ id: g.id, rowIds: g.rows.map((r) => r.id) }));
}

/**
 * Placement for a create/move from the grid's display neighbours. With only a group (a
 * group's "+ Add row", or a drop onto a collapsed/empty group) the row goes after the
 * last row of that group in show order; for an empty group, after the last row of the
 * nearest earlier group that has rows, else before the first row of a later one, else at
 * the end. `groupsInOrder` lists each group's row ids in show order (display order of the
 * groups). `excludeId` is the row being moved (it isn't its own neighbour).
 */
export function placementFor(
  pos: InsertPosition,
  groupsInOrder?: readonly { id: string; rowIds: readonly string[] }[],
  excludeId?: string,
): Placement {
  if (pos.afterRowId !== undefined && pos.afterRowId !== excludeId)
    return { after: pos.afterRowId };
  if (pos.beforeRowId !== undefined && pos.beforeRowId !== excludeId) {
    return { before: pos.beforeRowId };
  }
  if (pos.groupId === undefined || !groupsInOrder) return {};
  const ids = (g: { rowIds: readonly string[] }) => g.rowIds.filter((r) => r !== excludeId);
  const at = groupsInOrder.findIndex((g) => g.id === pos.groupId);
  if (at < 0) return {};
  for (let i = at; i >= 0; i--) {
    const last = ids(groupsInOrder[i] as { rowIds: readonly string[] }).at(-1);
    if (last) return { after: last };
  }
  for (let i = at + 1; i < groupsInOrder.length; i++) {
    const first = ids(groupsInOrder[i] as { rowIds: readonly string[] })[0];
    if (first) return { before: first };
  }
  return {};
}
