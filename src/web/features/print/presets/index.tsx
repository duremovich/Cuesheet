// Built-in print layouts on /shows/:id/print/<tab>?preset=… (R21, S3). The calling script
// (/script/print) and the SM cue sheet (/print/cues?layout=cuesheet) predate these and
// keep their URLs; `printPresetUrl` knows them all (share links and ⌘K use it).
import type { SharePreset } from "../../../../shared/share";
import { scriptPrintUrl } from "../../script/links";
import type { TabKey } from "../../show/tabs";
import { cueSheetUrl } from "../PrintTable";
import { ContentListPrint } from "./ContentListPrint";
import { NotesPrint, notesPrintUrl } from "./NotesPrint";
import { SurfaceSheetPrint } from "./SurfaceSheetPrint";

/** Which `?preset=` each print tab takes. */
const TAB_PRESETS: Partial<Record<TabKey, readonly string[]>> = {
  notes: ["by-person", "by-cue"],
  content: ["content"],
  surfaces: ["surfaces"],
};

export function isTabPreset(tab: TabKey, preset: string | null): boolean {
  return !!preset && (TAB_PRESETS[tab] ?? []).includes(preset);
}

/** The layout for `/print/<tab>?preset=<preset>` (checked with `isTabPreset`). */
export function PresetPrint({ preset }: { preset: string }) {
  switch (preset) {
    case "by-person":
    case "by-cue":
      return <NotesPrint preset={preset} />;
    case "content":
      return <ContentListPrint />;
    case "surfaces":
      return <SurfaceSheetPrint />;
    default:
      return null;
  }
}

export function printPresetUrl(
  showId: string,
  preset: SharePreset,
  opts: { session?: string | null } = {},
): string {
  const base = `/shows/${encodeURIComponent(showId)}/print`;
  switch (preset) {
    case "calling-script":
      return scriptPrintUrl(showId);
    case "cuesheet":
      return cueSheetUrl(showId);
    case "by-person":
    case "by-cue":
      return notesPrintUrl(showId, preset, opts);
    case "content":
      return `${base}/content?preset=content`;
    case "surfaces":
      return `${base}/surfaces?preset=surfaces`;
  }
}
