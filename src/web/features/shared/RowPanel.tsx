// The read-only row panel (Space / the expand icon). A side panel beside the grid, not a
// modal, so the grid stays usable; it follows the active row. M2 makes it editable.
import { type ReactNode, useEffect, useRef } from "react";
import { Chip } from "../../components/grid";
import type { Column } from "../../components/grid/types";
import { formatValue } from "../../components/grid/values";
import styles from "./TableFrame.module.css";

export interface PanelSection {
  title: string;
  /** Rendered as a list; an empty list shows `empty`. */
  items: { id: string; content: ReactNode }[];
  empty: string;
}

export function RowPanel<Row>({
  title,
  row,
  columns,
  sections = [],
  onClose,
}: {
  title: string;
  row: Row;
  columns: Column<Row>[];
  sections?: PanelSection[];
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Escape closes the panel when focus is inside it.
  const rootRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, []);

  return (
    <aside className={styles.panel} aria-label={title} data-testid="row-panel" ref={rootRef}>
      <div className={styles.panelHeader}>
        <h2 className={styles.panelTitle}>{title}</h2>
        <button
          type="button"
          ref={closeRef}
          className={styles.panelClose}
          aria-label="Close panel"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div className={styles.panelBody}>
        <dl className={styles.fields}>
          {columns.map((c) => (
            <div key={c.key} className={styles.field}>
              <dt>{c.title}</dt>
              <dd>{renderValue(c, row)}</dd>
            </div>
          ))}
        </dl>
        {sections.map((s) => (
          <section key={s.title} className={styles.panelSection}>
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
      </div>
    </aside>
  );
}

function renderValue<Row>(c: Column<Row>, row: Row): ReactNode {
  const v = c.getValue(row);
  if (c.type === "select" || c.type === "multiselect") {
    const values = (Array.isArray(v) ? v : v ? [v] : []) as string[];
    if (values.length === 0) return <span className="muted">—</span>;
    return values.map((value) => {
      const o = c.options?.find((x) => x.value === value);
      return <Chip key={value} label={o?.label ?? value} color={o?.color} />;
    });
  }
  const text = formatValue(c, v);
  return text ? <span className={styles.value}>{text}</span> : <span className="muted">—</span>;
}
