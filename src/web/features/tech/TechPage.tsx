// Tech mode (R7; ux.md §Tech mode), /shows/:id/tech?cue=<id>: a compact cue list (grouped
// by scene, virtualized) with the current cue highlighted, and the current cue's notes
// with a compose box that keeps focus. Keys in the compose box: ↓/↑ or Space/Shift+Space
// (box empty) move the current cue, ⌘/Ctrl+G goes to a typed cue number, Enter saves, Tab
// cycles the type chips, ⌥1–5 priority, @ assigns, "* …" is a general note, "8.5: …" (or q8.5 / #8.5) goes
// to that cue. The current cue is `?cue=`, shared with the cue list.
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { FieldOption } from "../../../shared/tables";
import { optionColor } from "../../components/grid/Chip";
import { type ShowState, useShowStore } from "../../lib/show-store";
import { openNotesByScene } from "../cues/cueViews";
import { openNoteCounts } from "../notes/compose";
import { NoteCompose, type NoteComposeHandle } from "../notes/NoteCompose";
import { NoteFocusContext, NoteList } from "../notes/NoteList";
import { useNotesFor } from "../notes/NotesPanel";
import { SessionControl } from "../notes/SessionControl";
import { CueContentCards } from "../shared/CueContentCards";
import { readPref, usePref, writePref } from "../shared/prefs";
import { rowUrl } from "../show/tabs";
import { useWorkspace } from "../show/workspace";
import styles from "./Tech.module.css";
import { goToCue, navOrder, stepCue, type TechRow, techRows } from "./techList";

type Mode = "cue" | "scene" | "content";
const ROW_HEIGHT: Record<TechRow["kind"], number> = { scene: 28, section: 22, cue: 32 };
const NO_OPTIONS: FieldOption[] = [];
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isId = (v: unknown): v is string | null => v === null || typeof v === "string";
const selectState = (s: ShowState) => s;

