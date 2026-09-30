// A toolbar button that opens a non-modal dialog (the view toolbar's Filter, Sort, Group,
// Fields, Row height and Color panels). Focus moves into the panel and is trapped there
// (Tab cycles); Escape or a click outside closes it and returns focus to the button. Below
// 600px the panel is a full-width sheet at the bottom of the screen (CSS).
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import styles from "./ViewBar.module.css";

const FOCUSABLE =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])';

export function Popover({
  label,
  button,
  children,
  pressed,
  testId,
  wide,
  open: controlledOpen,
  onOpenChange,
}: {
  /** Accessible name of the button and the dialog. */
  label: string;
  /** Button content (defaults to the label). */
  button?: ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  pressed?: boolean;
  testId?: string;
  /** A wider panel (rule builders). */
  wide?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = controlledOpen ?? ownOpen;
  const setOpen = (o: boolean) => {
    setOwnOpen(o);
    onOpenChange?.(o);
  };
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const setOpenRef = useRef(setOpen);
  setOpenRef.current = setOpen;

  useEffect(() => {
    if (!open) return;
    const first =
      panel.current?.querySelector<HTMLElement>("[data-autofocus]") ??
      panel.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel.current)?.focus();
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || buttonRef.current?.contains(t)) return;
      setOpenRef.current(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== "Tab" || !panel.current) return;
    const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (el) => el.offsetParent !== null || el === document.activeElement,
    );
    if (items.length === 0) return;
    const first = items[0] as HTMLElement;
    const last = items.at(-1) as HTMLElement;
    if (
      e.shiftKey &&
      (document.activeElement === first || document.activeElement === panel.current)
    ) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className={styles.popWrap}>
      <button
        type="button"
        ref={buttonRef}
        className={styles.toolButton}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-pressed={pressed}
        data-testid={testId}
        onClick={() => setOpen(!open)}
      >
        {button ?? label}
      </button>
      {open && (
        <div
          ref={panel}
          id={id}
          role="dialog"
          aria-label={label}
          tabIndex={-1}
          className={styles.popover}
          data-wide={wide || undefined}
          data-testid={testId ? `${testId}-popover` : undefined}
          onKeyDown={onKeyDown}
        >
          <div className={styles.popHeader}>
            <h3 className={styles.popTitle}>{label}</h3>
            <button type="button" className={styles.iconButton} aria-label="Close" onClick={close}>
              ×
            </button>
          </div>
          <div className={styles.popBody}>
            {typeof children === "function" ? children(close) : children}
          </div>
        </div>
      )}
    </div>
  );
}
