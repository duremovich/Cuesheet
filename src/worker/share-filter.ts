// What a share link's viewer receives (R23): the snapshot and broadcast ops cut down to
// the link's scope (src/shared/share.ts `shareScope`). Tables outside the scope come back
// empty, views only the shared one, attachments only those on rows of the link's table,
// links (joins) only between tables in scope. Pure; used by the ShowDO.
import type { AnyResolvedOp, Joins, SnapshotResponse } from "../shared/ops";
import type { ShareScope } from "../shared/share";
import { LINKS, type LinkSpec, linkSpec, type TableName } from "../shared/tables";

const inScope = (scope: ShareScope, table: string) =>
  (scope.tables as readonly string[]).includes(table);

function joinVisible(scope: ShareScope, spec: LinkSpec): boolean {
  return inScope(scope, spec.from) && inScope(scope, spec.to);
}

export function filterSnapshot(snap: SnapshotResponse, scope: ShareScope): SnapshotResponse {
  const tables = {} as Record<string, unknown[]>;
  for (const [name, rows] of Object.entries(snap.tables) as [string, unknown[]][]) {
    if (!inScope(scope, name)) {
      tables[name] = [];
    } else if (name === "views") {
      tables[name] = (rows as { id: string }[]).filter((v) => v.id === scope.viewId);
    } else if (name === "attachments") {
      tables[name] = (rows as { table: string }[]).filter((a) =>
        (scope.attachmentTables as readonly string[]).includes(a.table),
      );
    } else {
      tables[name] = rows;
    }
  }
  const joins = {} as Record<string, Record<string, string[]>>;
  const visibleKeys = new Set(
    (Object.values(LINKS) as LinkSpec[]).filter((s) => joinVisible(scope, s)).map((s) => s.key),
  );
  for (const [key, map] of Object.entries(snap.joins)) {
    joins[key] = visibleKeys.has(key as LinkSpec["key"]) ? map : {};
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

/**
 * The ops of a committed batch a share viewer may see. `attachmentTable(id)` looks up an
 * existing attachment's record table (for updates, whose ops don't carry it).
 */
export function filterOps(
  ops: readonly AnyResolvedOp[],
  scope: ShareScope,
  attachmentTable: (id: string) => string | undefined,
): AnyResolvedOp[] {
  return ops.filter((op) => {
    if (op.op === "meta") return true;
    if (op.op === "link" || op.op === "unlink") {
      const spec = linkSpec(op.table, op.field);
      return spec ? joinVisible(scope, spec) : false;
    }
    const table = op.table as TableName;
    if (!inScope(scope, table)) return false;
    if (table === "views") return op.id === scope.viewId;
    if (table === "attachments") {
      const t =
        op.op === "create"
          ? (op.fields as { table?: unknown }).table
          : op.op === "delete"
            ? // Gone from the DB already; a delete only carries the id.
              (attachmentTable(op.id) ?? scope.attachmentTables[0])
            : attachmentTable(op.id);
      return typeof t === "string" && (scope.attachmentTables as readonly string[]).includes(t);
    }
    return true;
  });
}
