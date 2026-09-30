import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./ContextMenu.module.css";
import { placeAtPoint, useOutsidePointer } from "./popover";
import type { MenuItem } from "./types";

export type { MenuItem };

/** A keyboard-navigable menu at a point (right-click). Closes on Escape or outside click. */
export function ContextMenu({
  x,
  y,
  items,
  label,
  onClose,
  portalOwner,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  label: string;
  onClose: () => void;
  portalOwner?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Mounted transparent (not visibility:hidden, which can't take focus), placed from its
  // measured size, then the first item is focused once the placement has committed.
  const [style, setStyle] = useState<React.CSSProperties>({
    position: "fixed",
    left: x,
    top: y,
    opacity: 0,
  });
  const placed = style.opacity === undefined;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setStyle(placeAtPoint(x, y, { width: el.offsetWidth, height: el.offsetHeight }));
  }, [x, y]);

  useLayoutEffect(() => {
    if (placed) ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [placed]);

  useOutsidePointer(() => [ref.current], onClose);

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    const buttons = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const i = buttons.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      buttons[(i + 1) % buttons.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      buttons[(i - 1 + buttons.length) % buttons.length]?.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      (e.key === "Home" ? buttons[0] : buttons.at(-1))?.focus();
    } else if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      onClose();
    }
  };

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      className={styles.menu}
      style={style}
      onKeyDown={onKeyDown}
      data-grid-portal={portalOwner}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          tabIndex={-1}
          className={styles.item}
          data-danger={item.danger || undefined}
          onClick={() => {
            onClose();
            item.onSelect();
          }}
        >
          <span>{item.label}</span>
          {item.shortcut && <span className={styles.shortcut}>{item.shortcut}</span>}
        </button>
      ))}
    </div>,
    document.body,
  );
}
