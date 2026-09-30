// The Resolve screen (ux.md §New script version, step 4): the cues whose anchors came out
// `changed` or `missing` after a new version was imported. For each: the old text with the
// marker on the left, the new page at the best guess on the right (other guesses as
// chips). Accept keeps the guess, Place lets you select the new text, Cut sets the cue's
// status to Cut and leaves it unanchored, Skip leaves it unanchored for later (a guess is
// dropped: the anchor becomes `missing`; the cue shows in the reader's Unplaced tray). Accepted / placed anchors become `manual`.
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { newId } from "../../../shared/ids";
import type { Op } from "../../../shared/ops";
import type { CueRow, FieldOptions } from "../../../shared/tables";
import type { Anchor, CueAnchorRow, ReanchorResult, ScriptText } from "./contract";
import { makeAnchor, makePositionAnchor } from "./contract";
import { useScriptText } from "./data";
import {
  cueLabel,
  markerText,
  type PageBlocks,
  pagesOf,
  type QuoteRange,
  quoteRanges,
  triggerBadge,
} from "./markers";
import { rangeToSpan } from "./placement";
import {
  allDone,
  buildResolveItems,
  initResolve,
  type ResolveItem,
  resolveReducer,
} from "./resolve";
import styles from "./Script.module.css";
import { BlockText } from "./ScriptBlocks";
import type { AnchorFields, AnchorOp } from "./source";

export const CUT_STATUS = "Cut";
const GUESS = new Set(["guess"]);
const OLD = new Set(["old"]);
const NO_QUOTES = new Map<number, QuoteRange[]>();

function fieldsOf(cueId: string, versionId: string, a: Anchor): AnchorFields {
  return {
    cue_id: cueId,
    script_version_id: versionId,
    block: a.block,
    offset: a.offset,
    length: a.length,
    quote: a.quote,
    prefix: a.prefix,
    suffix: a.suffix,
    state: "manual",
    confidence: 1,
  };
}

/** The anchor op that puts `item`'s cue at `a` on `versionId` (manual). */
export function placeOp(item: ResolveItem, versionId: string, a: Anchor): AnchorOp {
  const fields = fieldsOf(item.cueId, versionId, a);
  return item.anchorId
    ? { op: "update", id: item.anchorId, fields }
    : { op: "create", id: newId(), fields };
}

/**
 * Skip (ux.md): leave the cue unanchored on this version. Its guessed anchor, if any,
 * becomes `missing` (no position), so the cue shows in the Unplaced tray and keeps its
 * warning until someone places it. Accept is the way to keep a guess.
 */
export function skipBatch(item: ResolveItem): { cueOps: Op[]; anchorOps: AnchorOp[] } {
  return {
    cueOps: [],
    anchorOps:
      item.anchorId && item.state === "changed"
        ? [
            {
              op: "update",
              id: item.anchorId,
              fields: { state: "missing", block: null, confidence: 0 },
            },
          ]
        : [],
  };
}

/** Cut: status Cut, and no anchor on this version. */
export function cutBatch(item: ResolveItem): { cueOps: Op[]; anchorOps: AnchorOp[] } {
  return {
    cueOps: [{ op: "update", table: "cues", id: item.cueId, fields: { status: CUT_STATUS } }],
    anchorOps: item.anchorId ? [{ op: "delete", id: item.anchorId }] : [],
  };
}

const STATUS_LABEL: Record<ResolveItem["status"], string> = {
  pending: "To do",
  accepted: "Accepted",
  placed: "Placed",
  cut: "Cut",
  skipped: "Skipped",
};

