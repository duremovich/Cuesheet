// Importing a script (the first one, or a new version): pick or drop a PDF / DOCX / TXT /
// MD file → text extracted in the browser → preview (pages, blocks, confidence, the first
// page) and a label → Import: POST the version (the server re-anchors the previous
// version's cues), then upload the original file to it (attachments pipeline) and point
// the version at it. A failed upload leaves the version without its original ("Attach
// original…" in the header retries). OCR / low confidence shows a warning with guidance.
import { useRef, useState } from "react";
import { checkAttachmentType } from "../../../shared/attachments";
import { newId } from "../../../shared/ids";
import { api, putFile } from "../../lib/api";
import type { ImportVersionResponse, ScriptText } from "./contract";
import { extractScript } from "./contract";
import { pagesOf } from "./markers";
import styles from "./Script.module.css";
import { BlockText } from "./ScriptBlocks";
import type { ScriptSource } from "./source";

export const SCRIPT_ACCEPT = ".pdf,.docx,.txt,.md,application/pdf,text/plain,text/markdown";

/** Below this, extraction is flagged (and always for OCR). */
export const LOW_CONFIDENCE = 0.8;

export function isLowConfidence(t: Pick<ScriptText, "source" | "confidence">): boolean {
  return t.source === "ocr" || t.confidence < LOW_CONFIDENCE;
}

export function LowConfidenceBanner({ source }: { source: ScriptText["source"] | null }) {
  return (
    <div className={styles.banner} data-kind="warning" role="status" data-testid="ocr-warning">
      <strong>
        {source === "ocr"
          ? "This script was read with OCR."
          : "Parts of this script were hard to read."}
      </strong>{" "}
      Check the text before placing cues: misread lines make cues harder to match when the next
      version comes in. If you can get a DOCX or a text PDF (one you can select text in), import
      that instead.
    </div>
  );
}

/** Upload `file` as the version's original and link it. Resolves to an error message or null. */
export async function uploadOriginal(
  source: ScriptSource,
  showId: string,
  versionId: string,
  file: File,
): Promise<string | null> {
  if (source.mode === "mock") return "Originals aren't stored in mock mode";
  try {
    const type = checkAttachmentType(file.type, file.name);
    if ("error" in type) return type.error;
    const res = await api.uploadUrl(showId, {
      table: "script_versions",
      recordId: versionId,
      field: "source_file",
      filename: file.name,
      contentType: type.contentType,
      size: file.size,
    });
    await putFile(res.uploadUrl, file, res.contentType);
    await source.setOriginal(versionId, res.attachmentId);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

type Phase =
  | { kind: "pick" }
  | { kind: "extracting"; file: File }
  | { kind: "preview"; file: File; text: ScriptText }
  | { kind: "importing"; file: File; text: ScriptText; step: string };

export function ImportPanel({
  source,
  showId,
  defaultLabel,
  isNewVersion,
  onDone,
  onCancel,
}: {
  source: ScriptSource;
  showId: string;
  defaultLabel: string;
  isNewVersion: boolean;
  onDone: (res: ImportVersionResponse, originalError: string | null, file: File) => void;
  onCancel?: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "pick" });
  const [label, setLabel] = useState(defaultLabel);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const take = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setPhase({ kind: "extracting", file });
    try {
      const text = await extractScript(file);
      setPhase({ kind: "preview", file, text });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase({ kind: "pick" });
    }
  };

  const doImport = async () => {
    if (phase.kind !== "preview") return;
    const { file, text } = phase;
    const versionId = newId();
    setError(null);
    setPhase({ kind: "importing", file, text, step: "Saving the script…" });
    let res: ImportVersionResponse;
    try {
      res = await source.importVersion({ versionId, label: label.trim() || defaultLabel, text });
    } catch (e) {
      setError(`Couldn't import the script: ${e instanceof Error ? e.message : String(e)}`);
      setPhase({ kind: "preview", file, text });
      return;
    }
    let originalError: string | null = null;
    if (source.mode === "live") {
      setPhase({ kind: "importing", file, text, step: "Uploading the original file…" });
      originalError = await uploadOriginal(source, showId, res.versionId, file);
    }
    onDone(res, originalError, file);
  };

  const preview = phase.kind === "preview" || phase.kind === "importing" ? phase : null;
  const firstPage = preview ? pagesOf(preview.text)[0] : undefined;

  return (
    <section
      className={styles.importPanel}
      aria-label="Import a script"
      data-testid="script-import"
    >
      <h3>{isNewVersion ? "Import a new version" : "Import a script"}</h3>
      {!preview && (
        // biome-ignore lint/a11y/noStaticElementInteractions: a drop zone; the button inside is the control
        <div
          className={styles.dropZone}
          data-dragging={dragging || undefined}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes("Files")) {
              e.preventDefault();
              setDragging(true);
            }
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void take(e.dataTransfer.files[0]);
          }}
        >
          {phase.kind === "extracting" ? (
            <p role="status" data-testid="extract-progress">
              <span className={styles.spinner} aria-hidden="true" /> Reading {phase.file.name}…
            </p>
          ) : (
            <>
              <p>Drop a PDF, DOCX or text file here, or</p>
              <button
                type="button"
                className={styles.primary}
                onClick={() => input.current?.click()}
              >
                Choose a file…
              </button>
              <input
                ref={input}
                type="file"
                accept={SCRIPT_ACCEPT}
                hidden
                data-testid="script-file-input"
                onChange={(e) => {
                  void take(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
              <p className="muted">
                The text is read in your browser and shown as pages you can place cues on.
              </p>
            </>
          )}
        </div>
      )}
      {preview && (
        <div className={styles.preview} data-testid="import-preview">
          <p className={styles.stats}>
            <strong>{preview.file.name}</strong> ·{" "}
            <span data-testid="preview-pages">{preview.text.pages.length} pages</span> ·{" "}
            {preview.text.blocks.length} blocks · {Math.round(preview.text.confidence * 100)}%
            confidence · {preview.text.source.toUpperCase()}
          </p>
          {isLowConfidence(preview.text) && <LowConfidenceBanner source={preview.text.source} />}
          {firstPage && (
            <section className={styles.previewPage} aria-label="First page">
              <p className="muted">Page {firstPage.label}</p>
              {firstPage.blocks.map((b) => (
                <BlockText key={b.i} block={b} />
              ))}
            </section>
          )}
          <label className={styles.formRow}>
            <span>Label</span>
            <input
              type="text"
              aria-label="Version label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Rehearsal draft 9/12"
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
              onClick={() => setPhase({ kind: "pick" })}
            >
              Choose another file
            </button>
          </div>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {onCancel && phase.kind !== "importing" && (
        <button type="button" className={styles.linkButton} onClick={onCancel}>
          Cancel
        </button>
      )}
    </section>
  );
}
