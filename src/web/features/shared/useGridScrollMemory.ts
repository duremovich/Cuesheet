// A table tab's scroll memory (CLAUDE.md "Scroll memory"): what to hand the grid (or gallery)
// as `scrollRestore`, and where its `onScrollPositionChange` reports go. One entry per show,
// tab and saved view, in lib/scrollMemory.ts.
//
// - Opening the tab: where you were in this view, if `useTableChrome` says this navigation
//   isn't a jump to a row (else nothing: the chrome focuses the URL's row).
// - Switching views, or changing the view's filters / sort / grouping / row height / layout
//   (`scrollSig`): the view's own remembered spot, else the row that was at the top if the
//   new layout still shows it, else the top.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ScrollRestore } from "../../components/grid/types";
import {
  restoreFor,
  type ScrollPosition,
  scrollKey,
  scrollMemory,
  TOP,
} from "../../lib/scrollMemory";

export function useGridScrollMemory(opts: {
  showId: string;
  tab: string;
  /** The saved view on screen (null: the built-in default). */
  viewId: string | null;
  /** `useViewConfig().scrollSig`. */
  sig: string;
  /** The rows have loaded (nothing is restored or saved before). */
  ready: boolean;
  chrome: { restoreScroll: boolean; urlRowAtMount: string | null; focusUrlRow: () => void };
}): {
  scrollRestore: ScrollRestore;
  onScrollPositionChange: (position: ScrollPosition) => void;
} {
  const { showId, tab, viewId, sig, ready, chrome } = opts;
  const memKey = scrollKey(showId, tab, viewId);
  const restoreKey = `${memKey}#${sig}`;
  const [state, setState] = useState<(ScrollRestore & { memKey: string }) | null>(null);
  let current = state;
  if (ready && state?.key !== restoreKey) {
    const saved = scrollMemory.get(memKey);
    let position: ScrollPosition | null;
    if (!state) {
      // The tab just opened.
      position = chrome.restoreScroll && saved ? restoreFor(saved, sig) : null;
      const row = chrome.urlRowAtMount;
      if (position && row)
        position = {
          ...position,
          active: {
            rowId: row,
            reveal: true,
            ...(saved?.active?.rowId === row ? { key: saved.active.key } : {}),
          },
        };
    } else {
      // Another view or layout: its own spot, else keep the top row if it's still shown.
      const from = saved ?? scrollMemory.get(state.memKey);
      position = from ? { ...restoreFor(from, sig), active: null } : TOP;
    }
    current = { key: restoreKey, position, memKey };
    setState(current);
  }

  // Restoring was right, but this view has nothing remembered: the URL's row as usual.
  const fallback = useRef(false);
  const focusUrlRow = chrome.focusUrlRow;
  useEffect(() => {
    if (fallback.current || !state) return;
    fallback.current = true;
    if (chrome.restoreScroll && chrome.urlRowAtMount && !state.position) focusUrlRow();
  }, [state, chrome.restoreScroll, chrome.urlRowAtMount, focusUrlRow]);

  const latest = useRef({ memKey, sig, ready });
  latest.current = { memKey, sig, ready };
  const onScrollPositionChange = useCallback((position: ScrollPosition) => {
    const l = latest.current;
    if (l.ready) scrollMemory.set(l.memKey, { ...position, sig: l.sig });
  }, []);

  return {
    scrollRestore: current
      ? { key: current.key, position: current.position }
      : { key: "", position: null },
    onScrollPositionChange,
  };
}
