// Find-or-create picker (R5a): a popover with a search box and a keyboard-navigable list.
// Used by link/select cells in the DataGrid; exported for reuse (detail panel, tech mode,
// script view).

import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Chip } from "./Chip";
import { useAnchoredStyle, useOutsidePointer } from "./popover";
import styles from "./RecordPicker.module.css";
import type { PickerItem } from "./types";

export type PickVia = "enter" | "tab" | "shiftTab" | "click";
export type CloseReason = "escape" | "outside" | "tab" | "shiftTab" | "enter";

export interface RecordPickerProps {
  /** The element the popover sits under. */
  anchor: HTMLElement | null;
  search: (query: string) => Promise<PickerItem[]> | PickerItem[];
  /** When set, a "Create '<query>'" row is offered if no label matches exactly. */
  create?: ((name: string) => Promise<PickerItem>) | undefined;
  initialQuery?: string;
  /** Recently picked items; shown first when they match the query. */
  recent?: PickerItem[];
  /** Items already chosen (checked in the list). */
  selectedIds?: string[];
  onPick: (item: PickerItem, via: PickVia) => void;
  onClose: (reason: CloseReason) => void;
  /** Backspace in an empty search box (multi pickers remove the last chip). */
  onBackspaceEmpty?: () => void;
  /** Multi pickers stay open after a pick and clear the query. */
  multi?: boolean;
  /** Chips shown above the search box (multi pickers). */
  chips?: ReactNode;
  /** Debounce for `search`, ms. */
  debounceMs?: number;
  /** Accessible name of the search box. */
  label?: string;
  placeholder?: string;
  /** Marks the portal so a host (the grid) can tell focus inside it from focus leaving. */
  portalOwner?: string;
}

type Entry = { kind: "item"; item: PickerItem; recent: boolean } | { kind: "create"; name: string };

export function buildEntries(
  query: string,
  results: readonly PickerItem[],
  recent: readonly PickerItem[],
  canCreate: boolean,
): Entry[] {
  const q = query.trim().toLowerCase();
  const recentMatches = recent.filter((r) => !q || r.label.toLowerCase().includes(q));
  const seen = new Set(recentMatches.map((r) => r.id));
  const entries: Entry[] = [
    ...recentMatches.map((item) => ({ kind: "item" as const, item, recent: true })),
    ...results
      .filter((r) => !seen.has(r.id))
      .map((item) => ({ kind: "item" as const, item, recent: false })),
  ];
  if (
    canCreate &&
    q &&
    !entries.some((e) => e.kind === "item" && e.item.label.trim().toLowerCase() === q)
  ) {
    entries.push({ kind: "create", name: query.trim() });
  }
  return entries;
}

