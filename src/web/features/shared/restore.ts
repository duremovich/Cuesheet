// Undo of a delete, for any table: invert what the server says the delete did.
//
// A delete's resolved ops (store.mutateResolved) list its whole cascade: unlinks of join
// rows, updates that cleared references to the row (a scene's cues → Unassigned, a person's
// content.creator_id, custom link values), deletes of dependent rows (a content's versions,
// a cue's script anchors, every deleted record's attachments), then the delete itself. With
// the store state from just before the delete, each of those can be put back:
//
//   1. creates: every deleted row under its old id with its stored fields; ordered tables
//      next to their old neighbour, in their old order; dependants after their parents.
//      (The server restores created_at/created_by from its own history; attachments come
//      back from the row and file it kept.)
//   2. updates: references and custom values a create couldn't carry yet (they point at
//      another row restored in this batch), then the cleared fields on surviving rows.
//   3. links: every unlinked join row at its old position (ascending, so chip order is kept).
//
// Built when Undo is clicked (`exists` reads the store then), so anything deleted by someone
// else in the meantime is left out instead of failing the batch.
import type { AnyResolvedOp, Op } from "../../../shared/ops";
import {
  type AttachmentRow,
  FIELDS,
  type FieldSpec,
  isOrderedTable,
  LINKS,
  type TableName,
} from "../../../shared/tables";
import type { ShowData } from "../../lib/show-state";
import { attachmentRestoreOps } from "../attachments/selectors";

type Exists = (table: TableName, id: string) => boolean;
type AnyFields = Record<string, unknown>;

/** Stamps and server-kept fields an update must not (or needn't) write back. */
const NOT_RESTORED = new Set([
  "updated_at",
  "updated_by",
  "created_at",
  "created_by",
  "completed_at",
  "completed_by",
  "order_key",
]);

const keyOf = (table: string, id: string) => `${table}\u0000${id}`;

