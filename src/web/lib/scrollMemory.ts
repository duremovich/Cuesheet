// Where you were in each tab (grid rows, gallery cards, script pages), so coming back to a
// tab lands on the same place. Positions are anchored on what was at the top of the view
// (a row, a group header, a page) plus the offset from it, not on a pixel scrollTop: rows
// have measured heights that are re-estimated on every mount, so the same pixel offset
// would land somewhere else.
//
// Kept per browser tab for the session: an in-memory map mirrored to sessionStorage (so a
// reload restores too; a new browser tab starts fresh). Never synced. Keys are
// `<showId>|<tab>|<view or version>` (scrollKey). CLAUDE.md "Scroll memory".

/** One item near the top of the view. */
export interface ScrollAnchor {
  /** The item: `r:<rowId>` (a grid row or gallery card), `g:<groupId>`, `p:<page>`. */
  key: string;
  /** Item top minus view top (px; ≤ 0 for the item the view's top edge is in). */
  at: number;
  /** For the first anchor: how far into the item the view's top is (0–1 of its height). */
  frac?: number;
}

export interface ScrollPosition {
  /** From the top of the view down; the first one still there wins. */
  anchors: ScrollAnchor[];
  /** Pixel fallbacks when no anchor is left (and the horizontal scroll, always used). */
  top: number;
  left: number;
  /**
   * The active cell (grids) or row (gallery). `reveal`: the URL names it, so if a collapsed
   * group hides it, expand that and scroll to it (as `focusRow` would).
   */
  active?: { rowId: string; key?: string; group?: boolean; reveal?: boolean } | null;
  /** What the layout was built from (a view's filters/sort/grouping): see restoreFor. */
  sig?: string;
}

/**
 * A position for a scroller to go to once per `key` (the grid's and gallery's
 * `scrollRestore`, the script readers' `restore`). `position: null` leaves the scroll alone
 * and doesn't use up the key.
 */
export interface ScrollRestore {
  key: string;
  position: ScrollPosition | null;
}

/** A laid-out item: its anchor key and its top and height, in the scroller's coordinates. */
export interface AnchorItem {
  key: string;
  start: number;
  size: number;
}

/**
 * The anchors for a view whose top edge is at `viewTop`: the item that edge is in, then the
 * next ones (up to `count` in all). `items` are in layout order.
 */
export function captureAnchors(
  items: readonly AnchorItem[],
  viewTop: number,
  count = 4,
): ScrollAnchor[] {
  // First item whose bottom is below the view's top.
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const it = items[mid] as AnchorItem;
    if (it.start + it.size <= viewTop) lo = mid + 1;
    else hi = mid;
  }
  const out: ScrollAnchor[] = [];
  for (let i = lo; i < items.length && out.length < count; i++) {
    const it = items[i] as AnchorItem;
    const a: ScrollAnchor = { key: it.key, at: it.start - viewTop };
    if (out.length === 0 && it.size > 0)
      a.frac = Math.min(1, Math.max(0, (viewTop - it.start) / it.size));
    out.push(a);
  }
  return out;
}

/**
 * Where the view's top goes to show `anchors` as they were: the first anchor `find` still
 * knows, at the same offset (`mode` "px") or the same fraction into it ("frac": pages whose
 * size scales with a zoom). Null when none is left.
 */
export function anchorTarget(
  anchors: readonly ScrollAnchor[],
  find: (key: string) => { start: number; size: number } | undefined,
  mode: "px" | "frac" = "px",
): number | null {
  for (const a of anchors) {
    const it = find(a.key);
    if (!it) continue;
    if (mode === "frac" && a.frac !== undefined) return Math.max(0, it.start + a.frac * it.size);
    return Math.max(0, it.start - a.at);
  }
  return null;
}

/**
 * The position to restore for a layout built from `sig`. The pixel fallback only makes sense
 * for the same layout: after a filter, sort or grouping change (or another view), the view
 * keeps the anchored row if it's still shown, else goes to the top.
 */
export function restoreFor(saved: ScrollPosition, sig: string | undefined): ScrollPosition {
  if (saved.sig === sig) return saved;
  return { ...saved, top: 0 };
}

