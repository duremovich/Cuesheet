// Applies batches of ops to a show's SQLite (see src/shared/ops.ts and
// docs/decisions/0006-mutation-ops-and-sync.md). Runs synchronously inside
// `ctx.storage.transactionSync`, so any thrown OpError rolls the whole batch back.
import type { Role } from "../../shared/api";
import { isValidId, newId } from "../../shared/ids";
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
  ATTACHMENT_FIELDS,
  DATA_TABLES,
  type DataTableName,
  FIELDS,
  type FieldOptions,
  type FieldSpec,
  fieldSpec,
  isAttachmentField,
  isDataTable,
  isOrderedTable,
  isTableName,
  LINKS,
  type LinkSpec,
  linkSpec,
  TABLE_NAMES,
  type TableName,
} from "../../shared/tables";
import {
  DEFAULT_VIEW_NAMES,
  defaultViewConfig,
  MAX_PERSONAL_VIEWS,
  sanitizeViewConfig,
  viewConfigError,
} from "../../shared/views";

export interface MutationContext {
  userId: string;
  role: Role;
  /** The sending store's id (echoed in the broadcast); null for server-side batches. */
  clientId: string | null;
  /** Import only: accept `created_at` in create fields. */
  allowCreatedAt?: boolean;
  /**
   * The upload route only: may create `attachments` rows (with their server-set fields).
   * Clients can't; they upload (see routes/attachments.ts).
   */
  upload?: boolean;
}

/** An attachment row this batch deleted: its R2 objects go after commit (best effort). */
export interface FreedFile {
  id: string;
  r2_key: string;
  size: number;
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
    else if (spec.type === "json") out[name] = parseJson(row[name], null);
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
  if (spec?.type === "multiselect" || spec?.type === "json" || typeof value === "object") {
    return JSON.stringify(value);
  }
  return value as SqlStorageValue;
}

