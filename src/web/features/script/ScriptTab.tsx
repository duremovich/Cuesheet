// The row panel's Script tab for a cue: where it sits in the script (current version, or
// the version being read), with the quoted text in its context and the anchor's state,
// plus "Show in script" / "Show in list".
import { useMemo } from "react";
import { Link } from "react-router";
import { useRow } from "../../lib/show-store";
import type { PanelTab } from "../shared/RowPanel";
import { rowUrl } from "../show/tabs";
import { useWorkspace } from "../show/workspace";
import type { AnchorState } from "./contract";
import { scriptUrl } from "./links";
import styles from "./Script.module.css";
import { useScriptSnapshot, useScriptVersions } from "./source";

const STATE_TEXT: Record<AnchorState, string> = {
  matched: "Matched in this version",
  moved: "Moved (same text, different place)",
  changed: "The line changed: check the placement",
  missing: "Not found in this version",
  manual: "Placed by hand",
};

export function ScriptTab({
  cueId,
  versionId,
  from,
}: {
  cueId: string;
  /** The version to show (default: the current one). */
  versionId?: string | null;
  /** Where the panel is: the script offers "Show in list", the grid "Show in script". */
  from: "script" | "grid";
}) {
  const ws = useWorkspace();
  const snap = useScriptSnapshot();
  const { versions, currentId } = useScriptVersions();
  const vid = versionId ?? currentId;
  const cue = useRow("cues", cueId);
  const version = versions.find((v) => v.id === vid);
  const anchor = useMemo(
    () => [...snap.anchors.values()].find((a) => a.cue_id === cueId && a.script_version_id === vid),
    [snap.anchors, cueId, vid],
  );
  return (
    <div className={styles.scriptTab} data-testid="panel-script">
      {!version ? (
        <p className="muted">No script imported yet.</p>
      ) : !anchor ? (
        <p className="muted">Not placed in {version.label ?? "this version"}.</p>
      ) : (
        <>
          <p>
            <span className={styles.stateChip} data-state={anchor.state}>
              {anchor.state}
            </span>{" "}
            {STATE_TEXT[anchor.state]}
            {anchor.confidence !== null && anchor.state !== "manual"
              ? ` · ${Math.round(anchor.confidence * 100)}%`
              : ""}
          </p>
          <p className="muted">
            {version.label ?? "Script"}
            {vid === currentId ? " (current)" : ""}
            {vid === currentId && cue?.page ? ` · page ${cue.page}` : ""}
          </p>
          {anchor.state !== "missing" && (
            <blockquote className={styles.context}>
              <span className="muted">…{anchor.prefix.replace(/\s+/g, " ")}</span>
              {anchor.length > 0 ? (
                <mark>{anchor.quote}</mark>
              ) : (
                <span className={styles.posMark} title="Placed at this position">
                  ▸
                </span>
              )}
              <span className="muted">{anchor.suffix.replace(/\s+/g, " ")}…</span>
            </blockquote>
          )}
        </>
      )}
      <p>
        {from === "grid" ? (
          <Link to={scriptUrl(ws.showId, cueId)} data-testid="panel-show-in-script">
            Show in script
          </Link>
        ) : (
          <Link to={rowUrl(ws.showId, "cues", cueId)}>Show in list</Link>
        )}
      </p>
    </div>
  );
}

/** The Script tab for a cue's row panel. */
export function scriptPanelTab(
  cueId: string,
  from: "script" | "grid",
  versionId?: string | null,
): PanelTab {
  return {
    id: "script",
    label: "Script",
    render: () => <ScriptTab cueId={cueId} from={from} versionId={versionId ?? null} />,
  };
}
