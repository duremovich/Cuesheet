// Cue rows as the grid sees them: the stored row plus its links resolved to labels, grouped
// by scene. Built with a ViewCache so a cue's view object only changes when the cue, its
// link lists or the linked records change (the grid re-renders exactly those rows).

import { thumbnailUrl } from "../../../shared/attachments";
import type { CueRow, SceneRow } from "../../../shared/tables";
import { sortRows } from "../../components/grid/ordering";
import type { Column, Group, PickerItem, SortSpec } from "../../components/grid/types";
import { groupByScene, sceneTitle, UNASSIGNED, type ViewCache } from "../../lib/show-selectors";
import type { ShowData } from "../../lib/show-state";
import { thumbnailOf } from "../attachments/selectors";
import { currentVersions } from "../content/versions";
import { contentItem, personItem, sceneItem } from "../shared/pickers";

export interface CueView {
  id: string;
  cue: CueRow;
  scene: PickerItem | null;
  content: PickerItem[];
  assignees: PickerItem[];
}

const NONE: string[] = [];

/**
 * With `showId`, content chips carry the content's current version ("· V03") and a tiny
 * thumbnail (its first image).
 */
export function buildCueViews(
  data: ShowData,
  cache: ViewCache<CueView>,
  showId?: string,
): CueView[] {
  const { tables, order, joins } = data;
  const versions = currentVersions(tables.content_versions);
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
      // Chips show the current version and thumbnail, so those are deps too.
      const extras = showId
        ? content.flatMap((c) =>
            c ? [versions.get(c.id), thumbnailOf(tables.attachments, "content", c.id)] : [],
          )
        : [];
      return [
        get(
          id,
          [cue, scene, contentIds, personIds, ...content, ...contentScenes, ...persons, ...extras],
          () => ({
            id,
            cue,
            scene: scene ? sceneItem(scene) : null,
            content: content.flatMap((c) => {
              if (!c) return [];
              const item = contentItem(c, tables.scenes);
              if (!showId) return [item];
              const version = versions.get(c.id)?.version?.trim();
              const thumb = thumbnailOf(tables.attachments, "content", c.id);
              return [
                {
                  ...item,
                  ...(version ? { badge: version } : {}),
                  ...(thumb ? { thumb: thumbnailUrl(showId, thumb.id) } : {}),
                },
              ];
            }),
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

/** Open (not Done) notes linked to each cue (the "Open notes" view field). */
export function openNotesByCue(data: Pick<ShowData, "tables" | "joins">): Map<string, number> {
  const out = new Map<string, number>();
  for (const note of data.tables.notes.values()) {
    if (note.status === "Done") continue;
    for (const cueId of data.joins.noteCues.get(note.id) ?? []) {
      out.set(cueId, (out.get(cueId) ?? 0) + 1);
    }
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

/**
 * Every cue in the order number hints (ghost midpoint, duplicates) are computed over: all
 * groups in show order, each sorted when a live sort is on. Never the filtered display.
 */
export function hintOrder<R>(
  groups: readonly Group<R>[],
  sort: readonly SortSpec[] | undefined,
  columns: readonly Column<R>[],
): R[] {
  return groups.flatMap((g) =>
    sort && sort.length > 0 ? sortRows(g.rows, sort, columns) : g.rows,
  );
}
