// The generic Print view (R21 base): a saved view's visible columns, grouping, filters,
// sort and colors as a paginated light layout. Each group is its own table whose <thead>
// holds the group title and the column headers, so browsers repeat both at the top of
// every printed page the group runs onto. Other layouts (SM cue sheet, notes by person…)
// are meant to reuse this with their own columns.
import type { ReactNode } from "react";
import { Link } from "react-router";
import type { ColorRule, Column, Group } from "../../components/grid/types";
import { formatValue } from "../../components/grid/values";
import { useShowStore } from "../../lib/show-store";
import frameStyles from "../shared/TableFrame.module.css";
import { type TabKey, tabInfo } from "../show/tabs";
import { useWorkspace } from "../show/workspace";
import styles from "./Print.module.css";
import { PrintShell, useOrientation } from "./PrintShell";

/** `/shows/<id>/print/<tab>?view=<viewId>`. */
export function printViewUrl(showId: string, tab: TabKey, viewId?: string | null): string {
  const base = `/shows/${encodeURIComponent(showId)}/print/${tab}`;
  return viewId && !viewId.startsWith("builtin:")
    ? `${base}?view=${encodeURIComponent(viewId)}`
    : base;
}

/** The SM cue sheet (R21): `/shows/<id>/print/cues?layout=cuesheet`. */
export function cueSheetUrl(showId: string): string {
  return `/shows/${encodeURIComponent(showId)}/print/cues?layout=cuesheet`;
}

/** Columns that never wrap (numbers, cue numbers, pages, lengths). */
function noWrap(c: { key: string; type: string }): boolean {
  return (
    c.type === "number" ||
    c.type === "measurement" ||
    c.type === "pixelsize" ||
    c.key === "number" ||
    c.key === "page" ||
    c.key === "lx_cue" ||
    c.key === "sq_cue" ||
    c.key === "timecode"
  );
}

export interface RowStyle {
  row?: string;
  cells: Map<string, string>;
}

/** Evaluate color rules like the grid does: first matching row rule; cell rules stack. */
export function rowColors<R>(rules: readonly ColorRule<R>[], row: R): RowStyle {
  const out: RowStyle = { cells: new Map() };
  for (const r of rules) {
    if (!r.when(row)) continue;
    if (r.row && !out.row) out.row = r.row;
    if (r.cell) out.cells.set(r.cell.key, r.cell.color);
  }
  return out;
}

function cellStyle(color: string | undefined, text: boolean): React.CSSProperties | undefined {
  if (!color) return undefined;
  return {
    background: `var(--option-${color}-bg)`,
    ...(text ? { color: `var(--option-${color}-fg)` } : {}),
  };
}

export function PrintTable<R>({
  tab,
  columns,
  rows,
  groups,
  colorRules,
  rowId,
  sectionLabel,
  viewId,
  title,
  variant,
}: {
  tab: TabKey;
  columns: Column<R>[];
  rows?: R[] | undefined;
  groups?: Group<R>[] | undefined;
  colorRules: ColorRule<R>[];
  rowId: (r: R) => string;
  /** The saved view shown (its name goes in the header). */
  viewId: string | null;
  /** A divider row's label (cue sections), else null. */
  sectionLabel?: (r: R) => string | null;
  /** Default: the tab's name. */
  title?: string;
  /** `cuesheet`: the SM cue sheet's big type (no view name in the header). */
  variant?: "cuesheet";
}) {
  const [orientation, setOrientation] = useOrientation("landscape");
  const ws = useWorkspace();
  const viewName = useShowStore((s) => (viewId ? s.tables.views.get(viewId)?.name : undefined));
  const info = tabInfo(tab);
  const back = `/shows/${encodeURIComponent(ws.showId)}/${tab}${viewId ? `?view=${encodeURIComponent(viewId)}` : ""}`;
  const shown = columns.filter((c) => c.type !== "attachment" || c.format);
  const all: Group<R>[] = groups ?? [{ id: "all", title: "", rows: rows ?? [] }];
  const count = all.reduce((n, g) => n + g.rows.length, 0);

  const head = (g: Group<R>): ReactNode => (
    <thead>
      {g.title && (
        <tr className={styles.groupRow}>
          <th colSpan={shown.length}>
            {g.title}
            {g.subtitle ? <span className={styles.groupSub}> · {g.subtitle}</span> : null}
            <span className={styles.groupSub}> ({g.rows.length})</span>
          </th>
        </tr>
      )}
      <tr>
        {shown.map((c) => (
          <th
            key={c.key}
            scope="col"
            style={{ width: c.width ? `${c.width}px` : undefined }}
            data-nowrap={noWrap(c) || undefined}
          >
            {c.title}
          </th>
        ))}
      </tr>
    </thead>
  );

  return (
    <PrintShell
      title={title ?? info.label}
      back={back}
      testId="print-view"
      orientation={orientation}
      onOrientation={setOrientation}
      controls={
        tab === "cues" ? (
          <Link
            to={variant ? printViewUrl(ws.showId, "cues", viewId) : cueSheetUrl(ws.showId)}
            data-testid="print-switch-layout"
          >
            {variant ? "This view instead" : "SM cue sheet instead"}
          </Link>
        ) : null
      }
      subtitle={
        <span>
          {variant ? "" : `${viewName ?? "Default view"} · `}
          {count} {count === 1 ? info.noun : `${info.noun}s`}
        </span>
      }
    >
      {all
        .filter((g) => g.rows.length > 0 || !groups)
        .map((g) => (
          <table
            key={g.id}
            className={styles.table}
            data-variant={variant}
            data-testid="print-group"
          >
            {head(g)}
            <tbody>
              {g.rows.map((r) => {
                const label = sectionLabel?.(r) ?? null;
                if (label !== null) {
                  return (
                    <tr key={rowId(r)} className={styles.section}>
                      <td colSpan={shown.length}>{label}</td>
                    </tr>
                  );
                }
                const colors = rowColors(colorRules, r);
                return (
                  <tr key={rowId(r)} style={cellStyle(colors.row, false)} data-color={colors.row}>
                    {shown.map((c) => {
                      const cell = colors.cells.get(c.key);
                      return (
                        <td
                          key={c.key}
                          style={cellStyle(cell, true)}
                          data-nowrap={noWrap(c) || undefined}
                        >
                          {formatValue(c, c.getValue(r))}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        ))}
    </PrintShell>
  );
}

/** The toolbar's "Print" link for a grid tab (the view's print layout; cues: + cue sheet). */
export function PrintViewLink({ tab, viewId }: { tab: TabKey; viewId: string | null }) {
  const ws = useWorkspace();
  return (
    <>
      <Link
        className={frameStyles.toolButton}
        to={printViewUrl(ws.showId, tab, viewId)}
        title="Print this view (or save it as a PDF)"
        data-testid="print-view-link"
      >
        Print
      </Link>
      {tab === "cues" && (
        <Link
          className={frameStyles.toolButton}
          to={cueSheetUrl(ws.showId)}
          title="Print the SM cue sheet: cue, page, SM call / trigger, LX, description"
          data-testid="print-cuesheet-link"
        >
          Cue sheet
        </Link>
      )}
    </>
  );
}
