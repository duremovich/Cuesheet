// One page of the PDF page view: the original page drawn by pdf.js (canvas) with its text
// layer on top (selectable, searchable text), an SVG overlay with the cue marks
// (underlined quotes, positional ticks, leader lines) and the cue margin beside it (the
// cue numbers: click → the cue list; positional cues' labels along their leader line).
import type { PDFPageProxy, RenderTask } from "pdfjs-dist";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { FieldOptions } from "../../../../shared/tables";
import { optionColor } from "../../../components/grid/Chip";
import { MenuButton, type MenuEntry } from "../../shared/MenuButton";
import { type ColorBy, markerColor } from "../filters";
import { ANCHOR_DRAG_TYPE, type MarkerActions } from "../Marker";
import { cueLabel, triggerBadge } from "../markers";
import styles from "./PdfReader.module.css";
import type { LoadedPdf } from "./pdfDocument";
import { lineAt, type PdfLine, type Seg } from "./pdfMap";
import { ENTRY_HEIGHT, layoutMarks, type MarkLayout, type PageMark } from "./pdfMarks";
import type { PdfPageData } from "./pdfPages";

/** A position in the text layer: text item `ref` and character. */
export interface GlyphPoint {
  item: number;
  ch: number;
}

/** Width of the number box at the margin's outer edge, px (the leader ends at its left). */
export const NUMBER_W = 50;
/** The leader's bend from the page edge into the margin, px. */
export const ELBOW = 14;
/** Canvas backing store limit (px per side). */
const MAX_CANVAS = 8192;

export interface PdfPageProps {
  pdf: LoadedPdf;
  data: PdfPageData;
  label: string;
  scale: number;
  marginWidth: number;
  /** Narrow screens: numbers only, no labels. */
  compact: boolean;
  marks: readonly PageMark[];
  colorBy: ColorBy;
  fieldOptions: FieldOptions;
  openNotes: ReadonlyMap<string, number>;
  hot: ReadonlySet<string>;
  flash: string | null;
  activeCue: string | null;
  /** The find hit's text on this page. */
  findSegs: readonly Seg[] | null;
  canPlace: boolean;
  actions: MarkerActions;
  /** The cue list URL of a cue (the number is a link to it). */
  listHref: (cueId: string) => string;
  /** A page's text lines (for placing at a height); computed on first use. */
  linesOf: (page: number) => readonly PdfLine[];
  onSelect: (page: number, start: GlyphPoint, end: GlyphPoint, at: DOMRect | null) => void;
  /** A click in the margin at height `y` (points): a positional cue at that line. */
  onMarginClick: (page: number, y: number, clientX: number, clientY: number) => void;
  onDropAnchor: (anchorId: string, page: number, y: number) => void;
}

/** The ink of a cue color on paper (CSS variables; neutral without a color). */
export function inkStyle(color: string | undefined): React.CSSProperties {
  const c = color ? optionColor(color) : null;
  return {
    "--mark-ink": c ? `var(--paper-${c}-ink)` : "var(--paper-accent)",
    "--mark-bg": c ? `var(--paper-${c}-bg)` : "var(--paper-bg)",
  } as React.CSSProperties;
}

/** A DOM selection boundary → the text-layer glyph there (null: not in this layer). */
export function domPointToGlyph(layer: HTMLElement, node: Node, offset: number): GlyphPoint | null {
  if (!layer.contains(node)) return null;
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
  const span = el?.closest<HTMLElement>("[data-item]");
  if (span && layer.contains(span)) {
    const item = Number(span.dataset.item);
    if (node.nodeType === Node.TEXT_NODE) return { item, ch: offset };
    return { item, ch: offset === 0 ? 0 : (span.textContent ?? "").length };
  }
  // Between spans (the boundary is on the layer or a marked-content wrapper): the next span
  // in document order, else the end of the last one.
  const spans = [...layer.querySelectorAll<HTMLElement>("[data-item]")];
  const ref = el?.childNodes[offset] ?? null;
  for (const s of spans) {
    if (
      ref
        ? ref === s || !!(ref.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING)
        : !!(el && el.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING)
    ) {
      return { item: Number(s.dataset.item), ch: 0 };
    }
  }
  const last = spans.at(-1);
  return last ? { item: Number(last.dataset.item), ch: (last.textContent ?? "").length } : null;
}

