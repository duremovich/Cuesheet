// Attachment UI (R13, S4): thumbnails, the grid cell's strip (click → lightbox; drop or paste
// files onto the cell), the row panel's full-width field (add / remove / reorder), the
// lightbox (prev/next, download, delete with Undo) and <AttachmentsHost>, mounted once in
// the show workspace. Thumbnails come from GET …/thumb (made by the Worker); when there is
// none (too large to decode, or not an image) the original / a type label is shown.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { attachmentUrl, formatBytes, thumbnailUrl } from "../../../shared/attachments";
import type { AttachmentRow } from "../../../shared/tables";
import type { Column } from "../../components/grid/types";
import { api } from "../../lib/api";
import { useShowStore, useShowStoreInstance } from "../../lib/show-store";
import { useWorkspace, type Workspace } from "../show/workspace";
import styles from "./Attachments.module.css";
import { attachmentsOf, fileLabel, isImage, positionAt } from "./selectors";
import {
  flushDeletes,
  openLightbox,
  scheduleDelete,
  UNDO_MS,
  undoDelete,
  uploadErrors,
  uploadQueue,
  useHiddenFiles,
  useLightbox,
} from "./state";
import { progressOf, useRecordUploads } from "./uploads";

export { uploadQueue } from "./state";

/** Editors attach anywhere; commenters to notes they created (the server checks too). */
export function canAttachTo(
  ws: Pick<Workspace, "canEdit" | "role" | "userId">,
  table: string,
  record: { created_by: string } | undefined,
): boolean {
  if (ws.canEdit) return true;
  return ws.role === "commenter" && table === "notes" && record?.created_by === ws.userId;
}

/** A record's files, minus ones deleted and waiting out their Undo. */
export function useRecordFiles(table: string, recordId: string, field = "attachments") {
  const all = useShowStore((s) => attachmentsOf(s.tables.attachments, table, recordId, field));
  const hidden = useHiddenFiles();
  return useMemo(() => (hidden.size ? all.filter((f) => !hidden.has(f.id)) : all), [all, hidden]);
}

/** Delete a file with an Undo toast (the delete is sent when the toast runs out). */
export function useDeleteFile() {
  const ws = useWorkspace();
  const store = useShowStoreInstance();
  return useCallback(
    (file: AttachmentRow) => {
      const ops = [{ op: "delete" as const, table: "attachments" as const, id: file.id }];
      scheduleDelete(file.id, (keepalive) => {
        if (keepalive) {
          void api
            .mutate(ws.showId, { clientId: store.clientId, ops }, { keepalive: true })
            .catch(() => undefined);
        } else {
          store.mutate(ops).catch((e: unknown) => ws.reportError(e, "delete the file"));
        }
      });
      ws.toast(`Deleted ${file.filename}.`, "info", {
        duration: UNDO_MS,
        action: { label: "Undo", run: () => undoDelete(file.id) },
      });
    },
    [ws, store],
  );
}

export function Thumb({
  file,
  size = "sm",
  showId,
}: {
  file: AttachmentRow;
  size?: "xs" | "sm" | "md" | "lg";
  showId: string;
}) {
  const [src, setSrc] = useState(() => thumbnailUrl(showId, file.id));
  const [failed, setFailed] = useState(false);
  if (!isImage(file) || failed) {
    return (
      <span className={styles.thumb} data-size={size} title={file.filename}>
        {fileLabel(file).slice(0, 4)}
      </span>
    );
  }
  return (
    <span className={styles.thumb} data-size={size} data-testid="thumb">
      <img
        src={src}
        alt={file.filename}
        loading="lazy"
        draggable={false}
        onError={() => {
          // No thumbnail (too large to make one): the original, else a label.
          const original = attachmentUrl(showId, file.id);
          if (src !== original) setSrc(original);
          else setFailed(true);
        }}
      />
    </span>
  );
}

