// Tech mode's compact cue list (R7): rows grouped by scene with small headers, the cue
// order used by ↓/↑, and "go to cue" lookup. Pure, so it's unit-tested.
import type { CueRow, SceneRow } from "../../../shared/tables";
import { groupByScene, sceneTitle } from "../../lib/show-selectors";
import { cueNumberKey } from "../cues/cueNumbers";
import { findCue } from "../notes/compose";

export type TechRow =
  | { kind: "scene"; key: string; title: string; openNotes: number }
  | { kind: "section"; key: string; label: string }
  | { kind: "cue"; key: string; cue: CueRow };

/** Header / section / cue rows in show order, grouped like the cue list (Unassigned first). */
export function techRows(
  scenes: readonly SceneRow[],
  cues: readonly CueRow[],
  openNotesByScene: ReadonlyMap<string, number> = new Map(),
): TechRow[] {
  const out: TechRow[] = [];
  for (const g of groupByScene(scenes, cues, (c) => c.scene_id)) {
    if (g.rows.length === 0) continue;
    out.push({
      kind: "scene",
      key: `scene:${g.id}`,
      title: sceneTitle(g.scene),
      openNotes: openNotesByScene.get(g.id) ?? 0,
    });
    for (const c of g.rows) {
      out.push(
        c.is_section
          ? { kind: "section", key: c.id, label: c.description ?? "" }
          : { kind: "cue", key: c.id, cue: c },
      );
    }
  }
  return out;
}

/** The cue ids ↓/↑ step through (display order, sections skipped). */
export function navOrder(rows: readonly TechRow[]): string[] {
  return rows.flatMap((r) => (r.kind === "cue" ? [r.cue.id] : []));
}

/** The cue `delta` steps from `current` (clamped at the ends; no current: the first). */
export function stepCue(order: readonly string[], current: string | null, delta: number) {
  if (order.length === 0) return null;
  const i = current ? order.indexOf(current) : -1;
  if (i < 0) return order[0] as string;
  return order[Math.max(0, Math.min(order.length - 1, i + delta))] as string;
}

/**
 * ⌘G "go to cue": the cue whose number equals what was typed (14.2 = 14.20; nearest to
 * the current cue when numbers repeat), else the first whose number starts with it.
 */
export function goToCue(
  cues: readonly CueRow[],
  typed: string,
  currentId: string | null,
): CueRow | undefined {
  const q = typed.trim();
  if (!q) return undefined;
  const exact = findCue(cues, q, currentId);
  if (exact) return exact;
  const lower = q.toLowerCase();
  return cues.find(
    (c) =>
      !c.is_section &&
      c.number &&
      (c.number.toLowerCase().startsWith(lower) || cueNumberKey(c.number) === cueNumberKey(q)),
  );
}
