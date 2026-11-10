// Moving a show between instances (docs/deploy.md, "Moving a show between instances").
//
// Types of the admin-only transfer API (`src/worker/routes/transfer.ts`) and the pure
// helpers the CLI (`scripts/migrate-show.ts`) and the tests share. No imports: the CLI
// runs this file under plain Node.

export const TRANSFER_FORMAT = "cuesheet-show-transfer";
export const TRANSFER_VERSION = 1;

/** Key of the import marker in the show's Durable Object storage. */
export const TRANSFER_STATE_KEY = "transfer:state";

/** Column a dumped row carries its SQLite rowid in (restored as the same rowid). */
export const ROWID = "__rowid";

/** Largest rows request body the target accepts (POST …/transfer/rows). */
export const MAX_TRANSFER_BODY_BYTES = 16 * 1024 * 1024;
/** Largest single file the target accepts (PUT …/transfer/file); Workers allow 100 MB. */
export const MAX_TRANSFER_FILE_BYTES = 95 * 1024 * 1024;

export type TransferValue = string | number | null;
export type TransferRow = Record<string, TransferValue>;

/**
 * A show id's import marker on the target: `importing` from begin until finish
 * succeeds, then `imported` with the Durable Object version it ended at (an overwrite is
 * refused once the show has been edited past it).
 */
export interface TransferState {
  state: "importing" | "imported";
  at: number;
  version?: number;
}

export interface TransferTableInfo {
  name: string;
  columns: string[];
  rows: number;
}

/** What the Durable Object reports (`ShowDO.transferInfo`). */
export interface TransferDoInfo {
  /** `__drizzle_migrations` hashes, in order: both sides must run the same schema. */
  migrations: string[];
  tables: TransferTableInfo[];
  /** `sqlite_sequence` (AUTOINCREMENT counters, e.g. `changes`). */
  sequences: Record<string, number>;
  version: number;
  hasMeta: boolean;
  hasData: boolean;
  transfer: TransferState | null;
  alarm: number | null;
}

/** GET /api/admin/shows/:id/transfer. D1 rows are raw (snake_case columns). */
export interface TransferManifest {
  format: typeof TRANSFER_FORMAT;
  version: number;
  showId: string;
  d1: {
    show: Record<string, TransferValue> | null;
    memberships: Record<string, TransferValue>[];
    /** Raw rows, token hashes included (admin-only route). */
    shareLinks: Record<string, TransferValue>[];
  };
  do: TransferDoInfo;
}

export interface TransferFile {
  key: string;
  size: number;
  httpMetadata: Record<string, string>;
  customMetadata: Record<string, string>;
}

export interface TransferBeginRequest {
  migrations: string[];
  overwrite?: boolean;
}

export interface TransferRowsRequest {
  table: string;
  rows: TransferRow[];
}

export interface TransferFinishRequest {
  /** Rows per table the target must end up with (else the finish is refused). */
  counts: Record<string, number>;
  sequences: Record<string, number>;
  show: Record<string, TransferValue>;
  memberships: Record<string, TransferValue>[];
  shareLinks: Record<string, TransferValue>[];
}

export interface TransferFinishResponse {
  ok: true;
  version: number;
  /** Memberships / share links dropped because their user doesn't exist on the target. */
  skipped: { memberships: string[]; shareLinks: string[] };
}

/** Header carrying a file's expected SHA-256 (hex) on PUT …/transfer/file. */
export const SHA256_HEADER = "X-Transfer-Sha256";
/** Header carrying a file's R2 metadata (JSON `{httpMetadata, customMetadata}`). */
export const R2_METADATA_HEADER = "X-Transfer-R2-Metadata";

// ---- pure helpers ----

/**
 * Replace every occurrence of each id in `text` (a JSON document). Ids are UUIDs, which
 * never need escaping in JSON and never occur inside other values by accident, so a plain
 * replace also reaches ids nested inside JSON-in-a-string columns (`custom`, view
 * configs, history old/new values).
 */
export function remapIds(text: string, map: ReadonlyMap<string, string>): string {
  let out = text;
  for (const [from, to] of map) {
    if (from === to) continue;
    if (from.length < 16) throw new Error(`refusing to remap a short id: ${from}`);
    out = out.split(from).join(to);
  }
  return out;
}

/** JSON with object keys sorted at every level (stable for hashing). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/** Split rows into consecutive chunks whose JSON stays under `maxBytes` (≥ 1 row each). */
export function chunkRows<T>(rows: T[], maxBytes: number): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let size = 2;
  const enc = new TextEncoder();
  for (const row of rows) {
    const n = enc.encode(JSON.stringify(row)).byteLength + 1;
    if (current.length > 0 && size + n > maxBytes) {
      chunks.push(current);
      current = [];
      size = 2;
    }
    current.push(row);
    size += n;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

const ROLE_RANK: Record<string, number> = { viewer: 0, commenter: 1, editor: 2, owner: 3 };

/**
 * Source memberships with user ids mapped. Several source users can map to one target
 * user (everyone unmatched becomes the importing admin): they get the highest role and
 * the earliest `created_at`.
 */
export function mapMemberships(
  rows: Record<string, TransferValue>[],
  map: ReadonlyMap<string, string>,
): Record<string, TransferValue>[] {
  const byUser = new Map<string, Record<string, TransferValue>>();
  for (const row of rows) {
    const userId = String(row.user_id);
    const mapped = map.get(userId) ?? userId;
    const next: Record<string, TransferValue> = { ...row, user_id: mapped };
    const seen = byUser.get(mapped);
    if (!seen) {
      byUser.set(mapped, next);
      continue;
    }
    const rank = (r: Record<string, TransferValue>) => ROLE_RANK[String(r.role)] ?? -1;
    byUser.set(mapped, {
      ...seen,
      role: (rank(next) > rank(seen) ? next.role : seen.role) ?? null,
      created_at: Math.min(Number(seen.created_at), Number(next.created_at)),
    });
  }
  return [...byUser.values()].sort((a, b) => String(a.user_id).localeCompare(String(b.user_id)));
}

/** The ids of `users` that occur anywhere in `text`. */
export function referencedIds(text: string, ids: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const id of ids) if (text.includes(id)) out.add(id);
  return out;
}

export interface TableDigest {
  rows: number;
  sha256: string;
}

/** Differences between two sets of per-table digests (empty when they match). */
export function diffDigests(
  source: Record<string, TableDigest>,
  target: Record<string, TableDigest>,
): string[] {
  const out: string[] = [];
  for (const name of [...new Set([...Object.keys(source), ...Object.keys(target)])].sort()) {
    const s = source[name];
    const t = target[name];
    if (!s) out.push(`table ${name}: only on the target`);
    else if (!t) out.push(`table ${name}: missing on the target`);
    else if (s.rows !== t.rows)
      out.push(`table ${name}: ${s.rows} rows on source, ${t.rows} on target`);
    else if (s.sha256 !== t.sha256) out.push(`table ${name}: same row count, different content`);
  }
  return out;
}
