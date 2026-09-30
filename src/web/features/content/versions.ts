// Content versions (R10) on the client: the current version per content item (a cached
// selector over the store's `content_versions` map), a content item's versions newest
// first, the next "Vnn" label, and the ops for adding / restoring one.
import { newId } from "../../../shared/ids";
import type { Op } from "../../../shared/ops";
import type { ContentVersionRow, PersonRow } from "../../../shared/tables";
import { compareVersionAge } from "../../lib/show-state";

type Versions = ReadonlyMap<string, ContentVersionRow>;

const currentCache = new WeakMap<Versions, Map<string, ContentVersionRow>>();

/**
 * Content id → its current version. Cached per `content_versions` map, so it keeps its
 * identity (and so do the rows in it) until a version changes: safe to use as a memo dep.
 */
export function currentVersions(versions: Versions): Map<string, ContentVersionRow> {
  let out = currentCache.get(versions);
  if (!out) {
    out = new Map();
    for (const v of versions.values()) if (v.is_current) out.set(v.content_id, v);
    currentCache.set(versions, out);
  }
  return out;
}

/** "V03", or null when the content item has no current version (or it has no label). */
export function currentVersionLabel(versions: Versions, contentId: string): string | null {
  return currentVersions(versions).get(contentId)?.version?.trim() || null;
}

/** A content item's versions, newest first (position, then creation). */
export function versionsOf(versions: Versions, contentId: string): ContentVersionRow[] {
  return [...versions.values()]
    .filter((v) => v.content_id === contentId)
    .sort((a, b) => compareVersionAge(b, a));
}

/** The label after the highest "Vnn" (V01 when there's none): V03 → V04, V09a → V10. */
export function nextVersionLabel(labels: readonly (string | null)[]): string {
  let max = 0;
  for (const l of labels) {
    const m = /^v?(\d+)/i.exec(l?.trim() ?? "");
    if (m) max = Math.max(max, Number.parseInt(m[1] ?? "0", 10));
  }
  return `V${String(max + 1).padStart(2, "0")}`;
}

/** Today as `YYYY-MM-DD` in local time. */
export function today(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** The person linked to a user account (`persons.user_id`), if any. */
export function personForUser(
  persons: ReadonlyMap<string, PersonRow>,
  userId: string,
): PersonRow | undefined {
  for (const p of persons.values()) if (p.user_id === userId) return p;
  return undefined;
}

/**
 * "Add version": the next Vnn, today, rendered by you (when you're a person in the show),
 * Available, and current.
 */
export function addVersionOps(opts: {
  contentId: string;
  versions: Versions;
  persons: ReadonlyMap<string, PersonRow>;
  userId: string;
  id?: string;
  now?: Date;
}): Op[] {
  const existing = versionsOf(opts.versions, opts.contentId);
  const me = personForUser(opts.persons, opts.userId);
  return [
    {
      op: "create",
      table: "content_versions",
      id: opts.id ?? newId(),
      fields: {
        content_id: opts.contentId,
        version: nextVersionLabel(existing.map((v) => v.version)),
        date: today(opts.now),
        rendered_by: me?.id ?? null,
        status: "Available",
        is_current: true,
      },
    },
  ];
}

/** Recreate a deleted version with the same id and fields (the undo of a delete). */
export function restoreVersionOps(v: ContentVersionRow): Op[] {
  return [
    {
      op: "create",
      table: "content_versions",
      id: v.id,
      fields: {
        content_id: v.content_id,
        version: v.version,
        date: v.date,
        rendered_by: v.rendered_by,
        changes: v.changes,
        file_path: v.file_path,
        status: v.status,
        position: v.position,
        is_current: v.is_current,
        custom: v.custom,
      },
    },
  ];
}
