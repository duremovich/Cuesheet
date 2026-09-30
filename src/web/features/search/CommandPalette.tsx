// ⌘K / Ctrl+K (R5b): search the show and run commands. Enter on a record opens its tab and
// focuses the row (expanding its group); on a command, runs it.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ShowState } from "../../lib/show-store";
import { useShowStore } from "../../lib/show-store";
import { matchScore } from "../shared/search";
import { type AnyTabKey, TABS, type TabKey } from "../show/tabs";
import styles from "./CommandPalette.module.css";
import { type SearchHit, searchShow } from "./searchShow";

export interface PaletteCommand {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

type Entry =
  | { kind: "hit"; key: string; group: string; hit: SearchHit }
  | { kind: "command"; key: string; group: string; command: PaletteCommand };

const selectState = (s: ShowState) => s;

export function CommandPalette({
  open,
  onClose,
  commands,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  commands: PaletteCommand[];
  onPick: (tab: AnyTabKey, id: string) => void;
}) {
  if (!open) return null;
  return <PaletteDialog onClose={onClose} commands={commands} onPick={onPick} />;
}

function PaletteDialog({
  onClose,
  commands,
  onPick,
}: {
  onClose: () => void;
  commands: PaletteCommand[];
  onPick: (tab: AnyTabKey, id: string) => void;
}) {
  const state = useShowStore(selectState);
  const [q, setQ] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();
  const returnFocus = useRef<Element | null>(null);

  useEffect(() => {
    returnFocus.current = document.activeElement;
    input.current?.focus();
  }, []);

  const entries = useMemo<Entry[]>(() => {
    const cmds = commands
      .map((c, i) => ({ c, i, s: matchScore(q, [c.label]) }))
      .filter((x) => x.s !== null)
      .sort((a, b) => (a.s as number) - (b.s as number) || a.i - b.i)
      .map(({ c }) => ({
        kind: "command" as const,
        key: `cmd:${c.id}`,
        group: "Commands",
        command: c,
      }));
    const hits = searchShow(state, q).flatMap((g) =>
      g.hits.map((hit) => ({
        kind: "hit" as const,
        key: `${hit.tab}:${hit.id}`,
        group: g.label,
        hit,
      })),
    );
    // Commands first when the box is empty or the query names one ("sort", "go to"),
    // records first otherwise.
    const namesCommand = cmds.some((e) => (matchScore(q, [e.command.label]) ?? 3) <= 2);
    return !q.trim() ? cmds : namesCommand ? [...cmds, ...hits] : [...hits, ...cmds];
  }, [state, q, commands]);

  const active = entries[Math.min(index, entries.length - 1)];
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  });

  const close = (restore: boolean) => {
    onClose();
    if (restore && returnFocus.current instanceof HTMLElement) returnFocus.current.focus();
  };
  const choose = (e: Entry | undefined) => {
    if (!e) return;
    if (e.kind === "hit") {
      close(false);
      onPick(e.hit.tab, e.hit.id);
    } else {
      close(true);
      e.command.run();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === "Tab") {
      // Focus stays in the palette (it's modal); Tab moves through results like ↓.
      e.preventDefault();
      setIndex((i) =>
        e.shiftKey ? Math.max(i - 1, 0) : Math.min(i + 1, Math.max(entries.length - 1, 0)),
      );
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((i) => Math.min(i + 1, entries.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(active);
    }
  };

  let lastGroup = "";
  return (
    <div
      className={styles.backdrop}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) close(true);
      }}
    >
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Search and commands"
      >
        <input
          ref={input}
          className={styles.input}
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={active ? `${listId}-${active.key}` : undefined}
          aria-label="Search cues, content, scenes, notes, people or commands"
          placeholder="Search cues, content, scenes, notes, people… or type a command"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setIndex(0);
          }}
          onKeyDown={onKeyDown}
          autoComplete="off"
          spellCheck={false}
        />
        <div className={styles.list} role="listbox" id={listId} ref={list} aria-label="Results">
          {entries.length === 0 && <p className={styles.empty}>No matches.</p>}
          {entries.map((e) => {
            const header = e.group !== lastGroup ? e.group : null;
            lastGroup = e.group;
            const selected = e === active;
            const label = e.kind === "hit" ? e.hit.title : e.command.label;
            const detail = e.kind === "hit" ? e.hit.detail : e.command.hint;
            return (
              <div key={e.key}>
                {header && (
                  <div className={styles.groupLabel} role="presentation">
                    {header}
                  </div>
                )}
                <div
                  id={`${listId}-${e.key}`}
                  role="option"
                  aria-selected={selected}
                  className={styles.option}
                  data-testid="palette-option"
                  onPointerMove={() => setIndex(entries.indexOf(e))}
                  tabIndex={-1}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter") choose(e);
                  }}
                  onPointerDown={(ev) => ev.preventDefault()}
                  onClick={() => choose(e)}
                >
                  <span className={styles.optionLabel}>{label}</span>
                  {detail && <span className={styles.optionDetail}>{detail}</span>}
                </div>
              </div>
            );
          })}
        </div>
        <div className={styles.footer} aria-hidden="true">
          ↑↓ to move · Enter to open · Esc to close
        </div>
      </div>
    </div>
  );
}

/** The "Go to <tab>" commands. */
export function goToCommands(go: (tab: TabKey) => void): PaletteCommand[] {
  return TABS.map((t) => ({ id: `go-${t.key}`, label: `Go to ${t.label}`, run: () => go(t.key) }));
}
