// The Script tab (R20; ux.md §Script view), /shows/:id/script: import a script, read it
// with cue markers in the margin, place cues, import new versions and resolve the cues
// that didn't re-anchor cleanly. `?cue=<id>` scrolls to that cue's marker and flashes it
// (the cue list's parameter, so "Show in script" / "Show in list" round-trip);
// `?version=<id>` reads an older version (read-only); `?filter=` is the marker filter;
// `?resolve=<versionId>` is the Resolve screen for that version (pinned: if someone
// imports a newer one meanwhile, the screen says so and offers to switch; "1" = current). Editors place and resolve; everyone else reads.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { attachmentUrl } from "../../../shared/attachments";
import { newId } from "../../../shared/ids";
import type { Op } from "../../../shared/ops";
import type { FieldOption } from "../../../shared/tables";
import { api } from "../../lib/api";
import { ViewCache } from "../../lib/show-selectors";
import { type ShowState, useShowStore, useShowStoreInstance } from "../../lib/show-store";
import { cueColumns, cueEditOps } from "../cues/columns";
import { buildCueViews, type CueView, openNotesByCue } from "../cues/cueViews";
import { searchCues } from "../shared/pickers";
import { usePref } from "../shared/prefs";
import { RowPanel } from "../shared/RowPanel";
import { TableFrame, ToolbarButton } from "../shared/TableFrame";
import frameStyles from "../shared/TableFrame.module.css";
import type { FocusState } from "../shared/useTableChrome";
import { rowUrl } from "../show/tabs";
import { useWorkspace } from "../show/workspace";
import type { Anchor, ImportVersionResponse } from "./contract";
import { loadResults, saveResults, useScriptText, useVersionAnchors } from "./data";
import {
  COLOR_BY,
  type ColorBy,
  filterFromParam,
  filterToParam,
  isColorBy,
  isFiltered,
  type MarkerFilter,
} from "./filters";
import { ImportPanel, isLowConfidence, LowConfidenceBanner, uploadOriginal } from "./ImportPanel";
import { scriptPrintUrl } from "./links";
import type { MarkerActions } from "./Marker";
import { MoveDialog } from "./MoveDialog";
import { cueLabel, isPlaced, isPositionalCue } from "./markers";
import {
  attachBatch,
  moveAnchorOp,
  moveAsPositionalBatch,
  moveNeedsChoice,
  moveRequoteBatch,
  type NewCueInput,
  newCueBatch,
  scriptNeighbours,
  suggestNumber,
} from "./placement";
import { type FocusRequest, type Placement, Reader } from "./Reader";
import { ResolveScreen } from "./ResolveScreen";
import { buildResolveItems, type ReportCounts, reportCounts, reportText } from "./resolve";
import styles from "./Script.module.css";
import { scriptPanelTab } from "./ScriptTab";
import { type AnchorOp, useScriptSource, useScriptVersions } from "./source";

const selectState = (s: ShowState) => s;
const NO_OPTIONS: FieldOption[] = [];
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
export const CUT = "Cut";