/** The top of a fresh layout (another view with nothing remembered and no row in common). */
export const TOP: ScrollPosition = { anchors: [], top: 0, left: 0 };

export const scrollKey = (showId: string, tab: string, sub?: string | null): string =>
  `${showId}|${tab}|${sub ?? ""}`;

// --- The store ---

const STORAGE_KEY = "cuesheet.scroll";
/** Most recently saved first; older ones are dropped past this. */
export const MAX_ENTRIES = 200;
const WRITE_DELAY_MS = 300;

interface Stored {
  key: string;
  pos: ScrollPosition;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export class ScrollMemory {
  /** Insertion order = recency (re-set on every save). */
  private entries: Map<string, ScrollPosition> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly storage: () => StorageLike | null) {}

  private load(): Map<string, ScrollPosition> {
    if (this.entries) return this.entries;
    const m = new Map<string, ScrollPosition>();
    try {
      const raw = this.storage()?.getItem(STORAGE_KEY);
      const list: unknown = raw ? JSON.parse(raw) : [];
      if (Array.isArray(list))
        for (const e of list as Stored[])
          if (e && typeof e.key === "string" && isPosition(e.pos)) m.set(e.key, e.pos);
    } catch {
      // Unreadable or blocked: start empty.
    }
    this.entries = m;
    return m;
  }

  get(key: string): ScrollPosition | null {
    return this.load().get(key) ?? null;
  }

  set(key: string, pos: ScrollPosition): void {
    const m = this.load();
    m.delete(key);
    m.set(key, pos);
    while (m.size > MAX_ENTRIES) {
      const oldest = m.keys().next().value;
      if (oldest === undefined) break;
      m.delete(oldest);
    }
    if (this.timer === undefined) this.timer = setTimeout(() => this.flush(), WRITE_DELAY_MS);
  }

  /** The most recently saved entry whose key starts with `prefix`. */
  latest(prefix: string): ScrollPosition | null {
    let hit: ScrollPosition | null = null;
    for (const [k, v] of this.load()) if (k.startsWith(prefix)) hit = v;
    return hit;
  }

  /** Write to storage now (the page is being hidden or unloaded). */
  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.entries) return;
    const list: Stored[] = [...this.entries].map(([key, pos]) => ({ key, pos }));
    try {
      this.storage()?.setItem(STORAGE_KEY, JSON.stringify(list));
    } catch {
      // Storage full or blocked: positions last for this page only.
    }
  }

  /** Tests: forget everything held in memory (storage is re-read on next use). */
  reset(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.entries = null;
  }
}

function isPosition(v: unknown): v is ScrollPosition {
  if (typeof v !== "object" || v === null) return false;
  const p = v as ScrollPosition;
  return (
    Array.isArray(p.anchors) &&
    p.anchors.every((a) => a && typeof a.key === "string" && typeof a.at === "number") &&
    typeof p.top === "number" &&
    typeof p.left === "number"
  );
}

const sessionStore = (): StorageLike | null => {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
};

/** The app's one store. */
export const scrollMemory = new ScrollMemory(sessionStore);

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => scrollMemory.flush());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") scrollMemory.flush();
  });
}

/** React Router's key for a location it didn't create: a fresh page load of a typed or linked URL. */
export const FRESH_LOAD_KEY = "default";

/**
 * Whether a tab opened by this navigation should go back to where you were, rather than to
 * a row or cue the navigation points at: true unless it carries ⌘K's router focus, or a
 * `?<param>=` row. The one exception is a reload or back/forward to the URL you left (a
 * `POP` to a history entry the app made, so its location key isn't `FRESH_LOAD_KEY`) whose
 * row is the one you were on: that's not a jump. Opening a link or a typed URL is a `POP`
 * too, but to a fresh entry, so its row wins.
 */
export function shouldRestore(opts: {
  focusState: string | undefined;
  urlRow: string | null;
  navigationType: "POP" | "PUSH" | "REPLACE";
  locationKey: string;
  rememberedRow: string | null | undefined;
}): boolean {
  if (opts.focusState) return false;
  if (!opts.urlRow) return true;
  return (
    opts.navigationType === "POP" &&
    opts.locationKey !== FRESH_LOAD_KEY &&
    opts.urlRow === opts.rememberedRow
  );
}