export const PdfPage = memo(function PdfPage(p: PdfPageProps) {
  const n = p.data.page;
  const W = p.data.width * p.scale;
  const H = p.data.height * p.scale;
  const M = p.marginWidth;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const [proxy, setProxy] = useState<PDFPageProxy | null>(null);
  const [drawn, setDrawn] = useState<{ canvas: number; text: number }>({ canvas: 0, text: 0 });

  useEffect(() => {
    let live = true;
    p.pdf.doc.getPage(n).then(
      (pg) => live && setProxy(pg),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [p.pdf, n]);

  // The page itself (re-drawn when the zoom changes).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!proxy || !canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_CANVAS / Math.max(W, H, 1));
    const viewport = proxy.getViewport({ scale: p.scale * dpr });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    let task: RenderTask | null = null;
    try {
      task = proxy.render({ canvas, viewport });
    } catch {
      return;
    }
    const scale = p.scale;
    task.promise.then(
      () => setDrawn((d) => ({ ...d, canvas: scale })),
      () => undefined, // cancelled (zoom, scrolled away)
    );
    return () => task?.cancel();
  }, [proxy, p.scale, W, H]);

  // The text layer (pdf.js), its spans tagged with their item index.
  useEffect(() => {
    const layer = layerRef.current;
    if (!proxy || !layer) return;
    layer.replaceChildren();
    const tl = new p.pdf.pdfjs.TextLayer({
      textContentSource: p.data.content,
      container: layer,
      viewport: proxy.getViewport({ scale: p.scale }),
    });
    let live = true;
    const scale = p.scale;
    tl.render().then(
      () => {
        if (!live) return;
        tl.textDivs.forEach((d, i) => {
          d.dataset.item = String(i);
        });
        // As pdf.js's viewer does: a block after the text keeps drag-selections in the
        // text instead of jumping to the page's end.
        const end = document.createElement("div");
        end.className = "endOfContent";
        layer.append(end);
        setDrawn((d) => ({ ...d, text: scale }));
      },
      () => undefined,
    );
    return () => {
      live = false;
      tl.cancel();
    };
  }, [proxy, p.pdf, p.data, p.scale]);

  const layout = useMemo(
    () => layoutMarks(p.marks, p.scale, p.data.height),
    [p.marks, p.scale, p.data.height],
  );

  // Placing: a guide at the line under the pointer in the margin.
  const [guide, setGuide] = useState<number | null>(null);
  const yOf = (clientY: number, el: HTMLElement) =>
    (clientY - el.getBoundingClientRect().top) / p.scale;
  const onMouseUp = () => {
    if (!p.canPlace) return;
    layerRef.current?.classList.remove("selecting");
    requestAnimationFrame(() => {
      const layer = layerRef.current;
      const sel = window.getSelection();
      if (!layer || !sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      const start = domPointToGlyph(layer, range.startContainer, range.startOffset);
      if (!start) return;
      // A selection running onto the next page ends with this page.
      const end = domPointToGlyph(layer, range.endContainer, range.endOffset) ?? {
        item: p.data.geom.items.length,
        ch: 0,
      };
      p.onSelect(n, start, end, range.getBoundingClientRect?.() ?? null);
    });
  };

  const dragOver = (e: React.DragEvent) => {
    if (p.canPlace && e.dataTransfer.types.includes(ANCHOR_DRAG_TYPE)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    }
  };

  const lineEnd = W + M - NUMBER_W - 6;
  const rendered = drawn.canvas === p.scale && drawn.text === p.scale;

  return (
    <section
      className={styles.sheet}
      style={{ width: W + M, height: H }}
      data-testid="pdf-page"
      data-page={n}
      data-rendered={rendered || undefined}
      aria-label={`Page ${p.label}`}
      onDragOver={dragOver}
      onDrop={(e) => {
        const id = e.dataTransfer.getData(ANCHOR_DRAG_TYPE);
        if (!id) return;
        e.preventDefault();
        p.onDropAnchor(id, n, yOf(e.clientY, e.currentTarget));
      }}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: text selection (place a cue) */}
      <div
        className={styles.paper}
        style={
          {
            width: W,
            height: H,
            "--total-scale-factor": p.scale,
            "--scale-factor": p.scale,
            "--user-unit": 1,
            "--scale-round-x": "1px",
            "--scale-round-y": "1px",
          } as React.CSSProperties
        }
        onMouseDown={() => layerRef.current?.classList.add("selecting")}
        onMouseUp={onMouseUp}
        onKeyUp={(e) => {
          if (e.shiftKey) onMouseUp();
        }}
      >
        <canvas ref={canvasRef} className={styles.canvas} style={{ width: W, height: H }} />
        <div ref={layerRef} className={`textLayer ${styles.textLayer}`} data-testid="pdf-text" />
      </div>
      <svg
        className={styles.overlay}
        width={W + M}
        height={H}
        viewBox={`0 0 ${W + M} ${H}`}
        aria-hidden="true"
      >
        {p.findSegs?.map((s) => (
          <rect
            key={`find${s.x0}:${s.y}`}
            className={styles.find}
            x={s.x0 * p.scale - 1}
            y={(s.y - s.size * 0.85) * p.scale}
            width={(s.x1 - s.x0) * p.scale + 2}
            height={s.size * 1.1 * p.scale}
          />
        ))}
        {guide !== null && (
          <line
            className={styles.guide}
            x1={0}
            x2={W + M}
            y1={guide * p.scale}
            y2={guide * p.scale}
          />
        )}
        {p.marks.map((m) => {
          const l = layout.get(m.anchor.id);
          if (!l) return null;
          return (
            <MarkShapes
              key={m.anchor.id}
              mark={m}
              layout={l}
              scale={p.scale}
              pageWidth={W}
              lineEnd={lineEnd}
              color={markerColor(m.cue, p.colorBy, p.fieldOptions)}
              hot={p.hot.has(m.anchor.id) || p.flash === m.cue.id}
            />
          );
        })}
      </svg>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: placing by keyboard is in the text view */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the margin is a click target */}
      <div
        className={styles.margin}
        style={{ left: W, width: M, height: H }}
        data-testid="pdf-margin"
        data-can-place={p.canPlace || undefined}
        onMouseMove={(e) => {
          if (!p.canPlace || e.target !== e.currentTarget) return setGuide(null);
          const line = lineAt(p.linesOf(n), yOf(e.clientY, e.currentTarget));
          setGuide(line ? line.top - 1 : null);
        }}
        onMouseLeave={() => setGuide(null)}
        onClick={(e) => {
          if (!p.canPlace || e.target !== e.currentTarget) return;
          p.onMarginClick(n, yOf(e.clientY, e.currentTarget), e.clientX, e.clientY);
        }}
      >
        {p.marks.map((m) => {
          const l = layout.get(m.anchor.id);
          if (!l) return null;
          return (
            <MarginEntry
              key={m.anchor.id}
              mark={m}
              top={l.top}
              compact={p.compact}
              color={markerColor(m.cue, p.colorBy, p.fieldOptions)}
              openNotes={p.openNotes.get(m.cue.id) ?? 0}
              flash={p.flash === m.cue.id}
              active={p.activeCue === m.cue.id}
              draggable={p.canPlace}
              actions={p.actions}
              href={p.listHref(m.cue.id)}
              labelWidth={Math.max(0, M - NUMBER_W - ELBOW - 12)}
            />
          );
        })}
      </div>
    </section>
  );
});