export function ScriptPage() {
  const ws = useWorkspace();
  const store = useShowStoreInstance();
  const source = useScriptSource();
  const state = useShowStore(selectState);
  const { tables, joins, fieldOptions } = state;
  const { versions, currentId } = useScriptVersions();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();

  const setParam = useCallback(
    (key: string, value: string | null, replace = true) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (value) next.set(key, value);
          else next.delete(key);
          return next;
        },
        { replace, preventScrollReset: true },
      ),
    [setParams],
  );

  // --- which version ---
  const vParam = params.get("version");
  const resolveParam = ws.canEdit ? params.get("resolve") : null;
  const resolveVid =
    resolveParam === "1"
      ? currentId
      : resolveParam && versions.some((v) => v.id === resolveParam)
        ? resolveParam
        : null;
  const viewId =
    resolveVid ?? (vParam && versions.some((v) => v.id === vParam) ? vParam : currentId);
  const vIndex = versions.findIndex((v) => v.id === viewId);
  const version = versions[vIndex] ?? null;
  const prevId = vIndex > 0 ? (versions[vIndex - 1]?.id ?? null) : null;
  const isCurrent = !!viewId && viewId === currentId;
  const canPlace = ws.canEdit && isCurrent;
  const resolving = !!resolveVid;
  const openResolve = (cueId?: string) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("resolve", currentId ?? "1");
        next.delete("version");
        if (cueId) next.set("cue", cueId);
        return next;
      },
      { preventScrollReset: true },
    );
  const { text, error: textError } = useScriptText(viewId);
  const anchors = useVersionAnchors(viewId, tables.cues);
  const prevAnchors = useVersionAnchors(prevId, tables.cues);
  const anchorsRef = useRef(anchors);
  anchorsRef.current = anchors;

  // --- filter bar, colors ---
  const filterParam = params.get("filter") ?? "";
  const filter = useMemo(() => filterFromParam(filterParam), [filterParam]);
  const setFilter = (f: MarkerFilter) => setParam("filter", filterToParam(f) || null);
  const prefKey = `${ws.userId}.${ws.showId}`;
  const [colorBy, setColorBy] = usePref<ColorBy>(
    `cuesheet.scriptColor.${prefKey}`,
    "status",
    isColorBy,
  );
  const [showOthers, setShowOthers] = usePref(`cuesheet.scriptOthers.${prefKey}`, false, isBool);

  // --- import / report ---
  const [importOpen, setImportOpen] = useState(false);
  const [report, setReport] = useState<{
    versionId: string;
    counts: ReportCounts | null;
    flagged: number;
  } | null>(null);
  const [originalError, setOriginalError] = useState<{ versionId: string; message: string } | null>(
    null,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-read after an import (report)
  const results = useMemo(() => loadResults(ws.showId, viewId), [ws.showId, viewId, report]);
  const onImported = (res: ImportVersionResponse, origError: string | null, _file: File) => {
    saveResults(ws.showId, res.versionId, res.results);
    const counts = res.results.length ? reportCounts(res.results.map((r) => r.state)) : null;
    setReport({
      versionId: res.versionId,
      counts,
      flagged: counts ? counts.changed + counts.missing : 0,
    });
    setImportOpen(false);
    setParam("version", null);
    setOriginalError(origError ? { versionId: res.versionId, message: origError } : null);
  };

  // --- flagged cues (Resolve count, Unplaced tray) ---
  const flagged = useMemo(
    () =>
      isCurrent && prevId
        ? buildResolveItems({
            results,
            anchors,
            prevAnchors: prevAnchors.filter(isPlaced),
            cueExists: (id) => {
              const c = tables.cues.get(id);
              return !!c && c.status !== CUT;
            },
          })
        : [],
    [isCurrent, prevId, results, anchors, prevAnchors, tables.cues],
  );
  const unplaced = useMemo(
    () => flagged.filter((it) => !anchors.some((a) => a.cue_id === it.cueId && isPlaced(a))),
    [flagged, anchors],
  );

  // --- ?cue= → scroll + flash; the panel ---
  const cueParam = params.get("cue");
  const [panelCue, setPanelCue] = useState<string | null>(null);
  const [focusReq, setFocusReq] = useState<FocusRequest | null>(null);
  const nonce = useRef(0);
  const written = useRef<string | null>(null);
  const focusState = (location.state as FocusState | null)?.focus;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new navigation or ?cue= we didn't write
  useEffect(() => {
    const id = focusState ?? cueParam;
    if (!id || (id === written.current && !focusState)) return;
    written.current = id;
    setFocusReq({ cueId: id, nonce: ++nonce.current });
  }, [location.key, cueParam]);
  const focusCue = useCallback((cueId: string) => {
    setFocusReq({ cueId, nonce: ++nonce.current });
  }, []);
  const onFocusHandled = useCallback(() => setFocusReq(null), []);
  const onFocusMissing = useCallback(
    (cueId: string) => {
      const cue = store.getState().tables.cues.get(cueId);
      if (!cue) ws.toast("That cue no longer exists.");
      else ws.toast(`${cueLabel(cue)} isn't placed in this version of the script.`);
    },
    [store, ws],
  );

  const openCue = useCallback(
    (cueId: string) => {
      setPanelCue(cueId);
      written.current = cueId;
      setParam("cue", cueId);
    },
    [setParam],
  );
  const showInList = useCallback(
    (cueId: string) => {
      const st: FocusState = { focus: cueId };
      navigate(rowUrl(ws.showId, "cues", cueId), { state: st });
    },
    [navigate, ws.showId],
  );
  const report_ = ws.reportError;
  const apply = useCallback(
    (cueOps: Op[], anchorOps: AnchorOp[], what: string) =>
      source.apply(cueOps, anchorOps).catch((e: unknown) => {
        report_(e, what);
        throw e;
      }),
    [source, report_],
  );
  const actions = useMemo<MarkerActions>(
    () => ({
      onOpen: openCue,
      onShowInList: showInList,
      onRemove: canPlace
        ? (anchorId: string) =>
            void apply(
              [],
              [{ op: "delete", id: anchorId }],
              "remove the cue from the script",
            ).catch(() => undefined)
        : undefined,
    }),
    [openCue, showInList, canPlace, apply],
  );

  // --- placing ---
  const placement = useMemo<Placement>(
    () => ({
      suggest: (at) =>
        suggestNumber(scriptNeighbours(anchorsRef.current, store.getState().tables.cues, at)),
      searchCues: (q) => searchCues(store.getState(), q, null),
      create: async (anchor: Anchor, input: NewCueInput) => {
        if (!viewId) return;
        const cueId = newId();
        const neighbours = scriptNeighbours(
          anchorsRef.current,
          store.getState().tables.cues,
          anchor,
        );
        const b = newCueBatch({
          cueId,
          anchorId: newId(),
          versionId: viewId,
          anchor,
          input,
          neighbours,
        });
        await apply(b.cueOps, b.anchorOps, "add the cue");
        ws.toast(`Added ${input.number.trim() ? `cue ${input.number.trim()}` : "a cue"}.`);
        focusCue(cueId);
      },
      attach: async (cueId, anchor, positionTrigger) => {
        const cue = store.getState().tables.cues.get(cueId);
        if (!cue || !viewId) return;
        const existing = anchorsRef.current.find((a) => a.cue_id === cueId);
        const b = attachBatch({
          cue,
          existing,
          anchorId: newId(),
          versionId: viewId,
          anchor,
          positionTrigger,
        });
        await apply(b.cueOps, b.anchorOps, "attach the cue");
        focusCue(cueId);
      },
      move: async (anchorId, block) => {
        const row = anchorsRef.current.find((a) => a.id === anchorId);
        if (!row || !text || row.block === block) return;
        const positional = isPositionalCue(store.getState().tables.cues.get(row.cue_id));
        if (moveNeedsChoice(row, text, block, positional)) {
          setMoveAsk({ anchorId, block });
          return;
        }
        await apply([], [moveAnchorOp(row, text, block, positional)], "move the marker").catch(
          () => undefined,
        );
      },
    }),
    [store, viewId, apply, ws, focusCue, text],
  );

  // A Line marker dropped on a line without its quote: ask (MoveDialog).
  const [moveAsk, setMoveAsk] = useState<{ anchorId: string; block: number } | null>(null);
  const moveRow = moveAsk ? anchors.find((a) => a.id === moveAsk.anchorId) : undefined;
  const finishMove = (batch: { cueOps: Op[]; anchorOps: AnchorOp[] }) => {
    setMoveAsk(null);
    void apply(batch.cueOps, batch.anchorOps, "move the marker").catch(() => undefined);
  };

  // --- member names for "Resolved by …" / "imported by …" (members added after the
  // workspace loaded its list are fetched once when an unknown id shows up) ---
  const [extraNames, setExtraNames] = useState<ReadonlyMap<string, string>>(new Map());
  const unknownUsers = useMemo(() => {
    const ids = new Set<string>();
    for (const a of anchors) if (a.updated_by) ids.add(a.updated_by);
    for (const v of versions) ids.add(v.created_by);
    return [...ids]
      .filter((id) => id && id !== ws.userId && !ws.memberNames.has(id) && !extraNames.has(id))
      .sort()
      .join(",");
  }, [anchors, versions, ws.userId, ws.memberNames, extraNames]);
  useEffect(() => {
    if (!resolving || !unknownUsers) return;
    let live = true;
    api
      .members(ws.showId)
      .then((r) => {
        if (live) setExtraNames(new Map(r.members.map((m) => [m.userId, m.name])));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [resolving, unknownUsers, ws.showId]);
  const nameOf = useCallback(
    (uid: string) => ws.memberNames.get(uid) ?? extraNames.get(uid) ?? null,
    [ws.memberNames, extraNames],
  );

  // --- the row panel (cue fields, notes, the Script tab) ---
  const cache = useRef(new ViewCache<CueView>()).current;
  // biome-ignore lint/correctness/useExhaustiveDependencies: recomputed when the inputs change
  const views = useMemo(
    () => buildCueViews(state, cache, ws.showId),
    [
      tables.cues,
      tables.content,
      tables.persons,
      tables.scenes,
      tables.content_versions,
      tables.attachments,
      state.order.cues,
      joins.cueContent,
      joins.cueAssignees,
      ws.showId,
    ],
  );
  const viewsById = useMemo(() => new Map(views.map((v) => [v.id, v])), [views]);
  const columns = useMemo(
    () => cueColumns({ store, fieldOptions, editable: ws.canEdit }),
    [store, fieldOptions, ws.canEdit],
  );
  const panelView = panelCue ? viewsById.get(panelCue) : undefined;
  const panelTabs = useMemo(
    () => (panelCue ? [scriptPanelTab(panelCue, "script", viewId)] : undefined),
    [panelCue, viewId],
  );
  const stepPanel = (d: number) => {
    const placed = anchors.filter(isPlaced);
    const i = placed.findIndex((a) => a.cue_id === panelCue);
    const next = placed[i + d];
    if (next) {
      openCue(next.cue_id);
      focusCue(next.cue_id);
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: notes and links are the inputs
  const openNotes = useMemo(() => openNotesByCue(state), [tables.notes, joins.noteCues]);

  // --- original file ---
  const attachInput = useRef<HTMLInputElement>(null);
  const attachOriginal = async (file: File | undefined) => {
    if (!file || !version) return;
    const err = await uploadOriginal(source, ws.showId, version.id, file);
    setOriginalError(err ? { versionId: version.id, message: err } : null);
    if (!err) ws.toast("Original file attached.");
  };

  const statusOptions = fieldOptions["cues.status" as keyof typeof fieldOptions] ?? NO_OPTIONS;
  const triggerOptions =
    fieldOptions["cues.trigger_type" as keyof typeof fieldOptions] ?? NO_OPTIONS;
  const people = useMemo(
    () => [...tables.persons.values()].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")),
    [tables.persons],
  );
  const pending = flagged.length;

  if (versions.length === 0) {
    return (
      <TableFrame title="Script" testId="script-view">
        <div className={styles.empty} data-testid="script-empty">
          {ws.canEdit ? (
            <ImportPanel
              source={source}
              showId={ws.showId}
              defaultLabel="v1"
              isNewVersion={false}
              onDone={onImported}
            />
          ) : (
            <p className="muted">No script has been imported for this show yet.</p>
          )}
        </div>
      </TableFrame>
    );
  }

  const toolbar = (
    <>
      <select
        className={styles.select}
        aria-label="Script version"
        value={viewId ?? ""}
        onChange={(e) =>
          setParam("version", e.target.value === currentId ? null : e.target.value, false)
        }
      >
        {versions.map((v, i) => (
          <option key={v.id} value={v.id}>
            {v.label || `Version ${i + 1}`}
            {v.id === currentId ? " (current)" : ""}
          </option>
        ))}
      </select>
      {!isCurrent && (
        <>
          <span className={styles.readOnly} data-testid="script-readonly">
            Read-only: an older version
          </span>
          <ToolbarButton onClick={() => setParam("version", null, false)}>
            Back to current
          </ToolbarButton>
        </>
      )}
      <fieldset className={styles.filterBar} aria-label="Marker filter">
        <select
          className={styles.select}
          aria-label="Filter by status"
          value={filter.status ?? ""}
          onChange={(e) => setFilter({ ...filter, status: e.target.value || null })}
        >
          <option value="">Any status</option>
          {statusOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.value}
            </option>
          ))}
        </select>
        <select
          className={styles.select}
          aria-label="Filter by assignee"
          value={filter.assignee ?? ""}
          onChange={(e) => setFilter({ ...filter, assignee: e.target.value || null })}
        >
          <option value="">Anyone</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name ?? "(no name)"}
            </option>
          ))}
        </select>
        <select
          className={styles.select}
          aria-label="Filter by trigger"
          value={filter.trigger ?? ""}
          onChange={(e) => setFilter({ ...filter, trigger: e.target.value || null })}
        >
          <option value="">Any trigger</option>
          {triggerOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.value}
            </option>
          ))}
        </select>
        <select
          className={styles.select}
          aria-label="Color markers by"
          value={colorBy}
          onChange={(e) => setColorBy(isColorBy(e.target.value) ? e.target.value : "status")}
        >
          {COLOR_BY.map((c) => (
            <option key={c.value} value={c.value}>
              Color: {c.label}
            </option>
          ))}
        </select>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={showOthers}
            onChange={(e) => setShowOthers(e.target.checked)}
          />
          LX/SQ
        </label>
        {isFiltered(filter) && (
          <button
            type="button"
            className={styles.linkButton}
            onClick={() => setFilter({ status: null, assignee: null, trigger: null })}
          >
            Clear
          </button>
        )}
      </fieldset>
      {canPlace && pending > 0 && !resolving && (
        <ToolbarButton onClick={() => openResolve()} data-testid="open-resolve">
          Resolve ({pending})
        </ToolbarButton>
      )}
      {ws.canEdit && (
        <ToolbarButton onClick={() => setImportOpen(true)}>Import new version</ToolbarButton>
      )}
      <Link
        className={frameStyles.toolButton}
        to={scriptPrintUrl(ws.showId, {
          versionId: isCurrent ? null : viewId,
          filter: filterToParam(filter),
        })}
      >
        Print calling script
      </Link>
    </>
  );

  const notice = (
    <>
      {moveAsk && moveRow && text && (
        <MoveDialog
          cueLabel={cueLabel(tables.cues.get(moveRow.cue_id))}
          line={text.blocks[moveAsk.block]?.text ?? ""}
          onCancel={() => setMoveAsk(null)}
          onPositional={(trigger) =>
            finishMove(moveAsPositionalBatch(moveRow, text, moveAsk.block, trigger))
          }
          onRequote={() => finishMove(moveRequoteBatch(moveRow, text, moveAsk.block))}
        />
      )}
      {importOpen && (
        <ImportPanel
          source={source}
          showId={ws.showId}
          defaultLabel={`v${versions.length + 1}`}
          isNewVersion
          onDone={onImported}
          onCancel={() => setImportOpen(false)}
        />
      )}
      {report && report.versionId === viewId && (
        <div className={styles.banner} data-kind="info" role="status" data-testid="import-report">
          <span>
            {report.counts ? (
              <>
                New version imported:{" "}
                <strong data-testid="report-counts">{reportText(report.counts)}</strong>
              </>
            ) : (
              <>
                Script imported: {text?.pages.length ?? version?.page_count ?? 0} pages. Select a
                line to place a cue.
              </>
            )}
          </span>
          {report.flagged > 0 && canPlace && (
            <button type="button" className={styles.primary} onClick={() => openResolve()}>
              Resolve {report.flagged} {report.flagged === 1 ? "cue" : "cues"}
            </button>
          )}
          <button
            type="button"
            className={styles.linkButton}
            aria-label="Dismiss"
            onClick={() => setReport(null)}
          >
            ×
          </button>
        </div>
      )}
      {originalError && originalError.versionId === viewId && (
        <div
          className={styles.banner}
          data-kind="warning"
          role="status"
          data-testid="original-missing"
        >
          No original file for this version: {originalError.message}.
          {ws.canEdit && (
            <button
              type="button"
              className={styles.linkButton}
              onClick={() => attachInput.current?.click()}
            >
              Retry with a file…
            </button>
          )}
        </div>
      )}
      {version &&
        isLowConfidence({
          source: version.source ?? "txt",
          confidence: version.confidence ?? 1,
        }) && <LowConfidenceBanner source={version.source} />}
      {unplaced.length > 0 && !resolving && (
        <fieldset className={styles.tray} data-testid="unplaced-tray" aria-label="Unplaced cues">
          <span className="muted">Unplaced ({unplaced.length}):</span>
          {unplaced.map((it) => {
            const cue = tables.cues.get(it.cueId);
            return (
              <button
                key={it.cueId}
                type="button"
                className={styles.trayChip}
                onClick={() => (canPlace ? openResolve(it.cueId) : openCue(it.cueId))}
              >
                {cueLabel(cue)}
              </button>
            );
          })}
        </fieldset>
      )}
      {version && (
        <p className={styles.versionInfo}>
          {version.attachment_id ? (
            <a
              href={attachmentUrl(ws.showId, version.attachment_id)}
              target="_blank"
              rel="noreferrer"
            >
              Original file
            </a>
          ) : (
            <span className="muted">No original file</span>
          )}
          {!version.attachment_id && ws.canEdit && (
            <button
              type="button"
              className={styles.linkButton}
              onClick={() => attachInput.current?.click()}
            >
              Attach original…
            </button>
          )}
          <input
            ref={attachInput}
            type="file"
            hidden
            accept=".pdf,.docx,.txt,.md"
            onChange={(e) => {
              void attachOriginal(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </p>
      )}
    </>
  );

  return (
    <TableFrame
      title="Script"
      testId="script-view"
      toolbar={toolbar}
      notice={notice}
      panel={
        panelView && !resolving ? (
          <RowPanel
            title={panelView.cue.number ? `Cue ${panelView.cue.number}` : "Cue (no number)"}
            row={panelView}
            columns={columns}
            table="cues"
            recordId={panelView.id}
            onEdit={
              ws.canEdit
                ? (key, value) => store.mutate(cueEditOps(panelView, key, value))
                : undefined
            }
            extraTabs={panelTabs}
            onClose={() => setPanelCue(null)}
            onStep={stepPanel}
          />
        ) : null
      }
    >
      {textError ? (
        <p className="error">Couldn't load the script text: {textError}</p>
      ) : !text ? (
        <p className="muted">Loading the script…</p>
      ) : resolving && viewId ? (
        <ResolveScreen
          key={viewId}
          versionId={viewId}
          versionLabel={version?.label ?? "This version"}
          prevVersionId={prevId}
          text={text}
          cues={tables.cues}
          fieldOptions={fieldOptions}
          results={results}
          anchors={anchors}
          prevAnchors={prevAnchors.filter(isPlaced)}
          initialCue={cueParam}
          onApply={(c, a) => source.apply(c, a)}
          onError={ws.reportError}
          onExit={() => setParam("resolve", null, false)}
          readLive={(cueId) =>
            [...source.getSnapshot().anchors.values()].find(
              (a) => a.cue_id === cueId && a.script_version_id === viewId,
            )
          }
          readCue={(cueId) => store.getState().tables.cues.get(cueId)}
          nameOf={nameOf}
          userId={ws.userId}
          onNotice={(m) => ws.toast(m)}
          newerVersion={
            currentId && currentId !== viewId
              ? {
                  label: versions.find((v) => v.id === currentId)?.label ?? "a newer version",
                  by: (() => {
                    const uid = versions.find((v) => v.id === currentId)?.created_by;
                    if (!uid) return null;
                    return uid === ws.userId ? "you" : nameOf(uid);
                  })(),
                }
              : null
          }
          onSwitchVersion={() => openResolve()}
        />
      ) : (
        <Reader
          text={text}
          anchors={anchors}
          cues={tables.cues}
          assignees={joins.cueAssignees}
          openNotes={openNotes}
          fieldOptions={fieldOptions}
          filter={filter}
          colorBy={colorBy}
          showOthers={showOthers}
          canPlace={canPlace}
          activeCue={panelCue}
          focusRequest={focusReq}
          onFocusMissing={onFocusMissing}
          onFocusHandled={onFocusHandled}
          actions={actions}
          placement={placement}
        />
      )}
    </TableFrame>
  );
}
