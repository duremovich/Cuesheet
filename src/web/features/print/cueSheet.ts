// The SM cue sheet (R21; ux.md §Print and PDF): cue number, page, SM call / trigger, LX,
// description, grouped by scene, big type. A preset layout of the grid print
// (`/print/cues?layout=cuesheet`), independent of the saved view.
import type { Column } from "../../components/grid/types";
import type { CueView } from "../cues/cueViews";
import { triggerBadge } from "../script/markers";

/** "CLICK A - JOE: …" when the cue has an SM call, else its trigger ("LINE · Sweet Sue…"). */
export function smCall(v: CueView): string {
  const call = v.cue.sm_call?.trim();
  if (call) return call;
  // The badge carries LX / SQ / TC numbers; a line or a visual adds its text.
  const withText = v.cue.trigger_type === "Line" || v.cue.trigger_type === "Visual";
  return [triggerBadge(v.cue), withText ? v.cue.trigger_value?.trim() : null]
    .filter(Boolean)
    .join(" · ");
}

const text = (key: string, title: string, get: (v: CueView) => string, width?: number) =>
  ({ key, title, type: "text", getValue: get, ...(width ? { width } : {}) }) as Column<CueView>;

export const CUE_SHEET_COLUMNS: Column<CueView>[] = [
  text("number", "Cue", (v) => v.cue.number ?? "", 70),
  text("page", "Page", (v) => v.cue.page ?? "", 56),
  text("call", "SM call / trigger", smCall),
  text("lx_cue", "LX", (v) => v.cue.lx_cue ?? "", 60),
  text("description", "Description", (v) => v.cue.description ?? ""),
];
