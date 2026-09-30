// A new script version (ux.md §New script version): the report counts and the Resolve
// screen's list and state machine. Pure; ResolveScreen.tsx turns decisions into ops.
import type { Anchor, AnchorState, CueAnchorRow, ReanchorResult } from "./contract";

export interface ReportCounts {
  matched: number;
  moved: number;
  changed: number;
  missing: number;
}

/** "118 matched · 6 moved · 4 changed · 2 missing" counts (manual counts as matched). */
export function reportCounts(states: readonly AnchorState[]): ReportCounts {
  const c: ReportCounts = { matched: 0, moved: 0, changed: 0, missing: 0 };
  for (const s of states) {
    if (s === "manual" || s === "matched") c.matched++;
    else c[s]++;
  }
  return c;
}

export function reportText(c: ReportCounts): string {
  return `${c.matched} matched · ${c.moved} moved · ${c.changed} changed · ${c.missing} missing`;
}

export type ItemStatus = "pending" | "accepted" | "placed" | "cut" | "skipped";

export interface ResolveItem {
  cueId: string;
  state: "changed" | "missing";
  /** Where it was in the previous version. */
  from: Anchor | null;
  /** Best guesses in the new version, best first. */
  candidates: { anchor: Anchor; score: number }[];
  /** Its anchor row on the new version, if any. */
  anchorId: string | null;
  status: ItemStatus;
}

/**
 * The cues to resolve on `versionId`: from the import's results when we have them (this
 * session), else from the anchor rows (changed / missing states, plus cues anchored on the
 * previous version that have no anchor here). Script order of the previous version.
 */
export function buildResolveItems(opts: {
  results: readonly ReanchorResult[] | null;
  anchors: readonly CueAnchorRow[];
  prevAnchors: readonly CueAnchorRow[];
  cueExists: (id: string) => boolean;
}): ResolveItem[] {
  const here = new Map(opts.anchors.map((a) => [a.cue_id, a]));
  const items: ResolveItem[] = [];
  const seen = new Set<string>();
  const add = (item: ResolveItem) => {
    if (seen.has(item.cueId) || !opts.cueExists(item.cueId)) return;
    seen.add(item.cueId);
    items.push(item);
  };
  const resultBy = new Map((opts.results ?? []).map((r) => [r.cueId, r]));
  const prevOrder = [...opts.prevAnchors].sort((a, b) => a.block - b.block || a.offset - b.offset);
  for (const prev of prevOrder) {
    const row = here.get(prev.cue_id);
    const r = resultBy.get(prev.cue_id);
    // The row is the truth once it's been resolved (manual) or re-matched.
    if (row && row.state !== "changed" && row.state !== "missing") continue;
    const state: "changed" | "missing" =
      row?.state === "changed" || (!row && r?.state === "changed") ? "changed" : "missing";
    if (!row && !r) {
      add({
        cueId: prev.cue_id,
        state: "missing",
        from: prev,
        candidates: [],
        anchorId: null,
        status: "pending",
      });
      continue;
    }
    if (r && r.state !== "changed" && r.state !== "missing" && !row) continue;
    const candidates = r?.candidates.length
      ? r.candidates
      : row && row.state === "changed"
        ? [{ anchor: row, score: row.confidence ?? 0 }]
        : [];
    add({
      cueId: prev.cue_id,
      state,
      from: r?.from ?? prev,
      candidates,
      anchorId: row?.id ?? null,
      status: "pending",
    });
  }
  // Flagged rows whose cue wasn't on the previous version (placed there another way).
  for (const row of opts.anchors) {
    if (row.state !== "changed" && row.state !== "missing") continue;
    const r = resultBy.get(row.cue_id);
    add({
      cueId: row.cue_id,
      state: row.state,
      from: r?.from ?? null,
      candidates:
        r?.candidates ??
        (row.state === "changed" ? [{ anchor: row, score: row.confidence ?? 0 }] : []),
      anchorId: row.id,
      status: "pending",
    });
  }
  return items;
}

export interface ResolveState {
  items: ResolveItem[];
  /** The item on screen. */
  index: number;
  /** Which candidate of the current item is shown. */
  candidate: number;
  /** Place mode: waiting for a selection in the new text. */
  placing: boolean;
}

export type ResolveAction =
  | { type: "select"; index: number }
  | { type: "candidate"; index: number }
  | { type: "place" }
  | { type: "cancelPlace" }
  | { type: "done"; status: Exclude<ItemStatus, "pending"> }
  | { type: "sync"; items: ResolveItem[] };

export function initResolve(items: ResolveItem[]): ResolveState {
  return { items, index: 0, candidate: 0, placing: false };
}

/** The next pending item after `from` (wrapping); -1 when none is left. */
export function nextPending(items: readonly ResolveItem[], from: number): number {
  for (let k = 1; k <= items.length; k++) {
    const i = (from + k) % items.length;
    if (items[i]?.status === "pending") return i;
  }
  return -1;
}

export function resolveReducer(s: ResolveState, a: ResolveAction): ResolveState {
  switch (a.type) {
    case "select":
      if (a.index < 0 || a.index >= s.items.length) return s;
      return { ...s, index: a.index, candidate: 0, placing: false };
    case "candidate": {
      const item = s.items[s.index];
      if (!item || a.index < 0 || a.index >= item.candidates.length) return s;
      return { ...s, candidate: a.index };
    }
    case "place":
      return s.items[s.index]?.status === "pending" ? { ...s, placing: true } : s;
    case "cancelPlace":
      return { ...s, placing: false };
    case "done": {
      const items = s.items.map((it, i) => (i === s.index ? { ...it, status: a.status } : it));
      const next = nextPending(items, s.index);
      return { items, index: next >= 0 ? next : s.index, candidate: 0, placing: false };
    }
    case "sync": {
      // Items keep their decisions (a resolved cue leaves the fresh list but stays shown
      // as done); cues flagged since (a remote change) are added at the end.
      const known = new Set(s.items.map((it) => it.cueId));
      const added = a.items.filter((it) => !known.has(it.cueId));
      return added.length ? { ...s, items: [...s.items, ...added] } : s;
    }
  }
}

export function allDone(s: ResolveState): boolean {
  return s.items.every((it) => it.status !== "pending");
}
