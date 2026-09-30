// The script reader (ux.md §Script view › Reading): pages of extracted text in a readable
// column, page labels in the gutter, cue markers in a wide right margin (stacked when they
// share a block), a sticky page header and a page/scene navigator. Pages are virtualized.
// Keys (outside inputs): j / PageDown next page, k / PageUp previous, "/" find, "g" go to a
// page label. Editors on the current version place cues by selecting text or clicking
// the margin (PlacePopover) and drag markers to another block. ≤ 600 px: one column, and
// markers collapse to badges that expand on tap.
import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CueRow, FieldOptions } from "../../../shared/tables";
import type { PickerItem } from "../../components/grid/types";
import { useMediaQuery } from "../shared/useMediaQuery";
import type { Anchor, CueAnchorRow, ScriptBlock, ScriptText } from "./contract";
import { makeAnchor } from "./contract";
import { type ColorBy, type MarkerFilter, markerColor, matchesMarker } from "./filters";
import {
  ANCHOR_DRAG_TYPE,
  FaintMarker,
  Marker,
  type MarkerActions,
  markerStyle,
  otherDeptLabels,
} from "./Marker";
import {
  anchorsByBlock,
  cueLabel,
  FAINT_HEIGHT,
  findBlocks,
  findPage,
  headingsOf,
  isPlaced,
  MARKER_HEIGHT,
  type PageBlocks,
  pageIndexOfBlock,
  pagesOf,
  type StackItem,
  stackMarkers,
  triggerBadge,
} from "./markers";
import { PlacePopover, type PlaceRequest } from "./PlacePopover";
import type { NewCueInput } from "./placement";
import { rangeToSpan } from "./placement";
import styles from "./Script.module.css";
import { BlockText, type QuoteRange } from "./ScriptBlocks";

export interface Placement {
  create(anchor: Anchor, input: NewCueInput): Promise<void>;
  attach(cueId: string, anchor: Anchor, positionTrigger: string | null): Promise<void>;
  move(anchorId: string, block: number): Promise<void>;
  /** Number suggestion for a new cue at this position. */
  suggest(at: { block: number; offset: number }): string;
  searchCues(q: string): PickerItem[];
}

export interface FocusRequest {
  cueId: string;
  nonce: number;
}

export interface ReaderProps {
  text: ScriptText;
  anchors: readonly CueAnchorRow[];
  cues: ReadonlyMap<string, CueRow>;
  assignees: ReadonlyMap<string, string[]>;
  openNotes: ReadonlyMap<string, number>;
  fieldOptions: FieldOptions;
  filter: MarkerFilter;
  colorBy: ColorBy;
  showOthers: boolean;
  /** Editors on the current version. */
  canPlace: boolean;
  activeCue: string | null;
  focusRequest: FocusRequest | null;
  /** The cue asked for has no marker on this version. */
  onFocusMissing?: (cueId: string) => void;
  /** A focus request was carried out (or found missing): the parent drops it. */
  onFocusHandled?: () => void;
  actions: MarkerActions;
  placement: Placement;
}

const FLASH_MS = 2400;
const NONE: string[] = [];

function estimatePage(p: PageBlocks | undefined): number {
  if (!p) return 400;
  return 80 + p.blocks.reduce((h, b) => h + 14 + Math.ceil((b.text.length || 1) / 70) * 24, 0);
}

