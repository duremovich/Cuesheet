// Pure selectors over the show state for table views: scene grouping, reverse links, and a
// per-row view cache so derived row objects (a cue plus its linked content labels, ...)
// keep their identity while their inputs don't change. The DataGrid memoizes rows on the
// row object, so identity = "doesn't re-render".
import type { SceneRow } from "../../shared/tables";

/** Group id the grids use for rows without a (known) scene. Maps to `scene_id = null`. */
export const UNASSIGNED = "__unassigned__";

export interface SceneGroup<R> {
  /** Scene id, or UNASSIGNED. */
  id: string;
  scene: SceneRow | null;
  rows: R[];
}

/**
 * Rows (already in show order) grouped by scene: Unassigned first, then every scene in show
 * order (empty scenes included, so you can add to them). Rows whose scene no longer exists
 * count as Unassigned. The Unassigned group is included when it has rows, or when
 * `keepUnassigned` is set (e.g. a show with no scenes still needs somewhere to add a cue).
 */
export function groupByScene<R>(
  scenes: readonly SceneRow[],
  rows: readonly R[],
  sceneOf: (r: R) => string | null,
  opts: { keepUnassigned?: boolean } = {},
): SceneGroup<R>[] {
  const known = new Set(scenes.map((s) => s.id));
  const by = new Map<string, R[]>();
  for (const r of rows) {
    const s = sceneOf(r);
    const key = s && known.has(s) ? s : UNASSIGNED;
    let list = by.get(key);
    if (!list) {
      list = [];
      by.set(key, list);
    }
    list.push(r);
  }
  const out: SceneGroup<R>[] = [];
  const unassigned = by.get(UNASSIGNED) ?? [];
  if (unassigned.length > 0 || opts.keepUnassigned) {
    out.push({ id: UNASSIGNED, scene: null, rows: unassigned });
  }
  for (const scene of scenes) out.push({ id: scene.id, scene, rows: by.get(scene.id) ?? [] });
  return out;
}

/** "105 Scene Five: Backstage"; "Unassigned" for null. */
export function sceneTitle(scene: SceneRow | null | undefined): string {
  if (!scene) return "Unassigned";
  return [scene.number, scene.name].filter(Boolean).join(" ") || "Untitled scene";
}

/** `scene_id` for a group id (UNASSIGNED → null). */
export function sceneIdForGroup(groupId: string | undefined): string | null | undefined {
  if (groupId === undefined) return undefined;
  return groupId === UNASSIGNED ? null : groupId;
}

/** Invert a join (from → targets) into target → froms, keeping from-order. */
export function reverseJoin(join: ReadonlyMap<string, readonly string[]>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [from, targets] of join) {
    for (const t of targets) {
      const list = out.get(t);
      if (list) list.push(from);
      else out.set(t, [from]);
    }
  }
  return out;
}

function shallowEqual(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Caches one derived object per row id, rebuilt only when its dependency list changes
 * (compared element by element with ===). Use one cache per table view; call `pass` each
 * time the view is recomputed so entries for rows that disappeared are dropped.
 */
export class ViewCache<V> {
  private entries = new Map<string, { deps: readonly unknown[]; view: V }>();

  pass<T>(fn: (get: (id: string, deps: readonly unknown[], build: () => V) => V) => T): T {
    const next = new Map<string, { deps: readonly unknown[]; view: V }>();
    const get = (id: string, deps: readonly unknown[], build: () => V): V => {
      const hit = next.get(id) ?? this.entries.get(id);
      if (hit && shallowEqual(hit.deps, deps)) {
        next.set(id, hit);
        return hit.view;
      }
      const view = build();
      next.set(id, { deps, view });
      return view;
    };
    const out = fn(get);
    this.entries = next;
    return out;
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Returns `prev` when `next` has the same entries (by ===), so memo consumers stay stable. */
export function stableMap<K, V>(prev: Map<K, V> | undefined, next: Map<K, V>, eq = Object.is) {
  if (!prev || prev.size !== next.size) return next;
  for (const [k, v] of next) {
    if (!prev.has(k) || !eq(prev.get(k) as V, v)) return next;
  }
  return prev;
}
