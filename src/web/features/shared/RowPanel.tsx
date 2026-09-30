// The row panel (R18; ux.md §Detail panel): Space / the expand icon. A side panel beside
// the grid, not a modal, that follows the active row. Tabs: Fields (edited in place with the
// grid's editors and pickers), Notes (cues, content, scenes), Content (cues) and History.
// Keys: ↑/↓ (outside a text field) step the grid's rows; Escape leaves a field, then closes.
// Drag the left edge to resize (width remembered per user); on phones it's a bottom sheet
// at 60% with a handle to pull it to full height.
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TableName } from "../../../shared/tables";
import type { Column } from "../../components/grid/types";
import { useShowStore, useShowStoreInstance } from "../../lib/show-store";
import { AttachmentsField } from "../attachments/Attachments";
import { ContentVersions } from "../content/ContentVersions";
import { type NotesSubject, notesFor } from "../notes/compose";
import { NotesPanel } from "../notes/NotesPanel";
import { useWorkspace } from "../show/workspace";
import { CueContentCards } from "./CueContentCards";
import { FieldEditor } from "./FieldEditor";
import type { FieldLabels } from "./history";
import { PanelHistory } from "./PanelHistory";
import { usePref } from "./prefs";
import styles from "./RowPanel.module.css";

export interface PanelSection {
  title: string;
  /** Rendered as a list; an empty list shows `empty`. */
  items: { id: string; content: ReactNode }[];
  empty: string;
}

/** A tab a table adds after Fields (e.g. a surface's Calculator). */
export interface PanelTab {
  id: string;
  label: string;
  render: () => ReactNode;
}

type TabId = "fields" | "notes" | "content" | "versions" | "history" | (string & {});

const MIN_WIDTH = 300;
const MAX_WIDTH = 900;
const DEFAULT_WIDTH = 380;
const isWidth = (v: unknown): v is number =>
  typeof v === "number" && v >= MIN_WIDTH && v <= MAX_WIDTH;
export const panelWidthKey = (userId: string) => `cuesheet.panelWidth.${userId}`;

const NONE: string[] = [];

