// The calling script on the original PDF's pages (/shows/:id/script/print?layout=pdf): one
// sheet per page, the page as drawn by pdf.js (an image at print resolution) with the cue
// marks and the cue margin as vector SVG in the page's own units (points), so the whole
// sheet scales to the paper. Same marks as the PDF page view: underlined quotes, positional
// ticks and GO lines with their labels, numbers in the margin.
import { useEffect, useMemo, useState } from "react";
import type { CueRow, FieldOptions } from "../../../shared/tables";
import type { CueAnchorRow, ScriptText } from "../script/contract";
import { markerColor } from "../script/filters";
import { otherDeptLabels } from "../script/Marker";
import { ELBOW, inkStyle, MarkShapes, NUMBER_W } from "../script/pdf/PdfPage";
import { canvasMeasure, glyphMapOf, labelMeasure, usePdf } from "../script/pdf/pdfDocument";
import { wrapLines } from "../script/pdf/pdfMargin";
import { buildMarks, ENTRY_HEIGHT, layoutMarks, type PageMark } from "../script/pdf/pdfMarks";
import styles from "./Print.module.css";

/** Margin beside each printed page, points. */
const MARGIN = 150;
/** Page image resolution (× 72 dpi). */
const PRINT_SCALE = 2.5;
/** Margin labels: type and line height, points; the room beside the number box. */
const LABEL = { size: 8, weight: 600, family: "system-ui, sans-serif", line: 9.5 };
const LABEL_ROOM = MARGIN - NUMBER_W - ELBOW - 10;

/** A positional mark's label, in full, wrapped to the printed margin. */
function printLines(m: PageMark): string[] {
  if (!m.positional) return [];
  const text = [m.label, ...otherDeptLabels(m.cue)].filter(Boolean).join("  ");
  return wrapLines(text, LABEL_ROOM, labelMeasure(LABEL.weight, LABEL.size, LABEL.family));
}