/**
 * One cue's marks on a page (SVG, px = points × scale): the quote's underline (a positional
 * cue: a tick at its line), the leader to the margin (dotted under the rest of a quoted
 * line, a dashed line above a positional cue's line), then into the margin to its number.
 * `hot`: hovered or flashed (the trigger highlighted). Shared with the print layout.
 */
export function MarkShapes({
  mark: m,
  layout: l,
  scale,
  pageWidth: W,
  lineEnd,
  color,
  hot,
}: {
  mark: PageMark;
  layout: MarkLayout;
  scale: number;
  pageWidth: number;
  lineEnd: number;
  color: string | undefined;
  hot: boolean;
}) {
  const s = m.geom.start;
  const lit: Seg[] = m.positional
    ? [{ x0: s.x, x1: s.x + s.size * 0.6, y: s.y, size: s.size }]
    : m.geom.segs;
  return (
    <g
      style={inkStyle(color)}
      className={styles.mark}
      data-anchor={m.anchor.id}
      data-hot={hot || undefined}
      data-warn={m.warn || undefined}
    >
      {hot &&
        lit.map((g) => (
          <rect
            key={`h${g.x0}:${g.y}`}
            className={styles.highlight}
            x={g.x0 * scale - 2}
            y={(g.y - g.size * 0.85) * scale}
            width={(g.x1 - g.x0) * scale + 4}
            height={g.size * 1.15 * scale}
          />
        ))}
      {!m.positional &&
        m.geom.segs.map((g, k) => (
          <line
            key={`u${g.x0}:${g.y}`}
            className={styles.underline}
            data-testid={k === 0 ? "pdf-underline" : undefined}
            data-anchor={m.anchor.id}
            x1={g.x0 * scale}
            x2={g.x1 * scale}
            y1={(g.y + g.size * 0.2) * scale}
            y2={(g.y + g.size * 0.2) * scale}
          />
        ))}
      {m.positional && (
        <line
          className={styles.tick}
          data-testid="pdf-tick"
          x1={l.fromX}
          x2={l.fromX}
          y1={l.fromY}
          y2={(s.y + s.size * 0.2) * scale}
        />
      )}
      <polyline
        className={m.positional ? styles.goLine : styles.leaderOnPage}
        data-testid="pdf-leader"
        points={`${l.fromX},${l.fromY} ${W},${l.fromY}`}
      />
      <polyline
        className={styles.leader}
        points={`${W},${l.fromY} ${W + ELBOW},${l.lineY} ${lineEnd},${l.lineY}`}
      />
    </g>
  );
}

