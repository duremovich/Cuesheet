// Hooks over the script source: a version's text (fetched once per version), the import
// results kept for the Resolve screen (this tab's session), and the anchors of a version.
import { useEffect, useMemo, useState } from "react";
import { diffPages } from "../../../shared/script-anchor";
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

// ---- Revised pages (pages changed or new relative to the version before) ----

/** The pages of a version that differ from its predecessor's, and that version's label. */
export interface RevisedPages {
  /** The version's own label ("Pages 138, 139a"): the tag reads "Revised · <label>". */
  label: string;
  /** Physical page (1-based) → changed / new. Pages the same as before aren't in it. */
  pages: ReadonlyMap<number, "changed" | "new">;
}

type Revision = RevisedPages["pages"];

const revisedCache = new WeakMap<ScriptText, WeakMap<ScriptText, Revision>>();

/** `diffPages(prev, text)` as revised pages, computed once per pair of texts. */
export function revisedPagesOf(prev: ScriptText, text: ScriptText): Revision {
  let byPrev = revisedCache.get(text);
  if (!byPrev) {
    byPrev = new WeakMap();
    revisedCache.set(text, byPrev);
  }
  const hit = byPrev.get(prev);
  if (hit) return hit;
  const diff = diffPages(prev, text);
  const pages = new Map<number, "changed" | "new">();
  for (const p of diff.pages) if (p.status !== "same") pages.set(p.page, p.status);
  byPrev.set(prev, pages);
  return pages;
}

/**
 * The revised pages of a version against its predecessor (the version before it by
 * position; the base a version was re-anchored from isn't stored). Null while either text
 * loads, for the first version, or when nothing changed page-wise.
 */
export function useRevisedPages(
  text: ScriptText | null,
  prevVersionId: string | null,
  label: string,
): RevisedPages | null {
  const { text: prev } = useScriptText(prevVersionId);
  return useMemo(() => {
    if (!text || !prev) return null;
    const pages = revisedPagesOf(prev, text);
    return pages.size ? { label, pages } : null;
  }, [text, prev, label]);
}
