// The calling script (R21), /shows/:id/script/print?version=&filter=: the script's pages
// with cue markers in the margin beside the line they're on (quoted lines underlined),
// page labels, and a header with the show, version label and date. `?filter=` is the
// script view's filter bar (only matching cues); `?version=` a version other than the
// current one. Printed from the browser (print dialog / Save as PDF), always light.
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { type ShowState, useShowStore } from "../../lib/show-store";
import { useScriptText, useVersionAnchors } from "../script/data";
import { filterFromParam, isFiltered, markerColor, matchesMarker } from "../script/filters";
import { scriptUrl } from "../script/links";
import { markerStyle } from "../script/Marker";
import {
  anchorsByBlock,
  cueLabel,
  isPlaced,
  isPositionalCue,
  markerText,
  pagesOf,
  quoteRanges,
  triggerBadge,
} from "../script/markers";
import { BlockText } from "../script/ScriptBlocks";
import { useScriptVersions } from "../script/source";
import { useWorkspace } from "../show/workspace";
import styles from "./Print.module.css";
import { PrintShell, printDate } from "./PrintShell";

const selectState = (s: ShowState) => s;
const NONE: string[] = [];

export function CallingScriptPrint() {
  const ws = useWorkspace();
  const state = useShowStore(selectState);
  const { versions, currentId } = useScriptVersions();
  const [params, setParams] = useSearchParams();
  const vParam = params.get("version");
  const versionId = vParam && versions.some((v) => v.id === vParam) ? vParam : currentId;
  const version = versions.find((v) => v.id === versionId);
  const { text, error } = useScriptText(versionId);
  const anchors = useVersionAnchors(versionId, state.tables.cues);
  const filterParam = params.get("filter");
  const filter = useMemo(() => filterFromParam(filterParam), [filterParam]);
  const shown = useMemo(
    () =>
      anchors.filter((a) => {
        const cue = state.tables.cues.get(a.cue_id);
        return (
          !!cue &&
          isPlaced(a) &&
          matchesMarker(cue, state.joins.cueAssignees.get(cue.id) ?? NONE, filter)
        );
      }),
    [anchors, state.tables.cues, state.joins.cueAssignees, filter],
  );
  const byBlock = useMemo(
    () => anchorsByBlock(shown, (id) => state.tables.cues.get(id)?.order_key ?? ""),
    [shown, state.tables.cues],
  );
  const quotes = useMemo(
    () =>
      text
        ? quoteRanges(
            text,
            shown.filter((a) => !isPositionalCue(state.tables.cues.get(a.cue_id))),
          )
        : new Map(),
    [text, shown, state.tables.cues],
  );
  const pages = useMemo(() => (text ? pagesOf(text) : []), [text]);
  const filterText = [
    filter.status && `status ${filter.status}`,
    filter.trigger && `trigger ${filter.trigger}`,
    filter.assignee &&
      `assigned to ${state.tables.persons.get(filter.assignee)?.name ?? "someone"}`,
  ]
    .filter(Boolean)
    .join(", ");

  // Local state (the URL follows): a checkbox bound to the URL alone snaps back while the
  // router applies the change.
  const [go, setGo] = useState(params.get("go") !== "0");
  const date = printDate();

  return (
    <PrintShell
      title="Calling script"
      back={scriptUrl(ws.showId)}
      testId="print-script"
      screenOnlyHeader
      running={false}
      controls={
        <label className={styles.control}>
          <input
            type="checkbox"
            checked={go}
            onChange={(e) => {
              setGo(e.target.checked);
              setParams(
                (prev) => {
                  const next = new URLSearchParams(prev);
                  if (e.target.checked) next.delete("go");
                  else next.set("go", "0");
                  return next;
                },
                { replace: true },
              );
            }}
          />
          GO emphasis
        </label>
      }
      subtitle={
        <>
          <span data-testid="print-version">
            {version?.label ?? "No script"}
            {versionId && versionId !== currentId ? " (older version)" : ""}
          </span>
          <span>
            {shown.length} {shown.length === 1 ? "cue" : "cues"}
            {isFiltered(filter) ? ` · only ${filterText}` : ""}
          </span>
        </>
      }
    >
      {!versionId && <p>No script has been imported yet.</p>}
      {error && <p className="error">{error}</p>}
      {versionId && !text && !error && <p>Loading…</p>}
      {pages.map((p, idx) => (
        // One table per script page: its <thead>/<tfoot> repeat on every sheet the page
        // runs onto (the running header and footer); the last page doesn't force a break.
        <table
          key={p.page}
          className={styles.sheet}
          data-testid="print-page"
          data-last={idx === pages.length - 1 || undefined}
        >
          <thead>
            <tr>
              <td className={styles.running} data-testid="print-running-header">
                <span>{ws.showName}</span>
                <span>{version?.label ?? ""}</span>
                <span>Page {p.label}</span>
                <span>{date}</span>
              </td>
            </tr>
          </thead>
          <tfoot>
            <tr>
              <td className={styles.runningFoot}>
                {ws.showName} · {version?.label ?? ""} · page {p.label}
              </td>
            </tr>
          </tfoot>
          <tbody>
            <tr>
              <td className={styles.scriptPage}>
                <div className={styles.pageLabel}>Page {p.label}</div>
                {p.blocks.map((b) => {
                  const list = byBlock.get(b.i) ?? [];
                  return (
                    <div key={b.i} className={styles.scriptRow}>
                      <BlockText
                        block={b}
                        quotes={quotes.get(b.i)}
                        data-positional={
                          list.some((a) => isPositionalCue(state.tables.cues.get(a.cue_id))) ||
                          undefined
                        }
                      />
                      <div className={styles.printMargin}>
                        {list.map((a) => {
                          const cue = state.tables.cues.get(a.cue_id);
                          if (!cue) return null;
                          const badge = triggerBadge(cue);
                          return (
                            <div
                              key={a.id}
                              className={styles.printMarker}
                              data-testid="print-marker"
                              style={markerStyle(markerColor(cue, "status", state.fieldOptions))}
                            >
                              {go && (
                                <span className={styles.go} data-testid="print-go">
                                  GO
                                </span>
                              )}
                              <strong className={go ? styles.goNumber : undefined}>
                                {cueLabel(cue)}
                              </strong>
                              {badge && <span className={styles.printTrigger}> · {badge}</span>}
                              <div className={styles.printMarkerText}>{markerText(cue)}</div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </td>
            </tr>
          </tbody>
        </table>
      ))}
    </PrintShell>
  );
}
