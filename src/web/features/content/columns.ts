// Content list columns (data-model.md §Content) and edit → ops.

import type { Op } from "../../../shared/ops";
import type { ContentRow, FieldOptions } from "../../../shared/tables";
import type { Column, PickerItem } from "../../components/grid/types";
import type { ShowStore } from "../../lib/show-store";
import { selectOptions } from "../cues/columns";
import { textField } from "../shared/ops";
import { createPerson, searchPersons, searchScenes } from "../shared/pickers";

export interface ContentView {
  id: string;
  content: ContentRow;
  scene: PickerItem | null;
  creator: PickerItem | null;
  cues: PickerItem[];
  noteCount: number;
}

const TEXT = ["name", "description", "loop_in", "loop_out"] as const;

export function contentColumns(opts: {
  store: ShowStore;
  fieldOptions: FieldOptions;
  editable: boolean;
}): Column<ContentView>[] {
  const { store } = opts;
  const text = (key: (typeof TEXT)[number]) => (v: ContentView) => v.content[key] ?? "";
  const cols: Column<ContentView>[] = [
    { key: "name", title: "Name", type: "text", width: 260, frozen: true, getValue: text("name") },
    {
      key: "scene",
      title: "Scene",
      type: "link",
      width: 220,
      getValue: (v) => v.scene,
      search: (q) => searchScenes(store.getState(), q),
    },
    {
      key: "status",
      title: "Status",
      type: "select",
      width: 130,
      options: selectOptions(opts.fieldOptions, "content.status"),
      getValue: (v) => v.content.status,
    },
    {
      key: "creator",
      title: "Creator",
      type: "link",
      width: 160,
      getValue: (v) => v.creator,
      search: (q) => searchPersons(store.getState(), q),
      create: (name) => createPerson(store, name),
    },
    {
      key: "description",
      title: "Description",
      type: "longtext",
      width: 260,
      getValue: text("description"),
    },
    { key: "loop_in", title: "Loop in", type: "text", width: 100, getValue: text("loop_in") },
    { key: "loop_out", title: "Loop out", type: "text", width: 100, getValue: text("loop_out") },
    {
      key: "cues",
      title: "Cues",
      type: "multilink",
      width: 180,
      editable: false,
      getValue: (v) => v.cues,
    },
    { key: "notes", title: "Notes", type: "readonly", width: 70, getValue: (v) => v.noteCount },
  ];
  return opts.editable ? cols : cols.map((c) => ({ ...c, editable: false }));
}

export function contentEditOps(view: ContentView, key: string, value: unknown): Op[] {
  const id = view.id;
  if ((TEXT as readonly string[]).includes(key)) {
    return [{ op: "update", table: "content", id, fields: { [key]: textField(value) } }];
  }
  const ref = (value as { id: string } | null)?.id ?? null;
  switch (key) {
    case "status":
      return [
        {
          op: "update",
          table: "content",
          id,
          fields: { status: (value as string | null) ?? null },
        },
      ];
    case "scene":
      return [{ op: "update", table: "content", id, fields: { scene_id: ref } }];
    case "creator":
      return [{ op: "update", table: "content", id, fields: { creator_id: ref } }];
    default:
      return [];
  }
}
