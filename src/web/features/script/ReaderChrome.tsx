// What the text reader and the PDF page view share around their pages: the navigator
// (scenes and pages), the find / go-to bar, and the keys (j / PageDown next page, k /
// PageUp previous, "/" find, "g" go to a page label; ignored in inputs and dialogs).
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { ScriptText } from "./contract";
import { findBlocks } from "./markers";
import styles from "./Script.module.css";

export function ScriptNavigator({
  headings,
  pages,
  current,
  open,
  onHeading,
  onPage,
  children,
}: {
  headings: readonly { block: number; label: string; text: string }[];
  pages: readonly { key: number; label: string }[];
  current: number;
  open: boolean;
  onHeading: (block: number) => void;
  onPage: (index: number) => void;
  /** More sections (the PDF view's cues not on any page). */
  children?: ReactNode;
}) {
  return (
    <nav
      className={styles.navigator}
      aria-label="Script pages"
      data-open={open || undefined}
      data-testid="script-navigator"
    >
      {headings.length > 0 && (
        <>
          <h3>Scenes</h3>
          <ul>
            {headings.map((h) => (
              <li key={h.block}>
                <button type="button" className={styles.navItem} onClick={() => onHeading(h.block)}>
                  <span className={styles.navLabel}>{h.label}</span> {h.text}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <h3>Pages</h3>
      <div className={styles.pageGrid}>
        {pages.map((p, i) => (
          <button
            key={p.key}
            type="button"
            aria-current={i === current ? "page" : undefined}
            aria-label={`Page ${p.label}`}
            onClick={() => onPage(i)}
          >
            {p.label}
          </button>
        ))}
      </div>
      {children}
    </nav>
  );
}

/** Keys outside inputs and dialogs; the handlers are read at key time (no re-binding). */
export function useReaderKeys(handlers: {
  next: () => void;
  prev: () => void;
  find: () => void;
  goto: () => void;
}): void {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("input, textarea, select, [contenteditable]")) return;
      if (document.querySelector('[role="dialog"]')) return;
      const h = ref.current;
      if (e.key === "j" || e.key === "PageDown") {
        e.preventDefault();
        h.next();
      } else if (e.key === "k" || e.key === "PageUp") {
        e.preventDefault();
        h.prev();
      } else if (e.key === "/") {
        e.preventDefault();
        h.find();
      } else if (e.key === "g") {
        e.preventDefault();
        h.goto();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}

export interface FindGoto {
  /** The bar (null when neither is open). */
  bar: ReactNode;
  /** The block of the current find hit (highlighted), or null. */
  findBlock: number | null;
  openFind: () => void;
  openGoto: () => void;
}

/**
 * Find (blocks containing the query, case-insensitive; Enter / Shift+Enter step) and go
 * to a page label (exact, then prefix). The view scrolls: `toBlock` for a hit, `toPage`
 * for a page index; `findPage` resolves a label to a page index (-1: none).
 */
export function useFindGoto(opts: {
  text: ScriptText;
  findPage: (label: string) => number;
  toBlock: (block: number) => void;
  toPage: (index: number) => void;
  /** Where focus goes back to when the bar closes. */
  focusBack: () => void;
}): FindGoto {
  const { text } = opts;
  const [find, setFind] = useState<{ query: string; at: number } | null>(null);
  const hits = useMemo(() => (find ? findBlocks(text, find.query) : []), [find, text]);
  const findBlock = find && hits.length ? (hits[find.at % hits.length] ?? null) : null;
  const findInput = useRef<HTMLInputElement>(null);
  const [goto, setGoto] = useState<{ value: string; error: string | null } | null>(null);
  const gotoInput = useRef<HTMLInputElement>(null);
  const findOpen = find !== null;
  const gotoOpen = goto !== null;
  useEffect(() => {
    if (findOpen) findInput.current?.focus();
  }, [findOpen]);
  useEffect(() => {
    if (gotoOpen) gotoInput.current?.focus();
  }, [gotoOpen]);
  const stepFind = (d: number) => {
    if (!find || hits.length === 0) return;
    const at = (find.at + d + hits.length) % hits.length;
    setFind({ ...find, at });
    const b = hits[at];
    if (b !== undefined) opts.toBlock(b);
  };

  const bar =
    find || goto ? (
      <div className={styles.findBar}>
        {find && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
            }}
          >
            <input
              ref={findInput}
              type="text"
              aria-label="Find in script"
              placeholder="Find in script"
              value={find.query}
              onChange={(e) => {
                const query = e.target.value;
                setFind({ query, at: 0 });
                const first = findBlocks(text, query)[0];
                if (first !== undefined) opts.toBlock(first);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  stepFind(e.shiftKey ? -1 : 1);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setFind(null);
                  opts.focusBack();
                }
              }}
            />
            <span className="muted" data-testid="find-count">
              {find.query.trim()
                ? hits.length
                  ? `${(find.at % hits.length) + 1} of ${hits.length}`
                  : "No matches"
                : ""}
            </span>
            <button type="button" onClick={() => stepFind(-1)} aria-label="Previous match">
              ↑
            </button>
            <button type="button" onClick={() => stepFind(1)} aria-label="Next match">
              ↓
            </button>
            <button type="button" onClick={() => setFind(null)} aria-label="Close find">
              ×
            </button>
          </form>
        )}
        {goto && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const i = opts.findPage(goto.value);
              if (i < 0) {
                setGoto({ ...goto, error: `No page "${goto.value}"` });
                return;
              }
              opts.toPage(i);
              setGoto(null);
              opts.focusBack();
            }}
          >
            <input
              ref={gotoInput}
              type="text"
              aria-label="Go to page"
              placeholder="Page label (e.g. 14)"
              value={goto.value}
              onChange={(e) => setGoto({ value: e.target.value, error: null })}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setGoto(null);
                  opts.focusBack();
                }
              }}
            />
            {goto.error && <span className="error">{goto.error}</span>}
          </form>
        )}
      </div>
    ) : null;

  return {
    bar,
    findBlock,
    openFind: () => {
      setFind((f) => f ?? { query: "", at: 0 });
      findInput.current?.focus();
    },
    openGoto: () => setGoto({ value: "", error: null }),
  };
}
