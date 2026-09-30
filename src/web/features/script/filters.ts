// The script view's filter bar (status / assignee / trigger type) and marker colors (per
// view: by status by default). The filter round-trips through `?filter=` so the calling
// script print can show the same cues.
import type { CueRow, FieldOptions } from "../../../shared/tables";

export interface MarkerFilter {
  status: string | null;
  /** A person id. */
  assignee: string | null;
  trigger: string | null;
}

export const NO_FILTER: MarkerFilter = { status: null, assignee: null, trigger: null };

export type ColorBy = "status" | "trigger" | "none";

export const COLOR_BY: readonly { value: ColorBy; label: string }[] = [
  { value: "status", label: "Status" },
  { value: "trigger", label: "Trigger type" },
  { value: "none", label: "No color" },
];

export function isFiltered(f: MarkerFilter): boolean {
  return f.status !== null || f.assignee !== null || f.trigger !== null;
}

export function matchesMarker(
  cue: CueRow,
  assigneeIds: readonly string[],
  f: MarkerFilter,
): boolean {
  if (f.status !== null && (cue.status ?? "") !== f.status) return false;
  if (f.trigger !== null && (cue.trigger_type ?? "") !== f.trigger) return false;
  if (f.assignee !== null && !assigneeIds.includes(f.assignee)) return false;
  return true;
}

/** `?filter=` value: "status=Cued&trigger=LX" (empty when unfiltered). */
export function filterToParam(f: MarkerFilter): string {
  const p = new URLSearchParams();
  if (f.status !== null) p.set("status", f.status);
  if (f.assignee !== null) p.set("assignee", f.assignee);
  if (f.trigger !== null) p.set("trigger", f.trigger);
  return p.toString();
}

export function filterFromParam(s: string | null | undefined): MarkerFilter {
  if (!s) return NO_FILTER;
  const p = new URLSearchParams(s);
  return {
    status: p.get("status"),
    assignee: p.get("assignee"),
    trigger: p.get("trigger"),
  };
}

/** The option palette color of a marker (undefined: neutral). */
export function markerColor(
  cue: CueRow,
  colorBy: ColorBy,
  options: FieldOptions,
): string | undefined {
  if (colorBy === "none") return undefined;
  const field = colorBy === "status" ? "cues.status" : "cues.trigger_type";
  const value = colorBy === "status" ? cue.status : cue.trigger_type;
  if (!value) return undefined;
  return options[field as keyof FieldOptions]?.find((o) => o.value === value)?.color ?? undefined;
}

export const isColorBy = (v: unknown): v is ColorBy =>
  v === "status" || v === "trigger" || v === "none";
