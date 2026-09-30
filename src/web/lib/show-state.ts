// Pure, immutable show state for the client store (./show-store.ts): building it from a
// snapshot, resolving ops locally the way the server will (optimistic updates), and
// applying resolved ops. Untouched rows keep their identity so React selectors stay cheap.
import {
  type AnyOp,
  type AnyResolvedOp,
  type FieldValues,
  isMetaOp,
  type Joins,
  type Op,
  type ResolvedOp,
  type ShowSettings,
  type SnapshotResponse,
} from "../../shared/ops";
import { compareOrder, effectivePlacement, orderKeyFor } from "../../shared/order";
import { pageForBlock } from "../../shared/script";
import {
  type AnyRow,
  ATTACHMENT_FIELDS,
  type ContentVersionRow,
  type CueAnchorRow,
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
  type ScriptVersionRow,
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
  /** Show-level settings (the DO `meta` row): the default measurement unit. */
  meta: ShowSettings;
}

const NO_META: ShowSettings = { default_unit: null };

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
      surfaces: new Map(),
      views: new Map(),
      content_versions: new Map(),
      attachments: new Map(),
      scripts: new Map(),
      script_versions: new Map(),
      cue_anchors: new Map(),
    },
    order: { scenes: [], cues: [], content: [], surfaces: [] },
    joins: {
      cueContent: new Map(),
      cueAssignees: new Map(),
      noteCues: new Map(),
      noteAssignees: new Map(),
      sceneSurfaces: new Map(),
      contentSurfaces: new Map(),
    },
    fieldOptions: {},
    meta: NO_META,
  };
}

/**
 * Build state from a snapshot. With `prev` (a refetch), unchanged parts keep their identity
 * (structural sharing): a row deep-equal to its previous copy is the previous object, a
 * table / order list / join map whose contents didn't change is the previous one, and so
 * are equal join lists and field options. A refetch then re-renders only what changed.
 */
export function fromSnapshot(snap: SnapshotResponse, prev?: ShowData): ShowData {
  const data = emptyData();
  data.version = snap.version;
  data.fieldOptions =
    prev && jsonEqual(prev.fieldOptions, snap.fieldOptions) ? prev.fieldOptions : snap.fieldOptions;
  const meta = snap.meta ?? NO_META;
  data.meta = prev && jsonEqual(prev.meta, meta) ? prev.meta : meta;
  for (const t of TABLE_NAMES) {
    const map = data.tables[t] as RowMap;
    const old = prev?.tables[t] as RowMap | undefined;
    let same = !!old && old.size === snap.tables[t].length;
    for (const row of snap.tables[t] as AnyRow[]) {
      const before = old?.get(row.id);
      if (before && jsonEqual(before, row)) map.set(row.id, before);
      else {
        map.set(row.id, row);
        same = false;
      }
    }
    if (same && old) (data.tables as Record<TableName, RowMap>)[t] = old;
  }
  for (const t of ORDERED_TABLES) {
    const ids = sortIds(data.tables[t] as RowMap, [...data.tables[t].keys()]);
    const old = prev?.order[t];
    data.order[t] = old && arraysEqual(old, ids) ? old : ids;
  }
  for (const key of Object.keys(data.joins) as JoinName[]) {
    const old = prev?.joins[key];
    const map = new Map<string, string[]>();
    let same = !!old;
    const entries = Object.entries(snap.joins[key] ?? {});
    if (old && old.size !== entries.length) same = false;
    for (const [from, targets] of entries) {
      const before = old?.get(from);
      if (before && arraysEqual(before, targets)) map.set(from, before);
      else {
        map.set(from, targets);
        same = false;
      }
    }
    data.joins[key] = same && old ? old : map;
  }
  return data;
}

function arraysEqual(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Deep equality for JSON-shaped values (rows, options). Key order doesn't matter. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => jsonEqual(x, bb[i]));
  }
  const ka = Object.keys(a);
  const bo = b as Record<string, unknown>;
  if (ka.length !== Object.keys(bo).length) return false;
  return ka.every(
    (k) => Object.hasOwn(bo, k) && jsonEqual((a as Record<string, unknown>)[k], bo[k]),
  );
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
    (id) => rows.get(id) as unknown as { id: string; order_key: string; scene_id?: string | null },
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
export function resolveLocal(data: ShowData, ops: AnyOp[], ctx: LocalContext): AnyResolvedOp[] {
  const out: AnyResolvedOp[] = [];
  let state = data;
  for (const op of ops) {
    if (isMetaOp(op)) {
      // Resolves to itself (the server validates the unit).
      state = applyResolved(state, [op]);
      out.push(op);
      continue;
    }
    const resolved = resolveOne(state, op, ctx);
    state = applyResolved(state, resolved);
    out.push(...resolved);
    if (op.table === "views" && (op.op === "create" || op.op === "update")) {
      const cleared = clearOtherDefaults(state, op.id, ctx);
      state = applyResolved(state, cleared);
      out.push(...cleared);
    }
    if (op.table === "content_versions") {
      const more = versionFollowUps(state, op, ctx);
      state = applyResolved(state, more);
      out.push(...more);
    }
    if (op.table === "cue_anchors" || op.table === "scripts") {
      const more = scriptFollowUps(state, op, ctx);
      state = applyResolved(state, more);
      out.push(...more);
    }
  }
  return out;
}

