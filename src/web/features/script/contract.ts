// What the script reader UI (this folder) uses from the script data model and anchoring
// engine (M4a: src/shared/script.ts, src/shared/script-anchor/, ./extract/). Everything
// here imports script types and engine helpers from this file only.
//
// Anchor rows come from the store with nullable fields (`block: null` for a `missing`
// anchor); the UI works on `CueAnchorRow`, the same row normalized (`normalizeAnchor`:
// block -1 when it has no position, empty strings, state `manual` when unset).
import type {
  ScriptRow,
  ScriptVersionRow,
  CueAnchorRow as StoredAnchorRow,
} from "../../../shared/tables";

export type {
  Anchor,
  AnchorState,
  BlockKind,
  CreateScriptVersionResponse as ImportVersionResponse,
  ReanchorResult,
  ScriptBlock,
  ScriptPageInfo,
  ScriptText,
} from "../../../shared/script";
export {
  anchorPosition,
  makeAnchor,
  makePositionAnchor,
} from "../../../shared/script-anchor";
export type { ScriptRow, ScriptVersionRow, StoredAnchorRow };

import type { AnchorState, ScriptText } from "../../../shared/script";

/** A `cue_anchors` row as the UI sees it (see `normalizeAnchor`). */
export interface CueAnchorRow {
  id: string;
  cue_id: string;
  script_version_id: string;
  /** -1: no position (a `missing` anchor). */
  block: number;
  offset: number;
  length: number;
  quote: string;
  prefix: string;
  suffix: string;
  /** Physical page, derived by the server from `block`. */
  page: number | null;
  state: AnchorState;
  confidence: number | null;
}

const normalized = new WeakMap<StoredAnchorRow, CueAnchorRow>();

export function normalizeAnchor(row: StoredAnchorRow): CueAnchorRow {
  const hit = normalized.get(row);
  if (hit) return hit;
  const out: CueAnchorRow = {
    id: row.id,
    cue_id: row.cue_id,
    script_version_id: row.script_version_id,
    block: row.block ?? -1,
    offset: row.offset ?? 0,
    length: row.length ?? 0,
    quote: row.quote ?? "",
    prefix: row.prefix ?? "",
    suffix: row.suffix ?? "",
    page: row.page,
    state: row.state ?? "manual",
    confidence: row.confidence,
  };
  normalized.set(row, out);
  return out;
}

/** Extract a script file in the browser (PDF, DOCX, TXT/MD); the extractor loads on demand. */
export async function extractScript(file: File): Promise<ScriptText> {
  const m = await import("./extract");
  return m.extractScript(file);
}
