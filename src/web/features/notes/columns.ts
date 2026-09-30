// Notes columns (data-model.md §Note), per-row editability (commenters: own notes only) and
// edit → ops.

import type { Op } from "../../../shared/ops";
import type { AttachmentRow, FieldOptions, NoteRow } from "../../../shared/tables";
import type { Column, PickerItem } from "../../components/grid/types";
import type { ShowStore } from "../../lib/show-store";
import { attachmentColumn } from "../attachments/Attachments";
import { selectOptions } from "../cues/columns";
import { linkDiffOps, textField } from "../shared/ops";
import {
  createPerson,
  createScene,
  searchContent,
  searchCues,
  searchPersons,
  searchScenes,
} from "../shared/pickers";

export interface NoteView {
  id: string;
  note: NoteRow;
  assignees: PickerItem[];
  cues: PickerItem[];
  content: PickerItem | null;
  scene: PickerItem | null;
  author: string;
  /** Can the current user edit this note? */
  editable: boolean;
  /** Photos and files (R13). */
  files: AttachmentRow[];
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function formatTimestamp(ms: unknown): string {
  return typeof ms === "number" && ms > 0 ? dateFormat.format(new Date(ms)) : "";
}

/**
 * Editors edit every note; commenters only notes they created (the server enforces it; the
 * grid shows others' notes read-only); viewers none.
 */
export function canEditNote(
  role: string,
  userId: string,
  note: Pick<NoteRow, "created_by">,
): boolean {
  if (role === "owner" || role === "editor") return true;
  return role === "commenter" && note.created_by === userId;
}

export function noteColumns(opts: {
  store: ShowStore;
  fieldOptions: FieldOptions;
  /** Editors may create people from the assignee picker. */
  canCreateRecords: boolean;
  /** For the attachment column's file URLs and uploads. */
  showId?: string;
}): Column<NoteView>[] {
  const { store } = opts;
  const editable = (v: NoteView) => v.editable;
  const sceneOf = (v: NoteView) => v.note.scene_id;
  return [
    {
      key: "body",
      title: "Note",
      type: "longtext",
      width: 340,
      editable,
      getValue: (v) => v.note.body ?? "",
    },
    attachmentColumn<NoteView>({
      table: "notes",
      showId: opts.showId ?? "",
      title: "Photos",
      width: 120,
      files: (v) => v.files,
      recordId: (v) => v.id,
      editable,
    }),
    {
      key: "type",
      title: "Type",
      type: "multiselect",
      width: 170,
      editable,
      options: selectOptions(opts.fieldOptions, "notes.type"),
      getValue: (v) => v.note.type,
    },
    {
      key: "priority",
      title: "Priority",
      type: "select",
      width: 90,
      editable,
      options: selectOptions(opts.fieldOptions, "notes.priority"),
      getValue: (v) => v.note.priority,
    },
    {
      key: "status",
      title: "Status",
      type: "select",
      width: 120,
      editable,
      options: selectOptions(opts.fieldOptions, "notes.status"),
      getValue: (v) => v.note.status,
    },
    {
      key: "assignees",
      title: "Assignees",
      type: "multilink",
      width: 170,
      editable,
      getValue: (v) => v.assignees,
      search: (q) => searchPersons(store.getState(), q),
      ...(opts.canCreateRecords ? { create: (name: string) => createPerson(store, name) } : {}),
    },
    {
      key: "cues",
      title: "Cues",
      type: "multilink",
      width: 150,
      editable,
      getValue: (v) => v.cues,
      search: (q, v) => searchCues(store.getState(), q, sceneOf(v)),
    },
    {
      key: "content",
      title: "Content",
      type: "link",
      width: 200,
      editable,
      getValue: (v) => v.content,
      search: (q, v) => searchContent(store.getState(), q, sceneOf(v)),
    },
    {
      key: "scene",
      title: "Scene",
      type: "link",
      width: 200,
      editable,
      getValue: (v) => v.scene,
      search: (q) => searchScenes(store.getState(), q),
      ...(opts.canCreateRecords ? { create: (name: string) => createScene(store, name) } : {}),
    },
    {
      // Defaults to the show's current session; editable per note.
      key: "session",
      title: "Session",
      type: "text",
      width: 110,
      editable,
      getValue: (v) => v.note.session ?? "",
    },
    {
      key: "created_by",
      title: "Created by",
      type: "readonly",
      width: 140,
      getValue: (v) => v.author,
    },
    {
      key: "created_at",
      title: "Created",
      type: "readonly",
      width: 160,
      getValue: (v) => v.note.created_at,
      format: formatTimestamp,
    },
  ];
}

export function noteEditOps(view: NoteView, key: string, value: unknown): Op[] {
  const id = view.id;
  const ref = (value as { id: string } | null)?.id ?? null;
  switch (key) {
    case "body":
      return [{ op: "update", table: "notes", id, fields: { body: textField(value) } }];
    case "session":
      return [{ op: "update", table: "notes", id, fields: { session: textField(value) } }];
    case "type":
      return [
        { op: "update", table: "notes", id, fields: { type: (value as string[] | null) ?? [] } },
      ];
    case "priority":
    case "status":
      return [
        { op: "update", table: "notes", id, fields: { [key]: (value as string | null) ?? null } },
      ];
    case "content":
      return [{ op: "update", table: "notes", id, fields: { content_id: ref } }];
    case "scene":
      return [{ op: "update", table: "notes", id, fields: { scene_id: ref } }];
    case "assignees":
    case "cues": {
      const current = view[key].map((p) => p.id);
      const next = ((value as { id: string }[] | null) ?? []).map((p) => p.id);
      return linkDiffOps("notes", id, key, current, next);
    }
    default:
      return [];
  }
}

/** Group id for a note status (Notes are grouped by status). */
export const statusGroupId = (status: string | null) => `status:${status ?? ""}`;
export const statusFromGroupId = (groupId: string | undefined): string | null | undefined =>
  groupId?.startsWith("status:") ? groupId.slice(7) || null : undefined;
