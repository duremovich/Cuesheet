// Test data for the script view's unit and DOM tests (not used by the app).
import type { CueRow } from "../../../shared/tables";
import type { CueAnchorRow, ScriptText } from "./contract";
import { extractPlainText } from "./extract/text";

export function cueRow(p: Partial<CueRow> & { id: string }): CueRow {
  return {
    custom: {},
    created_at: 0,
    created_by: "",
    updated_at: 0,
    updated_by: "",
    order_key: "a0",
    scene_id: null,
    number: null,
    description: null,
    trigger_type: null,
    trigger_value: null,
    sm_call: null,
    lx_cue: null,
    sq_cue: null,
    timecode: null,
    ae_time: null,
    measure: null,
    page: null,
    status: null,
    is_section: false,
    ...p,
  };
}

export function anchorRow(p: Partial<CueAnchorRow> & { id: string; cue_id: string }): CueAnchorRow {
  return {
    script_version_id: "v1",
    block: 0,
    offset: 0,
    length: 0,
    quote: "",
    prefix: "",
    suffix: "",
    page: 1,
    state: "manual",
    confidence: 1,
    ...p,
  };
}

/** A small two-page script. Blocks: 0 heading, 1 direction, 2 JOE, 3 dialogue, 4 SUE,
 * 5 dialogue (page 1); 6 JERRY, 7 dialogue, 8 direction (page 2, labelled 13). */
export const SAMPLE: ScriptText = extractPlainText(
  [
    "--- page 12 ---",
    "",
    "ACT ONE, SCENE 5",
    "",
    "(Night on the platform.)",
    "",
    "JOE",
    "Keep your head down and your case up.",
    "",
    "SUE",
    "Sweet Sue needs a sax and a bass.",
    "--- page 13 ---",
    "",
    "JERRY",
    "Daphne. Bass. Classically trained.",
    "",
    "(Lights shift.)",
  ].join("\n"),
);
