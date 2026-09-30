// A list of notes as cards (R6, ux.md §Detail panel and notes panel): body, type chips,
// priority, assignees, status (click cycles Open → In progress → Done), session, author and
// time. Commenters edit and delete only their own notes, viewers nothing (the server
// enforces the same). Double-click the body to edit it in place.
import {
  createContext,
  memo,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { FieldOption, NoteRow } from "../../../shared/tables";
import { Chip } from "../../components/grid";
import { optionColor } from "../../components/grid/Chip";
import { useShowStore, useShowStoreInstance } from "../../lib/show-store";
import { AttachmentStrip, uploadQueue } from "../attachments/Attachments";
import { attachmentsOf } from "../attachments/selectors";
import { useRecordUploads } from "../attachments/uploads";
import { useWorkspace } from "../show/workspace";
import { canEditNote, formatTimestamp } from "./columns";
import { initials, isOpen, nextStatus, noteRestoreOps } from "./compose";
import styles from "./Notes.module.css";

const NONE: string[] = [];
const NO_OPTIONS: FieldOption[] = [];

/** A stable palette color for a name (avatars). */
function colorFor(name: string): string {
  const palette = ["blue", "purple", "teal", "pink", "orange", "green", "yellow", "red"];
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return palette[Math.abs(h) % palette.length] as string;
}

/**
 * Where focus goes when a card loses it for good (the note you were editing was deleted by
 * someone else). Tech mode points it at its compose box.
 */
export const NoteFocusContext = createContext<(() => void) | null>(null);

/** How long "Undo" stays available after deleting a note. */
export const UNDO_MS = 8000;

export function NoteList({
  notes,
  showLinks = false,
  empty = "No notes yet.",
  label = "Notes",
}: {
  notes: readonly NoteRow[];
  /** Show which cue/content each note is linked to (lists that span several records). */
  showLinks?: boolean;
  empty?: string;
  label?: string;
}) {
  if (notes.length === 0) return <p className={styles.listEmpty}>{empty}</p>;
  const firstDone = notes.findIndex((n) => !isOpen(n));
  return (
    <ul className={styles.list} aria-label={label} data-testid="note-list">
      {notes.map((n, i) => (
        <NoteItem
          key={n.id}
          note={n}
          showLinks={showLinks}
          doneDivider={i === firstDone && i > 0}
        />
      ))}
    </ul>
  );
}

function NoteItem({
  note,
  showLinks,
  doneDivider,
}: {
  note: NoteRow;
  showLinks: boolean;
  doneDivider: boolean;
}) {
  return (
    <>
      {doneDivider && (
        <li className={styles.divider} aria-hidden="true">
          Done
        </li>
      )}
      <NoteCard note={note} showLinks={showLinks} />
    </>
  );
}

export const NoteCard = memo(function NoteCard({
  note,
  showLinks,
}: {
  note: NoteRow;
  showLinks: boolean;
}) {
  const ws = useWorkspace();
  const store = useShowStoreInstance();
  const assigneeIds = useShowStore((s) => s.joins.noteAssignees.get(note.id) ?? NONE);
  const cueIds = useShowStore((s) => s.joins.noteCues.get(note.id) ?? NONE);
  const persons = useShowStore((s) => s.tables.persons);
  const cues = useShowStore((s) => s.tables.cues);
  const content = useShowStore((s) =>
    note.content_id ? s.tables.content.get(note.content_id) : undefined,
  );
  const typeOptions = useShowStore((s) => s.fieldOptions["notes.type"] ?? NO_OPTIONS);
  const priorityOptions = useShowStore((s) => s.fieldOptions["notes.priority"] ?? NO_OPTIONS);
  const statusOptions = useShowStore((s) => s.fieldOptions["notes.status"] ?? NO_OPTIONS);
  const canEdit = canEditNote(ws.role, ws.userId, note);
  const uploading = useRecordUploads(uploadQueue, "notes", note.id).length > 0;
  const hasFiles = useShowStore(
    (s) => attachmentsOf(s.tables.attachments, "notes", note.id).length > 0,
  );
  const [draft, setDraft] = useState<string | null>(null);
  const refocus = useContext(NoteFocusContext);

  // Deleted by someone else while you edit it: say so, and put focus somewhere useful.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const onLost = useRef({ toast: ws.toast, refocus });
  onLost.current = { toast: ws.toast, refocus };
  useEffect(
    () => () => {
      if (draftRef.current === null || store.getState().tables.notes.has(note.id)) return;
      onLost.current.toast(
        "The note you were editing was deleted by someone else; your edit was discarded.",
        "error",
      );
      onLost.current.refocus?.();
    },
    [store, note.id],
  );

  const custom = note.custom as { created_by_name?: unknown };
  const author =
    ws.memberNames.get(note.created_by) ??
    (typeof custom.created_by_name === "string" ? custom.created_by_name : "");
  const status = note.status ?? "Open";
  const statusColor = statusOptions.find((o) => o.value === status)?.color ?? "gray";
  const priorityColor = priorityOptions.find((o) => o.value === note.priority)?.color;

  const send = (fields: Record<string, unknown>, what: string) =>
    store
      .mutate([{ op: "update", table: "notes", id: note.id, fields }])
      .catch((e: unknown) => ws.reportError(e, what));

  const saveBody = () => {
    if (draft === null) return;
    const body = draft.trim();
    setDraft(null);
    if (body && body !== (note.body ?? "")) void send({ body }, "save the note");
  };

  const next = nextStatus(status);
  const cueLabels = showLinks
    ? cueIds.flatMap((id) => {
        const c = cues.get(id);
        return c ? [c.number ? `Q ${c.number}` : "Q (no number)"] : [];
      })
    : [];

  return (
    <li className={styles.note} data-testid="note" data-status={status} data-note-id={note.id}>
      <div className={styles.top}>
        <button
          type="button"
          className={styles.status}
          disabled={!canEdit}
          aria-label={canEdit ? `Status: ${status}. Change to ${next}` : `Status: ${status}`}
          title={canEdit ? `Click: ${next}` : status}
          onClick={() => void send({ status: next }, "change the status")}
        >
          <Chip label={status} color={optionColor(statusColor)} />
        </button>
        {draft !== null ? (
          <BodyEditor
            value={draft}
            onChange={setDraft}
            onSave={saveBody}
            onCancel={() => setDraft(null)}
          />
        ) : (
          <p
            className={styles.body}
            data-editable={canEdit || undefined}
            title={canEdit ? "Double-click to edit" : undefined}
            onDoubleClick={canEdit ? () => setDraft(note.body ?? "") : undefined}
          >
            {note.body || <span className="muted">(empty note)</span>}
          </p>
        )}
        {canEdit && draft === null && (
          <>
            <button
              type="button"
              className={styles.iconButton}
              aria-label="Edit note"
              title="Edit"
              onClick={() => setDraft(note.body ?? "")}
            >
              ✎
            </button>
            <button
              type="button"
              className={styles.iconButton}
              aria-label="Delete note"
              title="Delete"
              onClick={() => {
                // No confirm: an Undo toast recreates it (same id and links) for a while.
                const state = store.getState();
                const linkedCues = state.joins.noteCues.get(note.id) ?? [];
                const linkedPeople = state.joins.noteAssignees.get(note.id) ?? [];
                // Built when Undo runs, so links to records deleted meanwhile are dropped.
                const restore = () =>
                  noteRestoreOps(note, linkedCues, linkedPeople, (table, id) =>
                    store.getState().tables[table].has(id),
                  );
                store
                  .mutate([{ op: "delete", table: "notes", id: note.id }])
                  .then(() =>
                    ws.toast("Note deleted.", "info", {
                      duration: UNDO_MS,
                      action: {
                        label: "Undo",
                        run: () =>
                          void store
                            .mutate(restore())
                            .catch((e: unknown) => ws.reportError(e, "restore the note")),
                      },
                    }),
                  )
                  .catch((e: unknown) => ws.reportError(e, "delete the note"));
              }}
            >
              ×
            </button>
          </>
        )}
      </div>
      {(hasFiles || uploading) && (
        <div className={styles.photos}>
          <AttachmentStrip table="notes" recordId={note.id} max={6} />
        </div>
      )}
      <div className={styles.meta}>
        {note.type.length > 0 && (
          <span className={styles.chips}>
            {note.type.map((t) => (
              <Chip
                key={t}
                label={t}
                color={optionColor(typeOptions.find((o) => o.value === t)?.color)}
              />
            ))}
          </span>
        )}
        {note.priority && <Chip label={`P${note.priority}`} color={optionColor(priorityColor)} />}
        {assigneeIds.length > 0 && (
          <span className={styles.avatars}>
            {assigneeIds.map((id) => {
              const name = persons.get(id)?.name ?? "?";
              const c = colorFor(name);
              return (
                <span
                  key={id}
                  className={styles.avatar}
                  title={name}
                  role="img"
                  aria-label={name}
                  style={{ background: `var(--option-${c}-bg)`, color: `var(--option-${c}-fg)` }}
                >
                  {initials(name)}
                </span>
              );
            })}
          </span>
        )}
        {(cueLabels.length > 0 || (showLinks && content)) && (
          <span className={styles.links}>
            {[...cueLabels, ...(showLinks && content?.name ? [content.name] : [])].join(" · ")}
          </span>
        )}
        {note.session && <span className={styles.session}>{note.session}</span>}
        <span>
          {author || "Unknown"} · {formatTimestamp(note.created_at)}
        </span>
      </div>
    </li>
  );
});

function BodyEditor({
  value,
  onChange,
  onSave,
  onCancel,
}: {
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // Saved or cancelled: a blur while unmounting mustn't save again.
  const settled = useRef(false);
  const settle = (fn: () => void) => {
    if (settled.current) return;
    settled.current = true;
    fn();
  };
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  });
  useLayoutEffect(() => {
    const el = ref.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, []);
  return (
    <textarea
      ref={ref}
      className={styles.bodyEditor}
      aria-label="Edit note"
      rows={1}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => settle(onSave)}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          settle(onSave);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          settle(onCancel);
        }
      }}
    />
  );
}
