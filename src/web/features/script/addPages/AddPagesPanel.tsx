// "Add pages…" (Script tab header, editors): replacement / inserted pages for the current
// version when its original is a PDF. Drop or pick PDFs → each page's printed label is read
// (the extractor's own logic) → a plan, one editable row per page (Replace X / Insert after
// X / Insert at the start / Skip), plus "Remove pages" for cuts with no replacement →
// Preview: the current PDF is fetched, the merged PDF built (pdf-lib, ./merge) and the
// whole of it extracted like a full import (running headers, labels) → Import: the same
// path as ImportPanel (POST the version re-anchored from the current one, upload the merged
// PDF as its original, the report and the Resolve screen). Lazy chunk (pdf-lib, pdf.js).
import { useMemo, useRef, useState } from "react";
import { attachmentUrl, MAX_ATTACHMENT_BYTES } from "../../../../shared/attachments";
import { newId } from "../../../../shared/ids";
import { diffPages, type PageDiff } from "../../../../shared/script-anchor";
import type { AttachmentRow } from "../../../../shared/tables";
import type { ImportVersionResponse, ScriptText, ScriptVersionRow } from "../contract";
import { useScriptText } from "../data";
import { labelShape } from "../extract/labels";
import { extractPdf } from "../extract/pdf";
import {
  isLowConfidence,
  LowConfidenceBanner,
  originalTooBig,
  textTooBig,
  uploadOriginal,
} from "../ImportPanel";
import { loadPdfjs } from "../pdf/pdfjs";
import styles from "../Script.module.css";
import type { ScriptSource } from "../source";
import { MergeError, mergePdf } from "./merge";
import {
  actionText,
  type BasePage,
  basePageName,
  buildPlan,
  checkPlan,
  defaultVersionLabel,
  mergeOrder,
  type PlanRow,
  proposeAction,
  type RowAction,
} from "./plan";
import { type IncomingFile, readIncoming } from "./read";

export interface AddPagesPanelProps {
  source: ScriptSource;
  showId: string;
  /** The current version (pages are added to it). */
  version: ScriptVersionRow;
  /** Its original file (`attachment_id`), if any. */
  original: AttachmentRow | null;
  onDone: (res: ImportVersionResponse, originalError: string | null, file: File) => void;
  onCancel: () => void;
  /** Switch to "Import new version" (when this version has no PDF to add to). */
  onImportFull: () => void;
}

type Phase =
  | { kind: "plan" }
  | { kind: "reading"; names: string[] }
  | { kind: "building"; step: string }
  | { kind: "preview"; file: File; text: ScriptText; diff: PageDiff }
  | { kind: "importing"; file: File; text: ScriptText; diff: PageDiff; step: string };

