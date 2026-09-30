// Cue rows as the grid sees them: the stored row plus its links resolved to labels, grouped
// by scene. Built with a ViewCache so a cue's view object only changes when the cue, its
// link lists or the linked records change (the grid re-renders exactly those rows).

import type { CueRow, SceneRow } from "../../../shared/tables";
import type { Group, PickerItem } from "../../components/grid/types";
import { groupByScene, sceneTitle, UNASSIGNED, type ViewCache } from "../../lib/show-selectors";
import type { ShowData } from "../../lib/show-state";
import { contentItem, personItem, sceneItem } from "../shared/pickers";

export interface CueView {
  id: string;
  cue: CueRow;
  scene: PickerItem | null;
  content: PickerItem[];
  assignees: PickerItem[];
}

const NONE: string[] = [];

export function buildCueViews(data: ShowData, cache: ViewCache<CueView>): CueView[] {
  const { tables, order, joins } = data;
  return cache.pass((get) =>
    order.cues.flatMap((id) => {
      const cue = tables.cues.get(id);
      if (!cue) return [];
      const contentIds = joins.cueContent.get(id) ?? NONE;
      const personIds = joins.cueAssignees.get(id) ?? NONE;
      const content = contentIds.map((c) => tables.content.get(c));
      const persons = personIds.map((p) => tables.persons.get(p));
      const scene = cue.scene_id ? tables.scenes.get(cue.scene_id) : undefined;
      // Linked content labels include their scene, so content's scenes are deps too.
      const contentScenes = content.map((c) =>
        c?.scene_id ? tables.scenes.get(c.scene_id) : null,
      );
      return [
        get(
          id,
          [cue, scene, contentIds, personIds, ...content, ...contentScenes, ...persons],
          () => ({
            id,
            cue,
            scene: scene ? sceneItem(scene) : null,
            content: content.flatMap((c) => (c ? [contentItem(c, tables.scenes)] : [])),
            assignees: persons.flatMap((p) => (p ? [personItem(p)] : [])),
          }),
        ),
      ];
    }),
  );
}

/** Open (not Done) notes per scene: by the note's scene, or the scenes of its cues. */
export function openNotesByScene(data: ShowData): Map<string, number> {
  const out = new Map<string, number>();
  for (const note of data.tables.notes.values()) {
    if (note.status === "Done") continue;
    const scenes = new Set<string>();
    if (note.scene_id) scenes.add(note.scene_id);
    for (const cueId of data.joins.noteCues.get(note.id) ?? []) {
      const s = data.tables.cues.get(cueId)?.scene_id;
      if (s) scenes.add(s);
    }
    for (const s of scenes) out.set(s, (out.get(s) ?? 0) + 1);
  }
  return out;
}

function groupSubtitle(scene: SceneRow, showAct: boolean, openNotes: number): string | undefined {
  const parts = [
    showAct ? scene.act : null,
    scene.song,
    openNotes ? `${openNotes} open ${openNotes === 1 ? "note" : "notes"}` : null,
  ].filter((p): p is string => !!p?.trim());
  return parts.length ? parts.join(" · ") : undefined;
}

/**
 * Grid groups: Unassigned first (always present, so an empty show has somewhere to add a
 * cue), then scenes in show order. When any scene has an act, the act leads the subtitle
 * (the grid has one grouping level; see open-questions.md).
 */
export function cueGroups(
  scenes: readonly SceneRow[],
  views: readonly CueView[],
  openNotes: ReadonlyMap<string, number>,
): Group<CueView>[] {
  const showAct = scenes.some((s) => !!s.act);
  return groupByScene(scenes, views, (v) => v.cue.scene_id, { keepUnassigned: true }).map((g) => {
    const subtitle = g.scene
      ? groupSubtitle(g.scene, showAct, openNotes.get(g.id) ?? 0)
      : "Cues with no scene";
    return {
      id: g.id,
      title: g.id === UNASSIGNED ? "Unassigned" : sceneTitle(g.scene),
      ...(subtitle ? { subtitle } : {}),
      rows: g.rows,
    };
  });
}