export function RowPanel<Row>({
  title,
  row,
  columns,
  table,
  recordId,
  onEdit,
  sections = [],
  extraTabs,
  onClose,
  onStep,
}: {
  title: string;
  row: Row;
  columns: Column<Row>[];
  /** The record shown (for Notes, Content and History). */
  table: TableName;
  recordId: string;
  /** Commit a field (the grid's `onEdit` for this row). Omit: read-only. */
  onEdit?: ((key: string, value: unknown) => Promise<void> | void) | undefined;
  /** Extra read-only lists under the fields (e.g. the cues using a content item). */
  sections?: PanelSection[];
  /** Tabs after Fields (keep the array stable; ids must not clash with the built-in ones). */
  extraTabs?: PanelTab[] | undefined;
  onClose: () => void;
  /** ↑/↓ inside the panel: move the grid's active row (the panel follows it). */
  onStep?: (delta: number) => void;
}) {
  const ws = useWorkspace();
  const rootRef = useRef<HTMLElement>(null);
  const notesSubject: NotesSubject | null =
    table === "cues" || table === "content" || table === "scenes" ? { table, id: recordId } : null;
  const tabs = useMemo(() => {
    const t: { id: TabId; label: string }[] = [{ id: "fields", label: "Fields" }];
    for (const x of extraTabs ?? []) t.push({ id: x.id, label: x.label });
    if (notesSubject) t.push({ id: "notes", label: "Notes" });
    if (table === "cues") t.push({ id: "content", label: "Content" });
    if (table === "content") t.push({ id: "versions", label: "Versions" });
    t.push({ id: "history", label: "History" });
    return t;
  }, [notesSubject, table, extraTabs]);
  const [tab, setTab] = useState<TabId>("fields");
  const active = tabs.some((t) => t.id === tab) ? tab : "fields";

  // Counts for the tab labels.
  const cueContent = useShowStore((s) =>
    table === "cues" ? (s.joins.cueContent.get(recordId) ?? NONE) : NONE,
  );
  const versionTable = useShowStore((s) => s.tables.content_versions);
  const versionCount = useMemo(
    () =>
      table === "content"
        ? [...versionTable.values()].filter((v) => v.content_id === recordId).length
        : 0,
    [table, versionTable, recordId],
  );
  const notes = useShowStore((s) => s.tables.notes);
  const noteCues = useShowStore((s) => s.joins.noteCues);
  const cues = useShowStore((s) => s.tables.cues);
  const store = useShowStoreInstance();
  // Open notes, by the same definition as the Notes tab (a scene: its notes and its cues').
  // biome-ignore lint/correctness/useExhaustiveDependencies: notes, links and cues are the inputs
  const noteCount = useMemo(
    () => (notesSubject ? notesFor(store.getState(), notesSubject, { openOnly: true }).length : 0),
    [store, notesSubject?.table, notesSubject?.id, notes, noteCues, cues],
  );

  const labels = useMemo<FieldLabels>(
    () => Object.fromEntries(columns.map((c) => [c.key, c.title])),
    [columns],
  );

  // --- keys ---
  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.nativeEvent.isComposing || e.defaultPrevented) return;
    const t = e.target as HTMLElement;
    const typing = t.matches("input, textarea, select, [contenteditable]");
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      // In a field: leave it (the field reverts itself); otherwise close.
      if (typing) rootRef.current?.focus();
      else onClose();
    } else if (
      !typing &&
      (e.key === "ArrowDown" || e.key === "ArrowUp") &&
      !e.altKey &&
      t.getAttribute("role") !== "tab"
    ) {
      e.preventDefault();
      onStep?.(e.key === "ArrowDown" ? 1 : -1);
    }
  };

  // --- width (desktop) ---
  const [width, setWidth] = usePref(panelWidthKey(ws.userId), DEFAULT_WIDTH, isWidth);
  const [liveWidth, setLiveWidth] = useState<number | null>(null);
  const shownWidth = liveWidth ?? width;
  const clampW = (w: number) => Math.round(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, w)));
  const onResizeDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const start = shownWidth;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    let last = start;
    const move = (ev: PointerEvent) => {
      last = clampW(start + (startX - ev.clientX));
      setLiveWidth(last);
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      setLiveWidth(null);
      setWidth(last);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  // --- bottom sheet (phones) ---
  const [expanded, setExpanded] = useState(false);
  const drag = useRef<{ y: number; moved: boolean } | null>(null);

  // Keep the chosen tab in view on the tab strip.
  const tabRefs = useRef(new Map<TabId, HTMLButtonElement>());
  const selectTab = useCallback((id: TabId, focus = false) => {
    setTab(id);
    if (focus) tabRefs.current.get(id)?.focus();
  }, []);
  useEffect(() => {
    if (active !== tab) setTab(active);
  }, [active, tab]);

  const panelId = `row-panel-${table}`;
  return (
    <aside
      className={styles.panel}
      aria-label={title}
      data-testid="row-panel"
      data-expanded={expanded || undefined}
      ref={rootRef}
      tabIndex={-1}
      style={{ "--panel-width": `${shownWidth}px` } as React.CSSProperties}
      onKeyDown={onKeyDown}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: a draggable splitter, not a divider */}
      <div
        className={styles.resizer}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        aria-valuenow={shownWidth}
        tabIndex={0}
        onPointerDown={onResizeDown}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 50 : 10;
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            e.stopPropagation();
            setWidth(clampW(shownWidth + (e.key === "ArrowLeft" ? step : -step)));
          }
        }}
      />
      <button
        type="button"
        className={styles.sheetHandle}
        aria-label={expanded ? "Collapse panel" : "Expand panel"}
        aria-expanded={expanded}
        onPointerDown={(e) => {
          drag.current = { y: e.clientY, moved: false };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const dy = e.clientY - d.y;
          if (dy < -30 && !expanded) {
            d.moved = true;
            setExpanded(true);
          } else if (dy > 30 && expanded) {
            d.moved = true;
            setExpanded(false);
          }
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onClick={() => {
          if (drag.current?.moved) return;
          setExpanded((x) => !x);
        }}
      />
      <div className={styles.header}>
        <h2 className={styles.title}>{title}</h2>
        <button type="button" className={styles.close} aria-label="Close panel" onClick={onClose}>
          ×
        </button>
      </div>
      <div className={styles.tabs} role="tablist" aria-label="Panel sections">
        {tabs.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              if (el) tabRefs.current.set(t.id, el);
              else tabRefs.current.delete(t.id);
            }}
            type="button"
            role="tab"
            id={`${panelId}-tab-${t.id}`}
            aria-selected={active === t.id}
            aria-controls={`${panelId}-body`}
            tabIndex={active === t.id ? 0 : -1}
            className={styles.tab}
            onClick={() => selectTab(t.id)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                e.preventDefault();
                const next =
                  tabs[(i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
                if (next) selectTab(next.id, true);
              }
            }}
          >
            {t.label}
            {t.id === "notes" && noteCount > 0 && (
              <span className={styles.count} title={`${noteCount} open`}>
                {noteCount}
              </span>
            )}
            {t.id === "content" && cueContent.length > 0 && (
              <span className={styles.count}>{cueContent.length}</span>
            )}
            {t.id === "versions" && versionCount > 0 && (
              <span className={styles.count}>{versionCount}</span>
            )}
          </button>
        ))}
      </div>
      <div
        className={styles.body}
        id={`${panelId}-body`}
        role="tabpanel"
        aria-labelledby={`${panelId}-tab-${active}`}
        data-fill={active === "notes" || undefined}
      >
        {active === "fields" && (
          <>
            <dl className={styles.fields}>
              {columns.map((c) =>
                c.type === "attachment" ? (
                  // Attachments: full width, with add / remove / reorder (R13).
                  <div key={c.key} className={styles.field} data-wide="">
                    <dt>{c.title}</dt>
                    <dd>
                      <AttachmentsField
                        table={table}
                        recordId={recordId}
                        field={c.key.startsWith("custom.") ? c.key.slice(7) : c.key}
                        label={c.title}
                      />
                    </dd>
                  </div>
                ) : (
                  <div key={c.key} className={styles.field}>
                    <dt>{c.title}</dt>
                    <dd>
                      <FieldEditor
                        col={c}
                        row={row}
                        canEdit={!!onEdit}
                        onCommit={(v) => {
                          const p = onEdit?.(c.key, v);
                          if (p) p.catch((e: unknown) => ws.reportError(e, "save the change"));
                        }}
                      />
                    </dd>
                  </div>
                ),
              )}
            </dl>
            {sections.map((s) => (
              <section key={s.title} className={styles.section}>
                <h3>
                  {s.title} <span className="muted">{s.items.length}</span>
                </h3>
                {s.items.length === 0 ? (
                  <p className="muted">{s.empty}</p>
                ) : (
                  <ul>
                    {s.items.map((it) => (
                      <li key={it.id}>{it.content}</li>
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </>
        )}
        {active === "notes" && notesSubject && <NotesPanel subject={notesSubject} />}
        {active === "content" && table === "cues" && <CueContentCards cueId={recordId} />}
        {active === "versions" && table === "content" && <ContentVersions contentId={recordId} />}
        {active === "history" && (
          <PanelHistory
            table={table}
            id={recordId}
            labels={labels}
            unit={columns.find((c) => c.type === "measurement")?.unit}
          />
        )}
        {extraTabs?.find((x) => x.id === active)?.render()}
      </div>
    </aside>
  );
}
