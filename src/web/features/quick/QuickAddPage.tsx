// Phone quick-add (R7; ux.md §Tech mode), /shows/:id/quick: one-thumb note taking at
// 390px. A big searchable cue picker (recent cues first), the compose box, type chips,
// priority, the session label, and a camera button (photos attach to the next saved note,
// R13). The picked cue stays picked after saving.
import { useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import type { CueRow } from "../../../shared/tables";
import { useShowStore } from "../../lib/show-store";
import { NoteCompose, type NoteComposeHandle } from "../notes/NoteCompose";
import { SessionControl } from "../notes/SessionControl";
import { isStringArray, usePref } from "../shared/prefs";
import { rankItems } from "../shared/search";
import { useWorkspace } from "../show/workspace";
import styles from "./Quick.module.css";

const RECENT_MAX = 8;
const NO_IDS: string[] = [];

/** Recently picked cues first (most recent first), then the rest in show order. */
export function quickCueList(cues: readonly CueRow[], recent: readonly string[], q: string) {
  const byId = new Map(cues.map((c) => [c.id, c]));
  const recentCues = recent.flatMap((id) => {
    const c = byId.get(id);
    return c && !c.is_section ? [c] : [];
  });
  const rest = cues.filter((c) => !c.is_section && !recent.includes(c.id));
  const all = [...recentCues, ...rest];
  if (!q.trim()) return { items: all.slice(0, 60), recentCount: recentCues.length };
  return {
    items: rankItems(all, q, (c) => [c.number, c.description], { limit: 60 }),
    recentCount: 0,
  };
}

export function QuickAddPage() {
  const ws = useWorkspace();
  const compose = useRef<NoteComposeHandle>(null);
  const camera = useRef<HTMLInputElement>(null);
  const status = useShowStore((s) => s.status);
  const cuesMap = useShowStore((s) => s.tables.cues);
  const order = useShowStore((s) => s.order.cues);
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const [picking, setPicking] = useState(false);
  const [recent, setRecent] = usePref(
    `cuesheet.recentCues.${ws.userId}.${ws.showId}`,
    NO_IDS,
    isStringArray,
  );
  const cues = useMemo(() => order.flatMap((id) => cuesMap.get(id) ?? []), [order, cuesMap]);
  const pickedId = params.get("cue");
  const picked = pickedId ? cuesMap.get(pickedId) : undefined;
  const list = useMemo(() => quickCueList(cues, recent, query), [cues, recent, query]);

  const pick = (c: CueRow) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("cue", c.id);
        return next;
      },
      { replace: true },
    );
    setRecent([c.id, ...recent.filter((id) => id !== c.id)].slice(0, RECENT_MAX));
    setQuery("");
    setPicking(false);
  };

  if (status === "loading") return <p className="muted">Loading…</p>;
  const showPicker = picking || !picked;

  return (
    <section className={styles.page} aria-label="Quick add" data-testid="quick-add">
      <div className={styles.head}>
        <h2 className={styles.title}>Quick note</h2>
        <SessionControl />
      </div>
      {picked && (
        <button
          type="button"
          className={styles.picked}
          aria-expanded={showPicker}
          onClick={() => setPicking((p) => !p)}
          data-testid="quick-picked"
        >
          <span className={styles.pickedNumber}>Cue {picked.number ?? "—"}</span>
          <span className={styles.pickedDesc}>{picked.description}</span>
          <span className={styles.change}>{showPicker ? "Close" : "Change"}</span>
        </button>
      )}
      {showPicker && (
        <div className={styles.picker}>
          <input
            type="search"
            className={styles.search}
            aria-label="Find a cue"
            placeholder="Cue number or description"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              const first = list.items[0];
              if (e.key === "Enter" && first) {
                e.preventDefault();
                pick(first);
              }
            }}
          />
          <ul className={styles.cues} aria-label="Cues">
            {list.items.map((c, i) => (
              <li key={c.id}>
                {i === 0 && list.recentCount > 0 && <div className={styles.label}>Recent</div>}
                {i === list.recentCount && list.recentCount > 0 && (
                  <div className={styles.label}>All cues</div>
                )}
                <button
                  type="button"
                  className={styles.cue}
                  aria-current={c.id === pickedId}
                  onClick={() => pick(c)}
                >
                  <span className={styles.cueNumber}>{c.number ?? "—"}</span>
                  <span className={styles.cueDesc}>{c.description}</span>
                </button>
              </li>
            ))}
            {list.items.length === 0 && <li className={styles.none}>No matching cues.</li>}
          </ul>
        </div>
      )}
      {ws.canComment ? (
        <div className={styles.compose}>
          <NoteCompose
            ref={compose}
            subject={picked ? { table: "cues", id: picked.id } : null}
            requireTarget
            label="Quick note"
            placeholder={
              picked
                ? `Note on cue ${picked.number ?? ""}`
                : "Pick a cue, or type * for a general note"
            }
            extra={
              <>
                <button
                  type="button"
                  className={styles.camera}
                  aria-label="Add a photo"
                  title="Take or pick a photo (attached when the note is saved)"
                  onClick={() => camera.current?.click()}
                >
                  📷
                </button>
                <input
                  ref={camera}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  multiple
                  className={styles.cameraInput}
                  tabIndex={-1}
                  aria-label="Photo to attach"
                  data-testid="camera-input"
                  onChange={(e) => {
                    compose.current?.addFiles([...(e.target.files ?? [])]);
                    e.target.value = "";
                  }}
                />
              </>
            }
          />
        </div>
      ) : (
        <p className="muted">You can read notes in this show but not add them.</p>
      )}
    </section>
  );
}
