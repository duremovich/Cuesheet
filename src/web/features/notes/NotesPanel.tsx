// The notes panel for one record (R6): its notes (open first, newest first) and a compose
// box pre-linked to it. Used by the row panel's Notes tab (cues, content, scenes), tech
// mode and quick-add. Viewers get the list only.
import { forwardRef, useMemo } from "react";
import type { NoteRow } from "../../../shared/tables";
import { useShowStore, useShowStoreInstance } from "../../lib/show-store";
import { useWorkspace } from "../show/workspace";
import { type NotesSubject, notesFor } from "./compose";
import { NoteCompose, type NoteComposeHandle, type NoteComposeProps } from "./NoteCompose";
import { NoteList } from "./NoteList";
import styles from "./Notes.module.css";

/** The notes about `subject` (null: none), live. */
export function useNotesFor(
  subject: NotesSubject | null,
  opts: { openOnly?: boolean } = {},
): NoteRow[] {
  const store = useShowStoreInstance();
  const notes = useShowStore((s) => s.tables.notes);
  const noteCues = useShowStore((s) => s.joins.noteCues);
  const cues = useShowStore((s) => s.tables.cues);
  const table = subject?.table;
  const id = subject?.id;
  const openOnly = !!opts.openOnly;
  // biome-ignore lint/correctness/useExhaustiveDependencies: notes, links and cues are the inputs
  return useMemo(
    () =>
      table && id ? notesFor(store.getState(), { table, id } as NotesSubject, { openOnly }) : [],
    [store, notes, noteCues, cues, table, id, openOnly],
  );
}

export const NotesPanel = forwardRef<
  NoteComposeHandle,
  { subject: NotesSubject } & Omit<NoteComposeProps, "subject">
>(function NotesPanel({ subject, ...compose }, ref) {
  const ws = useWorkspace();
  const notes = useNotesFor(subject);
  return (
    <div className={styles.panel} data-testid="notes-panel">
      <NoteList notes={notes} empty="No notes yet." />
      {ws.canComment ? (
        <NoteCompose ref={ref} subject={subject} {...compose} />
      ) : (
        <p className={styles.readOnly}>You can read notes in this show but not add them.</p>
      )}
    </div>
  );
});
