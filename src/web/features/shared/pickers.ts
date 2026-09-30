// Find-or-create for link cells (R5a). Searches read the store's current state at call
// time, so column definitions don't depend on the data; creates go through `mutate`.

import { newId } from "../../../shared/ids";
import type { ContentRow, CueRow, PersonRow, SceneRow } from "../../../shared/tables";
import type { PickerItem } from "../../components/grid/types";
import { sceneTitle } from "../../lib/show-selectors";
import type { ShowData } from "../../lib/show-state";
import type { ShowStore } from "../../lib/show-store";
import { prefixedContentName } from "../content/contentName";
import { rankItems } from "./search";

const LIMIT = 50;

export function sceneItem(s: SceneRow): PickerItem {
  return { id: s.id, label: sceneTitle(s), ...(s.song ? { secondary: s.song } : {}) };
}

export function contentItem(c: ContentRow, scenes: ShowData["tables"]["scenes"]): PickerItem {
  const scene = c.scene_id ? scenes.get(c.scene_id) : undefined;
  return {
    id: c.id,
    label: c.name?.trim() || "(unnamed content)",
    ...(scene ? { secondary: sceneTitle(scene) } : {}),
  };
}

export function personItem(p: PersonRow): PickerItem {
  return {
    id: p.id,
    label: p.name?.trim() || "(no name)",
    ...(p.role ? { secondary: p.role } : {}),
  };
}

export function cueItem(c: CueRow): PickerItem {
  const num = c.number?.trim();
  const desc = c.description?.trim();
  return {
    id: c.id,
    label: num ? num : desc ? desc.slice(0, 40) : "(unnumbered cue)",
    ...(num && desc ? { secondary: desc.slice(0, 60) } : {}),
  };
}

const ordered = <T>(ids: readonly string[], map: ReadonlyMap<string, T>): T[] =>
  ids.map((id) => map.get(id)).filter((x): x is T => x !== undefined);

/** Content by name and description; same scene first (R5a). */
export function searchContent(data: ShowData, q: string, sceneId: string | null): PickerItem[] {
  const all = ordered(data.order.content, data.tables.content);
  return rankItems(all, q, (c) => [c.name, c.description], {
    boost: (c) => sceneId !== null && c.scene_id === sceneId,
    limit: LIMIT,
  }).map((c) => contentItem(c, data.tables.scenes));
}

export function searchPersons(data: ShowData, q: string): PickerItem[] {
  const all = [...data.tables.persons.values()].sort((a, b) =>
    (a.name ?? "").localeCompare(b.name ?? ""),
  );
  return rankItems(all, q, (p) => [p.name, p.role], { limit: LIMIT }).map(personItem);
}

export function searchScenes(data: ShowData, q: string): PickerItem[] {
  const all = ordered(data.order.scenes, data.tables.scenes);
  return rankItems(all, q, (s) => [sceneTitle(s), s.song], { limit: LIMIT }).map(sceneItem);
}

export function searchCues(data: ShowData, q: string, sceneId: string | null): PickerItem[] {
  const all = ordered(data.order.cues, data.tables.cues).filter((c) => !c.is_section);
  return rankItems(all, q, (c) => [c.number, c.description], {
    boost: (c) => sceneId !== null && c.scene_id === sceneId,
    limit: LIMIT,
  }).map(cueItem);
}

/**
 * New content from a picker: in `sceneId`, named with the scene's `SSS-NNN-` prefix unless
 * the typed name has one, placed after the scene's last content item.
 */
export async function createContent(
  store: ShowStore,
  typed: string,
  sceneId: string | null,
): Promise<PickerItem> {
  const data = store.getState();
  const scene = sceneId ? data.tables.scenes.get(sceneId) : undefined;
  const name = prefixedContentName(
    typed,
    scene?.number,
    [...data.tables.content.values()].map((c) => c.name),
  );
  const id = newId();
  const lastInScene = ordered(data.order.content, data.tables.content)
    .filter((c) => (c.scene_id ?? null) === (sceneId ?? null))
    .at(-1);
  await store.mutate([
    {
      op: "create",
      table: "content",
      id,
      fields: { name, scene_id: scene ? scene.id : null },
      ...(lastInScene ? { after: lastInScene.id } : {}),
    },
  ]);
  const row = store.getState().tables.content.get(id);
  return row ? contentItem(row, store.getState().tables.scenes) : { id, label: name };
}

export async function createPerson(store: ShowStore, typed: string): Promise<PickerItem> {
  const id = newId();
  await store.mutate([{ op: "create", table: "persons", id, fields: { name: typed.trim() } }]);
  return { id, label: typed.trim() };
}