/**
 * Like the server (ops-engine `prepareAnchor` / `syncCuePage`): an anchor's page comes
 * from its block through the version's page map (a position-less anchor has none), and
 * Cue.page follows anchors on the script's current version, also when the current version
 * changes.
 */
function scriptFollowUps(data: ShowData, op: Op, ctx: LocalContext): ResolvedOp[] {
  if (op.op !== "create" && op.op !== "update") return [];
  const stamp = { updated_at: ctx.now, updated_by: ctx.userId };
  if (op.table === "scripts") {
    const vid = op.fields.current_version_id;
    if (op.op !== "update" || typeof vid !== "string") return [];
    const anchors = [...data.tables.cue_anchors.values()].filter(
      (a) => a.script_version_id === vid,
    );
    return cuePageOps(data, anchors, stamp);
  }
  const a = data.tables.cue_anchors.get(op.id);
  const version = a && data.tables.script_versions.get(a.script_version_id);
  if (!a || !version) return [];
  const fixed: FieldValues =
    a.block === null
      ? { offset: null, length: null, page: null }
      : {
          offset: a.offset ?? 0,
          length: a.length ?? 0,
          page: pageForBlock(version.page_map ?? [], a.block)?.page ?? null,
          ...(op.op === "create" && a.state === null ? { state: "manual" } : {}),
        };
  const changed = Object.fromEntries(
    Object.entries(fixed).filter(([k, v]) => (a as unknown as Record<string, unknown>)[k] !== v),
  );
  const out: ResolvedOp[] = [];
  if (Object.keys(changed).length > 0) {
    out.push({ op: "update", table: "cue_anchors", id: a.id, fields: { ...changed, ...stamp } });
  }
  return [...out, ...cuePageOps(data, [{ ...a, ...changed } as CueAnchorRow], stamp)];
}

/**
 * Cue.page updates for anchors that are on their script's current version (`current`:
 * the version about to become current, when `data` doesn't say so yet).
 */
function cuePageOps(
  data: ShowData,
  anchors: CueAnchorRow[],
  stamp: { updated_at: number; updated_by: string },
  current?: string,
): ResolvedOp[] {
  const out: ResolvedOp[] = [];
  for (const a of anchors) {
    if (a.block === null) continue;
    const version = data.tables.script_versions.get(a.script_version_id);
    const script = version && data.tables.scripts.get(version.script_id);
    if (!version || (current ?? script?.current_version_id) !== version.id) continue;
    const label = pageForBlock(version.page_map ?? [], a.block)?.label;
    const cue = data.tables.cues.get(a.cue_id);
    if (label !== undefined && cue && cue.page !== label) {
      out.push({ op: "update", table: "cues", id: cue.id, fields: { page: label, ...stamp } });
    }
  }
  return out;
}

/**
 * Like the server: a version that became current un-currents its siblings (deleting the
 * current version promotes the newest remaining one: see the delete case).
 */
function versionFollowUps(data: ShowData, op: Op, ctx: LocalContext): ResolvedOp[] {
  if (op.op !== "create" && op.op !== "update") return [];
  const stamp = { updated_at: ctx.now, updated_by: ctx.userId };
  const versions = data.tables.content_versions;
  const v = versions.get(op.id);
  if (v && !v.is_current && op.op === "update" && op.fields.is_current === false) {
    // Un-currented: the newest other version takes over (the server refuses it when
    // there's no other).
    const others = [...versions.values()].filter(
      (o) => o.id !== v.id && o.content_id === v.content_id,
    );
    if (others.some((o) => o.is_current)) return [];
    const next = others.sort((a, b) => compareVersionAge(b, a))[0];
    return next
      ? [
          {
            op: "update",
            table: "content_versions",
            id: next.id,
            fields: { is_current: true, ...stamp },
          },
        ]
      : [];
  }
  if (!v?.is_current) return [];
  const out: ResolvedOp[] = [];
  for (const o of versions.values()) {
    if (o.id !== v.id && o.content_id === v.content_id && o.is_current) {
      out.push({
        op: "update",
        table: "content_versions",
        id: o.id,
        fields: { is_current: false, ...stamp },
      });
    }
  }
  return out;
}

/** The content's version that becomes current when `deleted` (the current one) goes. */
function promotedVersion(data: ShowData, deleted: ContentVersionRow): ContentVersionRow | null {
  let best: ContentVersionRow | null = null;
  for (const o of data.tables.content_versions.values()) {
    if (o.id === deleted.id || o.content_id !== deleted.content_id) continue;
    if (!best || compareVersionAge(o, best) > 0) best = o;
  }
  return best;
}

