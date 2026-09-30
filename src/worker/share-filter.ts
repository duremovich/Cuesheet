// What a share link's viewer receives (R23): the snapshot and broadcast ops cut down to
// the link's scope (src/shared/share.ts `shareScope`). Tables outside the scope come back
// empty, views only the shared one, attachments only those on rows of the link's table,
// links (joins) only between tables in scope. Rows are scrubbed: no user ids
// (`created_by`, `updated_by`, `completed_by`), people only as name + role (their contact
// details and account link never leave; a People link keeps group and custom fields).
// Notes presets see only their session's / person's notes. Pure; used by the ShowDO.
import type { AnyResolvedOp, Joins, SnapshotResponse } from "../shared/ops";
import type { ShareScope } from "../shared/share";
import { LINKS, type LinkSpec, linkSpec, type TableName } from "../shared/tables";

const inScope = (scope: ShareScope, table: string) =>
  (scope.tables as readonly string[]).includes(table);

function joinVisible(scope: ShareScope, spec: LinkSpec): boolean {
  return inScope(scope, spec.from) && inScope(scope, spec.to);
}

/** Fields never sent to a share viewer, and what they become in a full row. */
const USER_FIELDS: Record<string, string | null> = {
  created_by: "",
  updated_by: "",
  completed_by: null,
  owner_user_id: null,
};
const PERSON_PRIVATE = ["email", "phone", "organization", "user_id"] as const;
const PERSON_EXTRA = ["group"] as const;

type Fields = Record<string, unknown>;

/** A row (or a create's fields) as a share viewer may see it. */
export function scrubRow(table: string, row: Fields, scope: ShareScope): Fields {
  const out: Fields = { ...row };
  for (const [k, v] of Object.entries(USER_FIELDS)) if (k in out) out[k] = v;
  if (table === "persons") {
    for (const k of PERSON_PRIVATE) if (k in out) out[k] = null;
    if (!scope.fullPersons) {
      for (const k of PERSON_EXTRA) if (k in out) out[k] = null;
      if ("custom" in out) out.custom = {};
    }
  }
  return out;
}

/** An update's changed fields as a share viewer may see them (private ones dropped). */
function scrubChanges(table: string, fields: Fields, scope: ShareScope): Fields {
  const out: Fields = { ...fields };
  for (const [k, v] of Object.entries(USER_FIELDS)) if (k in out) out[k] = v;
  if (table === "persons") {
    for (const k of PERSON_PRIVATE) delete out[k];
    if (!scope.fullPersons) {
      for (const k of PERSON_EXTRA) delete out[k];
      delete out.custom;
    }
  }
  return out;
}

/** Note ids a notes preset may see (all when the link has no notes filter). */
function visibleNotes(
  notes: readonly { id: string; session: string | null }[],
  assignees: Record<string, string[]>,
  scope: ShareScope,
): Set<string> {
  const f = scope.notes;
  return new Set(
    notes
      .filter(
        (n) =>
          !f ||
          ((f.session === null || n.session === f.session) &&
            (f.person === null || (assignees[n.id] ?? []).includes(f.person))),
      )
      .map((n) => n.id),
  );
}

export function filterSnapshot(snap: SnapshotResponse, scope: ShareScope): SnapshotResponse {
  const noteIds = visibleNotes(
    snap.tables.notes as { id: string; session: string | null }[],
    snap.joins.noteAssignees,
    scope,
  );
  const tables = {} as Record<string, unknown[]>;
  for (const [name, rows] of Object.entries(snap.tables) as unknown as [string, Fields[]][]) {
    let kept: Fields[];
    if (!inScope(scope, name)) kept = [];
    else if (name === "views") kept = rows.filter((v) => v.id === scope.viewId);
    else if (name === "attachments") {
      kept = rows.filter((a) =>
        (scope.attachmentTables as readonly string[]).includes(a.table as string),
      );
    } else if (name === "notes") kept = rows.filter((n) => noteIds.has(n.id as string));
    else kept = rows;
    tables[name] = kept.map((r) => scrubRow(name, r, scope));
  }
  const joins = {} as Record<string, Record<string, string[]>>;
  const specs = new Map((Object.values(LINKS) as LinkSpec[]).map((s) => [s.key as string, s]));
  for (const [key, map] of Object.entries(snap.joins)) {
    const spec = specs.get(key);
    if (!spec || !joinVisible(scope, spec)) {
      joins[key] = {};
    } else if (spec.from === "notes") {
      joins[key] = Object.fromEntries(Object.entries(map).filter(([id]) => noteIds.has(id)));
    } else {
      joins[key] = map;
    }
  }
  const fieldOptions = Object.fromEntries(
    Object.entries(snap.fieldOptions).filter(([k]) => inScope(scope, k.split(".")[0] ?? "")),
  ) as SnapshotResponse["fieldOptions"];
  return {
    ...snap,
    tables: tables as unknown as SnapshotResponse["tables"],
    joins: joins as unknown as Joins,
    fieldOptions,
  };
}

export interface FilterLookups {
  /**
   * An attachment's record table: live rows, and rows deleted in this batch (kept in
   * `pending_r2_deletes`); undefined when unknown.
   */
  attachmentTable(id: string): string | undefined;
}

/**
 * The ops of a committed batch a share viewer may see, scrubbed; or `"refetch"` when the
 * batch changes which notes a notes preset may see (its viewers then get `{type:"version"}`
 * and refetch their filtered snapshot, so a note leaving the session or person goes away).
 */
export function filterOps(
  ops: readonly AnyResolvedOp[],
  scope: ShareScope,
  lookups: FilterLookups,
): AnyResolvedOp[] | "refetch" {
  if (
    scope.notes &&
    ops.some((op) => op.op !== "meta" && (op.table === "notes" || op.table === "persons"))
  ) {
    return "refetch";
  }
  const out: AnyResolvedOp[] = [];
  for (const op of ops) {
    if (op.op === "meta") {
      out.push(op);
      continue;
    }
    if (op.op === "link" || op.op === "unlink") {
      const spec = linkSpec(op.table, op.field);
      if (spec && joinVisible(scope, spec)) out.push(op);
      continue;
    }
    const table = op.table as TableName;
    if (!inScope(scope, table)) continue;
    if (table === "views" && op.id !== scope.viewId) continue;
    if (table === "attachments") {
      const t =
        op.op === "create"
          ? (op.fields as { table?: unknown }).table
          : lookups.attachmentTable(op.id);
      if (typeof t !== "string" || !(scope.attachmentTables as readonly string[]).includes(t)) {
        continue;
      }
    }
    if (op.op === "create") out.push({ ...op, fields: scrubRow(table, op.fields, scope) });
    else if (op.op === "update" || op.op === "move") {
      out.push({ ...op, fields: scrubChanges(table, op.fields, scope) });
    } else out.push(op);
  }
  return out;
}
