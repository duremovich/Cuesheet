// Dragging a Line cue's marker onto a line that doesn't contain its quote: ask what to do
// instead of converting it silently. Either the cue becomes a positional cue (LX /
// Timecode / Visual) at that line, or it re-anchors on the whole line and takes it as its
// trigger text.
import { useEffect, useId, useRef, useState } from "react";
import { POSITION_TRIGGERS } from "./PlacePopover";
import styles from "./Script.module.css";

export function MoveDialog({
  cueLabel,
  line,
  onPositional,
  onRequote,
  onCancel,
}: {
  cueLabel: string;
  /** The target line's text (shortened for display). */
  line: string;
  onPositional: (trigger: string) => void;
  onRequote: () => void;
  onCancel: () => void;
}) {
  const [trigger, setTrigger] = useState<string>("LX");
  const titleId = useId();
  const root = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<Element | null>(null);
  useEffect(() => {
    returnFocus.current = document.activeElement;
    root.current?.querySelector<HTMLElement>("select, button")?.focus();
    return () => (returnFocus.current as HTMLElement | null)?.focus?.();
  }, []);
  const short = line.length > 80 ? `${line.slice(0, 79)}…` : line;
  return (
    <div
      ref={root}
      className={`${styles.popover} ${styles.dialog}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-testid="move-dialog"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <p className={styles.popoverTitle} id={titleId}>
        {cueLabel}'s line isn't on “{short}”.
      </p>
      <div className={styles.popoverActions}>
        <select
          aria-label="Positional trigger"
          value={trigger}
          onChange={(e) => setTrigger(e.target.value)}
        >
          {POSITION_TRIGGERS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => onPositional(trigger)}>
          Make this a positional cue
        </button>
      </div>
      <div className={styles.popoverActions}>
        <button type="button" className={styles.primary} onClick={onRequote}>
          Re-anchor on this line and update trigger text
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
