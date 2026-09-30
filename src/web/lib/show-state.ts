// Pure, immutable show state for the client store (./show-store.ts): building it from a
// snapshot, resolving ops locally the way the server will (optimistic updates), and
// applying resolved ops. Untouched rows keep their identity so React selectors stay cheap.
import type { FieldValues, Joins, Op, ResolvedOp, SnapshotResponse } from "../../shared/ops";
import { compareOrder, orderKeyFor } from "../../shared/order";
import {
  type AnyRow,
  FIELDS,
  type FieldOptions,
  type FieldSpec,
  isOrderedTable,
  LINKS,
  type LinkSpec,
  linkSpec,
  ORDERED_TABLES,
  type OrderedTableName,
  type Row,
  TABLE_NAMES,
  type TableName,
} from "../../shared/tables";

export type JoinName = keyof Joins;

export interface ShowData {
  version: number;
  /** Rows by id. */
  tables: { [T in TableName]: Map<string, Row<T>> };
  /** Ids of ordered tables in show order (order_key, then id). */
  order: { [T in OrderedTableName]: string[] };
  /** From-id → target ids in chip order. */
  joins: { [K in JoinName]: Map<string, string[]> };
  fieldOptions: FieldOptions;
}

type Tables = ShowData["tables"];
type RowMap = Map<string, AnyRow>;

export function emptyData(): ShowData {
  return {
    version: 0,
    tables: {
      scenes: new Map(),
      cues: new Map(),
      content: new Map(),
      notes: new Map(),
      persons: new Map(),
    },
    order: { scenes: [], cues: [], content: [] },
    joins: {
      cueContent: new Map(),
      cueAssignees: new Map(),
      noteCues: new Map(),
      noteAssignees: new Map(),
    },
    fieldOptions: {},
  };
}

export function fromSnapshot(snap: SnapshotResponse): ShowData {
  const data = emptyData();
  data.version = snap.version;
  data.fieldOptions = snap.fieldOptions;
  for (const t of TABLE_NAMES) {
    const map = data.tables[t] as RowMap;
    for (const row of snap.tables[t] as AnyRow[]) map.set(row.id, row);
  }
  for (const t of ORDERED_TABLES) {
    data.order[t] = sortIds(data.tables[t] as RowMap, [...data.tables[t].keys()]);
  }
  for (const key of Object.keys(data.joins) as JoinName[]) {
    data.joins[key] = new Map(Object.entries(snap.joins[key] ?? {}));
  }
  return data;
}

function sortIds(rows: RowMap, ids: string[]): string[] {
  return ids.sort((a, b) =>
    compareOrder(rows.get(a) as { id: string; order_key: string }, rows.get(b) as never),
  );
}

/** Rows of an ordered table in show order, as {id, order_key} (for orderKeyFor). */
function keyed(data: ShowData, table: OrderedTableName) {
  const rows = data.tables[table] as RowMap;
  return data.order[table].map(
    (id) => rows.get(id) as unknown as { id: string; order_key: string },
  );
}

function linkFieldName(spec: LinkSpec): string {
  for (const [name, s] of Object.entries(LINKS)) {
    if (s === spec) return name.slice(name.indexOf(".") + 1);
  }
  return "";
}

export interface LocalContext {
  userId: string;
  now: number;
}

export class LocalOpError extends Error {}

/**
 * Resolve ops against `data` the way the server will: order keys from neighbours, defaults
 * and timestamps, merged custom, delete cascades. Validation is left to the server; this
 * only throws when an op can't be applied at all (unknown row or neighbour).
 */
export function resolveLocal(data: ShowData, ops: Op[], ctx: LocalContext): ResolvedOp[] {
  const out: ResolvedOp[] = [];
  let state = data;
  for (const op of ops) {
    const resolved = resolveOne(state, op, ctx);
    state = applyResolved(state, resolved);
    out.push(...resolved);
  }
  return out;
}