/** Lazily loaded by the calling-script print (only for `?layout=pdf`). */
export default function PdfCallingScript({
  pdfUrl,
  text,
  anchors,
  cues,
  fieldOptions,
  labelOf,
  revisedOf,
}: {
  pdfUrl: string;
  text: ScriptText;
  /** The cues to show (placed, filtered). */
  anchors: readonly CueAnchorRow[];
  cues: ReadonlyMap<string, CueRow>;
  fieldOptions: FieldOptions;
  labelOf: (page: number) => string;
  /** "Revised · <label>" for a page changed since the version before. */
  revisedOf?: (page: number) => string | undefined;
}) {
  const { pdf, error } = usePdf(pdfUrl);
  const [images, setImages] = useState<string[]>([]);
  const [renderError, setRenderError] = useState<string | null>(null);
  const marks = useMemo(() => {
    if (!pdf) return new Map<number, PageMark[]>();
    return buildMarks({
      anchors,
      cues,
      text,
      map: glyphMapOf(pdf, text),
      geomOf: (p) => pdf.pages[p - 1]?.geom,
      measure: canvasMeasure,
      showOthers: false,
    }).byPage;
  }, [pdf, anchors, cues, text]);

  useEffect(() => {
    if (!pdf) return;
    let live = true;
    const urls: string[] = [];
    setImages([]);
    (async () => {
      for (const p of pdf.pages) {
        const page = await pdf.doc.getPage(p.page);
        const viewport = page.getViewport({ scale: PRINT_SCALE });
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        await page.render({ canvas, viewport }).promise;
        const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
        canvas.width = 0;
        canvas.height = 0;
        if (!live) return;
        const url = blob ? URL.createObjectURL(blob) : "";
        urls.push(url);
        setImages((prev) => {
          const next = [...prev];
          next[p.page - 1] = url;
          return next;
        });
      }
    })().catch((e: unknown) => {
      if (live) setRenderError(e instanceof Error ? e.message : String(e));
    });
    return () => {
      live = false;
      for (const u of urls) if (u) URL.revokeObjectURL(u);
    };
  }, [pdf]);

  if (error || renderError) return <p className="error">{error ?? renderError}</p>;
  if (!pdf) return <p>Opening the PDF…</p>;
  const done = images.filter(Boolean).length;
  return (
    <div data-testid="print-pdf" data-ready={done === pdf.pages.length || undefined}>
      {done < pdf.pages.length && (
        <p className={styles.pdfProgress}>
          Preparing page {done + 1} of {pdf.pages.length}…
        </p>
      )}
      {pdf.pages.map((p, idx) => {
        const W = p.width;
        const H = p.height;
        const list = marks.get(p.page) ?? [];
        const lines = new Map(list.map((m) => [m.anchor.id, printLines(m)]));
        const layout = layoutMarks(list, 1, H, {
          linesOf: (m) => lines.get(m.anchor.id)?.length || 1,
          lineHeight: LABEL.line,
        });
        const lineEnd = W + MARGIN - NUMBER_W - 6;
        return (
          <section
            key={p.page}
            className={styles.pdfSheet}
            data-testid="print-pdf-page"
            data-last={idx === pdf.pages.length - 1 || undefined}
            aria-label={`Page ${labelOf(p.page)}`}
          >
            <svg viewBox={`0 0 ${W + MARGIN} ${H}`} className={styles.pdfSvg} role="img">
              <title>{`Page ${labelOf(p.page)}`}</title>
              <rect width={W + MARGIN} height={H} fill="var(--paper-bg)" />
              {images[idx] && <image href={images[idx]} width={W} height={H} />}
              <line x1={W} x2={W} y1={0} y2={H} stroke="var(--paper-rule)" strokeWidth={0.75} />
              {revisedOf?.(p.page) && (
                <text
                  x={W + MARGIN - 6}
                  y={14}
                  textAnchor="end"
                  fontSize={9}
                  fontWeight={600}
                  fill="var(--paper-yellow-ink)"
                  fontFamily="system-ui, sans-serif"
                  data-testid="print-revised"
                >
                  {revisedOf(p.page)}
                </text>
              )}
              {list.map((m) => {
                const l = layout.get(m.anchor.id);
                if (!l) return null;
                const color = markerColor(m.cue, "status", fieldOptions);
                const label = lines.get(m.anchor.id) ?? [];
                const rowTop = l.top + l.extra;
                return (
                  <g key={m.anchor.id} data-testid="print-pdf-marker" style={inkStyle(color)}>
                    <MarkShapes
                      mark={m}
                      layout={l}
                      scale={1}
                      pageWidth={W}
                      lineEnd={lineEnd}
                      color={color}
                      hot={false}
                    />
                    {label.length > 0 && (
                      <text
                        fontSize={LABEL.size}
                        fontWeight={LABEL.weight}
                        fill="var(--mark-ink)"
                        fontFamily={LABEL.family}
                        data-testid="print-pdf-label"
                      >
                        {label.map((line, k) => (
                          <tspan
                            // biome-ignore lint/suspicious/noArrayIndexKey: the lines of one label, in order
                            key={k}
                            x={W + ELBOW + 3}
                            y={l.lineY - 2.5 - (label.length - 1 - k) * LABEL.line}
                          >
                            {line}
                          </tspan>
                        ))}
                      </text>
                    )}
                    <rect
                      x={lineEnd}
                      y={rowTop + 1}
                      width={NUMBER_W}
                      height={ENTRY_HEIGHT - 2}
                      rx={3}
                      fill="var(--mark-bg)"
                      stroke="var(--mark-ink)"
                      strokeWidth={1.25}
                    />
                    <text
                      x={lineEnd + NUMBER_W / 2}
                      y={rowTop + ENTRY_HEIGHT - 6}
                      textAnchor="middle"
                      fontSize={11}
                      fontWeight={700}
                      fill="var(--mark-ink)"
                      fontFamily="ui-monospace, Menlo, Consolas, monospace"
                    >
                      {(m.cue.number?.trim() || "–") + (m.warn ? " ⚠" : "")}
                    </text>
                  </g>
                );
              })}
            </svg>
          </section>
        );
      })}
    </div>
  );
}
