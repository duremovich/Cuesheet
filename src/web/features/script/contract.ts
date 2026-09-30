// The contract between the script reader UI (M4b, this folder) and the script data model /
// extraction / anchoring engine (M4a: src/shared/script.ts, src/shared/script-anchor/,
// ./extract/, routes/script.ts). Everything in this folder imports script types and
// engine helpers from HERE only, so wiring the real engine is a change to this file:
//
//   export type { ... } from "../../../shared/script";
//   export { makeAnchor } from "../../../shared/script-anchor";
//   extractScript → (await import("./extract")).extractScript(file)
//
// Until M4a lands, the types are declared below and `makeAnchor` / `extractScript` come
// from local stand-ins (./mock/: TXT/MD only), used by the fixture-backed mock source
// (VITE_SCRIPT_MOCK=1, see ./source.ts).
import type { Json } from "../../../shared/tables";

export type BlockKind = "heading" | "character" | "dialogue" | "direction" | "lyric" | "other";

export interface ScriptBlock {
  /** Stable index in the version's text (= its position in `blocks`). */
  i: number;
  /** Physical page (1-based), a key into `pages`. */
  page: number;
  kind: BlockKind;
  text: string;
}

export interface ScriptPageInfo {
  page: number;
  /** The printed page number ("14", "14a"). */
  label: string;
}

export interface ScriptText {
  blocks: ScriptBlock[];
  pages: ScriptPageInfo[];
  source: "pdf" | "docx" | "txt" | "ocr";
  /** 0–1: how sure extraction is (OCR and odd layouts are lower). */
  confidence: number;
}

export interface Anchor {
  block: number;
  offset: number;
  /** 0: a position (LX / timecode / visual cues), not a quote. */
  length: number;
  quote: string;
  prefix: string;
  suffix: string;
}

export type AnchorState = "matched" | "moved" | "changed" | "missing" | "manual";

export interface ReanchorResult {
  cueId: string;
  from: Anchor;
  to: Anchor | null;
  state: AnchorState;
  confidence: number;
  candidates: { anchor: Anchor; score: number }[];
}

// ---- Store rows (tables in the show snapshot, written with ops) ----

export interface ScriptRow {
  id: string;
  title: string | null;
  current_version_id: string | null;
}

export interface ScriptVersionRow {
  id: string;
  script_id: string;
  label: string | null;
  attachment_id: string | null;
  /** ms since the epoch (an ISO string is accepted too). */
  imported_at: number | string | null;
  source: ScriptText["source"] | null;
  confidence: number | null;
  text_key: string | null;
  block_count: number | null;
  page_count: number | null;
  stats: Json | null;
  position: number | null;
}

export interface CueAnchorRow {
  id: string;
  cue_id: string;
  script_version_id: string;
  block: number;
  offset: number;
  length: number;
  quote: string;
  prefix: string;
  suffix: string;
  /** Derived by the server from `block` (the client never sends it). */
  page: number | null;
  state: AnchorState;
  confidence: number | null;
}

/** Response of `POST /api/shows/:id/script/versions`. */
export interface ImportVersionResponse {
  versionId: string;
  results: ReanchorResult[];
}

// ---- Engine helpers (M4a stand-ins until it lands) ----

export { makeAnchor } from "./mock/anchorText";

/** Extract a script file in the browser (PDF, DOCX, TXT/MD). Loaded on demand. */
export async function extractScript(file: File): Promise<ScriptText> {
  const m = await import("./mock/extractText");
  return m.extractScript(file);
}