function resolveOne(data: ShowData, op: Op, ctx: LocalContext): ResolvedOp[] {
  const rows = data.tables[op.table] as RowMap;
  const stamp = { updated_at: ctx.now, updated_by: ctx.userId };
  switch (op.op) {
    case "create": {
      if (rows.has(op.id)) throw new LocalOpError(`${op.table} ${op.id} already exists`);
      const fields: FieldValues = {};
      for (const [name, spec] of Object.entries(FIELDS[op.table]) as [string, FieldSpec][]) {
        fields[name] = spec.type === "bool" ? false : spec.type === "multiselect" ? [] : null;
      }
      Object.assign(fields, { custom: {} }, op.fields, {
        created_at: ctx.now,
        created_by: ctx.userId,
        ...stamp,
      });
      if (isOrderedTable(op.table)) {
        fields.order_key = orderKeyFor(keyed(data, op.table), op);
      }
      return [{ op: "create", table: op.table, id: op.id, fields }];
    }
    case "update": {
      const row = rows.get(op.id);
      if (!row) throw new LocalOpError(`${op.table} ${op.id} not found`);
      const fields: FieldValues = { ...op.fields, ...stamp };
      if (op.fields.custom && typeof op.fields.custom === "object") {
        const merged: Record<string, unknown> = { ...row.custom };
        for (const [k, v] of Object.entries(op.fields.custom)) {
          if (v === null) delete merged[k];
          else merged[k] = v;
        }
        fields.custom = merged;
      }
      return [{ op: "update", table: op.table, id: op.id, fields }];
    }
    case "move": {
      if (!rows.has(op.id)) throw new LocalOpError(`${op.table} ${op.id} not found`);
      const order_key = orderKeyFor(keyed(data, op.table), op, op.id);
      return [{ op: "move", table: op.table, id: op.id, fields: { order_key, ...stamp } }];
    }
    case "link": {
      const spec = linkSpec(op.table, op.field);
      if (!spec) throw new LocalOpError(`${op.table}.${op.field} is not a link field`);
      const current = data.joins[spec.key].get(op.id) ?? [];
      if (current.includes(op.targetId)) return [];
      const position = Math.min(op.position ?? current.length, current.length);
      return [{ ...op, position }];
    }
    case "unlink": {
      const spec = linkSpec(op.table, op.field);
      if (!spec) throw new LocalOpError(`${op.table}.${op.field} is not a link field`);
      return (data.joins[spec.key].get(op.id) ?? []).includes(op.targetId) ? [op] : [];
    }
    case "delete": {
      if (!rows.has(op.id)) throw new LocalOpError(`${op.table} ${op.id} not found`);
      return [...cascade(data, op.table, op.id, stamp), op];
    }
  }
}

/** The explicit ops the server emits before a delete (same order as the op engine). */
function cascade(
  data: ShowData,
  table: TableName,
  id: string,
  stamp: { updated_at: number; updated_by: string },
): ResolvedOp[] {
  const out: ResolvedOp[] = [];
  for (const spec of Object.values(LINKS) as LinkSpec[]) {
    const field = linkFieldName(spec);
    if (spec.from === table) {
      const targets = [...(data.joins[spec.key].get(id) ?? [])].reverse();
      for (const t of targets) out.push({ op: "unlink", table, id, field, targetId: t });
    }
    if (spec.to === table) {
      for (const [from, targets] of data.joins[spec.key]) {
        if (targets.includes(id)) {
          out.push({ op: "unlink", table: spec.from, id: from, field, targetId: id });
        }
      }
    }
  }
  for (const other of TABLE_NAMES) {
    for (const [name, spec] of Object.entries(FIELDS[other]) as [string, FieldSpec][]) {
      if (spec.type !== "ref" || spec.ref !== table) continue;
      for (const row of (data.tables[other] as RowMap).values()) {
        if ((row as unknown as Record<string, unknown>)[name] === id) {
          out.push({ op: "update", table: other, id: row.id, fields: { [name]: null, ...stamp } });
        }
      }
    }
  }
  return out;
}

