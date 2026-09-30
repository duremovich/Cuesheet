// The show's current session ("Tech 2"): set once, stamped on every new note. Shared by
// the whole team (D1 `shows.current_session`, PATCH /api/shows/:id, broadcast as
// `{type:"show"}`). Editors change it; everyone else sees it.
import { useId, useMemo, useRef, useState } from "react";
import { MAX_SESSION_LENGTH } from "../../../shared/api";
import { api } from "../../lib/api";
import { useShowStore, useShowStoreInstance } from "../../lib/show-store";
import { useWorkspace } from "../show/workspace";
import styles from "./Notes.module.css";

const BASE_SUGGESTIONS = [
  "Rehearsal",
  "Tech 1",
  "Tech 2",
  "Tech 3",
  "Tech 4",
  "Tech 5",
  "Dress 1",
  "Dress 2",
  "Preview 1",
  "Preview 2",
  "Preview 3",
  "Preview 4",
  "Opening",
];

/** Suggestions: the usual sessions, plus any already used on notes (newest first). */
export function sessionSuggestions(used: readonly string[]): string[] {
  return [...new Set([...used, ...BASE_SUGGESTIONS])];
}

export function SessionControl({ compact = false }: { compact?: boolean }) {
  const ws = useWorkspace();
  const store = useShowStoreInstance();
  const current = useShowStore((s) => s.show?.currentSession ?? null);
  const notes = useShowStore((s) => s.tables.notes);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const skipBlur = useRef(false);
  const listId = useId();

  const suggestions = useMemo(() => {
    const used = [...notes.values()]
      .filter((n) => n.session)
      .sort((a, b) => b.created_at - a.created_at)
      .map((n) => n.session as string);
    return sessionSuggestions(used).slice(0, 30);
  }, [notes]);

  // The header's copy hides on phones (tech mode and quick-add show their own).
  const cls = compact ? `${styles.sessionControl} ${styles.headerOnly}` : styles.sessionControl;
  if (!ws.canEdit) {
    if (compact && !current) return null;
    return (
      <span className={cls} data-testid="session-label">
        {!compact && "Session:"}
        <span className={styles.sessionValue}>{current ?? "—"}</span>
      </span>
    );
  }

  const commit = async (value: string) => {
    const next = value.trim() || null;
    setDraft(null);
    if (next === current) return;
    setBusy(true);
    try {
      const res = await api.updateShow(ws.showId, { current_session: next });
      store.setShow({ name: res.show.name, currentSession: res.show.currentSession });
    } catch (e) {
      ws.reportError(e, "set the session");
    } finally {
      setBusy(false);
    }
  };

  return (
    <label className={cls} title="Session: stamped on every new note">
      {!compact && "Session"}
      <input
        className={styles.sessionInput}
        aria-label="Session"
        list={listId}
        placeholder="e.g. Tech 2"
        maxLength={MAX_SESSION_LENGTH}
        value={draft ?? current ?? ""}
        disabled={busy}
        onFocus={(e) => setDraft(e.currentTarget.value)}
        onChange={(e) => {
          const v = e.target.value;
          setDraft(v);
          // Picking a suggestion from the list commits at once.
          const native = e.nativeEvent as InputEvent;
          if (native.inputType === "insertReplacementText" || native.inputType === undefined) {
            if (suggestions.includes(v)) void commit(v);
          }
        }}
        onBlur={(e) => {
          if (skipBlur.current) skipBlur.current = false;
          else if (draft !== null) void commit(e.currentTarget.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            skipBlur.current = true;
            void commit(e.currentTarget.value);
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            skipBlur.current = true;
            setDraft(null);
            e.currentTarget.blur();
          }
        }}
      />
      <datalist id={listId}>
        {suggestions.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </label>
  );
}