/** The grid cell: up to three thumbnails and "+n"; upload progress while files go up. */
export function AttachmentStrip({
  table,
  recordId,
  field = "attachments",
  max = 3,
}: {
  table: string;
  recordId: string;
  field?: string;
  max?: number;
}) {
  const ws = useWorkspace();
  const files = useRecordFiles(table, recordId, field);
  const uploads = useRecordUploads(uploadQueue, table, recordId);
  const open = (file: AttachmentRow) =>
    openLightbox({ table, recordId, field, attachmentId: file.id });
  const shown = files.slice(0, max);
  const rest = files.length - shown.length;
  return (
    <span className={styles.strip} data-testid="attachment-strip">
      {shown.map((f) => (
        <button
          key={f.id}
          type="button"
          tabIndex={-1}
          className={styles.stripButton}
          aria-label={`Open ${f.filename}`}
          title={f.filename}
          onMouseDown={(e) => e.preventDefault()}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => open(f)}
        >
          <Thumb file={f} showId={ws.showId} />
        </button>
      ))}
      {rest > 0 && (
        <button
          type="button"
          tabIndex={-1}
          className={styles.more}
          aria-label={`${rest} more files`}
          onMouseDown={(e) => e.preventDefault()}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => {
            const f = files[max];
            if (f) open(f);
          }}
        >
          +{rest}
        </button>
      )}
      {uploads.map((u) =>
        u.status === "error" ? (
          <span key={u.key} className={styles.failed} title={u.error}>
            ⚠
          </span>
        ) : (
          <span
            key={u.key}
            className={styles.progress}
            role="progressbar"
            aria-label={`Uploading ${u.filename}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progressOf(u) * 100)}
            data-testid="upload-progress"
          >
            <span style={{ width: `${Math.round(progressOf(u) * 100)}%` }} />
          </span>
        ),
      )}
    </span>
  );
}

/**
 * The grid column for an attachment field. `files(view)` must be part of the view object
 * (so the row re-renders when its files change); `record(view)` gives the id (and creator,
 * for commenters' own notes).
 */
export function attachmentColumn<V>(opts: {
  table: string;
  showId: string;
  field?: string;
  title?: string;
  width?: number;
  files: (v: V) => AttachmentRow[];
  recordId: (v: V) => string;
  editable: boolean | ((v: V) => boolean);
}): Column<V> {
  const field = opts.field ?? "attachments";
  return {
    key: field,
    title: opts.title ?? "Attachments",
    type: "attachment",
    width: opts.width ?? 140,
    editable: opts.editable,
    getValue: opts.files,
    format: (v) =>
      Array.isArray(v) ? (v as AttachmentRow[]).map((f) => f.filename).join(", ") : "",
    compare: (a, b) => (a as AttachmentRow[]).length - (b as AttachmentRow[]).length,
    renderCell: (v) => (
      <AttachmentStrip table={opts.table} recordId={opts.recordId(v)} field={field} />
    ),
    onOpen: (v) => {
      const first = opts.files(v)[0];
      if (first) {
        openLightbox({
          table: opts.table,
          recordId: opts.recordId(v),
          field,
          attachmentId: first.id,
        });
      }
    },
    onFiles: (v, files) =>
      uploadQueue.add(opts.showId, { table: opts.table, recordId: opts.recordId(v), field }, files),
  };
}

/** Files from a drop or paste event (none: not a file transfer). */
function filesOf(data: DataTransfer | null): File[] {
  return data ? [...data.files] : [];
}

/**
 * The row panel's attachment field, full width: thumbnails with filename, move earlier /
 * later, remove; "+ Add files" (or drop / paste onto it) uploads.
 */
export function AttachmentsField({
  table,
  recordId,
  field = "attachments",
  label = "Attachments",
}: {
  table: string;
  recordId: string;
  field?: string;
  label?: string;
}) {
  const ws = useWorkspace();
  const store = useShowStoreInstance();
  const record = useShowStore((s) =>
    (s.tables as unknown as Record<string, Map<string, { created_by: string }>>)[table]?.get(
      recordId,
    ),
  );
  const canEdit = canAttachTo(ws, table, record);
  const files = useRecordFiles(table, recordId, field);
  const uploads = useRecordUploads(uploadQueue, table, recordId);
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const remove = useDeleteFile();
  const add = (list: File[]) => {
    if (list.length) uploadQueue.add(ws.showId, { table, recordId, field }, list);
  };
  const move = (file: AttachmentRow, to: number) => {
    store
      .mutate([
        {
          op: "update",
          table: "attachments",
          id: file.id,
          fields: { position: positionAt(files, file.id, to) },
        },
      ])
      .catch((e: unknown) => ws.reportError(e, "move the file"));
  };

  return (
    <fieldset
      className={styles.field}
      data-testid="attachments-field"
      data-drop={over || undefined}
      aria-label={label}
      tabIndex={canEdit ? 0 : undefined}
      onPaste={(e) => {
        const list = filesOf(e.clipboardData);
        if (!canEdit || list.length === 0) return;
        e.preventDefault();
        add(list);
      }}
      onDragOver={(e) => {
        if (!canEdit || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        if (!canEdit) return;
        e.preventDefault();
        add(filesOf(e.dataTransfer));
      }}
    >
      {files.length > 0 ? (
        <ul className={styles.files} aria-label={label}>
          {files.map((f, i) => (
            <li key={f.id} className={styles.file} data-testid="attachment">
              <button
                type="button"
                className={styles.fileOpen}
                aria-label={`Open ${f.filename}`}
                onClick={() => openLightbox({ table, recordId, field, attachmentId: f.id })}
              >
                <Thumb file={f} size="lg" showId={ws.showId} />
              </button>
              <span className={styles.fileName} title={`${f.filename} · ${formatBytes(f.size)}`}>
                {f.filename}
              </span>
              {canEdit && (
                <span className={styles.fileActions}>
                  <button
                    type="button"
                    aria-label={`Move ${f.filename} earlier`}
                    title="Move earlier"
                    disabled={i === 0}
                    onClick={() => move(f, i - 1)}
                  >
                    ←
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${f.filename} later`}
                    title="Move later"
                    disabled={i === files.length - 1}
                    onClick={() => move(f, i + 1)}
                  >
                    →
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${f.filename}`}
                    title="Remove"
                    onClick={() => remove(f)}
                  >
                    ×
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <span className={styles.fieldRow}>
          No files{canEdit ? " yet: drop, paste or add some." : "."}
        </span>
      )}
      {uploads.length > 0 && (
        <ul className={styles.uploads} aria-label="Uploads">
          {uploads.map((u) => (
            <li key={u.key}>
              <span>{u.filename}</span>
              {u.status === "error" ? (
                <>
                  <span className={styles.failed}>{u.error}</span>
                  <button type="button" onClick={() => uploadQueue.dismiss(u.key)}>
                    Dismiss
                  </button>
                </>
              ) : (
                <span
                  className={styles.progress}
                  role="progressbar"
                  aria-label={`Uploading ${u.filename}`}
                  aria-valuenow={Math.round(progressOf(u) * 100)}
                >
                  <span style={{ width: `${Math.round(progressOf(u) * 100)}%` }} />
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <span className={styles.fieldRow}>
          <button type="button" onClick={() => input.current?.click()}>
            + Add files
          </button>
          <input
            ref={input}
            type="file"
            multiple
            className={styles.hiddenInput}
            tabIndex={-1}
            aria-label={`Add files to ${label}`}
            data-testid="attachment-input"
            onChange={(e) => {
              add([...(e.target.files ?? [])]);
              e.target.value = "";
            }}
          />
        </span>
      )}
    </fieldset>
  );
}

/** The lightbox for the file `useLightbox()` names; prev/next through its record's files. */
function Lightbox() {
  const ws = useWorkspace();
  const target = useLightbox();
  const files = useRecordFiles(target?.table ?? "", target?.recordId ?? "", target?.field);
  const record = useShowStore((s) =>
    target
      ? (s.tables as unknown as Record<string, Map<string, { created_by: string }>>)[
          target.table
        ]?.get(target.recordId)
      : undefined,
  );
  const remove = useDeleteFile();
  const dialog = useRef<HTMLDivElement>(null);
  const returnTo = useRef<Element | null>(null);
  const lastIndex = useRef(0);
  const found = target ? files.findIndex((f) => f.id === target.attachmentId) : -1;
  // The file shown was deleted: stay at its position.
  const index = found >= 0 ? found : Math.min(lastIndex.current, files.length - 1);
  lastIndex.current = Math.max(0, index);
  const file = index >= 0 ? files[index] : undefined;
  const open = !!target && !!file;

  const close = useCallback(() => {
    openLightbox(null);
  }, []);
  const go = useCallback(
    (delta: number) => {
      if (!target) return;
      const next = files[index + delta];
      if (next) openLightbox({ ...target, attachmentId: next.id });
    },
    [target, files, index],
  );

  useEffect(() => {
    if (!open) return;
    returnTo.current = document.activeElement;
    dialog.current?.focus();
    // Focus can drop to <body> (a button that became disabled, e.g. "Previous" on the
    // first file): keys still reach the lightbox, and focus goes back into it.
    const onKey = (e: KeyboardEvent) => {
      if (dialog.current?.contains(e.target as Node)) return;
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        goRef.current(e.key === "ArrowLeft" ? -1 : 1);
      } else if (e.key === "Tab") {
        e.preventDefault();
        dialog.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      const el = returnTo.current as HTMLElement | null;
      if (el?.isConnected) el.focus({ preventScroll: true });
    };
  }, [open, close]);
  const goRef = useRef(go);
  goRef.current = go;
  // Nothing left to show (the record or its last file went): close.
  useEffect(() => {
    if (target && files.length === 0) close();
  }, [target, files.length, close]);

  if (!open || !target || !file) return null;
  const canEdit = canAttachTo(ws, target.table, record);
  const href = attachmentUrl(ws.showId, file.id);
  const kind = file.content_type;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: clicking the backdrop closes the dialog
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes it (keys on the dialog)
    <div
      className={styles.backdrop}
      data-grid-portal=""
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={dialog}
        className={styles.lightbox}
        role="dialog"
        aria-modal="true"
        aria-label={`${file.filename} (${index + 1} of ${files.length})`}
        tabIndex={-1}
        data-testid="lightbox"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            close();
          } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            e.stopPropagation();
            go(e.key === "ArrowLeft" ? -1 : 1);
          } else if (e.key === "Tab") {
            // Keep focus inside.
            const items = [
              ...(dialog.current?.querySelectorAll<HTMLElement>(
                "button:not(:disabled), a[href], video",
              ) ?? []),
            ];
            const first = items[0];
            const last = items.at(-1);
            if (!first || !last) return;
            if (
              e.shiftKey &&
              (document.activeElement === first || document.activeElement === dialog.current)
            ) {
              e.preventDefault();
              last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first.focus();
            }
          }
          e.stopPropagation();
        }}
      >
        <div className={styles.lbHeader}>
          <h2 className={styles.lbTitle} data-testid="lightbox-filename" title={file.filename}>
            {file.filename}
          </h2>
          <span className={styles.lbCount} data-testid="lightbox-count">
            {index + 1} / {files.length} · {formatBytes(file.size)}
          </span>
          <span className={styles.lbActions}>
            <a
              href={attachmentUrl(ws.showId, file.id, { download: true })}
              download={file.filename}
            >
              Download
            </a>
            {canEdit && (
              <button type="button" data-danger="" onClick={() => remove(file)}>
                Delete
              </button>
            )}
            <button type="button" aria-label="Close" onClick={close}>
              ×
            </button>
          </span>
        </div>
        <div className={styles.lbBody}>
          {isImage(file) ? (
            <img key={file.id} src={href} alt={file.filename} data-testid="lightbox-image" />
          ) : kind.startsWith("video/") ? (
            // biome-ignore lint/a11y/useMediaCaption: user-supplied video without captions
            <video key={file.id} src={href} controls preload="metadata" />
          ) : (
            <div className={styles.lbFile}>
              <strong>{fileLabel(file)}</strong>
              <a href={href} target="_blank" rel="noopener">
                Open {file.filename}
              </a>
            </div>
          )}
          <button
            type="button"
            className={styles.lbNav}
            data-dir="prev"
            aria-label="Previous file"
            disabled={index === 0}
            onClick={() => go(-1)}
          >
            ‹
          </button>
          <button
            type="button"
            className={styles.lbNav}
            data-dir="next"
            aria-label="Next file"
            disabled={index === files.length - 1}
            onClick={() => go(1)}
          >
            ›
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Mounted once in the show workspace: the lightbox, upload errors as toasts, and deletes
 * still waiting out their Undo sent when the page is hidden or left.
 */
export function AttachmentsHost() {
  const ws = useWorkspace();
  const toast = ws.toast;
  useEffect(
    () =>
      uploadErrors.subscribe(() => {
        const e = uploadErrors.get();
        if (e) toast(`Couldn't upload ${e.filename}: ${e.error}`, "error");
      }),
    [toast],
  );
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") flushDeletes(true);
    };
    const onPageHide = () => flushDeletes(true);
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onHide);
      // Leaving the show: send them now.
      flushDeletes(true);
      openLightbox(null);
    };
  }, []);
  return <Lightbox />;
}
