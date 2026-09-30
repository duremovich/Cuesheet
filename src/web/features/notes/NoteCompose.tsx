// The note compose box (R6, R7): Enter saves (Shift+Enter: new line), type chips (default:
// the types you used last, per user), ⌥1–5 priority, `@` assigns through the person
// picker, and the prefix grammar in ./compose.ts ("8.5: …" / "#8.5 …" link cue 8.5, "* …" is a general
// note). New notes carry the show's current session. Tech mode adds its own keys through
// `onNavKey` and cycles type chips with Tab.
import {
  forwardRef,
  type ReactNode,
  useCallback,
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

export interface NoteComposeHandle {
  focus(): void;
  /** The text typed so far. */
  text(): string;
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
  const input = useRef<HTMLTextAreaElement>(null);
  const wrap = useRef<HTMLDivElement>(null);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => input.current?.focus({ preventScroll: true }),
      text: () => input.current?.value ?? "",
    }),
    [],
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

  const save = () => {
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
    store.mutate(ops).catch((e: unknown) => ws.reportError(e, "save the note"));
    writePref(typesPrefKey(ws.userId), activeTypes);
    setText("");
    setPriority(null);
    setAssignees([]);
    const where = describe(p.target);
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
      save();
    } else if (e.key === "Tab" && tabCyclesTypes && !mod && !e.altKey) {
      e.preventDefault();
      setTypes(cycleType(typeValues, activeTypes, e.shiftKey ? -1 : 1));
    } else if (e.key === "@" && !mod) {
      const el = e.currentTarget;
      const before = el.value.slice(0, el.selectionStart);
      if (before === "" || /\s$/.test(before)) {
        e.preventDefault();
        setMention(true);
      }
    }
  };

  const toggleType = (t: string) =>
    setTypes(activeTypes.includes(t) ? activeTypes.filter((x) => x !== t) : [...activeTypes, t]);

  const refocus = () => requestAnimationFrame(() => input.current?.focus({ preventScroll: true }));

  return (
    <div className={styles.compose} ref={wrap} data-testid="note-compose">
      <textarea
        ref={input}
        className={styles.composeInput}
        aria-label={label}
        aria-keyshortcuts="Enter Alt+1 Alt+2 Alt+3 Alt+4 Alt+5"
        placeholder={placeholder}
        rows={1}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (flash) setFlash(null);
        }}
        onKeyDown={onKeyDown}
      />
      <fieldset className={styles.composeRow} aria-label="Type">
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
          disabled={!parsed.body}
          onClick={() => {
            save();
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
            // Escape: the "@" was meant as text after all.
            if (reason === "escape") setText((t) => `${t}@`);
            refocus();
          }}
        />
      )}
    </div>
  );
});
