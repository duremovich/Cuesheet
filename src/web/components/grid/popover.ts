// Fixed-position placement for popovers rendered in a portal (so transformed or clipped
// grid ancestors don't affect them). Flips above the anchor when there's no room below.

import { type CSSProperties, useLayoutEffect, useRef, useState } from "react";

export interface PlacementOptions {
  minWidth: number;
  maxHeight: number;
}

export function placeBelow(rect: DOMRect, opts: PlacementOptions): CSSProperties {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(Math.max(rect.width, opts.minWidth), vw - 16);
  const left = Math.max(8, Math.min(rect.left, vw - width - 8));
  const below = vh - rect.bottom - 10;
  const above = rect.top - 10;
  if (below >= Math.min(opts.maxHeight, 220) || below >= above) {
    return {
      position: "fixed",
      top: rect.bottom + 2,
      left,
      width,
      maxHeight: Math.max(120, Math.min(opts.maxHeight, below)),
    };
  }
  return {
    position: "fixed",
    bottom: vh - rect.top + 2,
    left,
    width,
    maxHeight: Math.min(opts.maxHeight, above),
  };
}

export function placeAtPoint(
  x: number,
  y: number,
  size: { width: number; height: number },
): CSSProperties {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  return {
    position: "fixed",
    left: Math.max(8, Math.min(x, vw - size.width - 8)),
    top: Math.max(8, Math.min(y, vh - size.height - 8)),
  };
}

/** Keeps a popover under `anchor`, following scrolls and resizes. */
export function useAnchoredStyle(
  anchor: HTMLElement | null,
  opts: PlacementOptions,
): CSSProperties {
  const { minWidth, maxHeight } = opts;
  // Placed on the first render (not hidden) so the popover's input can take focus at once.
  const [style, setStyle] = useState<CSSProperties>(() =>
    anchor
      ? placeBelow(anchor.getBoundingClientRect(), { minWidth, maxHeight })
      : { position: "fixed", opacity: 0 },
  );
  useLayoutEffect(() => {
    if (!anchor) return;
    const update = () =>
      setStyle(placeBelow(anchor.getBoundingClientRect(), { minWidth, maxHeight }));
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [anchor, minWidth, maxHeight]);
  return style;
}

/** Calls `onOutside` for pointerdowns outside every element in `inside`. */
export function useOutsidePointer(
  inside: () => (Element | null)[],
  onOutside: () => void,
  enabled = true,
) {
  const ref = useRef({ inside, onOutside });
  ref.current = { inside, onOutside };
  useLayoutEffect(() => {
    if (!enabled) return;
    const handler = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && ref.current.inside().some((el) => el?.contains(t))) return;
      ref.current.onOutside();
    };
    document.addEventListener("pointerdown", handler, true);
    return () => document.removeEventListener("pointerdown", handler, true);
  }, [enabled]);
}
