import type { ReactNode } from "react";
import styles from "./Chip.module.css";
import { OPTION_COLORS } from "./types";

/** `--option-<color>-*` palette name, falling back to gray for unknown names. */
export function optionColor(color: string | undefined): string {
  return color && (OPTION_COLORS as readonly string[]).includes(color) ? color : "gray";
}

export function Chip({
  label,
  color,
  onRemove,
  removeLabel,
  badge,
  thumb,
}: {
  label: ReactNode;
  /** Option palette name; omitted = neutral (link chips). */
  color?: string | undefined;
  onRemove?: (() => void) | undefined;
  removeLabel?: string;
  /** Muted text after the label (a content item's current version). */
  badge?: string | undefined;
  /** A tiny image before the label (a thumbnail URL). */
  thumb?: string | undefined;
}) {
  const c = color === undefined ? undefined : optionColor(color);
  return (
    <span
      className={styles.chip}
      data-neutral={c === undefined || undefined}
      style={
        c ? { background: `var(--option-${c}-bg)`, color: `var(--option-${c}-fg)` } : undefined
      }
    >
      {thumb && (
        <img
          className={styles.thumb}
          src={thumb}
          alt=""
          loading="lazy"
          draggable={false}
          data-testid="chip-thumb"
          onError={(e) => {
            e.currentTarget.hidden = true;
          }}
        />
      )}
      <span className={styles.label}>
        {label}
        {badge && <span className={styles.badge}> · {badge}</span>}
      </span>
      {onRemove && (
        <button
          type="button"
          className={styles.remove}
          aria-label={removeLabel ?? "Remove"}
          tabIndex={-1}
          onPointerDown={(e) => e.preventDefault()}
          onClick={onRemove}
        >
          ×
        </button>
      )}
    </span>
  );
}
