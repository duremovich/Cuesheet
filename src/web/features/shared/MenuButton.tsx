// A toolbar button with a dropdown menu (sort menu). Keyboard: Enter/Space/↓ open and focus
// the first item, ↑/↓ move, Escape closes and returns focus to the button.
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import styles from "./TableFrame.module.css";

export interface MenuEntry {
  label: string;
  onSelect: () => void;
  /** Rendered as a checked radio item. */
  checked?: boolean;
  disabled?: boolean;
}

export function MenuButton({
  label,
  children,
  items,
  pressed,
}: {
  /** Accessible name of the button. */
  label: string;
  children: ReactNode;
  items: MenuEntry[];
  pressed?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !button.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };

  const onMenuKey = (e: React.KeyboardEvent) => {
    const buttons = [
      ...(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []),
    ];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      buttons[(i + 1) % buttons.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      buttons[(i - 1 + buttons.length) % buttons.length]?.focus();
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <div className={styles.menuWrap}>
      <button
        type="button"
        ref={button}
        className={styles.toolButton}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-pressed={pressed}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {children}
      </button>
      {open && (
        <div
          className={styles.menu}
          role="menu"
          id={id}
          ref={menu}
          onKeyDown={onMenuKey}
          aria-label={label}
        >
          {items.map((it) => {
            const pick = () => {
              close();
              it.onSelect();
            };
            return it.checked === undefined ? (
              <button
                key={it.label}
                type="button"
                role="menuitem"
                disabled={it.disabled}
                onClick={pick}
              >
                {it.label}
              </button>
            ) : (
              <button
                key={it.label}
                type="button"
                role="menuitemcheckbox"
                aria-checked={it.checked}
                disabled={it.disabled}
                onClick={pick}
              >
                {it.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
