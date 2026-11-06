// The PDF page view (the Script tab's default for a version whose original is a PDF): the
// original pages exactly as the file draws them (pdf.js canvas + its text layer, so text
// selects and the browser's find works), with a cue margin beside each page. Every placed
// cue gets its number in the margin (a link to the cue list) and a leader line to its
// trigger: quoted text is underlined in the cue's color; a positional cue (LX, timecode,
// visual…) gets a tick at its line, a line above it, and a label along the leader.
// Missing anchors, and anchors whose text couldn't be found in the PDF, are listed in the
// navigator. Pages are virtualized (a 100-page script renders only what's on screen) and
// the document is cached (pdfDocument.ts). Same keys as the text reader; zoom: fit width,
// −/+. Editors on the current version select text to place a cue, click the margin for a
// positional cue at that line, and drag numbers onto another line.
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { anchorTarget, captureAnchors } from "../../../lib/scrollMemory";
import { useMediaQuery } from "../../shared/useMediaQuery";
import { rowUrl } from "../../show/tabs";
import type { Anchor, CueAnchorRow } from "../contract";
import { makeAnchor } from "../contract";
import { matchesMarker } from "../filters";
import type { MarkerActions } from "../Marker";
import { cueLabel, findPage, headingsOf, isPlaced, NEEDS_LOOK, pagesOf } from "../markers";
import { PlacePopover, type PlaceRequest } from "../PlacePopover";
import { makeLineAnchor, placeRequestFor, spanAnchor } from "../placement";
import type { ReaderProps } from "../Reader";
import { ScriptNavigator, useFindGoto, useReaderKeys } from "../ReaderChrome";
import scriptStyles from "../Script.module.css";
import { type GlyphPoint, PdfPage } from "./PdfPage";
import styles from "./PdfReader.module.css";
import { canvasMeasure, glyphMapOf, type LoadedPdf, usePdf } from "./pdfDocument";
import {
  blockSegs,
  lineAt,
  type PageGlyphIndex,
  type PdfLine,
  pageGlyphIndex,
  pageLines,
  selectionSpan,
} from "./pdfMap";
import { buildMarks, leaderStart, type PageMark } from "./pdfMarks";
import { MAX_SCALE, MIN_SCALE, type Zoom } from "./zoom";

const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
/** Margin width, px: number + label; numbers only on narrow screens. */
const MARGIN = 230;
const MARGIN_NARROW = 64;
const PAGE_GAP = 16;
const PAD = 16;
const FLASH_MS = 2400;
const NONE: string[] = [];
const NO_MARKS: PageMark[] = [];

export interface PdfReaderProps extends ReaderProps {
  showId: string;
  pdfUrl: string;
  zoom: Zoom;
  onZoom: (z: Zoom) => void;
  /** The PDF couldn't be opened: offer the text view. */
  onUseText: () => void;
}

/** Lazily loaded by the Script tab (`ScriptPage`): text-only shows never load it. */
export default function PdfReader(props: PdfReaderProps) {
  const { pdf, error } = usePdf(props.pdfUrl);
  if (error) {
    return (
      <div className={scriptStyles.banner} data-kind="warning" role="status">
        {error}
        <button type="button" className={scriptStyles.linkButton} onClick={props.onUseText}>
          Read the extracted text instead
        </button>
      </div>
    );
  }
  if (!pdf) {
    return (
      <p className="muted" data-testid="pdf-loading">
        Opening the PDF…
      </p>
    );
  }
  return <LoadedReader {...props} pdf={pdf} />;
}

