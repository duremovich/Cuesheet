// Applies batches of ops to a show's SQLite (see src/shared/ops.ts and
// docs/decisions/0006-mutation-ops-and-sync.md). Runs synchronously inside
// `ctx.storage.transactionSync`, so any thrown OpError rolls the whole batch back.
import type { Role } from "../../shared/api";
import { isValidId } from "../../shared/ids";
import type {
  DeleteOp,
  FieldValues,
  HistoryEntry,
  Joins,
  Op,
  Placement,
  ResolvedOp,
  SnapshotResponse,
  UnlinkOp,
} from "../../shared/ops";
import { effectivePlacement, orderKeyFor, PlacementError } from "../../shared/order";
import {
  FIELDS,
  type FieldOptions,
  type FieldSpec,
  fieldSpec,
  isOrderedTable,
  isTableName,
  LINKS,
  type LinkSpec,
  linkSpec,
  TABLE_NAMES,
  type TableName,
} from "../../shared/tables";

export interface MutationContext {
  userId: string;
  role: Role;
  /** The sending store's id (echoed in the broadcast); null for server-side batches. */
  clientId: string | null;
  /** Import only: accept `created_at` in create fields. */
  allowCreatedAt?: boolean;
}

export class OpError extends Error {
  constructor(
    message: string,
    readonly opIndex: number | undefined,
    readonly status: 400 | 403 = 400,
  ) {
    super(message);
  }
}

export interface BatchResult {
  prevVersion: number;
  version: number;
  ops: ResolvedOp[];
}

const MAX_TEXT = 100_000;
/** Largest a row may be, as UTF-8 JSON. */
export const MAX_ROW_BYTES = 512 * 1024;
const DONE_STATUS = "Done";
/** Keys that could pollute prototypes when custom objects are merged. */
export const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const encoder = new TextEncoder();
const byteLength = (v: unknown) => encoder.encode(JSON.stringify(v)).byteLength;

type DbRow = Record<string, SqlStorageValue>;
type WireRow = Record<string, unknown>;

/** Quote an identifier. Only ever called with names from our own specs. */
const q = (name: string) => `"${name.replaceAll('"', '""')}"`;

export function currentVersion(sql: SqlStorage): number {
  const row = sql.exec<{ v: number | null }>("SELECT max(version) AS v FROM changes").one();
  return row.v ?? 0;
}

export function loadFieldOptions(sql: SqlStorage): FieldOptions {
  const out: FieldOptions = {};
  const rows = sql
    .exec<{ table: string; field: string; value: string; color: string }>(
      'SELECT "table", field, value, color FROM field_options ORDER BY "table", field, position',
    )
    .toArray();
  for (const r of rows) {
    const key = `${r.table}.${r.field}` as keyof FieldOptions;
    const list = out[key] ?? [];
    list.push({ value: r.value, color: r.color });
    out[key] = list;
  }
  return out;
}

/** DB row → wire row (JSON columns parsed, booleans as booleans). */
export function decodeRow(table: TableName, row: DbRow): WireRow {
  const out: WireRow = { ...row };
  out.custom = parseJson(row.custom, {});
  for (const [name, spec] of Object.entries(FIELDS[table]) as [string, FieldSpec][]) {
    if (spec.type === "bool") out[name] = row[name] === 1;
    else if (spec.type === "multiselect") out[name] = parseJson(row[name], []);
  }
  return out;
}

