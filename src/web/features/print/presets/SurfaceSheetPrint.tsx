// Surface sheet (R21): `/shows/:id/print/surfaces?preset=surfaces` — a card per surface in
// show order: its reference image, size in meters and in feet-inches, pixel size, PPI,
// aspect ratio, and its regions (or the surface it's a region of).
import { useMemo } from "react";
import { attachmentUrl, thumbnailUrl } from "../../../../shared/attachments";
import { formatFormulaValue } from "../../../../shared/formula";
import type { SurfaceRow } from "../../../../shared/tables";
import { formatLength, formatPixelSize } from "../../../../shared/units";
import { type ShowState, useShowStore } from "../../../lib/show-store";
import { hasThumbnail, thumbnailOf } from "../../attachments/selectors";
import { useWorkspace } from "../../show/workspace";
import { computeSurface } from "../../surfaces/formulas";
import styles from "../Print.module.css";
import { PrintShell, printDate, useOrientation } from "../PrintShell";

const selectState = (s: ShowState) => s;

/** "4.50 m × 2.53 m" in one unit, or "" when neither side is set. */
export function sizeText(s: Pick<SurfaceRow, "width" | "height">, unit: "m" | "ft-in"): string {
  if (s.width === null && s.height === null) return "";
  const side = (v: number | null) => (v === null ? "?" : formatLength(v, unit));
  return `${side(s.width)} × ${side(s.height)}`;
}

export function SurfaceSheetPrint() {
  const ws = useWorkspace();
  const state = useShowStore(selectState);
  const [orientation, setOrientation] = useOrientation("portrait");
  const cards = useMemo(() => {
    const all = state.order.surfaces.flatMap((id) => state.tables.surfaces.get(id) ?? []);
    return all.map((s) => {
      const computed = computeSurface(state, s);
      const pixels =
        s.pixel_width !== null && s.pixel_height !== null
          ? formatPixelSize({ w: s.pixel_width, h: s.pixel_height })
          : "";
      return {
        surface: s,
        parent: s.parent_id ? state.tables.surfaces.get(s.parent_id) : undefined,
        regions: all.filter((r) => r.parent_id === s.id),
        image: thumbnailOf(state.tables.attachments, "surfaces", s.id, "images"),
        meters: sizeText(s, "m"),
        feet: sizeText(s, "ft-in"),
        pixels,
        ppi: computed.ppi === null ? "" : formatFormulaValue(computed.ppi, "m", 1),
        aspect: computed.aspect_ratio === null ? "" : formatFormulaValue(computed.aspect_ratio),
      };
    });
  }, [state]);

  return (
    <PrintShell
      title="Surface sheet"
      back={`/shows/${encodeURIComponent(ws.showId)}/surfaces`}
      testId="print-surfaces"
      orientation={orientation}
      onOrientation={setOrientation}
      running={{
        title: `${ws.showName} · Surface sheet`,
        footer: `${ws.showName} · ${printDate()}`,
      }}
      subtitle={
        <span>
          {cards.length} {cards.length === 1 ? "surface" : "surfaces"}
        </span>
      }
    >
      {cards.length === 0 && <p className="muted">No surfaces yet.</p>}
      <div className={styles.cards}>
        {cards.map((c) => (
          <article key={c.surface.id} className={styles.card} data-testid="print-row">
            <h2>
              {c.surface.name || "Unnamed surface"}
              {c.surface.channel ? (
                <span className={styles.groupSub}> · {c.surface.channel}</span>
              ) : null}
            </h2>
            {c.image && (
              <img
                className={styles.cardImage}
                src={
                  hasThumbnail(c.image)
                    ? thumbnailUrl(ws.showId, c.image.id)
                    : attachmentUrl(ws.showId, c.image.id)
                }
                alt={`${c.surface.name ?? "Surface"} reference`}
              />
            )}
            <dl className={styles.facts}>
              <dt>Size (m)</dt>
              <dd data-testid="surface-size-m">{c.meters || "—"}</dd>
              <dt>Size (ft-in)</dt>
              <dd data-testid="surface-size-ft">{c.feet || "—"}</dd>
              <dt>Pixels</dt>
              <dd>{c.pixels || "—"}</dd>
              <dt>PPI</dt>
              <dd>{c.ppi || "—"}</dd>
              <dt>Aspect</dt>
              <dd>{c.aspect || "—"}</dd>
              {c.parent && (
                <>
                  <dt>Region of</dt>
                  <dd>{c.parent.name}</dd>
                </>
              )}
            </dl>
            {c.regions.length > 0 && (
              <div>
                <strong>Regions</strong>
                <ul className={styles.regions}>
                  {c.regions.map((r) => (
                    <li key={r.id}>
                      {r.name || "Unnamed"}
                      {r.channel ? ` (${r.channel})` : ""}
                      {sizeText(r, "m") ? ` · ${sizeText(r, "m")}` : ""}
                      {r.pixel_width !== null && r.pixel_height !== null
                        ? ` · ${formatPixelSize({ w: r.pixel_width, h: r.pixel_height })}`
                        : ""}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </article>
        ))}
      </div>
    </PrintShell>
  );
}
