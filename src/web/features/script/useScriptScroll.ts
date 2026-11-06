// The Script tab's scroll memory (CLAUDE.md "Scroll memory"): one entry per show and script
// version, shared by the PDF page view and the text reader (anchors `p:<page>` + how far
// into the page), so leaving the tab, a reload, or switching PDF ↔ Text keeps your page.
// `?cue=` / ⌘K still win when they point somewhere: see shouldRestore.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ScrollPosition,
  type ScrollRestore,
  scrollKey,
  scrollMemory,
  shouldRestore,
} from "../../lib/scrollMemory";

export function useScriptScroll(opts: {
  showId: string;
  /** The version on screen (null until the versions have loaded). */
  versionId: string | null;
  /** "pdf" | "text": a new reader mounts, and restores, when it changes. */
  mode: string;
  /** `?cue=` and ⌘K's router focus, as the page opened. */
  cueParam: string | null;
  focusState: string | undefined;
  navigationType: "POP" | "PUSH" | "REPLACE";
  locationKey: string;
}): {
  /** The page opened where you left it: skip the opening `?cue=` jump. */
  restoreOnMount: boolean;
  restore: ScrollRestore;
  onScrollPositionChange: (position: ScrollPosition) => void;
} {
  const { showId, versionId, mode, cueParam } = opts;
  const [restoreOnMount] = useState(() =>
    shouldRestore({
      focusState: opts.focusState,
      urlRow: cueParam,
      navigationType: opts.navigationType,
      locationKey: opts.locationKey,
      rememberedRow: scrollMemory.latest(scrollKey(showId, "script", ""))?.active?.rowId,
    }),
  );
  const memKey = scrollKey(showId, "script", versionId);
  const key = `${memKey}#${mode}`;
  const [state, setState] = useState<ScrollRestore | null>(null);
  let current = state;
  if (versionId && state?.key !== key) {
    // The first version shown follows the opening navigation; later ones (another version,
    // the other view) go to their remembered spot, if any.
    const saved = scrollMemory.get(memKey);
    current = { key, position: !state && !restoreOnMount ? null : saved };
    setState(current);
  }

  const latest = useRef({ memKey, versionId, cueParam });
  latest.current = { memKey, versionId, cueParam };
  const onScrollPositionChange = useCallback((position: ScrollPosition) => {
    const l = latest.current;
    if (!l.versionId) return;
    scrollMemory.set(l.memKey, { ...position, active: l.cueParam ? { rowId: l.cueParam } : null });
  }, []);
  // Clicking a marker writes ?cue=: remember it, so a reload of that URL isn't a jump.
  useEffect(() => {
    if (!versionId) return;
    const saved = scrollMemory.get(memKey);
    if (saved && (saved.active?.rowId ?? null) !== cueParam)
      scrollMemory.set(memKey, { ...saved, active: cueParam ? { rowId: cueParam } : null });
  }, [memKey, versionId, cueParam]);

  return {
    restoreOnMount,
    restore: current ?? { key: "", position: null },
    onScrollPositionChange,
  };
}
