// An in-row confirmation (never a native dialog, like the grid's delete strip): a strip
// under the row it belongs to, with the question, the action and Cancel. Focus starts on
// Cancel; Escape cancels.
import { useId, useLayoutEffect, useRef } from "react";
import styles from "./ConfirmStrip.module.css";

export function ConfirmStrip({
  text,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  text: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const textId = useId();
  useLayoutEffect(() => cancelRef.current?.focus(), []);
  return (
    <div
      role="alertdialog"
      aria-modal="false"
      aria-labelledby={textId}
      className={styles.strip}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <span id={textId}>{text}</span>
      <button type="button" className="primary" onClick={onConfirm}>
        {confirmLabel}
      </button>
      <button type="button" ref={cancelRef} onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
