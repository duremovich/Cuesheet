// The mutation model: every write to show data is a batch of ops sent to
// POST /api/shows/:id/mutate, applied by the ShowDO in one transaction, and broadcast to
// every connected socket as the *resolved* ops. See docs/decisions/0006-mutation-ops-and-sync.md.
import type {
  AnyRow,
  FieldOptions,
  LinkName,
  OrderedTableName,
  Row,
  RowTypes,
  TableName,
} from "./tables";
import type { Unit } from "./units";

/** Values for a create/update. Keys are field names; `custom` is merged key by key. */
export type FieldValues = Record<string, unknown>;

/**
 * Position for create/move on ordered tables:
 * - `after: id` → right after that row; `after: null` → at the start;
 * - `before: id` → right before that row;
 * - neither → at the end.
 */
export interface Placement {
  after?: string | null;
  before?: string | null;
}

export interface CreateOp extends Placement {
  op: "create";
  table: TableName;
  /** Client-generated id (see `newId()` in ./ids.ts). */
  id: string;
  fields: FieldValues;
}

export interface UpdateOp {
  op: "update";
  table: TableName;
  id: string;
  fields: FieldValues;
}

export interface DeleteOp {
  op: "delete";
  table: TableName;
  id: string;
}

export interface MoveOp extends Placement {
  op: "move";
  table: OrderedTableName;
  id: string;
}

/** Many-to-many: `table.field` is one of LINKS (cues.content, notes.cues, scenes.surfaces, …). */
export interface LinkOp {
  op: "link";
  table: TableName;
  id: string;
  field: string;
  targetId: string;
  /** 0-based chip position; omitted → append. */
  position?: number;
}

export interface UnlinkOp {
  op: "unlink";
  table: TableName;
  id: string;
  field: string;
  targetId: string;
}

/**
 * Show-level settings kept in the ShowDO `meta` row (not a table): `default_unit`, the
 * display unit for measurements when neither the view nor the user picks one (a Unit from
 * ./units.ts, or null for meters). Editors and owners. Resolves to itself.
 */
export interface MetaOp {
  op: "meta";
  fields: MetaFields;
}

export interface MetaFields {
  default_unit?: Unit | null;
}

/** The `meta` part of the snapshot. */
export interface ShowSettings {
  default_unit: Unit | null;
}

/** An op on a table row. */
export type Op = CreateOp | UpdateOp | DeleteOp | MoveOp | LinkOp | UnlinkOp;

/** Anything a batch may hold: row ops and the show-level `meta` op. */
export type AnyOp = Op | MetaOp;

// ---- Resolved ops (what the server applied; what clients replay) ----

/** `fields` is the complete stored row minus `id` (order_key, timestamps, custom all filled). */
export interface ResolvedCreate {
  op: "create";
  table: TableName;
  id: string;
  fields: FieldValues;
  /**
   * Ordered tables: the placement actually used, which differs from the request when a
   * neighbour had been deleted (see `effectivePlacement` in ./order.ts).
   */
  placement?: Placement;
}

/**
 * Changed fields only, including `updated_at`/`updated_by`, server-set fields (e.g.
 * `completed_at`) and the full merged `custom` object when custom changed. A move resolves
 * to an update of `order_key` (op stays "move" so consumers can tell).
 */
export interface ResolvedUpdate {
  op: "update" | "move";
  table: TableName;
  id: string;
  fields: FieldValues;
}

export interface ResolvedLink {
  op: "link";
  table: TableName;
  id: string;
  field: string;
  targetId: string;
  position: number;
}

/**
 * Resolved ops for a delete include its cascade, expanded as explicit ops before the
 * delete itself: unlinks of join rows and updates that null references to the row.
 */
export type ResolvedOp = ResolvedCreate | ResolvedUpdate | DeleteOp | ResolvedLink | UnlinkOp;

/** What a batch resolves to: row ops and `meta` ops (which resolve to themselves). */
export type AnyResolvedOp = ResolvedOp | MetaOp;

export function isMetaOp(op: { op: string }): op is MetaOp {
  return op.op === "meta";
}

// ---- HTTP ----

export interface MutateRequest {
  /** Identifies the sending store instance so it can recognise its own echoes. */
  clientId: string;
  ops: AnyOp[];
}

export interface MutateResponse {
  /** Version before this batch; equals `version` when the batch changed nothing. */
  prevVersion: number;
  version: number;
  ops: AnyResolvedOp[];
}

export interface MutateError {
  error: string;
  /** Index into the request's ops of the op that failed (absent for whole-batch errors). */
  opIndex?: number;
}

export type Joins = {
  cueContent: Record<string, string[]>;
  cueAssignees: Record<string, string[]>;
  noteCues: Record<string, string[]>;
  noteAssignees: Record<string, string[]>;
  sceneSurfaces: Record<string, string[]>;
  contentSurfaces: Record<string, string[]>;
};

export interface SnapshotResponse {
  version: number;
  /** Ordered tables come sorted by order_key (ties by id); others by created_at, id. */
  tables: { [T in TableName]: RowTypes[T][] };
  /** From-id → target ids, in chip order. */
  joins: Joins;
  fieldOptions: FieldOptions;
  /** Show-level settings from the DO `meta` row. */
  meta: ShowSettings;
}

export interface HistoryEntry {
  version: number;
  ts: number;
  userId: string;
  /** Resolved from D1; null if the user no longer exists. */
  userName: string | null;
  table: TableName;
  recordId: string;
  /** Field name, `custom.<key>` for custom fields, a link field name, or `*` for create/delete. */
  field: string;
  /** JSON-encoded values (null = absent). */
  old: string | null;
  new: string | null;
  clientId: string | null;
}

export interface HistoryResponse {
  changes: HistoryEntry[];
}

export interface ImportResponse {
  created: {
    scenes: number;
    cues: number;
    content: number;
    notes: number;
    persons: number;
    surfaces: number;
  };
  warnings: string[];
}

export type { AnyRow, LinkName, Row };