function defaultValue(spec: FieldSpec): unknown {
  if (spec.type === "bool") return false;
  if (spec.type === "multiselect") return [];
  if (spec.type === "json") return {};
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
  /**
   * Personal views this batch touched → their owner. Ops on them are private: the ShowDO
   * sends them only to that owner's sockets.
   */
  readonly viewOwners = new Map<string, string>();
  /** Attachments deleted by this batch (directly or by cascade). */
  readonly freed: FreedFile[] = [];
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
    // Roles are checked per op (checkRole): viewers may still manage their own views.
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

  /**
   * Commenters may only touch notes they created. Views: anyone (viewers too) may manage
   * their own personal views; only editors/owners shared ones; nobody someone else's.
   * `created` holds a create's requested fields (a view's owner_user_id). Attachments follow
   * their record: editors any; commenters only on notes they created.
   */
  private checkRole(table: TableName, existing: DbRow | null, created?: FieldValues): void {
    const { role, userId } = this.ctx;
    if (table === "attachments") {
      if (role === "owner" || role === "editor") return;
      const parentTable = existing ? existing.table : created?.table;
      const parentId = existing ? existing.record_id : created?.record_id;
      if (role === "commenter" && parentTable === "notes" && typeof parentId === "string") {
        if (this.getRow("notes", parentId)?.created_by === userId) return;
        this.fail("Commenters can only attach files to their own notes", 403);
      }
    }
    if (table === "views") {
      const viewOwner = existing ? existing.owner_user_id : (created?.owner_user_id ?? null);
      if (viewOwner === userId) return;
      if (viewOwner !== null) this.fail("That view belongs to someone else", 403);
      if (role === "owner" || role === "editor") return;
      this.fail("Only editors can change shared views", 403);
    }
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
  private validate(
    table: TableName,
    field: string,
    spec: FieldSpec,
    value: unknown,
    allowAuto = false,
  ): unknown {
    const label = `${table}.${field}`;
    if (spec.auto && !allowAuto) this.fail(`${label} is set automatically`);
    if ((spec.type === "select" || spec.type === "ref") && value === "") value = null;
    if (table === "views") this.validateViewField(field, value);
    if (value === null) {
      if (spec.type === "bool") this.fail(`${label} must be true or false`);
      if (spec.type === "json") this.fail(`${label} can't be empty`);
      return spec.type === "multiselect" ? [] : null;
    }
    switch (spec.type) {
      case "json":
        if (byteLength(value) > MAX_TEXT) this.fail(`${label} is too large`);
        return value;
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

  /** Extra checks for `views` fields (beyond their FieldSpec type). */
  private validateViewField(field: string, value: unknown): void {
    switch (field) {
      case "table":
        if (!isDataTable(value)) this.fail(`views.table must be one of ${DATA_TABLES.join(", ")}`);
        break;
      case "name":
        if (typeof value === "string" && value.length > 100) this.fail("views.name is too long");
        break;
      case "owner_user_id":
        // Only yourself (a personal view) or null (shared); checkRole does the role part.
        if (value !== null && value !== this.ctx.userId) {
          this.fail("A personal view must belong to you", 403);
        }
        break;
      case "config": {
        // Structure here; the table-aware check (sanitizeConfig) runs once the table is known.
        const error = viewConfigError(value);
        if (error) this.fail(`views.${error}`);
        break;
      }
    }
  }

  /** The config rebuilt from known keys, or a 400 naming what's wrong (`sanitizeViewConfig`). */
  private sanitizeConfig(table: DataTableName, value: unknown): unknown {
    const r = sanitizeViewConfig(table, value);
    if ("error" in r) this.fail(`views.${r.error}`);
    return r.config;
  }

  /** At most MAX_PERSONAL_VIEWS personal views per user and table. */
  private checkPersonalCap(table: string, owner: string): void {
    const { n } = this.sql
      .exec<{ n: number }>(
        'SELECT count(*) AS n FROM views WHERE "table" = ? AND owner_user_id = ?',
        table,
        owner,
      )
      .one();
    if (n >= MAX_PERSONAL_VIEWS) {
      this.fail(`At most ${MAX_PERSONAL_VIEWS} personal views per table`);
    }
  }

  private noteViewOwner(table: TableName, id: string, row: DbRow): void {
    if (table === "views" && typeof row.owner_user_id === "string") {
      this.viewOwners.set(id, row.owner_user_id);
    }
  }

  /** Setting `is_default` on a shared view clears it on the table's other shared views. */
  private afterViewWrite(id: string): void {
    const row = this.getRow("views", id);
    if (row?.is_default !== 1) return;
    if (row.owner_user_id !== null) this.fail("Only a shared view can be the default");
    const others = this.sql
      .exec<DbRow>(
        'SELECT * FROM views WHERE "table" = ? AND owner_user_id IS NULL AND is_default = 1 AND id != ?',
        row.table,
        id,
      )
      .toArray();
    for (const o of others) this.write("views", o.id as string, o, { is_default: false });
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
    this.checkRole(table, null, fields);
    if (table === "attachments" && !this.ctx.upload) {
      this.fail("Files are attached by uploading them", 403);
    }
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
        row[name] = this.validate(table, name, spec, value, table === "attachments");
      }
    }
    if (table === "attachments") this.prepareAttachment(row);
    if (table === "content_versions") this.prepareVersion(row);
    if (table === "views") {
      if (!isDataTable(row.table)) this.fail("views.table is required");
      row.config =
        "config" in fields
          ? this.sanitizeConfig(row.table, row.config)
          : defaultViewConfig(row.table);
      if (typeof row.owner_user_id === "string")
        this.checkPersonalCap(row.table, row.owner_user_id);
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
    if (table === "views") {
      if (typeof row.owner_user_id === "string") this.viewOwners.set(id, row.owner_user_id);
      this.afterViewWrite(id);
    }
    if (table === "content_versions") this.afterVersionWrite(id);
  }

  /** A new attachment: its record must exist and have that attachment field. */
  private prepareAttachment(row: WireRow): void {
    const { table, field, record_id } = row;
    if (
      typeof table !== "string" ||
      typeof field !== "string" ||
      !isAttachmentField(table, field)
    ) {
      this.fail(`${String(table)}.${String(field)} is not an attachment field`);
    }
    if (typeof record_id !== "string" || !this.getRow(table as TableName, record_id)) {
      this.fail(`${table} ${String(record_id)} not found`);
    }
    for (const k of ["filename", "content_type", "size", "r2_key"]) {
      if (row[k] === null || row[k] === undefined) this.fail(`attachments.${k} is required`);
    }
    if (row.position === null) {
      const { p } = this.sql
        .exec<{ p: number | null }>(
          'SELECT max(position) AS p FROM attachments WHERE "table" = ? AND record_id = ? AND field = ?',
          table,
          record_id,
          field,
        )
        .one();
      row.position = (p ?? 0) + 1;
    }
  }

  /** A new version: after the content's others; current when the content has none yet. */
  private prepareVersion(row: WireRow): void {
    const contentId = row.content_id;
    if (typeof contentId !== "string") this.fail("content_versions.content_id is required");
    const { p, current } = this.sql
      .exec<{ p: number | null; current: number }>(
        "SELECT max(position) AS p, coalesce(max(is_current), 0) AS current FROM content_versions WHERE content_id = ?",
        contentId,
      )
      .one();
    if (row.position === null) row.position = (p ?? 0) + 1;
    if (!current) row.is_current = true;
  }

  /** Setting `is_current` on a version clears it on the content's other versions. */
  private afterVersionWrite(id: string): void {
    const row = this.getRow("content_versions", id);
    if (row?.is_current !== 1) return;
    const others = this.sql
      .exec<DbRow>(
        "SELECT * FROM content_versions WHERE content_id = ? AND is_current = 1 AND id != ?",
        row.content_id,
        id,
      )
      .toArray();
    for (const o of others)
      this.write("content_versions", o.id as string, o, { is_current: false });
  }

  /** The current version was deleted: the newest remaining one becomes current. */
  private afterVersionDelete(before: DbRow): void {
    if (before.is_current !== 1) return;
    const next = this.sql
      .exec<DbRow>(
        "SELECT * FROM content_versions WHERE content_id = ? ORDER BY position DESC, created_at DESC, id DESC LIMIT 1",
        before.content_id,
      )
      .toArray()[0];
    if (next) this.write("content_versions", next.id as string, next, { is_current: true });
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
    this.noteViewOwner(table, id, before);
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
        if (spec.immutable && !sameValue(decodeRow(table, before)[name], value)) {
          this.fail(`${table}.${name} can't be changed`);
        }
        changes[name] = this.validate(table, name, spec, value);
      }
    }
    if (table === "views" && "config" in changes) {
      changes.config = this.sanitizeConfig(before.table as DataTableName, changes.config);
    }
    this.write(table, id, before, changes);
    if (table === "views") this.afterViewWrite(id);
    if (table === "content_versions") this.afterVersionWrite(id);
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
    this.noteViewOwner(table, id, before);
    this.checkRole(table, before);
    this.remove(table, id, before);
    if (table === "content_versions") this.afterVersionDelete(before);
  }

  /**
   * Delete a row and what depends on it: its links, rows referencing it through a
   * `cascade` ref (a content's versions) and its attachments are deleted; other references
   * to it are cleared. Roles are checked on the row the client named; dependents go with it.
   */
  private remove(table: TableName, id: string, before: DbRow) {
    if (table === "views" && before.owner_user_id === null) {
      const { n } = this.sql
        .exec<{ n: number }>(
          'SELECT count(*) AS n FROM views WHERE "table" = ? AND owner_user_id IS NULL',
          before.table,
        )
        .one();
      if (n <= 1) this.fail("A table needs at least one shared view");
    }
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
        for (const r of refs) {
          if (spec.cascade) this.remove(other, r.id as string, r);
          else this.write(other, r.id as string, r, { [name]: null });
        }
      }
    }
    if (ATTACHMENT_FIELDS[table]) {
      const files = this.sql
        .exec<DbRow>(
          'SELECT * FROM attachments WHERE "table" = ? AND record_id = ? ORDER BY position, id',
          table,
          id,
        )
        .toArray();
      for (const f of files) this.remove("attachments", f.id as string, f);
    }
    if (table === "attachments") {
      this.freed.push({ id, r2_key: String(before.r2_key), size: Number(before.size) || 0 });
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

/** `created_by` of rows the DO writes on its own (the seeded default views). */
export const SYSTEM_USER = "system";

/**
 * Gives every data table without a shared view one shared default view (the built-in
 * config from `defaultViewConfig`). Runs when the DO starts, so shows created before views
 * existed get them on first open. Not logged in `changes` and doesn't bump the version: it
 * is the table's initial state, like the seeded select options. Returns how many it made.
 */
export function seedDefaultViews(sql: SqlStorage, now = Date.now()): number {
  let made = 0;
  for (const table of DATA_TABLES) {
    const has = sql
      .exec('SELECT 1 FROM views WHERE "table" = ? AND owner_user_id IS NULL LIMIT 1', table)
      .toArray();
    if (has.length > 0) continue;
    sql.exec(
      'INSERT INTO views (id, custom, created_at, created_by, updated_at, updated_by, "table", name, owner_user_id, is_default, position, config) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, 0, ?)',
      newId(),
      "{}",
      now,
      SYSTEM_USER,
      now,
      SYSTEM_USER,
      table,
      DEFAULT_VIEW_NAMES[table],
      JSON.stringify(defaultViewConfig(table)),
    );
    made++;
  }
  return made;
}

// ---- reads for the snapshot / history endpoints ----

/**
 * The whole show. With `userId`, `views` holds the shared views and that user's own
 * personal ones only (personal views are private); without it (internal use), all views.
 */
export function readSnapshot(sql: SqlStorage, userId?: string): SnapshotResponse {
  const tables = {} as Record<TableName, WireRow[]>;
  for (const table of TABLE_NAMES) {
    const orderBy = isOrderedTable(table) ? "order_key, id" : "created_at, id";
    const rows =
      table === "views" && userId !== undefined
        ? sql.exec<DbRow>(
            `SELECT * FROM views WHERE owner_user_id IS NULL OR owner_user_id = ? ORDER BY ${orderBy}`,
            userId,
          )
        : sql.exec<DbRow>(`SELECT * FROM ${q(table)} ORDER BY ${orderBy}`);
    tables[table] = rows.toArray().map((r) => decodeRow(table, r));
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
export function readHistory(sql: SqlStorage, query: HistoryQuery, userId?: string): HistoryEntry[] {
  const where: string[] = [];
  const args: SqlStorageValue[] = [];
  if (userId !== undefined) {
    // Personal views are private: only shared views' and your own views' history.
    where.push(
      `NOT ("table" = 'views' AND record_id NOT IN (SELECT id FROM views WHERE owner_user_id IS NULL OR owner_user_id = ?))`,
    );
    args.push(userId);
  }
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
