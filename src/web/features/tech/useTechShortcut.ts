// ⌘/Ctrl+Shift+. (period) anywhere in the show workspace opens tech mode at the current cue
// (`?cue=`). A chord browsers don't use, so type-to-edit in the grid keeps every letter.
// Read from `KeyboardEvent.code` because Shift turns "." into ">" on many layouts.
import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";

/** The tech-mode URL, carrying the current cue (`?cue=` is shared with the cue list). */
export function techUrl(showId: string, cueId?: string | null): string {
  const base = `/shows/${encodeURIComponent(showId)}/tech`;
  return cueId ? `${base}?cue=${encodeURIComponent(cueId)}` : base;
}

export const TECH_SHORTCUT_LABEL = "⌘/Ctrl+Shift+.";

/** True for ⌘/Ctrl+Shift+Period (no Alt), outside IME composition. */
export function isTechKey(
  e: Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "isComposing">,
): boolean {
  return (
    e.code === "Period" && (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && !e.isComposing
  );
}

export function useTechShortcut(showId: string, cueId: string | null) {
  const navigate = useNavigate();
  const cue = useRef(cueId);
  cue.current = cueId;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isTechKey(e)) return;
      e.preventDefault();
      e.stopPropagation();
      // A cell being edited commits the same way as when focus leaves it: blur it, and
      // navigate after the grid's blur handler (a 0 ms timeout, queued first) has run.
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== document.body) active.blur();
      setTimeout(() => navigate(techUrl(showId, cue.current)), 0);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [navigate, showId]);
}