const STATE_LABEL: Record<string, string> = {
  changed: "The line changed in this version: check the placement",
  stale: "The text here no longer matches the cue's quote: check the placement",
};

function MarginEntry({
  mark,
  top,
  compact,
  color,
  openNotes,
  flash,
  active,
  draggable,
  actions,
  href,
  labelWidth,
}: {
  mark: PageMark;
  top: number;
  compact: boolean;
  color: string | undefined;
  openNotes: number;
  flash: boolean;
  active: boolean;
  draggable: boolean;
  actions: MarkerActions;
  href: string;
  labelWidth: number;
}) {
  const { cue, anchor } = mark;
  const label = cueLabel(cue);
  const badge = triggerBadge(cue);
  const items: MenuEntry[] = [
    { label: "Open cue", onSelect: () => actions.onOpen(cue.id) },
    { label: "Show in list", onSelect: () => actions.onShowInList(cue.id) },
  ];
  if (actions.onRemove) {
    const remove = actions.onRemove;
    items.push({ label: "Remove from script", onSelect: () => remove(anchor.id) });
  }
  const text = [mark.label, ...mark.others].filter(Boolean).join("  ");
  const warnText = anchor.state === "changed" ? STATE_LABEL.changed : STATE_LABEL.stale;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover only highlights the trigger
    <div
      className={styles.entry}
      style={{ top, height: ENTRY_HEIGHT, ...inkStyle(color) }}
      data-testid="pdf-marker"
      data-cue={cue.id}
      data-anchor={anchor.id}
      data-state={anchor.state}
      data-positional={mark.positional || undefined}
      data-warn={mark.warn || undefined}
      data-flash={flash || undefined}
      data-active={active || undefined}
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData(ANCHOR_DRAG_TYPE, anchor.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onMouseEnter={() => actions.onHover?.(anchor.id)}
      onMouseLeave={() => actions.onHover?.(null)}
    >
      <div className={styles.entryMenu}>
        <MenuButton label={`More actions for ${label}`} items={items}>
          ⋯
        </MenuButton>
      </div>
      {!compact && text && (
        <button
          type="button"
          className={styles.entryLabel}
          style={{ maxWidth: labelWidth }}
          data-testid="pdf-marker-label"
          title={[badge, cue.trigger_value, cue.description].filter(Boolean).join(" · ")}
          onClick={() => actions.onOpen(cue.id)}
        >
          {text}
        </button>
      )}
      <a
        className={styles.number}
        href={href}
        data-testid="pdf-cue-number"
        aria-label={`${label}${badge ? ` · ${badge}` : ""}: show in the cue list${mark.warn ? " (check the placement)" : ""}`}
        onClick={(e) => {
          if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          actions.onShowInList(cue.id);
        }}
      >
        {cue.number?.trim() || "–"}
        {openNotes > 0 && (
          <span
            className={styles.notesDot}
            data-testid="marker-notes"
            title={`${openNotes} open ${openNotes === 1 ? "note" : "notes"}`}
          />
        )}
        {mark.warn && (
          <span className={styles.warn} data-testid="marker-warning" title={warnText}>
            ⚠
          </span>
        )}
      </a>
    </div>
  );
}
