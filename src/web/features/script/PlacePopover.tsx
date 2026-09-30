// The placement popover (ux.md §Placing cues): after selecting text, "New cue on this line"
// / "Attach existing cue"; after a click in the margin, the same with a position trigger
// (LX / Timecode / Visual). A new cue gets the suggested number (between the nearest
// anchored cues in script order), a description, the trigger type and value.
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { RecordPicker } from "../../components/grid";
import type { PickerItem } from "../../components/grid/types";
import type { NewCueInput } from "./placement";
import styles from "./Script.module.css";

export type PlaceKind = "selection" | "position";

export const POSITION_TRIGGERS = ["LX", "Timecode", "Visual"] as const;

export interface PlaceRequest {
  kind: PlaceKind;
  /** Viewport point the popover opens at. */
  x: number;
  y: number;
  /** The selected text (selection) or the block's text start (position; for display). */
  quote: string;
  /** Page label, for the heading. */
  pageLabel: string;
  suggestion: string;
  /** Lines the selected quote covers (> 1: "Quote covers 2 lines"). */
  lines?: number;
  /** Only a character name is selected: offer the following line instead. */
  nextLine?: boolean;
}

export function PlacePopover({
  request,
  onCreate,
  onAttach,
  searchCues,
  onClose,
  onUseNextLine,
}: {
  request: PlaceRequest;
  onUseNextLine?: () => void;
  onCreate: (input: NewCueInput) => Promise<void>;
  onAttach: (cueId: string, positionTrigger: string | null) => Promise<void>;
  searchCues: (q: string) => PickerItem[];
  onClose: () => void;
}) {
  const positional = request.kind === "position";
  const [step, setStep] = useState<"menu" | "new" | "attach">("menu");
  const [number, setNumber] = useState(request.suggestion);
  const [description, setDescription] = useState("");
  const [trigger, setTrigger] = useState<string>(positional ? "LX" : "Line");
  const [value, setValue] = useState(positional ? "" : request.quote);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const [pickerAnchor, setPickerAnchor] = useState<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({
    left: request.x,
    top: request.y,
  });
  const titleId = useId();

  // Keep it on screen.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-place when the step changes size
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const w = el.offsetWidth || 320;
    const h = el.offsetHeight || 200;
    const left = Math.max(8, Math.min(request.x, window.innerWidth - w - 8));
    const top =
      request.y + h + 8 > window.innerHeight ? Math.max(8, request.y - h - 16) : request.y + 8;
    setPos({ left, top });
  }, [request.x, request.y, step]);

  // Focus goes back where it was (a focused line) when the popover closes.
  useEffect(() => {
    const was = document.activeElement as HTMLElement | null;
    return () => {
      if (was?.isConnected && was !== document.body) was.focus({ preventScroll: true });
    };
  }, []);

  // Focus the first control of each step.
  useEffect(() => {
    const el = root.current;
    if (!el || step === "attach") return;
    el.querySelector<HTMLElement>("input, button, select")?.focus();
  }, [step]);

  // Click outside closes (the record picker's portal counts as inside).
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (root.current?.contains(t)) return;
      if (t?.closest?.("[data-grid-portal='script-place']")) return;
      onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [onClose]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const create = () =>
    run(() => onCreate({ number, description, trigger_type: trigger, trigger_value: value }));

  const heading = positional
    ? `Place a cue here · page ${request.pageLabel}`
    : `“${request.quote.length > 60 ? `${request.quote.slice(0, 59)}…` : request.quote}” · page ${request.pageLabel}`;

  return createPortal(
    <div
      ref={root}
      className={styles.popover}
      role="dialog"
      aria-labelledby={titleId}
      data-testid="place-popover"
      style={{ position: "fixed", left: pos.left, top: pos.top }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <p className={styles.popoverTitle} id={titleId}>
        {heading}
      </p>
      {!positional && (request.lines ?? 1) > 1 && (
        <p className={styles.popoverNote} data-testid="quote-lines">
          Quote covers {request.lines} lines
        </p>
      )}
      {request.nextLine && onUseNextLine && (
        <p className={styles.popoverNote} data-testid="next-line-hint">
          That's a character name. Anchor on the following line instead?{" "}
          <button type="button" className={styles.linkButton} onClick={onUseNextLine}>
            Use the next line
          </button>
        </p>
      )}
      {positional && (
        <label className={styles.formRow}>
          <span>Trigger</span>
          <select
            aria-label="Trigger type"
            value={trigger}
            onChange={(e) => setTrigger(e.target.value)}
          >
            {POSITION_TRIGGERS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
      )}
      {step === "menu" && (
        <div className={styles.popoverActions}>
          <button type="button" onClick={() => setStep("new")}>
            {positional ? "New cue here" : "New cue on this line"}
          </button>
          <button type="button" onClick={() => setStep("attach")}>
            Attach existing cue
          </button>
        </div>
      )}
      {step === "new" && (
        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy) void create();
          }}
        >
          <label className={styles.formRow}>
            <span>Cue</span>
            <input
              type="text"
              aria-label="Cue number"
              value={number}
              placeholder="14.25"
              onChange={(e) => setNumber(e.target.value)}
            />
          </label>
          <label className={styles.formRow}>
            <span>Description</span>
            <input
              type="text"
              aria-label="Description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <label className={styles.formRow}>
            <span>{positional ? trigger : "Line"}</span>
            <input
              type="text"
              aria-label="Trigger value"
              value={value}
              placeholder={
                positional
                  ? trigger === "Timecode"
                    ? "1:00:00"
                    : trigger === "LX"
                      ? "117"
                      : ""
                  : ""
              }
              onChange={(e) => setValue(e.target.value)}
            />
          </label>
          <div className={styles.popoverActions}>
            <button type="submit" className={styles.primary} disabled={busy}>
              Create cue
            </button>
            <button type="button" onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {step === "attach" && (
        <div ref={setPickerAnchor} className={styles.pickerAnchor}>
          {pickerAnchor && (
            <RecordPicker
              anchor={pickerAnchor}
              search={searchCues}
              label="Find a cue"
              placeholder="Cue number or description"
              portalOwner="script-place"
              onPick={(item) => void run(() => onAttach(item.id, positional ? trigger : null))}
              onClose={(reason) => {
                if (reason === "escape") setStep("menu");
              }}
            />
          )}
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>,
    document.body,
  );
}