function LoadedReader(props: PdfReaderProps & { pdf: LoadedPdf }) {
  const { pdf, text, anchors, cues, assignees, filter, canPlace, placement } = props;
  const narrow = useMediaQuery("(max-width: 600px)");
  const marginW = narrow ? MARGIN_NARROW : MARGIN;
  const map = useMemo(() => glyphMapOf(pdf, text), [pdf, text]);
  const geomOf = useCallback((page: number) => pdf.pages[page - 1]?.geom, [pdf]);

  // --- which cues ---
  const visible = useMemo(
    () =>
      anchors.filter((a) => {
        const cue = cues.get(a.cue_id);
        return !!cue && matchesMarker(cue, assignees.get(cue.id) ?? NONE, filter);
      }),
    [anchors, cues, assignees, filter],
  );
  const { byPage, unlocated } = useMemo(
    () =>
      buildMarks({
        anchors: visible.filter(isPlaced),
        cues,
        text,
        map,
        geomOf,
        measure: canvasMeasure,
        showOthers: props.showOthers,
      }),
    [visible, cues, text, map, geomOf, props.showOthers],
  );
  const missing = useMemo(() => visible.filter((a) => !isPlaced(a)), [visible]);
  const markOf = useCallback(
    (cueId: string) => {
      for (const list of byPage.values()) {
        const m = list.find((x) => x.cue.id === cueId);
        if (m) return m;
      }
      return null;
    },
    [byPage],
  );

  // --- pages, labels, zoom ---
  const labels = useMemo(() => new Map(text.pages.map((p) => [p.page, p.label])), [text]);
  const labelOf = useCallback((n: number) => labels.get(n) ?? String(n), [labels]);
  const navPages = useMemo(
    () => pdf.pages.map((p) => ({ key: p.page, label: labelOf(p.page) })),
    [pdf, labelOf],
  );
  const headings = useMemo(() => headingsOf(text), [text]);
  const scroller = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 0, room: 0 });
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () =>
      setBox({
        width: el.clientWidth,
        room: Math.max(0, el.clientHeight - (headerRef.current?.offsetHeight ?? 0)),
      });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const maxW = useMemo(() => Math.max(1, ...pdf.pages.map((p) => p.width)), [pdf]);
  const ready = box.width > 0;
  const fit = Math.min(MAX_SCALE, Math.max(MIN_SCALE, (box.width - 2 * PAD - marginW) / maxW));
  const scale = props.zoom === "fit" ? fit : props.zoom;
  const stepZoom = (d: 1 | -1) => {
    const next =
      d > 0
        ? ZOOM_STEPS.find((z) => z > scale + 0.001)
        : [...ZOOM_STEPS].reverse().find((z) => z < scale - 0.001);
    if (next !== undefined) props.onZoom(next);
  };

  const virtualizer = useVirtualizer({
    count: pdf.pages.length,
    getScrollElement: () => scroller.current,
    estimateSize: (i) => (pdf.pages[i]?.height ?? 792) * scale + PAGE_GAP,
    getItemKey: (i) => pdf.pages[i]?.page ?? i,
    overscan: 1,
    paddingEnd: box.room,
  });
  // A new zoom keeps the reading position (the same point of the same page stays put).
  const lastScale = useRef(scale);
  // biome-ignore lint/correctness/useExhaustiveDependencies: page sizes follow the zoom
  useLayoutEffect(() => {
    const el = scroller.current;
    const old = lastScale.current;
    lastScale.current = scale;
    virtualizer.measure();
    if (!el || old === scale) return;
    let y = 0;
    let i = 0;
    for (; i < pdf.pages.length; i++) {
      const h = (pdf.pages[i]?.height ?? 0) * old + PAGE_GAP;
      if (y + h > el.scrollTop) break;
      y += h;
    }
    let ny = 0;
    for (let k = 0; k < i; k++) ny += (pdf.pages[k]?.height ?? 0) * scale + PAGE_GAP;
    el.scrollTop = ny + (el.scrollTop - y) * (scale / old);
  }, [scale]);
  const [pageIdx, setPageIdx] = useState(0);
  const pageIdxRef = useRef(0);
  pageIdxRef.current = pageIdx;
  // Page tops (px, in the list): sizes are known, so no measuring.
  const tops = useMemo(() => {
    const out: number[] = [];
    let y = 0;
    for (const p of pdf.pages) {
      out.push(y);
      y += p.height * scale + PAGE_GAP;
    }
    return out;
  }, [pdf, scale]);
  /** The current page: the one at the middle of the visible script. */
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const header = headerRef.current?.offsetHeight ?? 0;
    const mid = el.scrollTop + (el.clientHeight - header) / 2;
    let i = 0;
    while (i + 1 < tops.length && (tops[i + 1] as number) <= mid) i++;
    if (i !== pageIdxRef.current) setPageIdx(i);
  };
  // --- scroll memory (props.restore / onScrollPositionChange): `p:<page>` + how far into
  // it, so a remembered spot survives a zoom change and matches the text view's anchors ---
  const pageBox = (key: string) => {
    const i = key.startsWith("p:") ? Number(key.slice(2)) - 1 : -1;
    const p = pdf.pages[i];
    return p ? { start: tops[i] ?? 0, size: p.height * scale + PAGE_GAP } : undefined;
  };
  const onPosition = props.onScrollPositionChange;
  const reportPosition = () => {
    const el = scroller.current;
    if (!el || !onPosition || !ready) return;
    const items = pdf.pages.map((p, i) => ({
      key: `p:${p.page}`,
      start: tops[i] ?? 0,
      size: p.height * scale + PAGE_GAP,
    }));
    onPosition({
      anchors: captureAnchors(items, el.scrollTop, 2),
      top: el.scrollTop,
      left: el.scrollLeft,
    });
  };
  const restoredKey = useRef<string | null>(null);
  const [, bump] = useState(0);
  // Page sizes are known up front: one jump, once the width (so the fit zoom) is known,
  // before that frame paints.
  useLayoutEffect(() => {
    const el = scroller.current;
    const r = props.restore;
    if (!el || !ready || !r?.position || r.key === restoredKey.current) return;
    restoredKey.current = r.key;
    el.scrollTop = anchorTarget(r.position.anchors, pageBox, "frac") ?? r.position.top;
    el.scrollLeft = r.position.left;
    virtualizer.scrollOffset = el.scrollTop; // lay out the restored pages in this commit
    onScroll();
    bump((n) => n + 1);
  });
  const scrollToPage = useCallback(
    (idx: number) => {
      const i = Math.max(0, Math.min(idx, pdf.pages.length - 1));
      virtualizer.scrollToIndex(i, { align: "start" });
      setPageIdx(i);
    },
    [virtualizer, pdf.pages.length],
  );
  /** A point of a page (points from its top) to the middle of the view. */
  const scrollToPoint = useCallback(
    (page: number, y: number) => {
      const el = scroller.current;
      const idx = page - 1;
      if (!el || idx < 0) return;
      const start = tops[idx] ?? 0;
      const header = headerRef.current?.offsetHeight ?? 0;
      el.scrollTo({ top: Math.max(0, start + y * scale - (el.clientHeight - header) / 2) });
      setPageIdx(idx);
    },
    [tops, scale],
  );
  const scrollToBlock = useCallback(
    (block: number) => {
      const g = map[block];
      const page = g?.page ?? text.blocks[block]?.page;
      if (!page) return;
      const geom = geomOf(page);
      const segs = g && geom ? blockSegs(g, 0, g.item.length, geom, canvasMeasure) : [];
      scrollToPoint(page, segs[0]?.y ?? 0);
    },
    [map, text, geomOf, scrollToPoint],
  );

  // --- flash (Show in script, a new cue) ---
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
  const markOfRef = useRef(markOf);
  markOfRef.current = markOf;
  const { onFocusMissing, onFocusHandled } = props;
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs per request (nonce)
  useEffect(() => {
    const req = props.focusRequest;
    // Wait for the first layout (the zoom depends on the view's width).
    if (!req || !ready) return;
    const a = anchorsRef.current.find((x) => x.cue_id === req.cueId && isPlaced(x));
    onFocusHandled?.();
    if (!a) {
      onFocusMissing?.(req.cueId);
      return;
    }
    const m = markOfRef.current(req.cueId);
    if (m) scrollToPoint(m.geom.page, leaderStart(m).y);
    else scrollToBlock(a.block);
    flashCue(req.cueId);
  }, [props.focusRequest?.nonce, props.focusRequest?.cueId, ready]);

  // --- find / go to / keys ---
  const findGoto = useFindGoto({
    text,
    findPage: (label) =>
      findPage(
        navPages.map((p) => ({ page: p.key, label: p.label, blocks: [] })),
        label,
      ),
    toBlock: scrollToBlock,
    toPage: scrollToPage,
    focusBack: () => scroller.current?.focus({ preventScroll: true }),
  });
  useReaderKeys({
    next: () => scrollToPage(pageIdxRef.current + 1),
    prev: () => scrollToPage(pageIdxRef.current - 1),
    find: findGoto.openFind,
    goto: findGoto.openGoto,
  });
  const findSegs = useMemo(() => {
    const b = findGoto.findBlock;
    const g = b === null ? null : map[b];
    const geom = g ? geomOf(g.page) : undefined;
    if (!g || !geom) return null;
    return { page: g.page, segs: blockSegs(g, 0, g.item.length, geom, canvasMeasure) };
  }, [findGoto.findBlock, map, geomOf]);

  // --- placing ---
  const [place, setPlace] = useState<{ req: PlaceRequest; anchor: Anchor } | null>(null);
  const openPlace = useCallback(
    (kind: PlaceRequest["kind"], anchor: Anchor, x: number, y: number, lines = 1) => {
      const suggestion = placement.suggest({ block: anchor.block, offset: anchor.offset });
      setPlace({ anchor, req: placeRequestFor(text, kind, anchor, { x, y, lines, suggestion }) });
    },
    [text, placement],
  );
  const pickNextLine = useCallback(() => {
    setPlace((cur) => {
      if (!cur) return cur;
      const next = text.blocks[cur.anchor.block + 1];
      if (!next) return cur;
      const anchor = makeAnchor(text, next.i, 0, next.text.length);
      const suggestion = placement.suggest({ block: anchor.block, offset: 0 });
      return {
        anchor,
        req: placeRequestFor(text, "selection", anchor, { x: cur.req.x, y: cur.req.y, suggestion }),
      };
    });
  }, [text, placement]);
  const closePlace = useCallback(() => {
    setPlace(null);
    window.getSelection()?.removeAllRanges();
  }, []);
  const indexes = useRef(new Map<number, PageGlyphIndex>());
  const lines = useRef(new Map<number, PdfLine[]>());
  // biome-ignore lint/correctness/useExhaustiveDependencies: caches belong to one map
  useEffect(() => {
    indexes.current.clear();
    lines.current.clear();
  }, [map]);
  const linesOf = useCallback(
    (page: number) => {
      let l = lines.current.get(page);
      const geom = geomOf(page);
      if (!l && geom) {
        l = pageLines(map, page, geom, canvasMeasure);
        lines.current.set(page, l);
      }
      return l ?? [];
    },
    [map, geomOf],
  );
  const onSelect = useCallback(
    (page: number, start: GlyphPoint, end: GlyphPoint, at: DOMRect | null) => {
      if (!canPlace) return;
      const geom = geomOf(page);
      if (!geom) return;
      let index = indexes.current.get(page);
      if (!index) {
        index = pageGlyphIndex(map, page, geom);
        indexes.current.set(page, index);
      }
      const span = selectionSpan(text, index, start, end);
      if (!span) return;
      openPlace(
        "selection",
        spanAnchor(text, span),
        at?.left ?? 0,
        at?.bottom ?? 0,
        span.endBlock - span.block + 1,
      );
    },
    [canPlace, geomOf, map, text, openPlace],
  );
  const onMarginClick = useCallback(
    (page: number, y: number, x: number, cy: number) => {
      if (!canPlace) return;
      const line = lineAt(linesOf(page), y);
      if (line) openPlace("position", makeLineAnchor(text, line.block, line.offset), x, cy);
    },
    [canPlace, linesOf, text, openPlace],
  );
  const onDropAnchor = useCallback(
    (anchorId: string, page: number, y: number) => {
      if (!canPlace) return;
      const line = lineAt(linesOf(page), y);
      if (line) void placement.move(anchorId, line.block, line.offset);
    },
    [canPlace, linesOf, placement],
  );

  // --- hover ---
  const [hot, setHot] = useState<string | null>(null);
  const hotSet = useMemo(() => new Set(hot ? [hot] : []), [hot]);
  const actions = useMemo<MarkerActions>(
    () => ({ ...props.actions, onHover: setHot }),
    [props.actions],
  );
  const listHref = useCallback(
    (cueId: string) => rowUrl(props.showId, "cues", cueId),
    [props.showId],
  );

  const [navOpen, setNavOpen] = useState(false);
  const sheetW = maxW * scale + marginW;
  const pagesInText = useMemo(() => pagesOf(text).length, [text]);
  const noPlace = missing.length + unlocated.length;

  return (
    <div className={scriptStyles.reader} data-narrow={narrow || undefined} data-testid="pdf-view">
      <ScriptNavigator
        headings={headings}
        pages={navPages}
        current={pageIdx}
        open={navOpen}
        onHeading={(b) => {
          scrollToBlock(b);
          setNavOpen(false);
        }}
        onPage={(i) => {
          scrollToPage(i);
          setNavOpen(false);
        }}
      >
        {noPlace > 0 && (
          <>
            <h3>Not on a page ({noPlace})</h3>
            <ul data-testid="pdf-unplaced">
              {missing.map((a) => (
                <UnplacedItem
                  key={a.id}
                  anchor={a}
                  cueText={cueLabel(cues.get(a.cue_id))}
                  why="Not found in this version"
                  onOpen={props.actions.onOpen}
                />
              ))}
              {unlocated.map((a) => (
                <UnplacedItem
                  key={a.id}
                  anchor={a}
                  cueText={cueLabel(cues.get(a.cue_id))}
                  why={`Page ${labelOf(text.blocks[a.block]?.page ?? 0)}: its text wasn't found in the PDF`}
                  onOpen={props.actions.onOpen}
                />
              ))}
            </ul>
          </>
        )}
      </ScriptNavigator>
      <div className={scriptStyles.readerMain}>
        {findGoto.bar}
        <div
          ref={scroller}
          className={`${scriptStyles.scroller} ${styles.scroller}`}
          tabIndex={-1}
          onScroll={() => {
            onScroll();
            reportPosition();
          }}
          data-testid="pdf-reader"
          data-scale={scale.toFixed(3)}
          aria-label="Script (PDF pages)"
          role="document"
        >
          <div
            ref={headerRef}
            className={scriptStyles.stickyHeader}
            data-testid="script-page-header"
          >
            <button
              type="button"
              className={scriptStyles.navToggle}
              aria-expanded={navOpen}
              onClick={() => setNavOpen((o) => !o)}
            >
              Pages
            </button>
            <span>
              Page <strong data-testid="current-page">{labelOf(pageIdx + 1)}</strong>
              <span className="muted">
                {" "}
                · {pageIdx + 1} of {pdf.pages.length}
              </span>
            </span>
            <span className={styles.zoom}>
              <button type="button" aria-label="Zoom out" onClick={() => stepZoom(-1)}>
                −
              </button>
              <span data-testid="pdf-zoom">{Math.round(scale * 100)}%</span>
              <button type="button" aria-label="Zoom in" onClick={() => stepZoom(1)}>
                +
              </button>
              <button
                type="button"
                aria-pressed={props.zoom === "fit"}
                onClick={() => props.onZoom("fit")}
              >
                Fit width
              </button>
            </span>
            <span className={scriptStyles.keysHint}>j/k pages · / find · g go to page</span>
          </div>
          {pagesInText > 0 && pdf.pages.length !== pagesInText && (
            <p className={styles.note}>
              The extracted text has {pagesInText} pages with text; the PDF has {pdf.pages.length}.
            </p>
          )}
          <div
            className={styles.pages}
            style={{ height: virtualizer.getTotalSize(), minWidth: sheetW + 2 * PAD }}
          >
            {(ready ? virtualizer.getVirtualItems() : []).map((item) => {
              const data = pdf.pages[item.index];
              if (!data) return null;
              return (
                <div
                  key={item.key}
                  className={styles.slot}
                  style={{ transform: `translateY(${item.start}px)`, height: item.size }}
                >
                  <PdfPage
                    pdf={pdf}
                    data={data}
                    label={labelOf(data.page)}
                    scale={scale}
                    marginWidth={marginW}
                    compact={narrow}
                    marks={byPage.get(data.page) ?? NO_MARKS}
                    colorBy={props.colorBy}
                    fieldOptions={props.fieldOptions}
                    openNotes={props.openNotes}
                    hot={hotSet}
                    flash={flash}
                    activeCue={props.activeCue}
                    findSegs={findSegs?.page === data.page ? findSegs.segs : null}
                    canPlace={canPlace}
                    actions={actions}
                    listHref={listHref}
                    linesOf={linesOf}
                    onSelect={onSelect}
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
          key={`${place.anchor.block}:${place.anchor.offset}:${place.anchor.length}`}
          request={place.req}
          onUseNextLine={pickNextLine}
          onClose={closePlace}
          searchCues={placement.searchCues}
          onCreate={(input) => placement.create(place.anchor, input)}
          onAttach={(cueId, trigger) => placement.attach(cueId, place.anchor, trigger)}
        />
      )}
    </div>
  );
}

function UnplacedItem({
  anchor,
  cueText,
  why,
  onOpen,
}: {
  anchor: CueAnchorRow;
  cueText: string;
  why: string;
  onOpen: (cueId: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        className={scriptStyles.navItem}
        title={why}
        data-state={anchor.state}
        onClick={() => onOpen(anchor.cue_id)}
      >
        <span className={scriptStyles.navLabel}>{cueText}</span>
        {NEEDS_LOOK.includes(anchor.state) ? "⚠ " : ""}
        {why}
      </button>
    </li>
  );
}