export function ResolveScreen({
  versionId,
  versionLabel,
  prevVersionId,
  text,
  cues,
  fieldOptions,
  results,
  anchors,
  prevAnchors,
  initialCue,
  onApply,
  onExit,
  onError,
}: {
  versionId: string;
  versionLabel: string;
  prevVersionId: string | null;
  text: ScriptText;
  cues: ReadonlyMap<string, CueRow>;
  fieldOptions: FieldOptions;
  results: readonly ReanchorResult[] | null;
  anchors: readonly CueAnchorRow[];
  prevAnchors: readonly CueAnchorRow[];
  initialCue?: string | null;
  onApply: (cueOps: Op[], anchorOps: AnchorOp[]) => Promise<void>;
  onExit: () => void;
  onError: (e: unknown, what: string) => void;
}) {
  const prev = useScriptText(prevVersionId);
  const fresh = useMemo(
    () =>
      buildResolveItems({
        results,
        anchors,
        prevAnchors: prevAnchors.filter((a) => a.state !== "missing"),
        cueExists: (id) => {
          const c = cues.get(id);
          return !!c && c.status !== CUT_STATUS;
        },
      }),
    [results, anchors, prevAnchors, cues],
  );
  const [state, dispatch] = useReducer(resolveReducer, fresh, (items) => {
    const s = initResolve(items);
    const at = initialCue ? items.findIndex((it) => it.cueId === initialCue) : -1;
    return at >= 0 ? { ...s, index: at } : s;
  });
  useEffect(() => dispatch({ type: "sync", items: fresh }), [fresh]);

  const item = state.items[state.index];
  const cue = item ? cues.get(item.cueId) : undefined;
  const cand = item?.candidates[state.candidate];
  const newPages = useMemo(() => pagesOf(text), [text]);
  const prevPages = useMemo(() => (prev.text ? pagesOf(prev.text) : []), [prev.text]);

  // The page shown on the right: the guess's, else where the cue was (same page number).
  const guessPage = useMemo(() => {
    const block = cand?.anchor.block;
    if (block !== undefined) {
      const i = newPages.findIndex((p) => p.blocks.some((b) => b.i === block));
      if (i >= 0) return i;
    }
    const oldPage = item?.from ? prev.text?.blocks[item.from.block]?.page : undefined;
    const i = oldPage === undefined ? -1 : newPages.findIndex((p) => p.page >= oldPage);
    return i >= 0 ? i : Math.max(0, newPages.length - 1);
  }, [cand, newPages, item, prev.text]);
  const [pageIdx, setPageIdx] = useState(guessPage);
  useEffect(() => setPageIdx(guessPage), [guessPage]);
  const [picked, setPicked] = useState<Anchor | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new item or mode drops the pick
  useEffect(() => setPicked(null), [state.index, state.placing]);
  const [busy, setBusy] = useState(false);

  const run = async (
    fn: () => Promise<void>,
    status: "accepted" | "placed" | "cut" | "skipped",
    what: string,
  ) => {
    setBusy(true);
    try {
      await fn();
      dispatch({ type: "done", status });
    } catch (e) {
      onError(e, what);
    } finally {
      setBusy(false);
    }
  };

  const accept = () => {
    if (!item || !cand) return;
    void run(
      () => onApply([], [placeOp(item, versionId, cand.anchor)]),
      "accepted",
      "accept the placement",
    );
  };
  const place = () => {
    if (!item || !picked) return;
    void run(() => onApply([], [placeOp(item, versionId, picked)]), "placed", "place the cue");
  };
  const skip = () => {
    if (!item) return;
    const b = skipBatch(item);
    void run(() => onApply(b.cueOps, b.anchorOps), "skipped", "skip the cue");
  };
  const cut = () => {
    if (!item) return;
    const hasCut = fieldOptions["cues.status" as keyof FieldOptions]?.some(
      (o) => o.value === CUT_STATUS,
    );
    if (!hasCut) {
      onError(new Error(`add a "${CUT_STATUS}" status option to cues first`), "cut the cue");
      return;
    }
    const b = cutBatch(item);
    void run(() => onApply(b.cueOps, b.anchorOps), "cut", "cut the cue");
  };

  const rightRef = useRef<HTMLDivElement>(null);
  const onPickText = (e: React.MouseEvent) => {
    if (!state.placing) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      if (!rightRef.current?.contains(range.commonAncestorContainer)) return;
      const span = rangeToSpan(range);
      if (span) setPicked(makeAnchor(text, span.block, span.offset, span.length));
      return;
    }
    // A click without a selection: a position at the start of that block.
    const el = (e.target as Element).closest<HTMLElement>("[data-block]");
    if (el) setPicked(makePositionAnchor(text, Number(el.dataset.block)));
  };

  if (state.items.length === 0) {
    return (
      <div className={styles.resolveDone} data-testid="resolve-screen">
        <p>Nothing to resolve: every cue from the previous version found its place.</p>
        <button type="button" className={styles.primary} onClick={onExit}>
          Back to the script
        </button>
      </div>
    );
  }

  const done = allDone(state);
  const newPage = newPages[pageIdx];
  const highlight = picked ?? (state.placing ? null : (cand?.anchor ?? null));
  const newQuotes = highlight ? quoteRanges(text, [{ ...highlight, id: "guess" }]) : NO_QUOTES;

  return (
    <div className={styles.resolve} data-testid="resolve-screen">
      <aside className={styles.resolveList} aria-label="Cues to resolve">
        <p className="muted">
          {versionLabel}: {state.items.filter((i) => i.status === "pending").length} of{" "}
          {state.items.length} left
        </p>
        <ul>
          {state.items.map((it, i) => {
            const c = cues.get(it.cueId);
            return (
              <li key={it.cueId}>
                <button
                  type="button"
                  className={styles.resolveItem}
                  aria-current={i === state.index ? "true" : undefined}
                  data-status={it.status}
                  data-testid="resolve-item"
                  onClick={() => dispatch({ type: "select", index: i })}
                >
                  <strong>{cueLabel(c)}</strong>{" "}
                  <span className={styles.stateChip} data-state={it.state}>
                    {it.state}
                  </span>{" "}
                  <span className="muted">{STATUS_LABEL[it.status]}</span>
                </button>
              </li>
            );
          })}
        </ul>
        <button type="button" onClick={onExit}>
          {done ? "Back to the script" : "Finish later"}
        </button>
      </aside>
      <div className={styles.resolveMain}>
        {done && (
          <p className={styles.banner} data-kind="success" role="status" data-testid="resolve-done">
            All flagged cues are handled.
          </p>
        )}
        {item && cue && (
          <>
            <header className={styles.resolveHeader}>
              <h3>
                {cueLabel(cue)}{" "}
                {triggerBadge(cue) && <span className={styles.trigger}>{triggerBadge(cue)}</span>}{" "}
                <span className={styles.stateChip} data-state={item.state}>
                  {item.state === "changed" ? "Line changed" : "Not found"}
                </span>
              </h3>
              <p className="muted">{markerText(cue) || "No description"}</p>
            </header>
            <div className={styles.resolvePanes}>
              <section aria-label="Previous version" className={styles.pane}>
                <h4>Before</h4>
                {prev.error && <p className="error">{prev.error}</p>}
                {!prev.text && !prev.error && prevVersionId && <p className="muted">Loading…</p>}
                {prev.text && item.from && (
                  <OldContext
                    text={prev.text}
                    pages={prevPages}
                    from={item.from}
                    label={cueLabel(cue)}
                  />
                )}
                {!item.from && <p className="muted">Not placed in the previous version.</p>}
              </section>
              <section aria-label="New version" className={styles.pane}>
                <h4>
                  Now{" "}
                  {newPage && (
                    <span className="muted">
                      · page {newPage.label}{" "}
                      <button
                        type="button"
                        className={styles.pageNav}
                        aria-label="Previous page"
                        disabled={pageIdx <= 0}
                        onClick={() => setPageIdx((i) => Math.max(0, i - 1))}
                      >
                        ‹
                      </button>
                      <button
                        type="button"
                        className={styles.pageNav}
                        aria-label="Next page"
                        disabled={pageIdx >= newPages.length - 1}
                        onClick={() => setPageIdx((i) => Math.min(newPages.length - 1, i + 1))}
                      >
                        ›
                      </button>
                    </span>
                  )}
                </h4>
                {item.candidates.length > 1 && !state.placing && (
                  <fieldset className={styles.chips} aria-label="Best guesses">
                    {item.candidates.map((c, i) => (
                      <button
                        // biome-ignore lint/suspicious/noArrayIndexKey: candidates are ranked
                        key={i}
                        type="button"
                        aria-pressed={i === state.candidate}
                        onClick={() => dispatch({ type: "candidate", index: i })}
                      >
                        Guess {i + 1} · {Math.round(c.score * 100)}%
                      </button>
                    ))}
                  </fieldset>
                )}
                {state.placing && (
                  <p className={styles.banner} data-kind="info">
                    Select the new text for {cueLabel(cue)} (or click a line to place it at its
                    start).
                  </p>
                )}
                {item.candidates.length === 0 && !state.placing && (
                  <p className="muted">No likely match in the new version.</p>
                )}
                {/* biome-ignore lint/a11y/noStaticElementInteractions: text selection target in Place mode */}
                <div
                  ref={rightRef}
                  className={styles.paneText}
                  data-placing={state.placing || undefined}
                  data-testid="resolve-new-text"
                  onMouseUp={onPickText}
                >
                  {newPage?.blocks.map((b) => (
                    <BlockText
                      key={b.i}
                      block={b}
                      quotes={newQuotes.get(b.i)}
                      hot={GUESS}
                      data-guess={highlight?.block === b.i || undefined}
                    />
                  ))}
                </div>
              </section>
            </div>
            {item.status !== "pending" ? (
              <p className="muted" data-testid="resolve-status">
                {STATUS_LABEL[item.status]}.
              </p>
            ) : state.placing ? (
              <div className={styles.resolveActions}>
                <button
                  type="button"
                  className={styles.primary}
                  disabled={!picked || busy}
                  onClick={place}
                >
                  {picked ? `Place ${cueLabel(cue)} here` : "Select text first"}
                </button>
                <button type="button" onClick={() => dispatch({ type: "cancelPlace" })}>
                  Cancel
                </button>
              </div>
            ) : (
              <div className={styles.resolveActions}>
                <button
                  type="button"
                  className={styles.primary}
                  disabled={!cand || busy}
                  onClick={accept}
                  title="Keep the best guess"
                >
                  Accept
                </button>
                <button type="button" disabled={busy} onClick={() => dispatch({ type: "place" })}>
                  Place
                </button>
                <button type="button" disabled={busy} onClick={cut} title="Mark the cue as Cut">
                  Cut
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={skip}
                  title="Leave it unplaced (it goes to the Unplaced tray)"
                >
                  Skip
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** The old version around the cue: its block with the quote underlined, ±1 block. */
function OldContext({
  text,
  pages,
  from,
  label,
}: {
  text: ScriptText;
  pages: readonly PageBlocks[];
  from: Anchor;
  label: string;
}) {
  const page = pages.find((p) => p.blocks.some((b) => b.i === from.block));
  const oldQuotes = quoteRanges(text, [{ ...from, id: "old" }]);
  const blocks = text.blocks.slice(Math.max(0, from.block - 1), from.block + 2);
  return (
    <div className={styles.paneText} data-testid="resolve-old-text">
      {page && <p className="muted">Page {page.label}</p>}
      {blocks.map((b) => (
        <div key={b.i} className={styles.oldRow}>
          <BlockText block={b} quotes={oldQuotes.get(b.i)} hot={OLD} />
          {b.i === from.block && <span className={styles.oldMarker}>{label}</span>}
        </div>
      ))}
    </div>
  );
}
