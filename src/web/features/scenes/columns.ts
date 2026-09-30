// Scene list columns (data-model.md §Scene) and edit → ops.

import type { Op } from "../../../shared/ops";
import type { FieldOptions, SceneRow } from "../../../shared/tables";
import type { Column, PickerItem } from "../../components/grid/types";
import type { ShowStore } from "../../lib/show-store";
import { selectOptions } from "../cues/columns";
import { textField } from "../shared/ops";
import { surfaceLinkColumn, surfaceLinkOps } from "../surfaces/columns";

export interface SceneView {
  id: string;
  scene: SceneRow;
  cueCount: number;
  contentCount: number;
  /** Linked surfaces (scenes.surfaces), in chip order. */
  surfaces: PickerItem[];
}

const TEXT = [
  "number",
  "name",
  "location",
  "time_of_day",
  "song",
  "description",
  "video_overview",
] as const;

export function sceneColumns(
  fieldOptions: FieldOptions,
  editable: boolean,
  store: ShowStore,
): Column<SceneView>[] {
  const text = (key: (typeof TEXT)[number]) => (v: SceneView) => v.scene[key] ?? "";
  const cols: Column<SceneView>[] = [
    {
      key: "number",
      title: "No.",
      type: "text",
      width: 70,
      frozen: true,
      getValue: text("number"),
    },
    { key: "name", title: "Name", type: "text", width: 280, getValue: text("name") },
    {
      key: "act",
      title: "Act",
      type: "select",
      width: 120,
      options: selectOptions(fieldOptions, "scenes.act"),
      getValue: (v) => v.scene.act,
    },
    { key: "location", title: "Location", type: "text", width: 180, getValue: text("location") },
    {
      key: "time_of_day",
      title: "Time of day",
      type: "text",
      width: 120,
      getValue: text("time_of_day"),
    },
    { key: "song", title: "Song", type: "text", width: 220, getValue: text("song") },
    {
      key: "description",
      title: "Description",
      type: "longtext",
      width: 260,
      getValue: text("description"),
    },
    {
      key: "video_overview",
      title: "Video overview",
      type: "longtext",
      width: 260,
      getValue: text("video_overview"),
    },
    { key: "cues", title: "Cues", type: "readonly", width: 70, getValue: (v) => v.cueCount },
    {
      key: "content_count",
      title: "Content",
      type: "readonly",
      width: 80,
      getValue: (v) => v.contentCount,
    },
    surfaceLinkColumn<SceneView>({ store, getValue: (v) => v.surfaces }),
  ];
  return editable ? cols : cols.map((c) => ({ ...c, editable: false }));
}

export function sceneEditOps(view: SceneView, key: string, value: unknown): Op[] {
  if ((TEXT as readonly string[]).includes(key)) {
    return [{ op: "update", table: "scenes", id: view.id, fields: { [key]: textField(value) } }];
  }
  if (key === "surfaces") {
    return surfaceLinkOps("scenes", view.id, view.surfaces, value as PickerItem[]);
  }
  if (key === "act") {
    return [
      {
        op: "update",
        table: "scenes",
        id: view.id,
        fields: { act: (value as string | null) ?? null },
      },
    ];
  }
  return [];
}
