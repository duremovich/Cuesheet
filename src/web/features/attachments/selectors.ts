// Attachments (R13) on the client: a record's files in order, and its thumbnail (the first
// image). Cached per `attachments` map so results keep their identity until a file changes.
import { attachmentKind, isImageType } from "../../../shared/attachments";
import type { AttachmentRow } from "../../../shared/tables";

type Files = ReadonlyMap<string, AttachmentRow>;

const byRecordCache = new WeakMap<Files, Map<string, AttachmentRow[]>>();

const recordKey = (table: string, recordId: string, field = "attachments") =>
  `${table}:${recordId}:${field}`;

function byRecord(files: Files): Map<string, AttachmentRow[]> {
  let out = byRecordCache.get(files);
  if (!out) {
    out = new Map();
    for (const f of files.values()) {
      const k = recordKey(f.table, f.record_id, f.field);
      const list = out.get(k);
      if (list) list.push(f);
      else out.set(k, [f]);
    }
    for (const list of out.values()) list.sort(compareAttachments);
    byRecordCache.set(files, out);
  }
  return out;
}

export function compareAttachments(a: AttachmentRow, b: AttachmentRow): number {
  return (
    (a.position ?? 0) - (b.position ?? 0) ||
    a.created_at - b.created_at ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

const NONE: AttachmentRow[] = [];

/** A record's files in `field`, in order (the same array while they don't change). */
export function attachmentsOf(
  files: Files,
  table: string,
  recordId: string,
  field = "attachments",
): AttachmentRow[] {
  return byRecord(files).get(recordKey(table, recordId, field)) ?? NONE;
}

/** The record's thumbnail: its first image attachment (S4), or undefined. */
export function thumbnailOf(
  files: Files,
  table: string,
  recordId: string,
  field = "attachments",
): AttachmentRow | undefined {
  return attachmentsOf(files, table, recordId, field).find((f) => isImageType(f.content_type));
}

export function isImage(f: Pick<AttachmentRow, "content_type">): boolean {
  return isImageType(f.content_type);
}

/** A short type label for non-image files ("PDF", "Video", "Text"). */
export function fileLabel(f: Pick<AttachmentRow, "content_type" | "filename">): string {
  switch (attachmentKind(f.content_type)) {
    case "pdf":
      return "PDF";
    case "video":
      return "Video";
    case "text":
      return "Text";
    case "image":
      return "Image";
    default:
      return f.filename.split(".").pop()?.toUpperCase() ?? "File";
  }
}

/** Position for a file moved to `to` (0-based) among `list` (not counting itself). */
export function positionAt(list: readonly AttachmentRow[], movingId: string, to: number): number {
  const others = list.filter((f) => f.id !== movingId);
  const before = others[to - 1]?.position ?? null;
  const after = others[to]?.position ?? null;
  if (before === null && after === null) return 1;
  if (before === null) return (after as number) - 1;
  if (after === null) return before + 1;
  return (before + after) / 2;
}
