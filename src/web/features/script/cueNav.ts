// The navigator's cue list (ux.md §Script view › Reading): one row per cue in show order
// (the cue list's order: cue numbers rule it, unnumbered cues keep their stored place),
// filtered like the markers, each with its callout and the page its anchor is on in this
// version. Pure; ReaderChrome renders the rows.
import type { CueRow } from "../../../shared/tables";
import type { CueAnchorRow, ScriptText } from "./contract";
import { type MarkerFilter, matchesMarker } from "./filters";
import { cueLabel, isPlaced, markerText, markerTitle } from "./markers";

export interface CueNavRow {
  id: string;
  /** The cue number ("–" when unnumbered). */
  number: string;
  /** The callout (`markerText`: SM call, else trigger text, else description). */
  text: string;
  /** Hover text: the number, the callout and description, and "not placed" when so. */
  title: string;
  /** Physical page of the cue's placed anchor on this version; null when not placed. */
  page: number | null;
  /** That page's printed label. */
  label: string | null;
}

const NONE: readonly string[] = [];

export function cueNavRows(opts: {
  /** Cue ids in show order (`state.order.cues`). */
  order: readonly string[];
  cues: ReadonlyMap<string, CueRow>;
  assignees: ReadonlyMap<string, readonly string[]>;
  filter: MarkerFilter;
  /** This version's anchors. */
  anchors: readonly CueAnchorRow[];
  text: ScriptText;
}): CueNavRow[] {
  const { cues, text } = opts;
  const placed = new Map<string, CueAnchorRow>();
  for (const a of opts.anchors) if (isPlaced(a) && !placed.has(a.cue_id)) placed.set(a.cue_id, a);
  const labels = new Map(text.pages.map((p) => [p.page, p.label]));
  const out: CueNavRow[] = [];
  for (const id of opts.order) {
    const cue = cues.get(id);
    if (!cue || cue.is_section) continue;
    if (!matchesMarker(cue, opts.assignees.get(id) ?? NONE, opts.filter)) continue;
    const a = placed.get(id);
    const page = a ? (text.blocks[a.block]?.page ?? null) : null;
    const label = page === null ? null : (labels.get(page) ?? String(page));
    const head = cueLabel(cue);
    const body = markerTitle(cue);
    out.push({
      id,
      number: cue.number?.trim() || "–",
      text: markerText(cue),
      title: [
        body ? `${head} · ${body}` : head,
        label === null ? "Not placed in this version of the script" : `Page ${label}`,
      ].join("\n"),
      page,
      label,
    });
  }
  return out;
}