/** Newer = higher position, then later created_at, then higher id (the server's order). */
export function compareVersionAge(
  a: Pick<ContentVersionRow, "position" | "created_at" | "id">,
  b: Pick<ContentVersionRow, "position" | "created_at" | "id">,
): number {
  return (
    (a.position ?? 0) - (b.position ?? 0) ||
    a.created_at - b.created_at ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** Like the server: a shared view that became the default un-defaults the table's others. */
function clearOtherDefaults(data: ShowData, id: string, ctx: LocalContext): ResolvedOp[] {
  const view = data.tables.views.get(id);
  if (!view?.is_default || view.owner_user_id !== null) return [];
  const out: ResolvedOp[] = [];
  for (const other of data.tables.views.values()) {
    if (
      other.id !== id &&
      other.table === view.table &&
      other.owner_user_id === null &&
      other.is_default
    ) {
      out.push({
        op: "update",
        table: "views",
        id: other.id,
        fields: { is_default: false, updated_at: ctx.now, updated_by: ctx.userId },
      });
    }
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
        fields[name] =
          spec.type === "bool"
            ? false
            : spec.type === "multiselect"
              ? []
              : spec.type === "json"
                ? {}
                : null;
      }
      Object.assign(fields, { custom: {} }, op.fields, {
        created_at: ctx.now,
        created_by: ctx.userId,
        ...stamp,
      });
      if (op.table === "content_versions") {
        let max = 0;
        let hasCurrent = false;
        for (const v of data.tables.content_versions.values()) {
          if (v.content_id !== fields.content_id) continue;
          max = Math.max(max, v.position ?? 0);
          hasCurrent ||= v.is_current;
        }
        if (fields.position === null || fields.position === undefined) fields.position = max + 1;
        if (!hasCurrent) fields.is_current = true;
      }
      if (isOrderedTable(op.table)) {
        const rows = keyed(data, op.table);
        const hasScene = "scene_id" in FIELDS[op.table];
        const sceneId = hasScene
          ? ((fields.scene_id as string | null | undefined) ?? null)
          : undefined;
        const placement = effectivePlacement(rows, op, sceneId);
        fields.order_key = orderKeyFor(rows, placement);
        return [{ op: "create", table: op.table, id: op.id, fields, placement }];
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
      const row = rows.get(op.id);
      if (!row) throw new LocalOpError(`${op.table} ${op.id} not found`);
      const out = [...cascade(data, op.table, op.id, stamp), op];
      if (op.table === "content_versions" && (row as ContentVersionRow).is_current) {
        const next = promotedVersion(data, row as ContentVersionRow);
        if (next) {
          out.push({
            op: "update",
            table: "content_versions",
            id: next.id,
            fields: { is_current: true, ...stamp },
          });
        }
      }
      if (op.table === "script_versions") {
        // The current script version went: the newest other one becomes current.
        const v = row as ScriptVersionRow;
        const script = data.tables.scripts.get(v.script_id);
        if (script?.current_version_id === v.id) {
          let next: ScriptVersionRow | null = null;
          for (const o of data.tables.script_versions.values()) {
            if (o.id === v.id || o.script_id !== v.script_id) continue;
            if (!next || compareVersionAge(o, next) > 0) next = o;
          }
          if (next) {
            out.push({
              op: "update",
              table: "scripts",
              id: script.id,
              fields: { current_version_id: next.id, ...stamp },
            });
            const nextId = next.id;
            const anchors = [...data.tables.cue_anchors.values()].filter(
              (a) => a.script_version_id === nextId,
            );
            out.push(...cuePageOps(data, anchors, stamp, nextId));
          }
        }
      }
      return out;
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
          if (spec.cascade) {
            out.push(...cascade(data, other, row.id, stamp), {
              op: "delete",
              table: other,
              id: row.id,
            });
          } else {
            out.push({
              op: "update",
              table: other,
              id: row.id,
              fields: { [name]: null, ...stamp },
            });
          }
        }
      }
    }
  }
  if (ATTACHMENT_FIELDS[table]) {
    const files = [...data.tables.attachments.values()]
      .filter((a) => a.table === table && a.record_id === id)
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || (a.id < b.id ? -1 : 1));
    for (const f of files) out.push({ op: "delete", table: "attachments", id: f.id });
  }
  return out;
}

/**
 * Apply resolved ops immutably. Tolerant: ops on rows that no longer exist are skipped
 * (a pending local op replayed over a newer server state).
 */
export function applyResolved(data: ShowData, ops: readonly AnyResolvedOp[]): ShowData {
  if (ops.length === 0) return data;
  let meta = data.meta;
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
      case "meta":
        meta = { ...meta, ...op.fields };
        break;
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
  return { ...data, tables, order, joins, meta };
}
