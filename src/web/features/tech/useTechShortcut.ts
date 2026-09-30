// `T` in the cue list (when not editing a cell) opens tech mode at the active cue.
// ux.md §Keyboard reference. Listens in the capture phase so the grid doesn't start
// editing the cell with a "t"; Enter / F2 still start editing a value that begins with t.
import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { useWorkspace } from "../show/workspace";

/** The tech-mode URL, carrying the current cue (`?cue=` is shared with the cue list). */
export function techUrl(showId: string, cueId?: string | null): string {
  const base = `/shows/${encodeURIComponent(showId)}/tech`;
  return cueId ? `${base}?cue=${encodeURIComponent(cueId)}` : base;
}

/** True for a plain `t`/`T` keydown on a cue-list cell that isn't being edited. */
export function isTechKey(e: KeyboardEvent): boolean {
  if (e.key !== "t" && e.key !== "T") return false;
  if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return false;
  const t = e.target as HTMLElement | null;
  if (!t || t.matches("input, textarea, select, [contenteditable]")) return false;
  const grid = t.closest('[role="grid"]');
  return !!grid && grid.getAttribute("aria-label") === "Cue list";
}

export function useTechShortcut(activeCueId: string | null) {
  const { showId } = useWorkspace();
  const navigate = useNavigate();
  const active = useRef(activeCueId);
  active.current = activeCueId;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isTechKey(e)) return;
      e.preventDefault();
      e.stopPropagation();
      navigate(techUrl(showId, active.current));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [navigate, showId]);
}
