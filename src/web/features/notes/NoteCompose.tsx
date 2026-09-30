// The note compose box (R6, R7): Enter saves (Shift+Enter: new line), type chips (default:
// the types you used last, per user), ⌥1–5 priority, `@` assigns through the person
// picker, and the prefix grammar in ./compose.ts ("8.5: …" / "#8.5 …" link cue 8.5, "* …" is a general
// note). New notes carry the show's current session. Tech mode adds its own keys through
// `onNavKey` and cycles type chips with Tab.
import {
  forwardRef,
  type ReactNode,
  useCallback,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { FieldOption } from "../../../shared/tables";
import { Chip, type PickerItem, RecordPicker } from "../../components/grid";
import { optionColor } from "../../components/grid/Chip";
import { useShowStore, useShowStoreInstance } from "../../lib/show-store";
import { uploadQueue } from "../attachments/state";
import { createPerson, searchPersons } from "../shared/pickers";
import { isStringArray, readPref, writePref } from "../shared/prefs";
import { useWorkspace } from "../show/workspace";
import {
  cycleType,
  type NotesSubject,
  type NoteTarget,
  noteCreateOps,
  parseNoteText,
  resolveLinks,
  subjectLinks,
} from "./compose";
import styles from "./Notes.module.css";

const NO_OPTIONS: FieldOption[] = [];
export const typesPrefKey = (userId: string) => `cuesheet.noteTypes.${userId}`;
/** Longest note body the box accepts (the server's row limit is far above this). */
export const MAX_NOTE_LENGTH = 100_000;
/** The character counter shows from here on. */
const COUNTER_FROM = MAX_NOTE_LENGTH - 2_000;

export interface NoteComposeHandle {
  focus(): void;
  /** The text typed so far. */
  text(): string;
  /** Photos / files to attach to the next saved note (the quick-add camera button). */
  addFiles(files: File[]): void;
}

export interface SavedNote {
  id: string;
  target: NoteTarget;
  /** "Cue 14.20", "General note", "Content 105-001-VAMP"… */
  where: string;
}

export interface NoteComposeProps {
  /** The record the note is about (pre-filled links); null = a general note. */
  subject: NotesSubject | null;
  /**
   * Called first for every key in the box; return true when handled (tech mode: ↑/↓,
   * Space on an empty box, ⌘G). `empty` is whether the box has no text.
   */
  onNavKey?: (e: React.KeyboardEvent<HTMLTextAreaElement>, empty: boolean) => boolean;
  /** Tab / Shift+Tab step through the type chips (tech mode) instead of moving focus. */
  tabCyclesTypes?: boolean;
  onSaved?: (note: SavedNote) => void;
  autoFocus?: boolean;
  label?: string;
  placeholder?: string;
  /** Extra controls at the end of the chip row (e.g. the quick-add camera button). */
  extra?: ReactNode;
  /**
   * With no subject, only save notes that say where they go (`* …` general, or an explicit
   * cue prefix). Quick-add uses it so a note isn't saved unattached by accident.
   */
  requireTarget?: boolean;
  /** Tech mode: "Skip to controls" moves focus out of the box (a way out of the Tab trap). */
  onSkip?: () => void;
}

export const NoteCompose = forwardRef<NoteComposeHandle, NoteComposeProps>(function NoteCompose(
  {
    subject,
    onNavKey,
    tabCyclesTypes = false,
    onSaved,
    autoFocus = false,
    label = "New note",
    placeholder = "Add a note… (Enter saves)",
    extra,
    requireTarget = false,
    onSkip,
  },
  ref,
) {
  const ws = useWorkspace();
  const store = useShowStoreInstance();
  const typeOptions = useShowStore((s) => s.fieldOptions["notes.type"] ?? NO_OPTIONS);
  const session = useShowStore((s) => s.show?.currentSession ?? null);
  const cues = useShowStore((s) => s.tables.cues);
  const cueOrder = useShowStore((s) => s.order.cues);
  const persons = useShowStore((s) => s.tables.persons);
  const typeValues = useMemo(() => typeOptions.map((o) => o.value), [typeOptions]);

  const [text, setText] = useState("");
  const [types, setTypes] = useState<string[]>(() =>
    readPref(typesPrefKey(ws.userId), [], isStringArray),
  );
  const [priority, setPriority] = useState<string | null>(null);
  const [assignees, setAssignees] = useState<PickerItem[]>([]);
  const [mention, setMention] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** Pasted / dropped / photographed files, uploaded once the note is saved (R13). */
  const [files, setFiles] = useState<{ key: number; file: File }[]>([]);
  const fileSeq = useRef(0);
  const [dropping, setDropping] = useState(false);
  const addFiles = useCallback((list: File[]) => {
    if (list.length) {
      setFiles((f) => [...f, ...list.map((file) => ({ key: ++fileSeq.current, file }))]);
    }
  }, []);
  const savingRef = useRef(false);
  /** Caret position where `@` opened the person picker (Escape puts the `@` back there). */
  const mentionAt = useRef(0);
  /** Tech mode: Escape "releases" Tab so it moves focus normally until the box is left. */
  const tabReleased = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const wrap = useRef<HTMLDivElement>(null);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => input.current?.focus({ preventScroll: true }),
      text: () => input.current?.value ?? "",
      addFiles,
    }),
    [addFiles],
  );

  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight + 2, 200)}px`;
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: focus once on mount
  useLayoutEffect(() => {
    if (autoFocus) input.current?.focus({ preventScroll: true });
  }, []);

  const cueList = useMemo(() => cueOrder.flatMap((id) => cues.get(id) ?? []), [cueOrder, cues]);
  const personList = useMemo(() => [...persons.values()], [persons]);
  const currentCueId = subject?.table === "cues" ? subject.id : null;
  const parsed = useMemo(
    () => parseNoteText(text, { cues: cueList, currentCueId, persons: personList }),
    [text, cueList, currentCueId, personList],
  );
  // Only offer types the show has (options are editable per show).
  const activeTypes = types.filter((t) => typeValues.includes(t));
  const canSave =
    !!parsed.body && !saving && !(requireTarget && !subject && parsed.target.kind === "current");

  const describe = useCallback(
    (target: NoteTarget): string => {
      if (target.kind === "general") return "General note";
      if (target.kind === "cue") return `Cue ${target.number}`;
      if (!subject) return "General note";
      const data = store.getState();
      if (subject.table === "cues") {
        const c = data.tables.cues.get(subject.id);
        return c?.number ? `Cue ${c.number}` : "This cue";
      }
      if (subject.table === "content") {
        return `Content ${data.tables.content.get(subject.id)?.name ?? ""}`.trim();
      }
      const s = data.tables.scenes.get(subject.id);
      return `Scene ${[s?.number, s?.name].filter(Boolean).join(" ")}`.trim();
    },
    [subject, store],
  );

  /**
   * Save, then clear the box. Nothing is cleared (and no "Saved") until the server has
   * accepted the note: on failure the text, types, priority and assignees stay put and the
   * error shows under the box, so nothing typed during tech is lost.
   */
  const save = async () => {
    if (!canSave || savingRef.current) return;
    const data = store.getState();
    const p = parseNoteText(text, {
      cues: data.order.cues.flatMap((id) => data.tables.cues.get(id) ?? []),
      currentCueId,
      persons: [...data.tables.persons.values()],
    });
    if (!p.body) return;
    const links = resolveLinks(data, p.target, subjectLinks(data, subject));
    const ops = noteCreateOps({
      body: p.body,
      types: activeTypes,
      priority,
      session: data.show?.currentSession ?? null,
      links,
      assigneeIds: [...assignees.map((a) => a.id), ...p.assigneeIds],
    });
    const id = ops[0]?.id as string;
    const where = describe(p.target);
    savingRef.current = true;
    setSaving(true);
    setError(null);
    setFlash(null);
    try {
      await store.mutate(ops);
    } catch (e) {
      setError(`Couldn't save the note: ${e instanceof Error ? e.message : String(e)}`);
      return;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
    // The note exists now: its files go up (a commenter's own note, so they may attach).
    if (files.length) {
      uploadQueue.add(
        ws.showId,
        { table: "notes", recordId: id },
        files.map((f) => f.file),
      );
      setFiles([]);
    }
    writePref(typesPrefKey(ws.userId), activeTypes);
    // Only clear what's still the saved text (typing may have continued meanwhile).
    setText((t) => (t === text ? "" : t));
    setPriority(null);
    setAssignees([]);
    setFlash(`Saved to ${where}`);
    onSaved?.({ id, target: p.target, where });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (onNavKey?.(e, e.currentTarget.value === "")) {
      e.preventDefault();
      return;
    }
    const mod = e.metaKey || e.ctrlKey;
    if (e.altKey && !mod && /^Digit[1-5]$/.test(e.code)) {
      e.preventDefault();
      const p = e.code.slice(5);
      setPriority((cur) => (cur === p ? null : p));
    } else if (e.key === "Enter" && !e.shiftKey && !mod && !e.altKey) {
      e.preventDefault();
      void save();
    } else if (e.key === "Escape" && tabCyclesTypes) {
      // Let Tab leave the box (WCAG 2.1.2: no keyboard trap).
      e.preventDefault();
      tabReleased.current = true;
      setFlash("Tab now moves to the controls");
    } else if (e.key === "Tab" && tabCyclesTypes && !tabReleased.current && !mod && !e.altKey) {
      e.preventDefault();
      setTypes(cycleType(typeValues, activeTypes, e.shiftKey ? -1 : 1));
    } else if (e.key === "@" && !mod) {
      const el = e.currentTarget;
      const before = el.value.slice(0, el.selectionStart);
      if (before === "" || /\s$/.test(before)) {
        e.preventDefault();
        mentionAt.current = el.selectionStart;
        setMention(true);
      }
    }
  };

  const toggleType = (t: string) =>
    setTypes(activeTypes.includes(t) ? activeTypes.filter((x) => x !== t) : [...activeTypes, t]);

  const refocus = () => requestAnimationFrame(() => input.current?.focus({ preventScroll: true }));
  const errorId = useId();

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a drop target around the compose controls
    <div
      className={styles.compose}
      ref={wrap}
      data-testid="note-compose"
      data-drop={dropping || undefined}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        setDropping(false);
        const list = [...e.dataTransfer.files];
        if (list.length === 0) return;
        e.preventDefault();
        addFiles(list);
        refocus();
      }}
    >
      <textarea
        ref={input}
        className={styles.composeInput}
        aria-label={label}
        aria-keyshortcuts="Enter Alt+1 Alt+2 Alt+3 Alt+4 Alt+5"
        placeholder={placeholder}
        rows={1}
        value={text}
        maxLength={MAX_NOTE_LENGTH}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        onFocus={() => {
          tabReleased.current = false;
        }}
        onChange={(e) => {
          setText(e.target.value);
          if (flash) setFlash(null);
        }}
        onKeyDown={onKeyDown}
        onPaste={(e) => {
          const list = [...e.clipboardData.files];
          if (list.length === 0) return;
          e.preventDefault();
          addFiles(list);
        }}
      />
      {files.length > 0 && (
        <ul className={styles.pendingFiles} aria-label="Files to attach">
          {files.map(({ key, file }) => (
            <li key={key} data-testid="pending-file">
              <Chip
                label={file.name || "photo"}
                onRemove={() => setFiles(files.filter((x) => x.key !== key))}
                removeLabel={`Don't attach ${file.name || "photo"}`}
              />
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className={styles.error} role="alert" id={errorId} data-testid="compose-error">
          {error}
        </p>
      )}
      {text.length >= COUNTER_FROM && (
        <p className={styles.counter} data-testid="compose-counter">
          {text.length.toLocaleString()} / {MAX_NOTE_LENGTH.toLocaleString()} characters
        </p>
      )}
      {tabCyclesTypes && (
        <p className={styles.tabHint}>
          Tab cycles the type · Esc, then Tab: leave the box
          {onSkip && (
            <>
              {" · "}
              <button type="button" className={styles.skip} onClick={onSkip}>
                Skip to controls
              </button>
            </>
          )}
        </p>
      )}
      <fieldset className={`${styles.composeRow} ${styles.typeRow}`} aria-label="Type">
        {typeOptions.map((o) => {
          const on = activeTypes.includes(o.value);
          const c = optionColor(o.color);
          return (
            <button
              key={o.value}
              type="button"
              className={styles.typeChip}
              aria-pressed={on}
              style={
                on ? { background: `var(--option-${c}-bg)`, color: `var(--option-${c}-fg)` } : {}
              }
              onClick={() => {
                toggleType(o.value);
                refocus();
              }}
            >
              {o.value}
            </button>
          );
        })}
      </fieldset>
      <div className={styles.composeRow}>
        <select
          className={styles.select}
          aria-label="Priority"
          title="Priority (⌥1–5)"
          value={priority ?? ""}
          onChange={(e) => setPriority(e.target.value || null)}
        >
          <option value="">P–</option>
          {["1", "2", "3", "4", "5"].map((p) => (
            <option key={p} value={p}>
              P{p}
            </option>
          ))}
        </select>
        {assignees.map((a) => (
          <Chip
            key={a.id}
            label={`@${a.label}`}
            onRemove={() => setAssignees(assignees.filter((x) => x.id !== a.id))}
            removeLabel={`Unassign ${a.label}`}
          />
        ))}
        <span className={styles.target} data-kind={parsed.target.kind} data-testid="compose-target">
          → {describe(parsed.target)}
        </span>
        <span data-testid="compose-session">{session ? `· ${session}` : "· no session"}</span>
        <span className={styles.spacer} />
        {flash && (
          <span className={styles.flash} role="status">
            {flash}
          </span>
        )}
        {extra}
        <button
          type="button"
          className={styles.saveButton}
          disabled={!canSave}
          onClick={() => {
            void save();
            refocus();
          }}
        >
          Add note
        </button>
      </div>
      {mention && (
        <RecordPicker
          anchor={input.current}
          label="Assign: search people"
          placeholder="Assign to…"
          selectedIds={assignees.map((a) => a.id)}
          search={(q) => searchPersons(store.getState(), q)}
          create={ws.canEdit ? (name) => createPerson(store, name) : undefined}
          onPick={(item) => {
            setMention(false);
            if (!assignees.some((a) => a.id === item.id)) setAssignees([...assignees, item]);
            refocus();
          }}
          onClose={(reason) => {
            setMention(false);
            // Escape: the "@" was meant as text after all; put it back where it was typed.
            if (reason === "escape") {
              const at = mentionAt.current;
              setText((t) => `${t.slice(0, at)}@${t.slice(at)}`);
              requestAnimationFrame(() => {
                const el = input.current;
                el?.focus({ preventScroll: true });
                el?.setSelectionRange(at + 1, at + 1);
              });
              return;
            }
            refocus();
          }}
        />
      )}
    </div>
  );
});