export function Reader(props: ReaderProps) {
  const { text, anchors, cues, assignees, filter, canPlace, placement } = props;
  const narrow = useMediaQuery("(max-width: 600px)");
  const pages = useMemo(() => pagesOf(text), [text]);
  const headings = useMemo(() => headingsOf(text), [text]);
  const shown = useMemo(
    () =>
      anchors.filter((a) => {
        const cue = cues.get(a.cue_id);
        return !!cue && isPlaced(a) && matchesMarker(cue, assignees.get(cue.id) ?? NONE, filter);
      }),
    [anchors, cues, assignees, filter],
  );
  const byBlock = useMemo(() => anchorsByBlock(shown), [shown]);

  // --- virtualized pages ---
  const scroller = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: pages.length,
    getScrollElement: () => scroller.current,
    estimateSize: (i) => estimatePage(pages[i]),
    getItemKey: (i) => pages[i]?.page ?? i,
    overscan: 2,
  });
  const [pageIdx, setPageIdx] = useState(0);
  const pageIdxRef = useRef(0);
  pageIdxRef.current = pageIdx;
  const onScroll = () => {
    const top = scroller.current?.scrollTop ?? 0;
    const item = virtualizer.getVirtualItems().find((it) => it.end > top + 40);
    if (item && item.index !== pageIdxRef.current) setPageIdx(item.index);
  };
  const scrollToPage = useCallback(
    (idx: number) => {
      const i = Math.max(0, Math.min(idx, pages.length - 1));
      virtualizer.scrollToIndex(i, { align: "start" });
      setPageIdx(i);
    },
    [virtualizer, pages.length],
  );
  /** Scrolls a block to the middle once its page is rendered, then runs `then`. */
  const scrollToBlock = useCallback(
    (block: number, then?: (el: HTMLElement) => void) => {
      const idx = pageIndexOfBlock(pages, block);
      if (idx < 0) return;
      virtualizer.scrollToIndex(idx, { align: "start" });
      setPageIdx(idx);
      let tries = 0;
      const find = () => {
        const el = scroller.current?.querySelector<HTMLElement>(`[data-block="${block}"]`);
        if (el) {
          el.scrollIntoView?.({ block: "center" });
          then?.(el);
        } else if (tries++ < 30) requestAnimationFrame(find);
      };
      requestAnimationFrame(find);
    },
    [pages, virtualizer],
  );

  // --- flash (Show in script, a new marker) ---
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flashCue = useCallback((cueId: string) => {
    clearTimeout(flashTimer.current);
    setFlash(cueId);
    flashTimer.current = setTimeout(() => setFlash(null), FLASH_MS);
  }, []);
  useEffect(() => () => clearTimeout(flashTimer.current), []);

  const anchorsRef = useRef(anchors);
  anchorsRef.current = anchors;
  const onFocusMissing = props.onFocusMissing;
  const onFocusHandled = props.onFocusHandled;
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs per request (nonce)
  useEffect(() => {
    const req = props.focusRequest;
    if (!req) return;
    const a = anchorsRef.current.find((x) => x.cue_id === req.cueId && isPlaced(x));
    onFocusHandled?.();
    if (!a) {
      onFocusMissing?.(req.cueId);
      return;
    }
    scrollToBlock(a.block, () => {
      const marker = scroller.current?.querySelector<HTMLElement>(
        `[data-testid="script-marker"][data-cue="${req.cueId}"]`,
      );
      marker?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      flashCue(req.cueId);
    });
  }, [props.focusRequest?.nonce, props.focusRequest?.cueId]);

  // --- find / go to ---
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
    if (b !== undefined) scrollToBlock(b);
  };

  // --- keys ---
  const keyState = useRef({ scrollToPage, pages: pages.length });
  keyState.current = { scrollToPage, pages: pages.length };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("input, textarea, select, [contenteditable]")) return;
      if (document.querySelector('[role="dialog"]')) return;
      const { scrollToPage } = keyState.current;
      if (e.key === "j" || e.key === "PageDown") {
        e.preventDefault();
        scrollToPage(pageIdxRef.current + 1);
      } else if (e.key === "k" || e.key === "PageUp") {
        e.preventDefault();
        scrollToPage(pageIdxRef.current - 1);
      } else if (e.key === "/") {
        e.preventDefault();
        setFind((f) => f ?? { query: "", at: 0 });
        findInput.current?.focus();
      } else if (e.key === "g") {
        e.preventDefault();
        setGoto({ value: "", error: null });
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // --- placing ---
  const [place, setPlace] = useState<{ req: PlaceRequest; anchor: Anchor } | null>(null);
  const openPlace = useCallback(
    (kind: PlaceRequest["kind"], anchor: Anchor, x: number, y: number) => {
      const page = text.blocks[anchor.block]?.page;
      const label = text.pages.find((p) => p.page === page)?.label ?? String(page ?? "");
      setPlace({
        anchor,
        req: {
          kind,
          x,
          y,
          quote: kind === "selection" ? anchor.quote : (text.blocks[anchor.block]?.text ?? ""),
          pageLabel: label,
          suggestion: placement.suggest({ block: anchor.block, offset: anchor.offset }),
        },
      });
    },
    [text, placement],
  );
  const onSelectEnd = () => {
    if (!canPlace) return;
    // After the browser has finished the selection.
    requestAnimationFrame(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      if (!scroller.current?.contains(range.commonAncestorContainer)) return;
      const span = rangeToSpan(range);
      if (!span) return;
      // (jsdom has no layout: no getBoundingClientRect on ranges)
      const rect = range.getBoundingClientRect?.() ?? { left: 0, bottom: 0 };
      openPlace(
        "selection",
        makeAnchor(text, span.block, span.offset, span.length),
        rect.left,
        rect.bottom,
      );
    });
  };
  const onMarginClick = useCallback(
    (block: number, x: number, y: number) => {
      if (!canPlace) return;
      openPlace("position", makeAnchor(text, block, 0, 0), x, y);
    },
    [canPlace, openPlace, text],
  );
  const onDropAnchor = useCallback(
    (anchorId: string, block: number) => {
      if (canPlace) void placement.move(anchorId, block);
    },
    [canPlace, placement],
  );
  const closePlace = useCallback(() => {
    setPlace(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  // --- hover: a marker's quote is emphasised ---
  const [hot, setHot] = useState<string | null>(null);
  const hotSet = useMemo(() => {
    const s = new Set<string>();
    if (hot) s.add(hot);
    if (flash) for (const a of shown) if (a.cue_id === flash) s.add(a.id);
    return s;
  }, [hot, flash, shown]);
  const actions = useMemo<MarkerActions>(
    () => ({ ...props.actions, onHover: setHot }),
    [props.actions],
  );

  const [navOpen, setNavOpen] = useState(false);
  const current = pages[pageIdx];

  return (
    <div className={styles.reader} data-narrow={narrow || undefined}>
      <nav
        className={styles.navigator}
        aria-label="Script pages"
        data-open={navOpen || undefined}
        data-testid="script-navigator"
      >
        {headings.length > 0 && (
          <>
            <h3>Scenes</h3>
            <ul>
              {headings.map((h) => (
                <li key={h.block}>
                  <button
                    type="button"
                    className={styles.navItem}
                    onClick={() => {
                      scrollToBlock(h.block);
                      setNavOpen(false);
                    }}
                  >
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
              key={p.page}
              type="button"
              aria-current={i === pageIdx ? "page" : undefined}
              aria-label={`Page ${p.label}`}
              onClick={() => {
                scrollToPage(i);
                setNavOpen(false);
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
      </nav>
      <div className={styles.readerMain}>
        {(find || goto) && (
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
                    if (first !== undefined) scrollToBlock(first);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      stepFind(e.shiftKey ? -1 : 1);
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      setFind(null);
                      scroller.current?.focus({ preventScroll: true });
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
                  const i = findPage(pages, goto.value);
                  if (i < 0) {
                    setGoto({ ...goto, error: `No page "${goto.value}"` });
                    return;
                  }
                  scrollToPage(i);
                  setGoto(null);
                  scroller.current?.focus({ preventScroll: true });
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
                      scroller.current?.focus({ preventScroll: true });
                    }
                  }}
                />
                {goto.error && <span className="error">{goto.error}</span>}
              </form>
            )}
          </div>
        )}
        <div
          ref={scroller}
          className={styles.scroller}
          tabIndex={-1}
          onScroll={onScroll}
          onMouseUp={onSelectEnd}
          onKeyUp={(e) => {
            if (e.shiftKey) onSelectEnd();
          }}
          data-testid="script-reader"
          aria-label="Script"
          role="document"
        >
          <div className={styles.stickyHeader} data-testid="script-page-header">
            <button
              type="button"
              className={styles.navToggle}
              aria-expanded={navOpen}
              onClick={() => setNavOpen((o) => !o)}
            >
              Pages
            </button>
            <span>
              Page <strong data-testid="current-page">{current?.label ?? ""}</strong>
              <span className="muted">
                {" "}
                · {pageIdx + 1} of {pages.length}
              </span>
            </span>
            <span className={styles.keysHint}>j/k pages · / find · g go to page</span>
          </div>
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((item) => {
              const p = pages[item.index];
              if (!p) return null;
              return (
                <div
                  key={item.key}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  className={styles.pageSlot}
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  <Page
                    page={p}
                    byBlock={byBlock}
                    cues={cues}
                    openNotes={props.openNotes}
                    fieldOptions={props.fieldOptions}
                    colorBy={props.colorBy}
                    showOthers={props.showOthers}
                    narrow={narrow}
                    canPlace={canPlace}
                    flash={flash}
                    hot={hotSet}
                    activeCue={props.activeCue}
                    findBlock={findBlock}
                    actions={actions}
                    onMarginClick={onMarginClick}
                    onDropAnchor={onDropAnchor}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {place && (
        <PlacePopover
          request={place.req}
          onClose={closePlace}
          searchCues={placement.searchCues}
          onCreate={(input) => placement.create(place.anchor, input)}
          onAttach={(cueId, trigger) => placement.attach(cueId, place.anchor, trigger)}
        />
      )}
    </div>
  );
}

// ---- one page ----

interface PageProps {
  page: PageBlocks;
  byBlock: ReadonlyMap<number, CueAnchorRow[]>;
  cues: ReadonlyMap<string, CueRow>;
  openNotes: ReadonlyMap<string, number>;
  fieldOptions: FieldOptions;
  colorBy: ColorBy;
  showOthers: boolean;
  narrow: boolean;
  canPlace: boolean;
  flash: string | null;
  hot: ReadonlySet<string>;
  activeCue: string | null;
  findBlock: number | null;
  actions: MarkerActions;
  onMarginClick: (block: number, x: number, y: number) => void;
  onDropAnchor: (anchorId: string, block: number) => void;
}

type Measured = ReadonlyMap<number, { top: number; height: number }>;

function sameMeasure(a: Measured, b: Measured): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const w = b.get(k);
    if (!w || w.top !== v.top || w.height !== v.height) return false;
  }
  return true;
}

/** The block at `y` (px from the text column's top): the last block starting at or above it. */
export function blockAtY(
  measured: Measured,
  blocks: readonly ScriptBlock[],
  y: number,
): number | null {
  let found: number | null = blocks[0]?.i ?? null;
  for (const b of blocks) {
    const m = measured.get(b.i);
    if (m && m.top <= y) found = b.i;
  }
  return found;
}

const Page = memo(function Page(p: PageProps) {
  const textRef = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState<Measured>(new Map());
  const measure = useCallback(() => {
    const root = textRef.current;
    if (!root) return;
    const next = new Map<number, { top: number; height: number }>();
    for (const el of root.querySelectorAll<HTMLElement>("[data-block]")) {
      next.set(Number(el.dataset.block), { top: el.offsetTop || 0, height: el.offsetHeight || 0 });
    }
    setMeasured((prev) => (sameMeasure(prev, next) ? prev : next));
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the content changes
  useLayoutEffect(measure, [measure, p.page, p.byBlock, p.narrow]);
  useEffect(() => {
    const root = textRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(root);
    return () => ro.disconnect();
  }, [measure]);

  // Markers of this page, stacked.
  const blockAnchors = p.page.blocks.flatMap((b) => p.byBlock.get(b.i) ?? []);
  const items: StackItem[] = [];
  for (const a of blockAnchors) {
    const top = measured.get(a.block)?.top ?? 0;
    items.push({ key: a.id, top, height: MARKER_HEIGHT });
    const cue = p.cues.get(a.cue_id);
    if (p.showOthers && cue) {
      otherDeptLabels(cue).forEach((label, k) => {
        items.push({ key: `${a.id}:${k}:${label}`, top, height: FAINT_HEIGHT });
      });
    }
  }
  const { tops, bottom } = stackMarkers(items);

  const [expanded, setExpanded] = useState<string | null>(null);
  const dragOver = (e: React.DragEvent) => {
    if (p.canPlace && e.dataTransfer.types.includes(ANCHOR_DRAG_TYPE)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    }
  };
  const marginY = (e: React.MouseEvent<HTMLElement>) =>
    e.clientY - e.currentTarget.getBoundingClientRect().top;

  return (
    <section
      className={styles.page}
      data-testid="script-page"
      data-page={p.page.page}
      aria-label={`Page ${p.page.label}`}
    >
      <div className={styles.gutter} aria-hidden="true">
        {p.page.label}
      </div>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: drop target for dragged markers */}
      <div
        ref={textRef}
        className={styles.textCol}
        onDragOver={dragOver}
        onDrop={(e) => {
          const id = e.dataTransfer.getData(ANCHOR_DRAG_TYPE);
          const el = (e.target as Element).closest<HTMLElement>("[data-block]");
          if (!id || !el) return;
          e.preventDefault();
          p.onDropAnchor(id, Number(el.dataset.block));
        }}
      >
        {p.page.blocks.map((b) => {
          const list = p.byBlock.get(b.i);
          const quotes: QuoteRange[] = (list ?? [])
            .filter((a) => a.length > 0)
            .map((a) => ({ id: a.id, start: a.offset, end: a.offset + a.length }));
          return (
            <BlockText
              key={b.i}
              block={b}
              quotes={quotes}
              hot={p.hot}
              highlight={p.findBlock === b.i}
              data-positional={list?.some((a) => a.length === 0) || undefined}
            >
              {p.narrow && list && list.length > 0 && (
                <span className={styles.badges}>
                  {list.map((a) => {
                    const cue = p.cues.get(a.cue_id);
                    if (!cue) return null;
                    const color = markerColor(cue, p.colorBy, p.fieldOptions);
                    return (
                      <button
                        key={a.id}
                        type="button"
                        className={styles.badge}
                        data-testid="script-marker"
                        data-cue={cue.id}
                        data-state={a.state}
                        data-flash={p.flash === cue.id || undefined}
                        aria-expanded={expanded === a.id}
                        style={markerStyle(color)}
                        onClick={() => setExpanded((x) => (x === a.id ? null : a.id))}
                      >
                        {cueLabel(cue)}
                        {a.state === "changed" || a.state === "missing" ? " ⚠" : ""}
                      </button>
                    );
                  })}
                </span>
              )}
              {p.narrow &&
                list?.map((a) => {
                  const cue = p.cues.get(a.cue_id);
                  if (!cue || expanded !== a.id) return null;
                  return (
                    <span key={`x${a.id}`} className={styles.badgeCard} data-testid="marker-card">
                      <strong>
                        {cueLabel(cue)} · {triggerBadge(cue)}
                      </strong>{" "}
                      {cue.trigger_type === "Line" ? cue.trigger_value : cue.description}
                      <span className={styles.badgeActions}>
                        <button type="button" onClick={() => p.actions.onOpen(cue.id)}>
                          Open
                        </button>
                        <button type="button" onClick={() => p.actions.onShowInList(cue.id)}>
                          Show in list
                        </button>
                      </span>
                    </span>
                  );
                })}
            </BlockText>
          );
        })}
      </div>
      {!p.narrow && (
        // biome-ignore lint/a11y/useKeyWithClickEvents: placing by keyboard is via text selection
        // biome-ignore lint/a11y/noStaticElementInteractions: the margin is a click target
        <div
          className={styles.margin}
          data-testid="script-margin"
          data-can-place={p.canPlace || undefined}
          style={{ minHeight: bottom }}
          onClick={(e) => {
            if (e.target !== e.currentTarget) return; // a marker
            const b = blockAtY(measured, p.page.blocks, marginY(e));
            if (b !== null) p.onMarginClick(b, e.clientX, e.clientY);
          }}
          onDragOver={dragOver}
          onDrop={(e) => {
            const id = e.dataTransfer.getData(ANCHOR_DRAG_TYPE);
            if (!id) return;
            e.preventDefault();
            const b = blockAtY(measured, p.page.blocks, marginY(e));
            if (b !== null) p.onDropAnchor(id, b);
          }}
        >
          {blockAnchors.map((a) => {
            const cue = p.cues.get(a.cue_id);
            if (!cue) return null;
            const top = tops.get(a.id) ?? 0;
            return (
              <div key={a.id}>
                <Marker
                  anchor={a}
                  cue={cue}
                  color={markerColor(cue, p.colorBy, p.fieldOptions)}
                  openNotes={p.openNotes.get(cue.id) ?? 0}
                  top={top}
                  flash={p.flash === cue.id}
                  active={p.activeCue === cue.id}
                  draggable={p.canPlace}
                  actions={p.actions}
                />
                {p.showOthers &&
                  otherDeptLabels(cue).map((label, k) => (
                    <FaintMarker
                      key={label}
                      text={label}
                      top={tops.get(`${a.id}:${k}:${label}`) ?? top}
                    />
                  ))}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
});
