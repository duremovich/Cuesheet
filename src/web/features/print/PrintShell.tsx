// Print layouts (R21; ux.md §Print and PDF). Routes under /shows/:id that render without
// the workspace chrome, always in the light theme (ux.md §Theme): the page sets
// <html data-theme="light"> while it's mounted (never stored as the user's choice) and
// restores the previous theme when you leave. The shell has a screen-only toolbar (Back,
// Print / Save as PDF) and a header repeated from the layout: show, title, version, date.
import { createContext, type ReactNode, useContext, useEffect } from "react";
import { Link } from "react-router";
import { useWorkspace } from "../show/workspace";
import styles from "./Print.module.css";

/** Forces the light theme on <html> while mounted. */
export function useLightTheme(): void {
  useEffect(() => {
    const root = document.documentElement;
    const before = root.dataset.theme;
    root.dataset.theme = "light";
    return () => {
      if (before === undefined) delete root.dataset.theme;
      else root.dataset.theme = before;
    };
  }, []);
}

export function printDate(d = new Date()): string {
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function PrintShell({
  title,
  subtitle,
  back,
  children,
  testId,
}: {
  title: string;
  /** Version, view name, filter… */
  subtitle?: ReactNode;
  back: string;
  children: ReactNode;
  testId?: string;
}) {
  useLightTheme();
  const ws = useWorkspace();
  useEffect(() => {
    const was = document.title;
    document.title = `${ws.showName} – ${title}`;
    return () => {
      document.title = was;
    };
  }, [ws.showName, title]);
  return (
    <div className={styles.print} data-theme="light" data-testid={testId}>
      <div className={styles.toolbar}>
        <Link to={back}>← Back</Link>
        <button type="button" className={styles.printButton} onClick={() => window.print()}>
          Print / Save as PDF
        </button>
        <span className={styles.hint}>
          Use your browser's print dialog; choose "Save as PDF" for a file.
        </span>
      </div>
      <header className={styles.header}>
        <div>
          <p className={styles.show} data-testid="print-show">
            {ws.showName}
          </p>
          <h1 className={styles.title}>{title}</h1>
        </div>
        <div className={styles.meta}>
          {subtitle}
          <span data-testid="print-date">{printDate()}</span>
        </div>
      </header>
      {children}
    </div>
  );
}

/** Set by the grid print route: the table components render a print table instead. */
export const PrintModeContext = createContext(false);

export function usePrintMode(): boolean {
  return useContext(PrintModeContext);
}
