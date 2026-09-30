// A toolbar button that opens a non-modal dialog (the view toolbar's Filter, Sort, Group,
// Fields, Row height and Color panels). Focus moves into the panel and is trapped there
// (Tab cycles); Escape or a click outside closes it and returns focus to the button. Below
// 600px the panel is a full-width sheet at the bottom of the screen (CSS).
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import styles from "./ViewBar.module.css";

const FOCUSABLE =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])';

/**
 * The panel's tab stops in order: visible, enabled controls, with one radio per group (the
 * checked one, else the first), as the browser's Tab would visit them.
 */
function tabStops(root: HTMLElement): HTMLElement[] {
  const seenRadio = new Set<string>();
  const all = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.getClientRects().length > 0 || el === document.activeElement,
  );
  return all.filter((el) => {
    if (!(el instanceof HTMLInputElement) || el.type !== "radio" || !el.name) return true;
    if (seenRadio.has(el.name)) return false;
    const group = all.filter(
      (x): x is HTMLInputElement =>
        x instanceof HTMLInputElement && x.type === "radio" && x.name === el.name,
    );
    const pick = group.find((x) => x.checked) ?? group[0];
    if (pick !== el) return false;
    seenRadio.add(el.name);
    return true;
  });
}

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

  // Keep a panel opened near the right edge on screen (desktop; phones get a sheet).
  useLayoutEffect(() => {
    const el = panel.current;
    if (!open || !el) return;
    el.style.left = "";
    if (window.innerWidth <= 600) return;
    const over = el.getBoundingClientRect().right - (window.innerWidth - 8);
    if (over > 0) el.style.left = `${-over}px`;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // Initial focus: the first control that doesn't remove or clear anything.
    const body = panel.current?.querySelector<HTMLElement>("[data-pop-body]");
    const first =
      body?.querySelector<HTMLElement>("[data-autofocus]") ??
      (body ? tabStops(body).find((el) => !el.hasAttribute("data-destructive")) : undefined);
    (first ?? panel.current)?.focus();
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || buttonRef.current?.contains(t)) return;
      setOpenRef.current(false);
    };
    // Escape closes from anywhere in the panel, whatever handles keys inside it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing) return;
      const t = e.target as Node | null;
      if (!t || !(panel.current?.contains(t) || buttonRef.current?.contains(t))) return;
      e.preventDefault();
      e.stopPropagation();
      setOpenRef.current(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  // Tab / Shift+Tab wrap around inside the panel (from both ends, and from the panel).
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab" || !panel.current) return;
    const items = tabStops(panel.current);
    if (items.length === 0) return;
    const first = items[0] as HTMLElement;
    const last = items.at(-1) as HTMLElement;
    const at = document.activeElement as HTMLElement | null;
    const i = at ? items.indexOf(at) : -1;
    if (e.shiftKey && (i <= 0 || at === panel.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (i === items.length - 1 || i === -1)) {
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
          <div className={styles.popBody} data-pop-body>
            {typeof children === "function" ? children(close) : children}
          </div>
        </div>
      )}
    </div>
  );
}