export function deleteRestoreOps(
  before: ShowData,
  resolved: readonly AnyResolvedOp[],
  exists: Exists,
): Op[] {
  const rowOf = (table: TableName, id: string) =>
    (before.tables[table] as Map<string, unknown>).get(id) as AnyFields | undefined;

  // --- What was deleted, and what of it can come back ---
  const deletes: { table: TableName; id: string; at: number }[] = [];
  resolved.forEach((op, at) => {
    if (op.op === "delete" && rowOf(op.table, op.id) && !exists(op.table, op.id))
      deletes.push({ table: op.table, id: op.id, at });
  });
  const restoring = new Set(deletes.map((d) => keyOf(d.table, d.id)));
  const there = (table: TableName, id: string) =>
    restoring.has(keyOf(table, id)) || exists(table, id);

  // Custom link fields per field table (`cues`, `custom:<id>`): their values are row ids.
  const linkFields = new Map<string, { key: string; target: string }[]>();
  for (const f of before.tables.custom_fields.values()) {
    if (f.type !== "link") continue;
    const target = (f.options as { target?: unknown } | null)?.target;
    if (typeof target !== "string") continue;
    const list = linkFields.get(f.table) ?? [];
    list.push({ key: f.key, target });
    linkFields.set(f.table, list);
  }
  const targetTable = (target: string): TableName =>
    target.startsWith("custom:") ? "custom_rows" : (target as TableName);
  /** A row's custom values with links to records that are gone (and staying gone) dropped. */
  const liveCustom = (table: TableName, row: AnyFields): AnyFields => {
    const custom = { ...((row.custom as AnyFields | undefined) ?? {}) };
    const fieldTable =
      table === "custom_rows" && typeof row.table_id === "string"
        ? `custom:${row.table_id}`
        : table;
    for (const { key, target } of linkFields.get(fieldTable) ?? []) {
      const v = custom[key];
      if (!Array.isArray(v)) continue;
      const kept = v.filter((x) => typeof x === "string" && there(targetTable(target), x));
      if (kept.length) custom[key] = kept;
      else delete custom[key];
    }
    return custom;
  };

  // --- 1. Creates ---
  const creates: Op[] = [];
  const later: Op[] = [];
  const created = new Set<string>();
  const createRow = (table: TableName, id: string, placement: AnyFields) => {
    const row = rowOf(table, id) as AnyFields;
    if (table === "attachments") {
      creates.push(...attachmentRestoreOps([row as unknown as AttachmentRow]));
      created.add(keyOf(table, id));
      return;
    }
    const fields: AnyFields = {};
    const deferred: AnyFields = {};
    for (const [name, spec] of Object.entries(FIELDS[table]) as [string, FieldSpec][]) {
      if (spec.auto || !(name in row)) continue;
      const v = row[name];
      if (spec.type === "ref" && typeof v === "string" && spec.ref) {
        if (!there(spec.ref, v)) {
          fields[name] = null; // its target is gone for good
          continue;
        }
        if (
          !spec.cascade &&
          restoring.has(keyOf(spec.ref, v)) &&
          !created.has(keyOf(spec.ref, v))
        ) {
          fields[name] = null; // set once its target exists again (step 2)
          deferred[name] = v;
          continue;
        }
      }
      fields[name] = v;
    }
    const custom = liveCustom(table, row);
    // Custom values go in step 2: their links may point at rows created after this one.
    if (Object.keys(custom).length) deferred.custom = custom;
    creates.push({ op: "create", table, id, fields, ...placement });
    created.add(keyOf(table, id));
    if (Object.keys(deferred).length) later.push({ op: "update", table, id, fields: deferred });
  };

  // Ordered tables first, each in its old order, next to the nearest old neighbour that's
  // there (still, or restored just before).
  const ordered = deletes.filter((d) => isOrderedTable(d.table));
  const tablesInOrder = [...new Set(ordered.map((d) => d.table))];
  for (const table of tablesInOrder) {
    const order = (before.order as Record<string, string[]>)[table] ?? [];
    const pos = new Map(order.map((id, i) => [id, i]));
    const mine = ordered
      .filter((d) => d.table === table)
      .sort((a, b) => (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0));
    for (const d of mine) {
      const i = pos.get(d.id) ?? -1;
      const shown = (id: string) =>
        created.has(keyOf(table, id)) || (!restoring.has(keyOf(table, id)) && exists(table, id));
      let after: string | null | undefined;
      for (let j = i - 1; j >= 0; j--) {
        const id = order[j] as string;
        if (shown(id)) {
          after = id;
          break;
        }
      }
      let beforeId: string | undefined;
      if (after === undefined) {
        for (let j = i + 1; j < order.length; j++) {
          const id = order[j] as string;
          if (!restoring.has(keyOf(table, id)) && exists(table, id)) {
            beforeId = id;
            break;
          }
        }
      }
      const placement =
        after !== undefined
          ? { after }
          : beforeId !== undefined
            ? { before: beforeId }
            : i === 0
              ? { after: null }
              : {};
      createRow(d.table, d.id, placement);
    }
  }
  // The rest in reverse delete order: the server deletes dependants before their parent.
  for (const d of [...deletes].reverse()) {
    if (!isOrderedTable(d.table)) createRow(d.table, d.id, {});
  }

  // --- 2. Updates: deferred refs/custom, then what the cascade cleared on surviving rows ---
  const updates: Op[] = [...later];
  for (const op of resolved) {
    if (op.op !== "update") continue;
    if (restoring.has(keyOf(op.table, op.id)) || !exists(op.table, op.id)) continue;
    const row = rowOf(op.table, op.id);
    if (!row) continue;
    const fields: AnyFields = {};
    for (const k of Object.keys(op.fields)) {
      if (NOT_RESTORED.has(k)) continue;
      if (k === "custom") {
        fields.custom = liveCustom(op.table, row);
        continue;
      }
      const spec = (FIELDS[op.table] as Record<string, FieldSpec>)[k];
      if (!spec || spec.auto) continue;
      const v = row[k];
      if (spec.type === "ref" && typeof v === "string" && spec.ref && !there(spec.ref, v)) continue;
      fields[k] = v;
    }
    if (Object.keys(fields).length)
      updates.push({ op: "update", table: op.table, id: op.id, fields });
  }

  // --- 3. Links, at their old positions ---
  const links: (Op & { op: "link" })[] = [];
  for (const op of resolved) {
    if (op.op !== "unlink") continue;
    const spec = (LINKS as Record<string, { from: TableName; to: TableName; key: string }>)[
      `${op.table}.${op.field}`
    ];
    if (!spec || !there(spec.from, op.id) || !there(spec.to, op.targetId)) continue;
    const list =
      (before.joins as Record<string, Map<string, string[]>>)[spec.key]?.get(op.id) ?? [];
    const position = list.indexOf(op.targetId);
    links.push({
      op: "link",
      table: op.table,
      id: op.id,
      field: op.field,
      targetId: op.targetId,
      ...(position >= 0 ? { position } : {}),
    });
  }
  links.sort((a, b) =>
    a.table !== b.table
      ? a.table < b.table
        ? -1
        : 1
      : a.id !== b.id
        ? a.id < b.id
          ? -1
          : 1
        : a.field !== b.field
          ? a.field < b.field
            ? -1
            : 1
          : (a.position ?? 0) - (b.position ?? 0),
  );

  return [...creates, ...updates, ...links];
}
