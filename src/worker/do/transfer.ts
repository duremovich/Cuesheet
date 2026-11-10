// The Durable Object side of moving a show between instances (routes/transfer.ts,
// docs/deploy.md "Moving a show between instances"). Raw SQL, below the op engine: every
// table's rows are copied as they are stored (rowids included), history and all.
//
// Import: `beginStaging` makes an empty staging table, `stageRows` appends to it (one
// request per chunk), `applyStaged` swaps the show's tables for the staged rows in one
// transaction with foreign keys deferred. Until then the show's data is untouched.
import {
  ROWID,
  type TransferDoInfo,
  type TransferRow,
  type TransferTableInfo,
  type TransferValue,
} from "../../shared/show-transfer";

/** A refused transfer step; the ShowDO returns it as a value (status + message). */
export class TransferError extends Error {
  constructor(
    readonly status: 400 | 409,
    message: string,
  ) {
    super(message);
  }
}

const STAGING = "_transfer_staging";
const MIGRATIONS = "__drizzle_migrations";
/** One staged row's JSON must fit in a SQLite value (2 MB in a Durable Object). */
const MAX_STAGED_ROW_BYTES = 2_000_000;

/** The show's own tables: not SQLite's, Cloudflare's (`_cf_*`), drizzle's or ours (`_…`). */
export function showTables(sql: SqlStorage): string[] {
  return sql
    .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .toArray()
    .map((r) => r.name)
    .filter((n) => !n.startsWith("sqlite_") && !n.startsWith("_"));
}

type ColumnInfo = {
  name: string;
  type: string;
  pk: number;
};

function columnsOf(sql: SqlStorage, table: string): ColumnInfo[] {
  return sql.exec<ColumnInfo>(`SELECT name, type, pk FROM pragma_table_info(?)`, table).toArray();
}

/** The column that is an alias of the rowid (a lone INTEGER PRIMARY KEY), if any. */
function rowidAlias(cols: ColumnInfo[]): string | null {
  const pks = cols.filter((c) => c.pk > 0);
  return pks.length === 1 && pks[0]?.type.toUpperCase() === "INTEGER" ? pks[0].name : null;
}

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

export function migrationHashes(sql: SqlStorage): string[] {
  const exists =
    sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", MIGRATIONS).toArray()
      .length > 0;
  if (!exists) return [];
  return sql
    .exec<{ hash: string }>(`SELECT hash FROM ${q(MIGRATIONS)} ORDER BY id`)
    .toArray()
    .map((r) => r.hash);
}

export function readSequences(sql: SqlStorage): Record<string, number> {
  const out: Record<string, number> = {};
  const exists =
    sql.exec("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'").toArray().length > 0;
  if (!exists) return out;
  for (const r of sql
    .exec<{ name: string; seq: number }>("SELECT name, seq FROM sqlite_sequence ORDER BY name")
    .toArray()) {
    out[r.name] = r.seq;
  }
  return out;
}

