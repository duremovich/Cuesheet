// A textarea that grows with its text, so nothing is ever hidden past its bottom edge.
// Without `max` it shows all of it (the panel or list around it scrolls); with `max` it
// stops there and scrolls inside. While you type at the end, the scroller around it
// follows, so the caret stays in view.

import { type RefObject, useLayoutEffect } from "react";

function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if (o === "auto" || o === "scroll") return p;
  }
  return null;
}

/**
 * Sizes `ref`'s textarea to its content on every render (call it unconditionally in the
 * component that renders the textarea). `max`: a height cap in px, past which it scrolls.
 */
export function useAutoGrow(
  ref: RefObject<HTMLTextAreaElement | null>,
  opts: { max?: number; enabled?: boolean } = {},
): void {
  const { max, enabled = true } = opts;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    // Collapsing to measure shrinks the page for a moment; a scroller around it would
    // clamp its scroll position (the panel jumping up as you type), so put it back.
    const parent = scrollParent(el);
    const keep = parent?.scrollTop ?? 0;
    const cs = getComputedStyle(el);
    const borders =
      (Number.parseFloat(cs.borderTopWidth) || 0) + (Number.parseFloat(cs.borderBottomWidth) || 0);
    el.style.height = "auto";
    const full = el.scrollHeight + borders;
    const capped = max !== undefined && full > max;
    el.style.height = `${capped ? max : full}px`;
    el.style.overflowY = capped ? "auto" : "hidden";
    if (parent && parent.scrollTop !== keep) parent.scrollTop = keep;
    // Typing at the end of a tall field: keep its bottom (the caret) visible.
    if (parent && el === document.activeElement && el.selectionEnd === el.value.length) {
      const view = parent.getBoundingClientRect();
      const below = el.getBoundingClientRect().bottom - (view.top + parent.clientHeight);
      if (below > 0) parent.scrollTop += below + 4;
    }
  });
}
