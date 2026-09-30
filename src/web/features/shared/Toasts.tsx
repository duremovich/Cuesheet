// Small transient messages at the bottom of the show workspace ("Couldn't save: …"), with
// an optional action button ("Undo filter").
import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./Toasts.module.css";

export type ToastKind = "info" | "error";

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
  action?: ToastAction;
}

const LIFETIME = { info: 3500, error: 7000 } as const;
/** Toasts with an action stay long enough to reach the button. */
const ACTION_LIFETIME = 8000;

export function useToasts() {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const timers = useRef(new Set<number>());
  const dismiss = useCallback((id: number) => {
    setItems((list) => list.filter((t) => t.id !== id));
  }, []);
  const toast = useCallback(
    (message: string, kind: ToastKind = "info", action?: ToastAction) => {
      const id = next.current++;
      // The same message twice in a row replaces the first (e.g. repeated failures).
      setItems((list) =>
        [
          ...list.filter((t) => t.message !== message),
          { id, message, kind, ...(action ? { action } : {}) },
        ].slice(-4),
      );
      const timer = window.setTimeout(
        () => {
          timers.current.delete(timer);
          dismiss(id);
        },
        action ? ACTION_LIFETIME : LIFETIME[kind],
      );
      timers.current.add(timer);
    },
    [dismiss],
  );
  useEffect(() => {
    const set = timers.current;
    return () => {
      for (const t of set) clearTimeout(t);
    };
  }, []);
  return { items, toast, dismiss };
}

export function Toasts({ items, dismiss }: { items: ToastItem[]; dismiss: (id: number) => void }) {
  return (
    <div className={styles.region} aria-live="polite" data-testid="toasts">
      {items.map((t) => (
        <div
          key={t.id}
          className={styles.toast}
          data-kind={t.kind}
          role={t.kind === "error" ? "alert" : "status"}
          data-testid="toast"
        >
          <span className={styles.message}>{t.message}</span>
          {t.action && (
            <button
              type="button"
              className={styles.action}
              onClick={() => {
                dismiss(t.id);
                t.action?.run();
              }}
            >
              {t.action.label}
            </button>
          )}
          <button
            type="button"
            className={styles.close}
            aria-label="Dismiss"
            onClick={() => dismiss(t.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