export function tableInfos(sql: SqlStorage): TransferTableInfo[] {
  return showTables(sql).map((name) => ({
    name,
    columns: columnsOf(sql, name).map((c) => c.name),
    rows: sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${q(name)}`).one().n,
  }));
}

export type DoInfoBase = Omit<TransferDoInfo, "transfer" | "alarm" | "hasData" | "version">;

export function baseInfo(sql: SqlStorage): DoInfoBase & { version: number } {
  const hasMeta = sql.exec("SELECT 1 FROM meta LIMIT 1").toArray().length > 0;
  const version = sql.exec<{ v: number | null }>("SELECT max(version) AS v FROM changes").one().v;
  return {
    migrations: migrationHashes(sql),
    tables: tableInfos(sql),
    sequences: readSequences(sql),
    hasMeta,
    version: version ?? 0,
  };
}

function plain(table: string, value: SqlStorageValue): TransferValue {
  if (value === null || typeof value === "string" || typeof value === "number") return value;
  // No table stores blobs today; refuse rather than copy something wrong.
  throw new Error(`${table}: a non-JSON value (${typeof value}) can't be transferred`);
}

/**
 * One page of a table's rows in rowid order, after `after`, stopping once the page's JSON
 * passes `maxBytes`. `next` is the last rowid sent (pass it back), or null at the end.
 */
export function readRowsPage(
  sql: SqlStorage,
  table: string,
  after: number,
  maxBytes: number,
): { rows: TransferRow[]; next: number | null } {
  if (!showTables(sql).includes(table)) throw new TransferError(400, `Unknown table ${table}`);
  const cursor = sql.exec<Record<string, SqlStorageValue>>(
    `SELECT rowid AS ${ROWID}, * FROM ${q(table)} WHERE rowid > ? ORDER BY rowid`,
    after,
  );
  const rows: TransferRow[] = [];
  let bytes = 0;
  for (const raw of cursor) {
    const row: TransferRow = {};
    for (const [k, v] of Object.entries(raw)) row[k] = plain(table, v);
    rows.push(row);
    bytes += JSON.stringify(row).length;
    if (bytes >= maxBytes) return { rows, next: Number(row[ROWID]) };
  }
  return { rows, next: null };
}

/** Start (or restart) an import: an empty staging table. The show's data is untouched. */
export function beginStaging(sql: SqlStorage): void {
  sql.exec(`DROP TABLE IF EXISTS ${q(STAGING)}`);
  sql.exec(
    `CREATE TABLE ${q(STAGING)} (seq INTEGER PRIMARY KEY, tbl TEXT NOT NULL, row TEXT NOT NULL)`,
  );
}

export function stagingExists(sql: SqlStorage): boolean {
  return (
    sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", STAGING).toArray()
      .length > 0
  );
}

/** Check and stage rows for `table`. Throws TransferError on anything unexpected. */
export function stageRows(sql: SqlStorage, table: string, rows: unknown): number {
  if (!stagingExists(sql)) throw new TransferError(409, "No import in progress (begin first)");
  if (!showTables(sql).includes(table)) throw new TransferError(400, `Unknown table ${table}`);
  if (!Array.isArray(rows)) throw new TransferError(400, "rows must be an array");
  const known = new Set(columnsOf(sql, table).map((c) => c.name));
  for (const [i, row] of rows.entries()) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new TransferError(400, `${table} row ${i}: not an object`);
    }
    for (const [k, v] of Object.entries(row)) {
      if (k !== ROWID && !known.has(k)) {
        throw new TransferError(400, `${table}: column ${k} doesn't exist here (schema mismatch)`);
      }
      if (v !== null && typeof v !== "string" && typeof v !== "number") {
        throw new TransferError(400, `${table}.${k}: values must be strings, numbers or null`);
      }
    }
    if (typeof (row as TransferRow)[ROWID] !== "number") {
      throw new TransferError(400, `${table} row ${i}: missing ${ROWID}`);
    }
    const json = JSON.stringify(row);
    if (json.length > MAX_STAGED_ROW_BYTES) {
      throw new TransferError(400, `${table} row ${i}: too large to stage`);
    }
    sql.exec(`INSERT INTO ${q(STAGING)} (tbl, row) VALUES (?, ?)`, table, json);
  }
  return rows.length;
}

/**
 * Replace every show table's rows with the staged ones, atomically (call inside
 * `transactionSync`). Foreign keys are checked at commit, so the order rows arrive in
 * doesn't matter. Refused (nothing changes) unless each table ends with `counts[table]`
 * rows. Sets the AUTOINCREMENT counters to `sequences`.
 */
export function applyStaged(
  sql: SqlStorage,
  counts: Record<string, number>,
  sequences: Record<string, number>,
): void {
  if (!stagingExists(sql)) throw new TransferError(409, "No import in progress (begin first)");
  sql.exec("PRAGMA defer_foreign_keys = ON");
  const tables = showTables(sql);
  for (const name of Object.keys(counts)) {
    if (!tables.includes(name)) throw new TransferError(400, `Unknown table ${name}`);
  }
  for (const t of tables) sql.exec(`DELETE FROM ${q(t)}`);
  const cols = new Map(tables.map((t) => [t, columnsOf(sql, t)]));
  const PAGE = 500;
  let after = 0;
  for (;;) {
    const page = sql
      .exec<{ seq: number; tbl: string; row: string }>(
        `SELECT seq, tbl, row FROM ${q(STAGING)} WHERE seq > ? ORDER BY seq LIMIT ${PAGE}`,
        after,
      )
      .toArray();
    for (const s of page) {
      const row = JSON.parse(s.row) as TransferRow;
      const alias = rowidAlias(cols.get(s.tbl) ?? []);
      const names: string[] = [];
      const values: TransferValue[] = [];
      for (const [k, v] of Object.entries(row)) {
        if (k === ROWID) {
          if (alias) continue; // the alias column carries it
          names.push("rowid");
        } else names.push(q(k));
        values.push(v);
      }
      sql.exec(
        `INSERT INTO ${q(s.tbl)} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
        ...values,
      );
    }
    if (page.length < PAGE) break;
    after = page[page.length - 1]?.seq ?? after;
  }
  for (const t of tables) {
    const n = sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${q(t)}`).one().n;
    const want = counts[t] ?? 0;
    if (n !== want) throw new TransferError(400, `${t}: ${n} rows staged, expected ${want}`);
  }
  for (const [name, seq] of Object.entries(sequences)) {
    if (!tables.includes(name)) continue;
    sql.exec("DELETE FROM sqlite_sequence WHERE name = ?", name);
    sql.exec("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)", name, seq);
  }
  sql.exec(`DROP TABLE ${q(STAGING)}`);
}
