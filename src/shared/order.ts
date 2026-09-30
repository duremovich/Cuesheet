// Show-order keys (docs/decisions/0003-row-order-fractional-index.md). The server and the
// client compute keys with this same function so optimistic inserts land where the server
// will put them. Keys compare as plain strings (byte order), never with localeCompare.
import { generateKeyBetween } from "fractional-indexing";
import type { Placement } from "./ops";

export interface Keyed {
  id: string;
  order_key: string;
}

/** Sort comparator for show order: order_key, then id (ids are time-ordered). */
export function compareOrder(a: Keyed, b: Keyed): number {
  if (a.order_key !== b.order_key) return a.order_key < b.order_key ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export class PlacementError extends Error {}

/**
 * Where a *create* actually goes when its neighbour no longer exists (e.g. another user
 * deleted it just before our batch arrived): a missing `after` falls back to `before` if
 * that still exists, then to the end of the new row's scene (`sceneId`, for cues and
 * content: right after the last row with the same scene_id), then to the end of the table.
 * A missing `before` falls back the same way. Placements that resolve are returned as is.
 */
export function effectivePlacement(
  rows: readonly (Keyed & { scene_id?: string | null })[],
  placement: Placement,
  sceneId?: string | null,
): Placement {
  const exists = (id: string | null | undefined) =>
    id === undefined || id === null || rows.some((r) => r.id === id);
  const { after, before } = placement;
  if (exists(after) && exists(before)) return placement;
  if (after != null && exists(after)) return { after };
  if (before != null && exists(before)) return { before };
  if (sceneId !== undefined) {
    const last = rows.findLast((r) => (r.scene_id ?? null) === (sceneId ?? null));
    if (last) return { after: last.id };
  }
  return {};
}

/**
 * The key for a row placed per `placement` among `rows` (in show order). `excludeId` is the
 * row being moved, which doesn't count as its own neighbour. Keys already in use are never
 * returned, so the server never gives two rows the same key. Two users inserting "after X"
 * at the same moment both keep their rows: the server applies them in turn, and the later
 * one gets a key between X and the earlier one, so it lands directly after X, before the
 * earlier insert.
 */
export function orderKeyFor(
  rows: readonly Keyed[],
  placement: Placement,
  excludeId?: string,
): string {
  const list = excludeId ? rows.filter((r) => r.id !== excludeId) : rows;
  const { after, before } = placement;
  let lo: string | null;
  let hi: string | null;
  if (after !== undefined && after !== null) {
    const i = list.findIndex((r) => r.id === after);
    if (i < 0) throw new PlacementError(`after: no row ${after}`);
    lo = list[i]?.order_key ?? null;
    hi = nextDistinctKey(list, i);
    if (before !== undefined && before !== null) {
      // Both given: honour `before` too when it really is further down.
      const j = list.findIndex((r) => r.id === before);
      if (j < 0) throw new PlacementError(`before: no row ${before}`);
      const b = list[j]?.order_key ?? null;
      if (b !== null && lo !== null && b > lo && (hi === null || b < hi)) hi = b;
    }
  } else if (after === null) {
    lo = null;
    hi = list[0]?.order_key ?? null;
  } else if (before !== undefined && before !== null) {
    const j = list.findIndex((r) => r.id === before);
    if (j < 0) throw new PlacementError(`before: no row ${before}`);
    hi = list[j]?.order_key ?? null;
    lo = prevDistinctKey(list, j);
  } else {
    lo = list.at(-1)?.order_key ?? null;
    hi = null;
  }
  return generateKeyBetween(lo, hi);
}

function nextDistinctKey(list: readonly Keyed[], i: number): string | null {
  const key = list[i]?.order_key;
  for (let k = i + 1; k < list.length; k++) {
    const next = list[k]?.order_key;
    if (next !== undefined && next !== key) return next;
  }
  return null;
}

function prevDistinctKey(list: readonly Keyed[], j: number): string | null {
  const key = list[j]?.order_key;
  for (let k = j - 1; k >= 0; k--) {
    const prev = list[k]?.order_key;
    if (prev !== undefined && prev !== key) return prev;
  }
  return null;
}

/** `n` increasing keys after `lastKey` (for bulk appends such as import). */
export function keysAfter(lastKey: string | null, n: number): string[] {
  const out: string[] = [];
  let prev = lastKey;
  for (let i = 0; i < n; i++) {
    prev = generateKeyBetween(prev, null);
    out.push(prev);
  }
  return out;
}
