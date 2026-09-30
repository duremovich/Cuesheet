// Shot list columns (R14; data-model.md §ShotList and Shot), in display order, and how an
// edit becomes ops. Shots group by `group` (a scene or setup, free text).
import type { Op } from "../../../shared/ops";
import type { AttachmentRow, FieldOptions, ShotRow } from "../../../shared/tables";
import type { PixelSize } from "../../../shared/units";
import type { PickerItem } from "../../components/grid/types";
import type { ShowStore } from "../../lib/show-store";
import { attachmentColumn } from "../attachments/Attachments";
import { selectOptions } from "../cues/columns";
import { parseDuration } from "../custom/values";
import { linkDiffOps, textField } from "../shared/ops";
import { createContent, createPerson, searchContent, searchPersons } from "../shared/pickers";
import type { FieldDef } from "../views/evaluate";

export interface ShotView {
  id: string;
  shot: ShotRow;
  talent: PickerItem[];
  content: PickerItem[];
  /** Reference images (`reference` attachments). */
  files: AttachmentRow[];
}

const TEXT = ["number", "group", "description", "camera", "lens", "duration"] as const;

export function shotColumns(opts: {
  store: ShowStore;
  fieldOptions: FieldOptions;
  editable: boolean;
  showId: string;
}): FieldDef<ShotView>[] {
  const { store } = opts;
  const text = (key: (typeof TEXT)[number]) => (v: ShotView) => v.shot[key] ?? "";
  const cols: FieldDef<ShotView>[] = [
    {
      key: "number",
      title: "Shot",
      type: "text",
      width: 70,
      frozen: true,
      getValue: text("number"),
    },
    {
      key: "group",
      title: "Group",
      type: "text",
      width: 140,
      groupable: true,
      getValue: text("group"),
    },
    {
      key: "description",
      title: "Description",
      type: "longtext",
      width: 260,
      getValue: text("description"),
    },
    attachmentColumn<ShotView>({
      table: "shots",
      field: "reference",
      title: "Reference",
      width: 120,
      showId: opts.showId,
      files: (v) => v.files,
      recordId: (v) => v.id,
      editable: opts.editable,
    }),
    {
      key: "framing",
      title: "Framing",
      type: "select",
      width: 100,
      options: selectOptions(opts.fieldOptions, "shots.framing"),
      getValue: (v) => v.shot.framing,
    },
    { key: "camera", title: "Camera", type: "text", width: 110, getValue: text("camera") },
    { key: "lens", title: "Lens", type: "text", width: 90, getValue: text("lens") },
    {
      key: "resolution",
      title: "Resolution",
      type: "pixelsize",
      width: 120,
      getValue: (v): PixelSize | null => v.shot.resolution,
    },
    {
      key: "frame_rate",
      title: "fps",
      type: "number",
      width: 70,
      getValue: (v) => v.shot.frame_rate,
    },
    {
      key: "duration",
      title: "Duration",
      type: "text",
      width: 100,
      getValue: text("duration"),
      parse: (t) => parseDuration(t) ?? { value: "" },
    },
    {
      key: "status",
      title: "Status",
      type: "select",
      width: 110,
      options: selectOptions(opts.fieldOptions, "shots.status"),
      getValue: (v) => v.shot.status,
    },
    {
      key: "talent",
      title: "Talent",
      type: "multilink",
      width: 170,
      getValue: (v) => v.talent,
      search: (q) => searchPersons(store.getState(), q),
      create: (name) => createPerson(store, name),
    },
    {
      key: "content",
      title: "Content",
      type: "multilink",
      width: 200,
      getValue: (v) => v.content,
      search: (q) => searchContent(store.getState(), q, null),
      create: (name) => createContent(store, name, null),
    },
  ];
  return opts.editable ? cols : cols.map((c) => ({ ...c, editable: false }));
}

export function shotEditOps(v: ShotView, key: string, value: unknown): Op[] {
  const id = v.id;
  if ((TEXT as readonly string[]).includes(key)) {
    return [{ op: "update", table: "shots", id, fields: { [key]: textField(value) } }];
  }
  switch (key) {
    case "framing":
    case "status":
      return [
        { op: "update", table: "shots", id, fields: { [key]: (value as string | null) ?? null } },
      ];
    case "resolution":
      return [{ op: "update", table: "shots", id, fields: { resolution: value ?? null } }];
    case "frame_rate":
      return [
        {
          op: "update",
          table: "shots",
          id,
          fields: { frame_rate: typeof value === "number" ? value : null },
        },
      ];
    case "talent":
    case "content": {
      const current = (key === "talent" ? v.talent : v.content).map((p) => p.id);
      const next = ((value as { id: string }[] | null) ?? []).map((p) => p.id);
      return linkDiffOps("shots", id, key, current, next);
    }
    default:
      return [];
  }
}
