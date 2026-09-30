// Layout of a table tab: a toolbar row, then the grid (filling the rest of the viewport)
// with the row panel beside it.
import type { ReactNode } from "react";
import { useShowStore } from "../../lib/show-store";
import styles from "./TableFrame.module.css";

export function TableFrame({
  title,
  toolbar,
  children,
  panel,
  notice,
  testId,
}: {
  title: string;
  toolbar?: ReactNode;
  children: ReactNode;
  panel?: ReactNode;
  /** A line between the toolbar and the grid (e.g. an empty-table hint). */
  notice?: ReactNode;
  testId?: string;
}) {
  const status = useShowStore((s) => s.status);
  const error = useShowStore((s) => s.error);
  return (
    <section className={styles.frame} aria-label={title} data-testid={testId}>
      <div className={styles.toolbar}>
        <h2 className={styles.title}>{title}</h2>
        {toolbar}
      </div>
      {status === "loading" && <p className="muted">Loading…</p>}
      {status === "error" && <p className="error">Couldn't load the show: {error}</p>}
      {status === "ready" && notice}
      {status === "ready" && (
        <div className={styles.body} data-panel-open={panel ? true : undefined}>
          <div className={styles.gridWrap}>{children}</div>
          {panel}
        </div>
      )}
    </section>
  );
}

/** A plain toolbar button. */
export function ToolbarButton({
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) {
  return (
    <button type="button" className={styles.toolButton} {...props}>
      {children}
    </button>
  );
}
