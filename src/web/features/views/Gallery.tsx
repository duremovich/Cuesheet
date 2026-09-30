// Gallery layout of a saved view (R19; ux.md §Images): one card per row with its first
// image large (or a placeholder with its name) and the view's first four visible fields
// beneath. Same rows, groups, filters, sorts and colors as the grid (the view computes
// them). Rows of cards are virtualized. Keys: arrows move, Home/End, Enter opens the image
// (else the panel), Space opens the row panel, Escape as the grid's. Implements the grid's
// handle (focusRow / stepRow / scrollToRow) so the tab's URL focus and panel work as-is.
// biome-ignore-all lint/a11y/useSemanticElements: an ARIA grid over absolutely positioned, virtualized rows of cards
// biome-ignore-all lint/a11y/useFocusableInteractive: APG grid pattern: only the active card is in the tab order (roving tabindex)
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type CSSProperties,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { AttachmentRow } from "../../../shared/tables";
import { optionColor } from "../../components/grid/Chip";
import type { ColorRule, Column, DataGridHandle, Group } from "../../components/grid/types";
import { formatValue } from "../../components/grid/values";
import { Thumb } from "../attachments/Attachments";
import styles from "./Gallery.module.css";
import {
  cardRowHeight,
  cardWidth,
  type GalleryKey,
  galleryColumns,
  galleryItems,
  HEADER_HEIGHT,
  moveInGallery,
} from "./gallery";

const FIELDS_SHOWN = 4;
const KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]);

export interface GalleryProps<V> {
  ref?: Ref<DataGridHandle>;
  "aria-label": string;
  rows?: V[];
  groups?: Group<V>[];
  rowId: (v: V) => string;
  /** The view's visible columns in order: the first FIELDS_SHOWN (minus the title) show. */
  columns: Column<V>[];
  /** Column shown as the card's title (not repeated among the fields). */
  titleKey: string;
  title: (v: V) => string;
  image: (v: V) => AttachmentRow | undefined;
  showId: string;
  colorRules?: ColorRule<V>[];
  onActiveRowChange?: (id: string | null) => void;
  onOpenRow?: (id: string) => void;
  onOpenImage?: (v: V, file: AttachmentRow) => void;
  onEscape?: () => void;
}