export function RecordPicker(props: RecordPickerProps) {
  const {
    anchor,
    create,
    initialQuery = "",
    recent = [],
    selectedIds = [],
    onPick,
    onClose,
    onBackspaceEmpty,
    multi = false,
    chips,
    debounceMs = 100,
    label = "Search",
    placeholder = "Find…",
    portalOwner,
  } = props;
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<{ q: string; items: PickerItem[] } | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [userMoved, setUserMoved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const searchRef = useRef(props.search);
  searchRef.current = props.search;
  const popRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const style = useAnchoredStyle(anchor, { minWidth: 280, maxHeight: 340 });

  const run = useCallback(async (q: string): Promise<PickerItem[]> => {
    const mine = ++seq.current;
    const items = await searchRef.current(q);
    if (mine === seq.current) setResults({ q, items });
    return items;
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      run(query).catch((e: unknown) => setError(e instanceof Error ? e.message : "Search failed"));
    }, debounceMs);
    return () => clearTimeout(t);
  }, [query, debounceMs, run]);

  // The host may extend the query (keys typed before this box had focus).
  const firstQuery = useRef(initialQuery);
  useEffect(() => {
    if (initialQuery === firstQuery.current) return;
    firstQuery.current = initialQuery;
    setQuery(initialQuery);
  }, [initialQuery]);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  useOutsidePointer(
    () => [popRef.current, anchor],
    () => onClose("outside"),
  );

  const entries = buildEntries(query, results?.items ?? [], recent, !!create);
  const hi = Math.min(highlight, Math.max(0, entries.length - 1));

  useEffect(() => {
    popRef.current?.querySelector(`[data-index="${hi}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [hi]);

  // Set synchronously while a pick/create is in flight so a second Enter (or click) can't
  // start another one before React re-renders with `busy`.
  const pendingRef = useRef(false);

  const choose = async (entry: Entry, via: PickVia) => {
    if (entry.kind === "item") {
      onPick(entry.item, via);
    } else {
      if (!create) return;
      setBusy(true);
      setError(null);
      try {
        const item = await create(entry.name);
        onPick(item, via);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't create it");
        setBusy(false);
        return;
      }
      setBusy(false);
    }
    if (multi) {
      setQuery("");
      setHighlight(0);
      setUserMoved(false);
      inputRef.current?.focus();
    }
  };

  /** Enter/Tab: resolve against fresh results (the user may type faster than the debounce). */
  const commit = async (via: "enter" | "tab" | "shiftTab") => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    try {
      const empty = query.trim() === "";
      if (empty && !userMoved && (via !== "enter" || multi)) {
        onClose(via === "enter" ? "enter" : via);
        return;
      }
      let list = entries;
      if (!results || results.q !== query) {
        try {
          list = buildEntries(query, await run(query), recent, !!create);
        } catch {
          return;
        }
      }
      const entry = list[userMoved ? Math.min(hi, list.length - 1) : 0];
      if (!entry) {
        onClose(via === "enter" ? "enter" : via);
        return;
      }
      await choose(entry, via);
    } finally {
      pendingRef.current = false;
    }
  };

  const chooseOnce = async (entry: Entry, via: PickVia) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    try {
      await choose(entry, via);
    } finally {
      pendingRef.current = false;
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    // IME composition: Enter/Escape/Tab belong to the input method.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setUserMoved(true);
        setHighlight(entries.length ? (hi + 1) % entries.length : 0);
        break;
      case "ArrowUp":
        e.preventDefault();
        setUserMoved(true);
        setHighlight(entries.length ? (hi - 1 + entries.length) % entries.length : 0);
        break;
      case "Enter":
        e.preventDefault();
        void commit("enter");
        break;
      case "Tab":
        e.preventDefault();
        void commit(e.shiftKey ? "shiftTab" : "tab");
        break;
      case "Escape":
        e.preventDefault();
        onClose("escape");
        break;
      case "Backspace":
        if (query === "" && onBackspaceEmpty) {
          e.preventDefault();
          onBackspaceEmpty();
        }
        break;
    }
  };

  const activeId = entries.length ? `${listId}-${hi}` : undefined;

  return createPortal(
    <div
      ref={popRef}
      className={styles.popover}
      style={style}
      data-grid-portal={portalOwner}
      data-testid="record-picker"
    >
      {chips && <div className={styles.chips}>{chips}</div>}
      <input
        ref={inputRef}
        className={styles.input}
        type="text"
        role="combobox"
        aria-label={label}
        aria-expanded="true"
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        placeholder={placeholder}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setHighlight(0);
          setUserMoved(false);
        }}
        onKeyDown={onKeyDown}
      />
      <div id={listId} role="listbox" aria-label={label} className={styles.list} aria-busy={busy}>
        {entries.map((entry, i) => {
          const isHi = i === hi;
          const common = {
            id: `${listId}-${i}`,
            role: "option" as const,
            "aria-selected": isHi,
            "data-index": i,
            "data-highlighted": isHi || undefined,
            className: styles.option,
            onPointerDown: (e: React.PointerEvent) => e.preventDefault(),
            onPointerEnter: () => {
              setHighlight(i);
              setUserMoved(true);
            },
            onClick: () => void chooseOnce(entry, "click"),
          };
          if (entry.kind === "create") {
            return (
              <div key="__create" {...common} data-create="true">
                <span className={styles.plus} aria-hidden="true">
                  +
                </span>
                <span>
                  Create <strong>“{entry.name}”</strong>
                </span>
              </div>
            );
          }
          const checked = selectedIds.includes(entry.item.id);
          return (
            <div key={entry.item.id} {...common} data-checked={checked || undefined}>
              <span className={styles.check} aria-hidden="true">
                {checked ? "✓" : ""}
              </span>
              <span className={styles.optionMain}>
                {entry.item.color ? (
                  <Chip label={entry.item.label} color={entry.item.color} />
                ) : (
                  entry.item.label
                )}
                {entry.item.secondary && (
                  <span className={styles.secondary}>{entry.item.secondary}</span>
                )}
              </span>
              {entry.recent && <span className={styles.recent}>recent</span>}
            </div>
          );
        })}
        {entries.length === 0 && (
          <div className={styles.empty}>{results ? "No matches" : "Searching…"}</div>
        )}
      </div>
      {busy && (
        <div className={styles.status} role="status">
          Creating…
        </div>
      )}
      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}
    </div>,
    document.body,
  );
}