/** The form most of the current labels share ("#" for 1, 2, 13a…). */
function dominantShape(base: readonly BasePage[]): string | null {
  const counts = new Map<string, number>();
  for (const p of base) {
    if (p.label) counts.set(labelShape(p.label), (counts.get(labelShape(p.label)) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [shape, n] of counts) if (!best || n > (counts.get(best) ?? 0)) best = shape;
  return best;
}

/** "<original name> (<label>).pdf", without characters file systems refuse. */
function mergedName(original: AttachmentRow, label: string): string {
  const stem = original.filename.replace(/\.pdf$/i, "").slice(0, 100);
  const tag = label.replace(/[\\/:*?"<>|]+/g, "-").slice(0, 60);
  return tag ? `${stem} (${tag}).pdf` : `${stem}.pdf`;
}

/** Changed and new pages of a diff, by label. */
function revisedLabels(diff: PageDiff): string[] {
  return diff.pages.filter((p) => p.status !== "same").map((p) => p.label);
}

export default function AddPagesPanel(props: AddPagesPanelProps) {
  const { version, original } = props;
  const isPdf = original?.content_type === "application/pdf";
  return (
    <section className={styles.importPanel} aria-label="Add pages" data-testid="add-pages">
      <h3>Add pages to {version.label || "the current version"}</h3>
      {isPdf && original ? (
        <AddPagesBody {...props} original={original} />
      ) : (
        <>
          <p data-testid="add-pages-unavailable">
            {original
              ? "Pages can only be added to a script imported from a PDF; this version's original isn't one."
              : "This version has no original file to add pages to."}{" "}
            Import the full new draft instead: its cues are carried over the same way.
          </p>
          <div className={styles.popoverActions}>
            <button type="button" className={styles.primary} onClick={props.onImportFull}>
              Import new version…
            </button>
            <button type="button" onClick={props.onCancel}>
              Cancel
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function AddPagesBody({
  source,
  showId,
  version,
  original,
  onDone,
  onCancel,
}: AddPagesPanelProps & { original: AttachmentRow }) {
  const { text: baseText, error: baseError } = useScriptText(version.id);
  const base = useMemo<BasePage[]>(
    () => baseText?.pages.map((p) => ({ index: p.page - 1, label: p.label })) ?? [],
    [baseText],
  );
  const [files, setFiles] = useState<IncomingFile[]>([]);
  const [rows, setRows] = useState<PlanRow[]>([]);
  const [removed, setRemoved] = useState<number[]>([]);
  const [phase, setPhase] = useState<Phase>({ kind: "plan" });
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [labelEdit, setLabelEdit] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const plan = useMemo(() => ({ rows, removed }), [rows, removed]);
  const check = useMemo(() => checkPlan(base, plan), [base, plan]);
  const label = labelEdit ?? defaultVersionLabel(base, plan);
  const busy = phase.kind === "reading" || phase.kind === "building" || phase.kind === "importing";

  const take = async (list: FileList | File[] | null | undefined) => {
    const picked = [...(list ?? [])];
    if (picked.length === 0 || !baseText) return;
    setError(null);
    setPhase({ kind: "reading", names: picked.map((f) => f.name) });
    const shape = dominantShape(base);
    const read: IncomingFile[] = [];
    const problems: string[] = [];
    for (const [k, file] of picked.entries()) {
      try {
        read.push(await readIncoming(file, files.length + k, shape));
      } catch (e) {
        problems.push(e instanceof Error ? e.message : String(e));
        read.push({ name: file.name, bytes: new Uint8Array(), pages: [] }); // keeps indexes
      }
    }
    setFiles((f) => [...f, ...read]);
    setRows((r) => [
      ...r,
      ...buildPlan(
        base,
        read.flatMap((f) => f.pages),
      ).rows,
    ]);
    if (problems.length) setError(problems.join(" "));
    setPhase({ kind: "plan" });
  };

  const setAction = (key: string, action: RowAction) =>
    setRows((rs) => rs.map((r) => (r.page.key === key ? { ...r, action, why: undefined } : r)));

  /** Merge, then extract the whole merged PDF like a full import. */
  const buildPreview = async () => {
    if (!check.ok || !baseText) return;
    setError(null);
    try {
      setPhase({ kind: "building", step: "Fetching the current PDF…" });
      const res = await fetch(attachmentUrl(showId, original.id), { credentials: "same-origin" });
      if (!res.ok) throw new MergeError(`The current PDF couldn't be loaded (${res.status}).`);
      const baseBytes = new Uint8Array(await res.arrayBuffer());
      setPhase({ kind: "building", step: "Merging pages…" });
      const maxTextPage = Math.max(0, ...baseText.pages.map((p) => p.page));
      const merged = await mergePdf(
        { bytes: baseBytes, name: original.filename },
        files.map((f) => ({ bytes: f.bytes, name: f.name })),
        (baseCount) => {
          if (baseCount < maxTextPage) {
            throw new MergeError(
              "The current PDF has fewer pages than this version's text, so pages can't be matched up: import the full new draft instead.",
            );
          }
          return mergeOrder(baseCount, plan);
        },
      );
      setPhase({ kind: "building", step: "Reading the merged script…" });
      const text = await extractPdf(merged, await loadPdfjs());
      const tooBig = textTooBig(text);
      if (tooBig) throw new MergeError(tooBig);
      const file = new File([merged as BlobPart], mergedName(original, label.trim()), {
        type: "application/pdf",
      });
      setPhase({ kind: "preview", file, text, diff: diffPages(baseText, text) });
    } catch (e) {
      setError(
        e instanceof MergeError || e instanceof Error
          ? e.message
          : `Couldn't build the new version: ${String(e)}`,
      );
      setPhase({ kind: "plan" });
    }
  };

  const doImport = async () => {
    if (phase.kind !== "preview") return;
    const { file, text, diff } = phase;
    const versionId = newId();
    const versionLabel = label.trim() || "Added pages";
    setError(null);
    setPhase({ kind: "importing", file, text, diff, step: "Saving the script…" });
    let res: ImportVersionResponse;
    try {
      res = await source.importVersion({
        versionId,
        label: versionLabel,
        text,
        baseVersionId: version.id,
      });
    } catch (e) {
      setError(`Couldn't import the script: ${e instanceof Error ? e.message : String(e)}`);
      setPhase({ kind: "preview", file, text, diff });
      return;
    }
    setPhase({ kind: "importing", file, text, diff, step: "Uploading the merged PDF…" });
    const named = new File([file], mergedName(original, versionLabel), { type: file.type });
    const originalError = originalTooBig(named)
      ? `it's over ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`
      : await uploadOriginal(source, showId, res.versionId, named);
    onDone(res, originalError, named);
  };

  if (baseError) {
    return (
      <p className="error" role="alert">
        Couldn't load the current version's text: {baseError}
      </p>
    );
  }
  if (!baseText) return <p className="muted">Loading the current version…</p>;

  const preview = phase.kind === "preview" || phase.kind === "importing" ? phase : null;
  if (preview) {
    const revised = revisedLabels(preview.diff);
    return (
      <div className={styles.preview} data-testid="add-pages-preview">
        <p className={styles.stats}>
          <strong>{mergedName(original, label.trim())}</strong> ·{" "}
          <span data-testid="preview-pages">{preview.text.pages.length} pages</span> ·{" "}
          {preview.text.blocks.length} blocks · {Math.round(preview.text.confidence * 100)}%
          confidence
        </p>
        <p className={styles.stats} data-testid="add-pages-revised">
          Revised: {revised.length ? revised.join(", ") : "none"}
          {removed.length > 0 &&
            ` · ${removed.length} ${removed.length === 1 ? "page" : "pages"} removed`}
        </p>
        {isLowConfidence(preview.text) && <LowConfidenceBanner source={preview.text.source} />}
        {originalTooBig(preview.file) && (
          <p className={styles.banner} data-kind="warning" data-testid="original-too-big">
            The merged PDF is over {MAX_ATTACHMENT_BYTES / 1024 / 1024} MB, so it won't be kept with
            the version (its text still imports, but you can't add pages to it later).
          </p>
        )}
        {preview.text.warnings?.map((w) => (
          <p key={w} className={styles.banner} data-kind="warning" data-testid="extract-warning">
            {w}
          </p>
        ))}
        <label className={styles.formRow}>
          <span>Label</span>
          <input
            type="text"
            aria-label="Version label"
            value={label}
            disabled={phase.kind === "importing"}
            onChange={(e) => setLabelEdit(e.target.value)}
          />
        </label>
        <div className={styles.popoverActions}>
          <button
            type="button"
            className={styles.primary}
            disabled={phase.kind === "importing"}
            onClick={() => void doImport()}
          >
            {phase.kind === "importing" ? phase.step : "Import"}
          </button>
          <button
            type="button"
            disabled={phase.kind === "importing"}
            onClick={() => setPhase({ kind: "plan" })}
          >
            Back to the plan
          </button>
          {phase.kind !== "importing" && (
            <button type="button" className={styles.linkButton} onClick={onCancel}>
              Cancel
            </button>
          )}
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }

  const removable = base.filter((p) => !removed.includes(p.index));
  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a drop zone; the button inside is the control */}
      <div
        className={styles.dropZone}
        data-dragging={dragging || undefined}
        onDragOver={(e) => {
          if (!busy && e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (!busy) void take(e.dataTransfer.files);
        }}
      >
        {phase.kind === "reading" ? (
          <p role="status" data-testid="add-pages-reading">
            <span className={styles.spinner} aria-hidden="true" /> Reading {phase.names.join(", ")}…
          </p>
        ) : (
          <>
            <p>
              Drop the new pages here (PDFs: single pages or a packet), or{" "}
              <button
                type="button"
                className={rows.length ? undefined : styles.primary}
                disabled={busy}
                onClick={() => input.current?.click()}
              >
                {rows.length ? "Add more…" : "Choose PDFs…"}
              </button>
            </p>
            <input
              ref={input}
              type="file"
              accept=".pdf,application/pdf"
              multiple
              hidden
              data-testid="add-pages-input"
              onChange={(e) => {
                void take(e.target.files);
                e.target.value = "";
              }}
            />
            {rows.length === 0 && (
              <p className="muted">
                Each page's printed label decides where it goes: a label this version has replaces
                that page, a new one (like 139b) goes in after the page before it. You can change
                each before anything is saved.
              </p>
            )}
          </>
        )}
      </div>

      {rows.length > 0 && (
        <table className={styles.addPagesTable} data-testid="add-pages-plan">
          <thead>
            <tr>
              <th scope="col">Page</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <PlanRowView
                key={r.page.key}
                row={r}
                base={base}
                error={check.rowErrors.get(r.page.key)}
                warning={check.rowWarnings.get(r.page.key)}
                disabled={busy}
                onChange={(a) => setAction(r.page.key, a)}
              />
            ))}
          </tbody>
        </table>
      )}

      <fieldset className={styles.tray} aria-label="Remove pages" data-testid="add-pages-remove">
        <select
          className={styles.select}
          aria-label="Remove a page"
          value=""
          disabled={busy}
          onChange={(e) => {
            const i = Number(e.target.value);
            if (e.target.value !== "" && !removed.includes(i)) {
              setRemoved((r) => [...r, i].sort((a, b) => a - b));
            }
          }}
        >
          <option value="">Remove a page…</option>
          {removable.map((p) => (
            <option key={p.index} value={p.index}>
              {basePageName(p)}
            </option>
          ))}
        </select>
        {removed.map((i) => {
          const p = base.find((b) => b.index === i);
          const name = p ? basePageName(p) : `PDF page ${i + 1}`;
          return (
            <button
              key={i}
              type="button"
              className={styles.trayChip}
              aria-label={`Keep page ${name}`}
              title="Keep this page"
              disabled={busy}
              onClick={() => setRemoved((r) => r.filter((x) => x !== i))}
            >
              −{name} ×
            </button>
          );
        })}
      </fieldset>

      <label className={styles.formRow}>
        <span>Label</span>
        <input
          type="text"
          aria-label="Version label"
          value={label}
          placeholder="Pages 138, 139a"
          disabled={busy}
          onChange={(e) => setLabelEdit(e.target.value)}
        />
      </label>
      {check.errors.length > 0 && rows.length + removed.length > 0 && (
        <p className="muted">{check.errors.join(" ")}</p>
      )}
      <div className={styles.popoverActions}>
        <button
          type="button"
          className={styles.primary}
          disabled={busy || !check.ok}
          onClick={() => void buildPreview()}
          data-testid="add-pages-preview-button"
        >
          {phase.kind === "building" ? phase.step : "Preview"}
        </button>
        <button type="button" className={styles.linkButton} disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

type Kind = "replace" | "insert" | "start" | "skip" | "choose";

function PlanRowView({
  row,
  base,
  error,
  warning,
  disabled,
  onChange,
}: {
  row: PlanRow;
  base: readonly BasePage[];
  error: string | undefined;
  warning: string | undefined;
  disabled: boolean;
  onChange: (a: RowAction) => void;
}) {
  const { page, action } = row;
  const name = `${page.label ?? "unlabelled page"} (${page.fileName}${page.index > 0 ? `, page ${page.index + 1}` : ""})`;
  const kind: Kind = action.kind === "insert" && action.after < 0 ? "start" : (action.kind as Kind);
  /** The base page the row points at now, else where its label would go. */
  const anchor = (): number => {
    if (action.kind === "replace") return action.targets[0] ?? base[0]?.index ?? 0;
    if (action.kind === "insert" && action.after >= 0) return action.after;
    const p = proposeAction(base, page.label).action;
    if (p.kind === "replace") return p.targets[0] ?? 0;
    if (p.kind === "insert" && p.after >= 0) return p.after;
    return base[0]?.index ?? 0;
  };
  const setKind = (k: Kind) => {
    if (k === "replace") onChange({ kind: "replace", targets: [anchor()] });
    else if (k === "insert") onChange({ kind: "insert", after: anchor() });
    else if (k === "start") onChange({ kind: "insert", after: -1 });
    else if (k === "skip") onChange({ kind: "skip" });
  };
  const target =
    action.kind === "replace"
      ? action.targets.length > 1
        ? "multi"
        : String(action.targets[0] ?? "")
      : action.kind === "insert"
        ? String(action.after)
        : "";
  return (
    <tr
      data-testid="add-pages-row"
      data-label={page.label ?? ""}
      data-action={actionText(base, action)}
      data-error={error ? true : undefined}
    >
      <td>
        <div className={styles.addPagesPage}>
          {page.thumb ? (
            <img src={page.thumb} alt="" width={32} />
          ) : (
            <span className={styles.addPagesThumb} aria-hidden="true" />
          )}
          <span>
            <strong className={styles.navLabel}>{page.label ?? "?"}</strong>
            <span className="muted">
              {page.fileName}
              {page.index > 0 || page.label === null ? ` · page ${page.index + 1}` : ""}
            </span>
            {page.firstLine && <span className={styles.addPagesLine}>{page.firstLine}</span>}
          </span>
        </div>
      </td>
      <td>
        <div className={styles.addPagesAction}>
          <select
            className={styles.select}
            aria-label={`Action for ${name}`}
            value={kind}
            disabled={disabled}
            onChange={(e) => setKind(e.target.value as Kind)}
          >
            {kind === "choose" && <option value="choose">Choose…</option>}
            <option value="replace">Replace</option>
            <option value="insert">Insert after</option>
            <option value="start">Insert at the start</option>
            <option value="skip">Skip</option>
          </select>
          {(action.kind === "replace" || (action.kind === "insert" && action.after >= 0)) && (
            <select
              className={styles.select}
              aria-label={`Page for ${name}`}
              value={target}
              disabled={disabled}
              onChange={(e) => {
                const i = Number(e.target.value);
                if (action.kind === "replace") onChange({ kind: "replace", targets: [i] });
                else onChange({ kind: "insert", after: i });
              }}
            >
              {target === "multi" && action.kind === "replace" && (
                <option value="multi">{actionText(base, action).replace(/^Replace /, "")}</option>
              )}
              {base.map((p) => (
                <option key={p.index} value={p.index}>
                  {basePageName(p)}
                </option>
              ))}
            </select>
          )}
        </div>
        {error && (
          <p className="error" data-testid="add-pages-row-error">
            {error}
          </p>
        )}
        {!error && warning && <p className={styles.addPagesWarn}>{warning}</p>}
        {!error && !warning && row.why && <p className="muted">{row.why}</p>}
      </td>
    </tr>
  );
}