function parseJson<T>(v: SqlStorageValue | undefined, fallback: T): T {
  if (typeof v !== "string") return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

/** Wire value → SQL value for one column. */
function encodeValue(spec: FieldSpec | undefined, value: unknown): SqlStorageValue {
  if (value === null || value === undefined) {
    if (spec?.type === "multiselect") return "[]";
    if (spec?.type === "bool") return 0;
    return null;
  }
  if (spec?.type === "bool") return value ? 1 : 0;
  if (spec?.type === "multiselect" || typeof value === "object") return JSON.stringify(value);
  return value as SqlStorageValue;
}

function defaultValue(spec: FieldSpec): unknown {
  if (spec.type === "bool") return false;
  if (spec.type === "multiselect") return [];
  return null;
}

const json = (v: unknown): string | null => (v === undefined ? null : JSON.stringify(v));

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * One batch. Construct, call `run(ops)` inside a storage transaction. Keeps no state
 * between batches.
 */
export class Batch {
  private readonly resolved: ResolvedOp[] = [];
  private options: Map<string, Set<string>> | null = null;
  private opIndex = 0;
  private readonly now: number;

  constructor(
    private readonly sql: SqlStorage,
    private readonly ctx: MutationContext,
    now = Date.now(),
  ) {
    this.now = now;
  }

  run(ops: unknown): BatchResult {
    if (!Array.isArray(ops)) throw new OpError("ops must be an array", undefined);
    if (this.ctx.role === "viewer" && ops.length > 0) {
      throw new OpError("Viewers can't make changes", 0, 403);
    }
    const prevVersion = currentVersion(this.sql);
    ops.forEach((raw, i) => {
      this.opIndex = i;
      this.apply(this.parse(raw));
    });
    return { prevVersion, version: currentVersion(this.sql), ops: this.resolved };
  }

  private fail(message: string, status: 400 | 403 = 400): never {
    throw new OpError(message, this.opIndex, status);
  }

  // ---- shape ----

  private parse(raw: unknown): Op {
    if (!isPlainObject(raw)) this.fail("op must be an object");
    const { op, table, id } = raw;
    if (!isTableName(table)) this.fail(`unknown table ${String(table)}`);
    if (!isValidId(id)) this.fail("id must be an id string");
    const placement = () => {
      for (const k of ["after", "before"] as const) {
        const v = raw[k];
        if (v !== undefined && v !== null && !isValidId(v)) this.fail(`${k} must be an id or null`);
      }
      return {
        ...(raw.after !== undefined ? { after: raw.after as string | null } : {}),
        ...(raw.before !== undefined ? { before: raw.before as string | null } : {}),
      };
    };
    switch (op) {
      case "create":
      case "update": {
        if (!isPlainObject(raw.fields)) this.fail("fields must be an object");
        if (op === "update") return { op, table, id, fields: raw.fields };
        return { op, table, id, fields: raw.fields, ...placement() };
      }
      case "delete":
        return { op, table, id };
      case "move":
        if (!isOrderedTable(table)) this.fail(`${table} has no show order`);
        return { op, table, id, ...placement() };
      case "link":
      case "unlink": {
        const { field, targetId, position } = raw;
        if (typeof field !== "string") this.fail("field must be a string");
        if (!isValidId(targetId)) this.fail("targetId must be an id");
        if (op === "unlink") return { op, table, id, field, targetId };
        if (position !== undefined && !(Number.isInteger(position) && (position as number) >= 0)) {
          this.fail("position must be a non-negative integer");
        }
        return {
          op,
          table,
          id,
          field,
          targetId,
          ...(position !== undefined ? { position: position as number } : {}),
        };
      }
      default:
        this.fail(`unknown op ${String(op)}`);
    }
  }

  private apply(op: Op): void {
    switch (op.op) {
      case "create":
        this.create(op.table, op.id, op.fields, op);
        break;
      case "update":
        this.update(op.table, op.id, op.fields);
        break;
      case "delete":
        this.delete(op);
        break;
      case "move":
        this.move(op.table, op.id, op);
        break;
      case "link":
        this.link(op.table, op.id, op.field, op.targetId, op.position);
        break;
      case "unlink":
        this.unlink(op);
        break;
    }
  }

  // ---- permissions ----

  /** Commenters may only touch notes they created. */
  private checkRole(table: TableName, existing: DbRow | null): void {
    const { role, userId } = this.ctx;
    if (role === "owner" || role === "editor") return;
    if (role === "commenter" && table === "notes") {
      if (!existing || existing.created_by === userId) return;
      this.fail("Commenters can only change their own notes", 403);
    }
    this.fail(
      role === "commenter" ? "Commenters can only change notes" : "Viewers can't make changes",
      403,
    );
  }

  // ---- reads ----

  private getRow(table: TableName, id: string): DbRow | null {
    return this.sql.exec<DbRow>(`SELECT * FROM ${q(table)} WHERE id = ?`, id).toArray()[0] ?? null;
  }

  private mustGet(table: TableName, id: string): DbRow {
    const row = this.getRow(table, id);
    if (!row) this.fail(`${table} ${id} not found`);
    return row;
  }

  private optionSet(table: TableName, field: string): Set<string> {
    if (!this.options) {
      this.options = new Map();
      for (const [key, opts] of Object.entries(loadFieldOptions(this.sql))) {
        this.options.set(key, new Set(opts.map((o) => o.value)));
      }
    }
    return this.options.get(`${table}.${field}`) ?? new Set();
  }

  // ---- validation ----

  /** Validate and normalise one field value from a client. */
  private validate(table: TableName, field: string, spec: FieldSpec, value: unknown): unknown {
    const label = `${table}.${field}`;
    if (spec.auto) this.fail(`${label} is set automatically`);
    if ((spec.type === "select" || spec.type === "ref") && value === "") value = null;
    if (value === null) {
      if (spec.type === "bool") this.fail(`${label} must be true or false`);
      return spec.type === "multiselect" ? [] : null;
    }
    switch (spec.type) {
      case "text":
        if (typeof value !== "string") this.fail(`${label} must be text`);
        if (value.length > MAX_TEXT) this.fail(`${label} is too long`);
        return value;
      case "number":
        if (typeof value !== "number" || !Number.isFinite(value)) {
          this.fail(`${label} must be a number`);
        }
        return value;
      case "bool":
        if (typeof value !== "boolean") this.fail(`${label} must be true or false`);
        return value;
      case "select": {
        if (typeof value !== "string" || !this.optionSet(table, field).has(value)) {
          this.fail(`${label}: "${String(value)}" is not an option`);
        }
        return value;
      }
      case "multiselect": {
        if (!Array.isArray(value)) this.fail(`${label} must be a list`);
        const opts = this.optionSet(table, field);
        const seen = new Set<string>();
        for (const v of value) {
          if (typeof v !== "string" || !opts.has(v)) {
            this.fail(`${label}: "${String(v)}" is not an option`);
          }
          if (seen.has(v)) this.fail(`${label}: "${v}" is listed twice`);
          seen.add(v);
        }
        return value;
      }
      case "ref": {
        const target = spec.ref as TableName;
        if (typeof value !== "string" || !this.getRow(target, value)) {
          this.fail(`${label}: ${target} ${String(value)} not found`);
        }
        return value;
      }
    }
  }

  private validateCustom(value: unknown): Record<string, unknown> {
    if (!isPlainObject(value)) this.fail("custom must be an object");
    for (const k of Object.keys(value)) {
      if (!k || k.length > 64) this.fail("custom field keys must be 1–64 characters");
      if (RESERVED_KEYS.has(k)) this.fail(`custom field key "${k}" is not allowed`);
    }
    if (byteLength(value) > MAX_TEXT) this.fail("custom is too large");
    return value;
  }

  // ---- history ----

  private log(table: TableName, recordId: string, field: string, oldV: unknown, newV: unknown) {
    this.sql.exec(
      'INSERT INTO changes (ts, user_id, "table", record_id, field, old, new, client_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      this.now,
      this.ctx.userId,
      table,
      recordId,
      field,
      json(oldV),
      json(newV),
      this.ctx.clientId,
    );
  }

  // ---- order ----

  private orderKey(table: TableName, placement: Placement, excludeId?: string): string {
    const { after, before } = placement;
    const t = q(table);
    try {
      if (after === undefined && before === undefined) {
        // Append: only the last key matters (fast path used by import).
        const last = this.sql
          .exec<{ order_key: string }>(
            `SELECT order_key FROM ${t} WHERE id != ? ORDER BY order_key DESC, id DESC LIMIT 1`,
            excludeId ?? "",
          )
          .toArray()[0];
        return orderKeyFor(last ? [{ id: "last", order_key: last.order_key }] : [], {});
      }
      const rows = this.sql
        .exec<{ id: string; order_key: string }>(
          `SELECT id, order_key FROM ${t} ORDER BY order_key, id`,
        )
        .toArray();
      return orderKeyFor(rows, placement, excludeId);
    } catch (e) {
      if (e instanceof PlacementError) this.fail(e.message);
      throw e;
    }
  }

  // ---- ops ----

  private create(table: TableName, id: string, fields: FieldValues, placement: Placement) {
    this.checkRole(table, null);
    if (this.getRow(table, id)) this.fail(`${table} ${id} already exists`);
    const row: WireRow = { id };
    for (const [name, spec] of Object.entries(FIELDS[table]) as [string, FieldSpec][]) {
      row[name] = defaultValue(spec);
    }
    row.custom = {};
    row.created_at = this.now;
    for (const [name, value] of Object.entries(fields)) {
      if (name === "custom") {
        row.custom = this.validateCustom(value);
      } else if (name === "created_at" && this.ctx.allowCreatedAt) {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          this.fail("created_at must be a number");
        }
        row.created_at = value;
      } else {
        const spec = fieldSpec(table, name);
        if (!spec) this.fail(`unknown field ${table}.${name}`);
        row[name] = this.validate(table, name, spec, value);
      }
    }
    row.created_by = this.ctx.userId;
    row.updated_at = this.now;
    row.updated_by = this.ctx.userId;
    let used: Placement | undefined;
    if (isOrderedTable(table)) {
      used = this.createPlacement(table, placement, row.scene_id as string | null | undefined);
      row.order_key = this.orderKey(table, used);
    }
    this.checkRowSize(table, row);
    if (table === "notes" && row.status === DONE_STATUS) {
      row.completed_at = this.now;
      row.completed_by = this.ctx.userId;
    }

    const cols = Object.keys(row);
    this.sql.exec(
      `INSERT INTO ${q(table)} (${cols.map(q).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
      ...cols.map((c) => encodeValue(c === "custom" ? undefined : fieldSpec(table, c), row[c])),
    );
    this.log(table, id, "*", undefined, row);
    const { id: _id, ...rest } = row;
    this.resolved.push({
      op: "create",
      table,
      id,
      fields: rest,
      ...(used ? { placement: used } : {}),
    });
  }

  /** The placement a create really gets (neighbours may have been deleted meanwhile). */
  private createPlacement(
    table: TableName,
    placement: Placement,
    sceneId: string | null | undefined,
  ): Placement {
    const { after, before } = placement;
    if ((after === undefined || after === null) && (before === undefined || before === null)) {
      return placement; // start or end: nothing to look up
    }
    const hasScene = "scene_id" in FIELDS[table];
    const rows = this.sql
      .exec<{ id: string; order_key: string; scene_id: string | null }>(
        `SELECT id, order_key, ${hasScene ? "scene_id" : "NULL AS scene_id"} FROM ${q(table)} ORDER BY order_key, id`,
      )
      .toArray();
    return effectivePlacement(rows, placement, hasScene ? (sceneId ?? null) : undefined);
  }

  private checkRowSize(table: TableName, row: WireRow): void {
    if (byteLength(row) > MAX_ROW_BYTES) {
      this.fail(`${table} row would exceed ${MAX_ROW_BYTES / 1024} KiB`);
    }
  }

  /** Apply already-validated changes to one row; logs and emits a resolved op. */
  private write(
    table: TableName,
    id: string,
    before: DbRow,
    changes: WireRow,
    kind: "update" | "move" = "update",
  ) {
    const old = decodeRow(table, before);
    const changed: WireRow = {};
    for (const [k, v] of Object.entries(changes)) {
      if (!sameValue(old[k], v)) changed[k] = v;
    }
    if (Object.keys(changed).length === 0) return;
    if (table === "notes" && "status" in changed) {
      const wasDone = old.status === DONE_STATUS;
      const isDone = changed.status === DONE_STATUS;
      if (isDone && !wasDone) {
        changed.completed_at = this.now;
        changed.completed_by = this.ctx.userId;
      } else if (!isDone && wasDone) {
        changed.completed_at = null;
        changed.completed_by = null;
      }
    }
    for (const [k, v] of Object.entries(changed)) {
      if (k === "custom") {
        const o = (old.custom ?? {}) as Record<string, unknown>;
        const n = v as Record<string, unknown>;
        for (const key of new Set([...Object.keys(o), ...Object.keys(n)])) {
          if (!sameValue(o[key], n[key])) this.log(table, id, `custom.${key}`, o[key], n[key]);
        }
      } else {
        this.log(table, id, k, old[k], v);
      }
    }
    changed.updated_at = this.now;
    changed.updated_by = this.ctx.userId;
    this.checkRowSize(table, { ...old, ...changed });
    const cols = Object.keys(changed);
    this.sql.exec(
      `UPDATE ${q(table)} SET ${cols.map((c) => `${q(c)} = ?`).join(", ")} WHERE id = ?`,
      ...cols.map((c) => encodeValue(c === "custom" ? undefined : fieldSpec(table, c), changed[c])),
      id,
    );
    this.resolved.push({ op: kind, table, id, fields: changed });
  }

  private update(table: TableName, id: string, fields: FieldValues) {
    const before = this.mustGet(table, id);
    this.checkRole(table, before);
    const changes: WireRow = {};
    for (const [name, value] of Object.entries(fields)) {
      if (name === "custom") {
        const patch = this.validateCustom(value);
        const merged = { ...parseJson<Record<string, unknown>>(before.custom, {}) };
        for (const [k, v] of Object.entries(patch)) {
          if (v === null) delete merged[k];
          else merged[k] = v;
        }
        changes.custom = merged;
      } else {
        const spec = fieldSpec(table, name);
        if (!spec) this.fail(`unknown field ${table}.${name}`);
        changes[name] = this.validate(table, name, spec, value);
      }
    }
    this.write(table, id, before, changes);
  }

  private move(table: TableName, id: string, placement: Placement) {
    const before = this.mustGet(table, id);
    this.checkRole(table, before);
    if (placement.after === id || placement.before === id)
      this.fail("can't move a row next to itself");
    const order_key = this.orderKey(table, placement, id);
    this.write(table, id, before, { order_key }, "move");
  }

  private delete(op: DeleteOp) {
    const { table, id } = op;
    const before = this.mustGet(table, id);
    this.checkRole(table, before);
    // Cascade, as explicit ops so history and clients see every change.
    for (const spec of Object.values(LINKS) as LinkSpec[]) {
      if (spec.from === table) {
        const rows = this.sql
          .exec<{ t: string }>(
            `SELECT ${q(spec.toCol)} AS t FROM ${q(spec.join)} WHERE ${q(spec.fromCol)} = ? ORDER BY position DESC`,
            id,
          )
          .toArray();
        for (const r of rows) this.removeLink(spec, table, id, linkField(spec), r.t);
      }
      if (spec.to === table) {
        const rows = this.sql
          .exec<{ f: string }>(
            `SELECT ${q(spec.fromCol)} AS f FROM ${q(spec.join)} WHERE ${q(spec.toCol)} = ?`,
            id,
          )
          .toArray();
        for (const r of rows) this.removeLink(spec, spec.from, r.f, linkField(spec), id);
      }
    }
    for (const other of TABLE_NAMES) {
      for (const [name, spec] of Object.entries(FIELDS[other]) as [string, FieldSpec][]) {
        if (spec.type !== "ref" || spec.ref !== table) continue;
        const refs = this.sql
          .exec<DbRow>(`SELECT * FROM ${q(other)} WHERE ${q(name)} = ?`, id)
          .toArray();
        for (const r of refs) this.write(other, r.id as string, r, { [name]: null });
      }
    }
    this.sql.exec(`DELETE FROM ${q(table)} WHERE id = ?`, id);
    this.log(table, id, "*", decodeRow(table, before), undefined);
    this.resolved.push({ op: "delete", table, id });
  }

  private link(table: TableName, id: string, field: string, targetId: string, position?: number) {
    const spec = linkSpec(table, field);
    if (!spec) this.fail(`${table}.${field} is not a link field`);
    this.checkRole(table, this.mustGet(table, id));
    if (!this.getRow(spec.to, targetId)) this.fail(`${spec.to} ${targetId} not found`);
    const join = q(spec.join);
    const from = q(spec.fromCol);
    const to = q(spec.toCol);
    const exists = this.sql
      .exec(`SELECT 1 FROM ${join} WHERE ${from} = ? AND ${to} = ?`, id, targetId)
      .toArray();
    if (exists.length > 0) return; // already linked: no-op
    const { n } = this.sql
      .exec<{ n: number }>(`SELECT count(*) AS n FROM ${join} WHERE ${from} = ?`, id)
      .one();
    const pos = position === undefined ? n : Math.min(position, n);
    this.sql.exec(
      `UPDATE ${join} SET position = position + 1 WHERE ${from} = ? AND position >= ?`,
      id,
      pos,
    );
    this.sql.exec(
      `INSERT INTO ${join} (${from}, ${to}, position) VALUES (?, ?, ?)`,
      id,
      targetId,
      pos,
    );
    this.log(table, id, field, undefined, targetId);
    this.resolved.push({ op: "link", table, id, field, targetId, position: pos });
  }

  private unlink(op: UnlinkOp) {
    const spec = linkSpec(op.table, op.field);
    if (!spec) this.fail(`${op.table}.${op.field} is not a link field`);
    this.checkRole(op.table, this.mustGet(op.table, op.id));
    this.removeLink(spec, op.table, op.id, op.field, op.targetId);
  }

  private removeLink(
    spec: LinkSpec,
    table: TableName,
    id: string,
    field: string,
    targetId: string,
  ) {
    const join = q(spec.join);
    const from = q(spec.fromCol);
    const to = q(spec.toCol);
    const row = this.sql
      .exec<{ position: number }>(
        `SELECT position FROM ${join} WHERE ${from} = ? AND ${to} = ?`,
        id,
        targetId,
      )
      .toArray()[0];
    if (!row) return; // not linked: no-op
    this.sql.exec(`DELETE FROM ${join} WHERE ${from} = ? AND ${to} = ?`, id, targetId);
    this.sql.exec(
      `UPDATE ${join} SET position = position - 1 WHERE ${from} = ? AND position > ?`,
      id,
      row.position,
    );
    this.log(table, id, field, targetId, undefined);
    this.resolved.push({ op: "unlink", table, id, field, targetId });
  }
}

/** The link field name (e.g. "assignees") for a spec. */
function linkField(spec: LinkSpec): string {
  for (const [name, s] of Object.entries(LINKS)) {
    if (s === spec) return name.slice(name.indexOf(".") + 1);
  }
  return "";
}

// ---- reads for the snapshot / history endpoints ----

export function readSnapshot(sql: SqlStorage): SnapshotResponse {
  const tables = {} as Record<TableName, WireRow[]>;
  for (const table of TABLE_NAMES) {
    const orderBy = isOrderedTable(table) ? "order_key, id" : "created_at, id";
    tables[table] = sql
      .exec<DbRow>(`SELECT * FROM ${q(table)} ORDER BY ${orderBy}`)
      .toArray()
      .map((r) => decodeRow(table, r));
  }
  const joins = {} as Joins;
  for (const spec of Object.values(LINKS) as LinkSpec[]) {
    const map: Record<string, string[]> = {};
    const rows = sql
      .exec<{ f: string; t: string }>(
        `SELECT ${q(spec.fromCol)} AS f, ${q(spec.toCol)} AS t FROM ${q(spec.join)} ORDER BY f, position`,
      )
      .toArray();
    for (const r of rows) {
      const list = map[r.f] ?? [];
      list.push(r.t);
      map[r.f] = list;
    }
    joins[spec.key] = map;
  }
  return {
    version: currentVersion(sql),
    tables: tables as unknown as SnapshotResponse["tables"],
    joins,
    fieldOptions: loadFieldOptions(sql),
  };
}

export interface HistoryQuery {
  table?: string;
  id?: string;
  limit?: number;
}

/** Newest first. `userName` is filled in by the Worker (D1). */
export function readHistory(sql: SqlStorage, query: HistoryQuery): HistoryEntry[] {
  const where: string[] = [];
  const args: SqlStorageValue[] = [];
  if (query.table) {
    where.push('"table" = ?');
    args.push(query.table);
  }
  if (query.id) {
    where.push("record_id = ?");
    args.push(query.id);
  }
  const limit = Math.max(1, Math.min(query.limit ?? 100, 1000));
  return sql
    .exec<{
      version: number;
      ts: number;
      user_id: string;
      table: string;
      record_id: string;
      field: string;
      old: string | null;
      new: string | null;
      client_id: string | null;
    }>(
      `SELECT * FROM changes ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY version DESC LIMIT ?`,
      ...args,
      limit,
    )
    .toArray()
    .map((r) => ({
      version: r.version,
      ts: r.ts,
      userId: r.user_id,
      userName: null,
      table: r.table as TableName,
      recordId: r.record_id,
      field: r.field,
      old: r.old,
      new: r.new,
      clientId: r.client_id,
    }));
}