export function TechPage() {
  const ws = useWorkspace();
  const state = useShowStore(selectState);
  const { tables, order, joins } = state;
  const statusOptions = useShowStore((s) => s.fieldOptions["cues.status"] ?? NO_OPTIONS);
  const [params, setParams] = useSearchParams();
  const compose = useRef<NoteComposeHandle>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<Mode>("cue");
  const [follow, setFollow] = usePref(`cuesheet.techFollow.${ws.userId}`, true, isBool);
  const [goto, setGoto] = useState<{ text: string; error: string | null } | null>(null);

  // --- rows ---
  const scenes = useMemo(
    () => order.scenes.flatMap((id) => tables.scenes.get(id) ?? []),
    [order.scenes, tables.scenes],
  );
  const cues = useMemo(
    () => order.cues.flatMap((id) => tables.cues.get(id) ?? []),
    [order.cues, tables.cues],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: notes and links are the inputs
  const sceneCounts = useMemo(
    () => openNotesByScene(state),
    [tables.notes, joins.noteCues, tables.cues],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: notes and links are the inputs
  const cueCounts = useMemo(() => openNoteCounts(state), [tables.notes, joins.noteCues]);
  const rows = useMemo(() => techRows(scenes, cues, sceneCounts), [scenes, cues, sceneCounts]);
  const nav = useMemo(() => navOrder(rows), [rows]);

  // --- current cue ---
  // The source of truth is local state (plus a ref that `step` updates synchronously, so
  // rapid ↓↓↓↓↓ never reads a stale cue); `?cue=` follows it (replace), and a URL change
  // we didn't make (back/forward) is adopted. Without `?cue=`, the last tech cue of this
  // show (per user, localStorage) is used.
  const lastCueKey = `cuesheet.techCue.${ws.userId}.${ws.showId}`;
  const urlCue = params.get("cue");
  const [cur, setCur] = useState<string | null>(
    () => urlCue ?? readPref<string | null>(lastCueKey, null, isId),
  );
  const navRef = useRef(nav);
  navRef.current = nav;
  /** Index in `nav` of the last current cue that existed (for the deleted-cue fallback). */
  const lastPos = useRef(-1);
  const lastValid = useRef<string | null>(null);
  const navSet = useMemo(() => new Set(nav), [nav]);
  // A missing cue (deleted by someone, or a stale link) falls back to its nearest
  // neighbour in show order: whatever now sits where it was; else the first cue.
  const current =
    cur && navSet.has(cur)
      ? cur
      : nav.length === 0
        ? null
        : lastPos.current >= 0
          ? (nav[Math.min(lastPos.current, nav.length - 1)] as string)
          : (nav[0] as string);
  const curRef = useRef(current);
  curRef.current = current;
  const currentCue = current ? tables.cues.get(current) : undefined;

  const setCurrent = useCallback((id: string | null) => {
    if (!id) return;
    curRef.current = id;
    setCur(id);
  }, []);
  const step = useCallback(
    (delta: number) => setCurrent(stepCue(navRef.current, curRef.current, delta)),
    [setCurrent],
  );

  const writtenUrl = useRef<string | null>(urlCue);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the resolved cue changes
  useEffect(() => {
    if (state.status !== "ready") return;
    if (cur && cur !== current && cur === lastValid.current) {
      ws.toast("That cue was deleted; moved to the nearest one.");
    }
    if (current) {
      lastPos.current = nav.indexOf(current);
      lastValid.current = current;
      if (cur !== current) setCur(current);
      writePref(lastCueKey, current);
      if (params.get("cue") !== current) {
        writtenUrl.current = current;
        setParams(
          (prev) => {
            const next = new URLSearchParams(prev);
            next.set("cue", current);
            return next;
          },
          { replace: true, preventScrollReset: true },
        );
      }
    }
  }, [current, state.status]);
  // Keep the neighbour position current as rows move around.
  useEffect(() => {
    if (current) lastPos.current = nav.indexOf(current);
  }, [nav, current]);
  // A `?cue=` we didn't write (back/forward, a link): adopt it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the URL changes
  useEffect(() => {
    if (urlCue && urlCue !== writtenUrl.current && urlCue !== curRef.current) {
      writtenUrl.current = urlCue;
      setCurrent(urlCue);
    }
  }, [urlCue]);

  // --- list (virtualized) ---
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: (i) => ROW_HEIGHT[rows[i]?.kind ?? "cue"],
    overscan: 12,
  });
  const currentIndex = rows.findIndex((r) => r.kind === "cue" && r.cue.id === current);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the current cue changes
  useEffect(() => {
    if (follow && currentIndex >= 0) virtualizer.scrollToIndex(currentIndex, { align: "center" });
  }, [currentIndex, follow]);

  const focusCompose = useCallback(() => {
    requestAnimationFrame(() => {
      if (ws.canComment) compose.current?.focus();
      else scroller.current?.focus({ preventScroll: true });
    });
  }, [ws.canComment]);
  // Viewers steer the list with the keyboard (no compose box to live in).
  // biome-ignore lint/correctness/useExhaustiveDependencies: once the list is there
  useEffect(() => {
    if (!ws.canComment && state.status === "ready")
      scroller.current?.focus({ preventScroll: true });
  }, [state.status]);

  // --- keys ---
  const onNavKey = (e: React.KeyboardEvent<HTMLTextAreaElement>, empty: boolean): boolean => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "g") {
      setGoto({ text: "", error: null });
      return true;
    }
    if (!empty || mod || e.altKey) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      step(e.key === "ArrowDown" ? 1 : -1);
      return true;
    }
    if (e.key === " ") {
      step(e.shiftKey ? -1 : 1);
      return true;
    }
    return false;
  };
  // Keys that reach the document outside the compose box (viewers; after clicking a note
  // or a button): move the cue, ⌘G, and typing a character lands in the compose box.
  // Mousedown on anything that isn't a control puts focus back in the compose box.
  const pageRef = useRef<HTMLDivElement>(null);
  const keyState = useRef({ step, canComment: ws.canComment });
  keyState.current = { step, canComment: ws.canComment };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, button, a, [contenteditable]")) return;
      if (document.querySelector('[role="dialog"]')) return; // ⌘K, settings
      const mod = e.metaKey || e.ctrlKey;
      const { step, canComment } = keyState.current;
      if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "g") {
        e.preventDefault();
        setGoto({ text: "", error: null });
      } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !mod && !e.altKey) {
        e.preventDefault();
        step(e.key === "ArrowDown" ? 1 : -1);
      } else if (e.key === " " && !mod && !e.altKey) {
        e.preventDefault();
        step(e.shiftKey ? -1 : 1);
      } else if (canComment && e.key.length === 1 && !mod && !e.altKey) {
        compose.current?.focus(); // the key itself lands in the box
      }
    };
    const onDown = (e: MouseEvent) => {
      if (!keyState.current.canComment || e.button !== 0) return;
      const t = e.target as HTMLElement | null;
      if (!t || !pageRef.current?.contains(t)) return;
      const interactive =
        'input, textarea, select, button, a, label, [contenteditable], [role="button"], ' +
        '[role="combobox"], [tabindex]:not([tabindex="-1"])';
      if (t.closest(interactive)) return;
      e.preventDefault();
      compose.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, []);

  const barRef = useRef<HTMLDivElement>(null);
  const skipToControls = () =>
    barRef.current?.querySelector<HTMLElement>("input, button, a")?.focus();

  const submitGoto = () => {
    if (!goto) return;
    const hit = goToCue(cues, goto.text, current);
    if (!hit) {
      setGoto({ ...goto, error: `No cue ${goto.text.trim() || "…"}` });
      return;
    }
    setCurrent(hit.id);
    setGoto(null);
    focusCompose();
  };

  const subject = useMemo(
    () => (current ? { table: "cues" as const, id: current } : null),
    [current],
  );
  const cueNotes = useNotesFor(subject);
  const sceneSubject = useMemo(
    () => (currentCue?.scene_id ? { table: "scenes" as const, id: currentCue.scene_id } : null),
    [currentCue?.scene_id],
  );
  const sceneNotes = useNotesFor(mode === "scene" ? sceneSubject : null, { openOnly: true });

  if (state.status === "loading") return <p className="muted">Loading…</p>;
  if (state.status === "error") return <p className="error">Couldn't load the show.</p>;

  const title = currentCue
    ? `Cue ${currentCue.number ?? "(no number)"}${currentCue.description ? ` · ${currentCue.description}` : ""}`
    : "No cues";

  return (
    <NoteFocusContext.Provider value={focusCompose}>
      <div className={styles.page} data-testid="tech-mode" ref={pageRef}>
        <div className={styles.bar} ref={barRef}>
          <h2 className={styles.title}>Tech mode</h2>
          <SessionControl />
          <button
            type="button"
            className={styles.barButton}
            aria-pressed={follow}
            title="Keep the current cue scrolled into view"
            onClick={() => {
              setFollow(!follow);
              focusCompose();
            }}
          >
            Follow
          </button>
          <Link className={styles.barButton} to={rowUrl(ws.showId, "cues", current)}>
            Cue list
          </Link>
        </div>
        <p className={styles.hint}>
          ↓/↑ or Space: next/previous cue · ⌘G: go to cue · Enter: save · Tab: type · ⌥1–5: priority
          · @: assign · “* …”: general note · “8.5: …” or “#8.5 …”: that cue
        </p>
        <div className={styles.layout}>
          <section className={styles.list} aria-label="Cues">
            <div
              ref={scroller}
              className={styles.scroller}
              tabIndex={ws.canComment ? -1 : 0}
              data-testid="tech-cue-list"
            >
              <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
                {virtualizer.getVirtualItems().map((item) => {
                  const r = rows[item.index] as TechRow;
                  const style = { top: item.start, height: item.size };
                  if (r.kind === "scene") {
                    return (
                      <div key={r.key} className={styles.sceneRow} style={style}>
                        {r.title}
                        {r.openNotes > 0 ? ` · ${r.openNotes} open` : ""}
                      </div>
                    );
                  }
                  if (r.kind === "section") {
                    return (
                      <div key={r.key} className={styles.sectionRow} style={style}>
                        {r.label}
                      </div>
                    );
                  }
                  const c = r.cue;
                  const color = statusOptions.find((o) => o.value === c.status)?.color;
                  const count = cueCounts.get(c.id) ?? 0;
                  return (
                    <button
                      key={r.key}
                      type="button"
                      tabIndex={-1}
                      className={styles.cueRow}
                      style={style}
                      aria-current={c.id === current}
                      data-testid="tech-cue"
                      data-cue-number={c.number ?? ""}
                      onClick={() => {
                        setCurrent(c.id);
                        focusCompose();
                      }}
                    >
                      <span className={styles.cueNumber}>{c.number ?? "—"}</span>
                      <span className={styles.cueDesc}>{c.description}</span>
                      <span className={styles.trigger}>
                        {[c.trigger_type, c.trigger_value].filter(Boolean).join(" ")}
                      </span>
                      <span className={styles.dotWrap}>
                        <span
                          className={styles.dot}
                          title={c.status ?? "No status"}
                          style={
                            color
                              ? { background: `var(--option-${optionColor(color)}-bg)` }
                              : undefined
                          }
                        />
                        {count > 0 && (
                          <span className={styles.noteCount} title={`${count} open notes`}>
                            {count}
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </section>
          <section className={styles.notes} aria-label="Notes for the current cue">
            <div className={styles.notesHeader}>
              <h3 className={styles.current} data-testid="tech-current" title={title}>
                {title}
              </h3>
              <fieldset className={styles.modes} aria-label="Show">
                {(
                  [
                    ["cue", "Cue notes"],
                    ["scene", "Scene open notes"],
                    ["content", "Content"],
                  ] as const
                ).map(([m, label]) => (
                  <button
                    key={m}
                    type="button"
                    className={styles.mode}
                    aria-pressed={mode === m}
                    onClick={() => {
                      setMode(m);
                      focusCompose();
                    }}
                  >
                    {label}
                  </button>
                ))}
              </fieldset>
            </div>
            <div className={styles.notesBody}>
              {mode === "cue" && (
                <NoteList notes={cueNotes} empty="No notes on this cue yet." label="Cue notes" />
              )}
              {mode === "scene" && (
                <NoteList
                  notes={sceneNotes}
                  showLinks
                  empty="No open notes in this scene."
                  label="Open notes in this scene"
                />
              )}
              {mode === "content" && (
                <div className={styles.contentPane}>
                  {current ? <CueContentCards cueId={current} /> : null}
                </div>
              )}
              {goto && (
                <div className={styles.goto}>
                  <label>
                    Go to cue{" "}
                    <input
                      // biome-ignore lint/a11y/noAutofocus: the ⌘G prompt takes focus at once
                      autoFocus
                      aria-label="Go to cue"
                      value={goto.text}
                      onChange={(e) => setGoto({ text: e.target.value, error: null })}
                      onKeyDown={(e) => {
                        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                        if (e.key === "Enter") {
                          e.preventDefault();
                          submitGoto();
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          e.stopPropagation();
                          setGoto(null);
                          focusCompose();
                        }
                      }}
                    />
                  </label>
                  {goto.error && (
                    <span className={styles.gotoError} role="alert">
                      {goto.error}
                    </span>
                  )}
                </div>
              )}
              {ws.canComment ? (
                current || nav.length === 0 ? (
                  <NoteCompose
                    ref={compose}
                    subject={subject}
                    autoFocus
                    tabCyclesTypes
                    onNavKey={onNavKey}
                    onSkip={skipToControls}
                    label="Tech note"
                    placeholder="Type a note, Enter saves it on the current cue"
                  />
                ) : null
              ) : (
                <p className={styles.readOnly}>
                  Read only: you can follow along but not add notes.
                </p>
              )}
            </div>
          </section>
        </div>
      </div>
    </NoteFocusContext.Provider>
  );
}
