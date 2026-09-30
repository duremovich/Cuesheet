// Cue list columns (data-model.md §Cue), in display order, and how an edit becomes ops.

import type { Op } from "../../../shared/ops";
import type { FieldOptions } from "../../../shared/tables";
import type { Column, SelectOption } from "../../components/grid/types";
import type { ShowStore } from "../../lib/show-store";
import { linkDiffOps, textField } from "../shared/ops";
import {
  createContent,
  createPerson,
  createScene,
  searchContent,
  searchPersons,
  searchScenes,
} from "../shared/pickers";
import type { CueView } from "./cueViews";

/** Text fields: column key = storage field. */
const TEXT = [
  "number",
  "description",
  "trigger_value",
  "sm_call",
  "lx_cue",
  "sq_cue",
  "timecode",
  "ae_time",
  "measure",
  "page",
] as const;

export function selectOptions(options: FieldOptions, key: `${string}.${string}`): SelectOption[] {
  return (options[key as keyof FieldOptions] ?? []).map((o) => ({
    value: o.value,
    color: o.color,
  }));
}

export function cueColumns(opts: {
  store: ShowStore;
  fieldOptions: FieldOptions;
  editable: boolean;
}): Column<CueView>[] {
  const { store, editable } = opts;
  const text = (key: (typeof TEXT)[number]) => (v: CueView) => v.cue[key] ?? "";
  const cols: Column<CueView>[] = [
    {
      key: "number",
      title: "Cue",
      type: "text",
      width: 76,
      frozen: true,
      getValue: text("number"),
    },
    {
      key: "description",
      title: "Description",
      type: "longtext",
      width: 260,
      getValue: text("description"),
    },
    {
      key: "trigger_type",
      title: "Trigger",
      type: "select",
      width: 110,
      options: selectOptions(opts.fieldOptions, "cues.trigger_type"),
      getValue: (v) => v.cue.trigger_type,
    },
    {
      key: "trigger_value",
      title: "Trigger value",
      type: "text",
      width: 150,
      getValue: text("trigger_value"),
    },
    { key: "sm_call", title: "SM call", type: "longtext", width: 240, getValue: text("sm_call") },
    { key: "lx_cue", title: "LX", type: "text", width: 70, getValue: text("lx_cue") },
    { key: "sq_cue", title: "SQ", type: "text", width: 70, getValue: text("sq_cue") },
    { key: "timecode", title: "Timecode", type: "text", width: 110, getValue: text("timecode") },
    { key: "ae_time", title: "AE time", type: "text", width: 100, getValue: text("ae_time") },
    { key: "measure", title: "MSR", type: "text", width: 70, getValue: text("measure") },
    { key: "page", title: "Page", type: "text", width: 64, getValue: text("page") },
    {
      key: "status",
      title: "Status",
      type: "select",
      width: 130,
      options: selectOptions(opts.fieldOptions, "cues.status"),
      getValue: (v) => v.cue.status,
    },
    {
      key: "assignees",
      title: "Assignees",
      type: "multilink",
      width: 170,
      getValue: (v) => v.assignees,
      search: (q) => searchPersons(store.getState(), q),
      create: (name) => createPerson(store, name),
    },
    {
      key: "content",
      title: "Content",
      type: "multilink",
      width: 240,
      getValue: (v) => v.content,
      search: (q, v) => searchContent(store.getState(), q, v.cue.scene_id),
      create: (name, v) => createContent(store, name, v.cue.scene_id),
    },
    {
      key: "scene",
      title: "Scene",
      type: "link",
      width: 220,
      getValue: (v) => v.scene,
      search: (q) => searchScenes(store.getState(), q),
      create: (name) => createScene(store, name),
    },
  ];
  return editable ? cols : cols.map((c) => ({ ...c, editable: false }));
}

/** The ops for a grid edit on a cue (`value` in the column's value shape). */
export function cueEditOps(view: CueView, key: string, value: unknown): Op[] {
  const id = view.id;
  if ((TEXT as readonly string[]).includes(key)) {
    return [{ op: "update", table: "cues", id, fields: { [key]: textField(value) } }];
  }
  switch (key) {
    case "trigger_type":
    case "status":
      return [
        { op: "update", table: "cues", id, fields: { [key]: (value as string | null) ?? null } },
      ];
    case "scene":
      return [
        {
          op: "update",
          table: "cues",
          id,
          fields: { scene_id: (value as { id: string } | null)?.id ?? null },
        },
      ];
    case "assignees":
    case "content": {
      const current = (key === "content" ? view.content : view.assignees).map((p) => p.id);
      const next = ((value as { id: string }[] | null) ?? []).map((p) => p.id);
      return linkDiffOps("cues", id, key, current, next);
    }
    default:
      return [];
  }
}
