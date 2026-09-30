// Hooks over the script source: a version's text (fetched once per version), the import
// results kept for the Resolve screen (this tab's session), and the anchors of a version.
import { useEffect, useMemo, useState } from "react";
import type { CueRow } from "../../../shared/tables";
import type { CueAnchorRow, ReanchorResult, ScriptText } from "./contract";
import { versionAnchors } from "./markers";
import { useScriptSnapshot, useScriptSource } from "./source";

export interface TextState {
  text: ScriptText | null;
  error: string | null;
}

/** A version's extracted text (null while loading or without a version). */
export function useScriptText(versionId: string | null): TextState {
  const source = useScriptSource();
  const [state, setState] = useState<{ id: string | null } & TextState>({
    id: null,
    text: null,
    error: null,
  });
  useEffect(() => {
    if (!versionId) return;
    let live = true;
    source.fetchText(versionId).then(
      (text) => live && setState({ id: versionId, text, error: null }),
      (e: unknown) =>
        live &&
        setState({
          id: versionId,
          text: null,
          error: e instanceof Error ? e.message : String(e),
        }),
    );
    return () => {
      live = false;
    };
  }, [source, versionId]);
  return state.id === versionId && versionId
    ? { text: state.text, error: state.error }
    : { text: null, error: null };
}

// ---- Import results (for the report and the Resolve screen) ----

const resultsKey = (showId: string, versionId: string) =>
  `cuesheet.scriptResults.${showId}.${versionId}`;

export function saveResults(showId: string, versionId: string, results: ReanchorResult[]): void {
  try {
    sessionStorage.setItem(resultsKey(showId, versionId), JSON.stringify(results));
  } catch {
    // not kept; the Resolve screen falls back to the anchor rows
  }
}

export function loadResults(showId: string, versionId: string | null): ReanchorResult[] | null {
  if (!versionId) return null;
  try {
    const raw = sessionStorage.getItem(resultsKey(showId, versionId));
    return raw ? (JSON.parse(raw) as ReanchorResult[]) : null;
  } catch {
    return null;
  }
}

/** A version's anchors (cues that still exist), in script order. */
export function useVersionAnchors(
  versionId: string | null,
  cues: ReadonlyMap<string, CueRow>,
): CueAnchorRow[] {
  const snap = useScriptSnapshot();
  return useMemo(
    () => versionAnchors(snap.anchors, versionId, cues),
    [snap.anchors, versionId, cues],
  );
}