/**
 * Apply resolved ops immutably. Tolerant: ops on rows that no longer exist are skipped
 * (a pending local op replayed over a newer server state).
 */
export function applyResolved(data: ShowData, ops: readonly ResolvedOp[]): ShowData {
  if (ops.length === 0) return data;
  const tables: Tables = { ...data.tables };
  const order = { ...data.order };
  const joins = { ...data.joins };
  const touchedTables = new Set<TableName>();
  const touchedOrder = new Set<OrderedTableName>();
  const touchedJoins = new Set<JoinName>();

  const tableMap = (t: TableName): RowMap => {
    if (!touchedTables.has(t)) {
      (tables as Record<TableName, RowMap>)[t] = new Map(data.tables[t] as RowMap);
      touchedTables.add(t);
    }
    return tables[t] as RowMap;
  };
  const joinMap = (k: JoinName) => {
    if (!touchedJoins.has(k)) {
      joins[k] = new Map(data.joins[k]);
      touchedJoins.add(k);
    }
    return joins[k];
  };
  const reorder = (t: TableName, id: string, removeOnly = false) => {
    if (!isOrderedTable(t)) return;
    if (!touchedOrder.has(t)) {
      order[t] = [...data.order[t]];
      touchedOrder.add(t);
    }
    const list = order[t];
    const i = list.indexOf(id);
    if (i >= 0) list.splice(i, 1);
    if (removeOnly) return;
    const rows = tables[t] as RowMap;
    const row = rows.get(id) as unknown as { id: string; order_key: string };
    // Binary search for the insertion point.
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const other = rows.get(list[mid] as string) as unknown as { id: string; order_key: string };
      if (compareOrder(other, row) < 0) lo = mid + 1;
      else hi = mid;
    }
    list.splice(lo, 0, id);
  };

  for (const op of ops) {
    switch (op.op) {
      case "create": {
        const map = tableMap(op.table);
        map.set(op.id, { ...op.fields, id: op.id } as unknown as AnyRow);
        reorder(op.table, op.id);
        break;
      }
      case "update":
      case "move": {
        const map = tableMap(op.table);
        const row = map.get(op.id);
        if (!row) break;
        map.set(op.id, { ...row, ...op.fields, id: op.id } as AnyRow);
        if ("order_key" in op.fields) reorder(op.table, op.id);
        break;
      }
      case "delete": {
        const map = tableMap(op.table);
        if (!map.delete(op.id)) break;
        reorder(op.table, op.id, true);
        // Belt and braces: drop any join rows still pointing at it.
        for (const spec of Object.values(LINKS) as LinkSpec[]) {
          if (spec.from === op.table && joins[spec.key].has(op.id)) joinMap(spec.key).delete(op.id);
          if (spec.to === op.table) {
            for (const [from, targets] of joins[spec.key]) {
              if (targets.includes(op.id)) {
                joinMap(spec.key).set(
                  from,
                  targets.filter((t) => t !== op.id),
                );
              }
            }
          }
        }
        break;
      }
      case "link": {
        const spec = linkSpec(op.table, op.field);
        if (!spec) break;
        const map = joinMap(spec.key);
        const current = map.get(op.id) ?? [];
        if (current.includes(op.targetId)) break;
        const next = [...current];
        next.splice(Math.min(op.position, next.length), 0, op.targetId);
        map.set(op.id, next);
        break;
      }
      case "unlink": {
        const spec = linkSpec(op.table, op.field);
        if (!spec) break;
        const map = joinMap(spec.key);
        const current = map.get(op.id);
        if (!current?.includes(op.targetId)) break;
        const next = current.filter((t) => t !== op.targetId);
        if (next.length) map.set(op.id, next);
        else map.delete(op.id);
        break;
      }
    }
  }
  return { ...data, tables, order, joins };
}
