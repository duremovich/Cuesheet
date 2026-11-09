// The Notes tab: notes grouped by status (Open / In progress / Done), oldest first.
// Commenters can add notes and edit their own; others' notes are read-only for them.
import { useMemo, useRef } from "react";
import type { Group } from "../../components/grid/types";
import { ViewCache } from "../../lib/show-selectors";
import { type ShowState, useShowStore, useShowStoreInstance } from "../../lib/show-store";
import { attachmentRestoreOps, attachmentsOf } from "../attachments/selectors";
import { contentItem, cueItem, personItem, sceneItem } from "../shared/pickers";
import { TableGrid } from "../shared/TableGrid";
import { useWorkspace } from "../show/workspace";
import {
  canEditNote,
  formatTimestamp,
  type NoteView,
  noteColumns,
  noteEditOps,
  statusFromGroupId,
  statusGroupId,
} from "./columns";
import { noteLinkIds, noteRestoreOps } from "./compose";

const NONE: string[] = [];
/** Done notes start folded away; the per-user collapse state takes over once changed. */
const DONE_COLLAPSED = [statusGroupId("Done")];
const ADD_TO_OPEN = { groupId: statusGroupId("Open") };
const selectState = (s: ShowState) => s;

// Custom values follow the note's own editability (commenters: their own notes).
const CUSTOM = {
  fieldTable: "notes",
  rowOf: (v: NoteView) => v.note,
  editable: (v: NoteView) => v.editable,
};

export function NotesGrid() {
  const ws = useWorkspace();
  const store = useShowStoreInstance();
  const state = useShowStore(selectState);
  const { tables, joins, fieldOptions } = state;
  const cache = useRef(new ViewCache<NoteView>()).current;

  const views = useMemo(() => {
    const notes = [...tables.notes.values()].sort((a, b) =>
      a.created_at !== b.created_at ? a.created_at - b.created_at : a.id < b.id ? -1 : 1,
    );
    return cache.pass((get) =>
      notes.map((note) => {
        const id = note.id;
        const personIds = joins.noteAssignees.get(id) ?? NONE;
        const cueIds = joins.noteCues.get(id) ?? NONE;
        const contentIds = joins.noteContent.get(id) ?? NONE;
        const persons = personIds.map((p) => tables.persons.get(p));
        const cues = cueIds.map((c) => tables.cues.get(c));
        const content = contentIds.map((c) => tables.content.get(c));
        // Content labels include their scene ("101 · NAME"), so those scenes are deps too.
        const contentScenes = content.map((c) =>
          c?.scene_id ? tables.scenes.get(c.scene_id) : undefined,
        );
        const scene = note.scene_id ? tables.scenes.get(note.scene_id) : undefined;
        const custom = note.custom as { created_by_name?: unknown };
        const author =
          ws.memberNames.get(note.created_by) ??
          (typeof custom.created_by_name === "string" ? custom.created_by_name : "");
        const editable = canEditNote(ws.role, ws.userId, note);
        const files = attachmentsOf(tables.attachments, "notes", id);
        return get(
          id,
          [
            note,
            scene,
            author,
            editable,
            files,
            ...persons,
            "|",
            ...cues,
            "|",
            ...content,
            ...contentScenes,
          ],
          () => ({
            id,
            note,
            assignees: persons.flatMap((p) => (p ? [personItem(p)] : [])),
            cues: cues.flatMap((c) => (c ? [cueItem(c)] : [])),
            content: content.flatMap((c) => (c ? [contentItem(c, tables.scenes)] : [])),
            scene: scene ? sceneItem(scene) : null,
            author,
            editable,
            files,
          }),
        );
      }),
    );
  }, [cache, tables, joins, ws.memberNames, ws.role, ws.userId]);

  const statusOptions = fieldOptions["notes.status"] ?? [];
  const groups = useMemo<Group<NoteView>[]>(() => {
    const known = new Set(statusOptions.map((o) => o.value));
    const out: Group<NoteView>[] = statusOptions.map((o) => ({
      id: statusGroupId(o.value),
      title: o.value,
      rows: views.filter((v) => v.note.status === o.value),
    }));
    const other = views.filter((v) => !v.note.status || !known.has(v.note.status));
    if (other.length) out.unshift({ id: statusGroupId(null), title: "No status", rows: other });
    return out;
  }, [views, statusOptions]);

  const columns = useMemo(
    () => noteColumns({ store, fieldOptions, canCreateRecords: ws.canEdit, showId: ws.showId }),
    [store, fieldOptions, ws.canEdit, ws.showId],
  );

  return (
    <TableGrid<NoteView>
      tab="notes"
      custom={CUSTOM}
      title="Notes"
      label="Notes"
      noun="note"
      testId="notes-list"
      columns={columns}
      rowId={(v) => v.id}
      groups={groups}
      defaultCollapsed={DONE_COLLAPSED}
      addPosition={ADD_TO_OPEN}
      editOps={noteEditOps}
      {...(ws.canComment
        ? {
            createOps: (id, pos) => {
              const status = statusFromGroupId(pos.groupId);
              return [
                {
                  op: "create",
                  table: "notes",
                  id,
                  fields: status === undefined ? { status: "Open" } : { status },
                },
              ];
            },
            deleteOps: (vs) =>
              vs.every((v) => v.editable)
                ? vs.map((v) => ({ op: "delete", table: "notes", id: v.id }))
                : "You can only delete notes you created.",
            // Undo, as for a note card's ×: same ids, fields, links and photos.
            restoreOps: (vs) => {
              const state = store.getState();
              const saved = vs.map((v) => ({
                note: v.note,
                links: noteLinkIds(state, v.id),
                photos: attachmentsOf(state.tables.attachments, "notes", v.id),
              }));
              return () => {
                const exists = (table: "cues" | "persons" | "content" | "scenes", id: string) =>
                  store.getState().tables[table].has(id);
                return saved.flatMap(({ note, links, photos }) => [
                  ...noteRestoreOps(note, links, exists),
                  ...attachmentRestoreOps(photos),
                ]);
              };
            },
          }
        : {})}
      panelTitle={(v) => `Note by ${v.author || "unknown"} · ${formatTimestamp(v.note.created_at)}`}
      empty={<p className="muted">No notes yet.</p>}
    />
  );
}