export function Gallery<V>(p: GalleryProps<V>) {
  const { rowId } = p;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const cols = width > 0 ? galleryColumns(width) : 1;
  const cw = width > 0 ? cardWidth(width, cols) : 200;

  const fields = useMemo(
    () =>
      p.columns
        .filter((c) => c.key !== p.titleKey && c.type !== "attachment")
        .slice(0, FIELDS_SHOWN),
    [p.columns, p.titleKey],
  );
  const rowH = cardRowHeight(cw, fields.length);
  const items = useMemo(
    () => galleryItems(p.groups ? { groups: p.groups } : { rows: p.rows ?? [] }, cols, rowId),
    [p.groups, p.rows, cols, rowId],
  );
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const byId = useMemo(() => {
    const m = new Map<string, { v: V; item: number }>();
    items.forEach((it, i) => {
      if (it.kind === "cards") for (const v of it.cards) m.set(rowId(v), { v, item: i });
    });
    return m;
  }, [items, rowId]);
  const byIdRef = useRef(byId);
  byIdRef.current = byId;

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (items[i]?.kind === "header" ? HEADER_HEIGHT : rowH),
    overscan: 3,
    getItemKey: (i) => items[i]?.key ?? i,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: sizes change with the card width
  useEffect(() => virtualizer.measure(), [rowH, cols]);

  // --- Active card (roving tabindex) ---
  const [active, setActive] = useState<string | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const onActiveRowChange = p.onActiveRowChange;
  const activate = useCallback(
    (id: string | null) => {
      if (activeRef.current === id) return;
      activeRef.current = id;
      setActive(id);
      onActiveRowChange?.(id);
    },
    [onActiveRowChange],
  );
  const pendingFocus = useRef<string | null>(null);
  /** A card to bring into view once the layout is known (the first render has no width). */
  const pendingScroll = useRef<string | null>(null);
  const [, rerender] = useState(0);
  const widthRef = useRef(width);
  widthRef.current = width;
  const scrollTo = useCallback(
    (id: string) => {
      if (widthRef.current === 0) {
        pendingScroll.current = id;
        rerender((n) => n + 1);
        return;
      }
      const at = byIdRef.current.get(id);
      if (at) virtualizer.scrollToIndex(at.item, { align: "auto" });
    },
    [virtualizer],
  );
  const focusCard = useCallback(
    (id: string) => {
      activate(id);
      pendingFocus.current = id;
      scrollTo(id);
      rerender((n) => n + 1);
    },
    [activate, scrollTo],
  );
  // After each render: a scroll that waited for the width, then the focus a card was
  // promised once it's rendered (virtualized rows appear after the scroll).
  useEffect(() => {
    const scrollId = pendingScroll.current;
    if (scrollId && width > 0) {
      pendingScroll.current = null;
      const at = byIdRef.current.get(scrollId);
      if (at) virtualizer.scrollToIndex(at.item, { align: "auto" });
    }
    const id = pendingFocus.current;
    if (!id) return;
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(id)}"]`);
    if (el) {
      pendingFocus.current = null;
      el.focus({ preventScroll: true });
    }
  });

  useImperativeHandle(
    p.ref,
    () => ({
      focusRow: (id) => {
        if (byIdRef.current.has(id)) focusCard(id);
      },
      stepRow: (delta) => {
        const next = moveInGallery(
          itemsRef.current,
          rowId,
          activeRef.current,
          delta > 0 ? "ArrowRight" : "ArrowLeft",
        );
        if (next) {
          activate(next);
          scrollTo(next);
        }
        return next ?? activeRef.current;
      },
      scrollToRow: (id) => scrollTo(id),
    }),
    [focusCard, activate, scrollTo, rowId],
  );

  const firstId = useMemo(() => {
    for (const it of items) if (it.kind === "cards" && it.cards[0]) return rowId(it.cards[0]);
    return null;
  }, [items, rowId]);
  const tabbable = active && byId.has(active) ? active : firstId;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
    const id = activeRef.current;
    if (KEYS.has(e.key)) {
      e.preventDefault();
      const next = moveInGallery(items, rowId, id, e.key as GalleryKey);
      if (next) focusCard(next);
      return;
    }
    if (!id) return;
    const entry = byId.get(id);
    if (e.key === " ") {
      e.preventDefault();
      p.onOpenRow?.(id);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const file = entry ? p.image(entry.v) : undefined;
      if (entry && file && p.onOpenImage) p.onOpenImage(entry.v, file);
      else p.onOpenRow?.(id);
    } else if (e.key === "Escape") {
      p.onEscape?.();
    }
  };

  const colorOf = (v: V): string | undefined => {
    for (const r of p.colorRules ?? []) {
      if (!r.row) continue;
      try {
        if (r.when(v)) return optionColor(r.row);
      } catch {
        // a rule that throws doesn't match
      }
    }
    return undefined;
  };

  const vItems = virtualizer.getVirtualItems();
  return (
    <div
      ref={scrollRef}
      className={styles.gallery}
      role="grid"
      aria-label={p["aria-label"]}
      aria-colcount={cols}
      data-testid="gallery"
      data-columns={cols}
      onKeyDown={onKeyDown}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {vItems.map((vi) => {
          const it = items[vi.index];
          if (!it) return null;
          const style: CSSProperties = {
            transform: `translateY(${vi.start}px)`,
            height: vi.size,
          };
          if (it.kind === "header") {
            return (
              <div
                key={it.key}
                role="row"
                className={styles.header}
                style={style}
                data-testid="gallery-group"
              >
                <div role="columnheader" aria-colspan={cols}>
                  <span className={styles.groupTitle}>{it.group.title}</span>
                  {it.group.subtitle && (
                    <span className={styles.muted}> · {it.group.subtitle}</span>
                  )}
                  <span className={styles.count}>{it.count}</span>
                </div>
              </div>
            );
          }
          return (
            <div
              key={it.key}
              role="row"
              className={styles.row}
              style={{ ...style, gridTemplateColumns: `repeat(${cols}, ${cw}px)` }}
            >
              {it.cards.map((v) => {
                const id = rowId(v);
                const file = p.image(v);
                const title = p.title(v);
                const color = colorOf(v);
                return (
                  // biome-ignore lint/a11y/useKeyWithClickEvents: keys are handled on the grid
                  <div
                    key={id}
                    role="gridcell"
                    className={styles.card}
                    tabIndex={id === tabbable ? 0 : -1}
                    aria-selected={id === active}
                    aria-label={title}
                    data-card-id={id}
                    data-testid="gallery-card"
                    data-colored={color ? true : undefined}
                    style={color ? { background: `var(--option-${color}-bg)` } : undefined}
                    onFocus={() => activate(id)}
                    onClick={() => {
                      activate(id);
                      p.onOpenRow?.(id);
                    }}
                  >
                    <div className={styles.image} style={{ height: Math.round(cw * 0.75) }}>
                      {file ? (
                        <Thumb
                          key={file.id}
                          file={file}
                          size="fill"
                          showId={p.showId}
                          testId="gallery-image"
                        />
                      ) : (
                        <span className={styles.placeholder}>{title}</span>
                      )}
                    </div>
                    <div className={styles.title} title={title}>
                      {title}
                    </div>
                    <dl className={styles.fields}>
                      {fields.map((c) => {
                        const text = formatValue(c, c.getValue(v));
                        return (
                          <div key={c.key} className={styles.field}>
                            <dt>{c.title}</dt>
                            <dd>{text || "—"}</dd>
                          </div>
                        );
                      })}
                    </dl>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      {items.length === 0 && <p className={styles.empty}>No rows to show.</p>}
    </div>
  );
}
