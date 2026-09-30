// Backups (docs/deploy.md, "Backups").
//
// - `GET /api/shows/:id/export.json` (owner): everything in the show's Durable Object
//   (every table, personal views included, joins, select options, settings) plus the D1
//   side (show row, members, share links without their token hashes) and a manifest of the
//   attachment files in R2 (key, size, type) so a restore can copy them.
// - `backupD1` (the Worker's weekly `scheduled` handler): every D1 table except sessions
//   and rate-limit events as gzipped JSON in R2 under `_backups/d1/<date>.json.gz`; the
//   newest BACKUPS_KEPT are kept. **Show data is not in D1** (it's in each show's Durable
//   Object): the per-show export, and DO point-in-time recovery, cover it.
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import type { SnapshotResponse } from "../../shared/ops";
import { pruneRateLimits } from "../auth/rate-limit";
import { schema } from "../db/d1/client";
import type { ShowEnv } from "./shows";

export const EXPORT_FORMAT = "cuesheet-show-export";
export const EXPORT_VERSION = 1;

export interface ShowExport {
  format: typeof EXPORT_FORMAT;
  version: number;
  exportedAt: string;
  show: { id: string; name: string; currentSession: string | null; createdAt: number };
  members: { userId: string; email: string; name: string; role: string }[];
  shareLinks: Record<string, unknown>[];
  snapshot: SnapshotResponse;
  /** Every attachment's R2 object (and thumbnail, when made) for copying files over. */
  files: {
    id: string;
    table: string;
    recordId: string;
    filename: string;
    contentType: string;
    size: number;
    r2Key: string;
    thumbKey: string | null;
  }[];
}

export async function exportShow(c: Context<ShowEnv>): Promise<Response> {
  const showId = c.var.show.id;
  const stub = c.env.SHOW.get(c.env.SHOW.idFromName(showId));
  const snapshot = JSON.parse(await stub.snapshotJson()) as SnapshotResponse;
  const db = c.var.db;
  const show = await db
    .select({
      id: schema.shows.id,
      name: schema.shows.name,
      currentSession: schema.shows.currentSession,
      createdAt: schema.shows.createdAt,
    })
    .from(schema.shows)
    .where(eq(schema.shows.id, showId))
    .get();
  const members = await db
    .select({
      userId: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
      role: schema.memberships.role,
    })
    .from(schema.memberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
    .where(eq(schema.memberships.showId, showId));
  const links = await db
    .select()
    .from(schema.shareLinks)
    .where(eq(schema.shareLinks.showId, showId));
  const out: ShowExport = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    show: show ?? { id: showId, name: c.var.show.name, currentSession: null, createdAt: 0 },
    members,
    shareLinks: links.map(({ tokenHash: _t, ...rest }) => rest),
    snapshot,
    files: snapshot.tables.attachments.map((a) => ({
      id: a.id,
      table: a.table,
      recordId: a.record_id,
      filename: a.filename,
      contentType: a.content_type,
      size: a.size,
      r2Key: a.r2_key,
      thumbKey: a.thumb_key,
    })),
  };
  const name = (show?.name ?? "show").replace(/[^\w.-]+/g, "_").slice(0, 60);
  return c.body(JSON.stringify(out), 200, {
    "Content-Type": "application/json",
    "Content-Disposition": `attachment; filename="${name}-${new Date().toISOString().slice(0, 10)}.json"`,
    "Cache-Control": "no-store",
  });
}

/** Weekly D1 backups kept in R2 (about three months). */
export const BACKUPS_KEPT = 13;
/**
 * Apart from show files (`shows/…`). These dumps hold password hashes and the hashes of
 * session-less tokens (invites, reset links, share links): treat them as secrets.
 */
export const BACKUP_PREFIX = "_backups/d1/";
/** Not worth backing up: short-lived and security-sensitive. */
const SKIPPED_TABLES = new Set(["sessions", "rate_limit_events", "d1_migrations"]);

/**
 * Dump every D1 table to R2 as gzipped JSON (`{format, exportedAt, tables: {name: rows}}`)
 * and drop backups beyond the newest BACKUPS_KEPT. Returns the object key.
 */
export async function backupD1(env: Env, now = new Date()): Promise<string> {
  const names = (
    await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
    ).all<{ name: string }>()
  ).results
    .map((r) => r.name)
    .filter((n) => !SKIPPED_TABLES.has(n));
  const tables: Record<string, unknown[]> = {};
  for (const name of names) {
    tables[name] = (await env.DB.prepare(`SELECT * FROM "${name}"`).all()).results;
  }
  const json = JSON.stringify({
    format: "cuesheet-d1-backup",
    exportedAt: now.toISOString(),
    tables,
  });
  const gz = new Response(
    new Blob([json]).stream().pipeThrough(new CompressionStream("gzip")),
  ).arrayBuffer();
  const key = `${BACKUP_PREFIX}${now.toISOString().replace(/[:.]/g, "-")}.json.gz`;
  await env.FILES.put(key, await gz, {
    httpMetadata: { contentType: "application/json", contentEncoding: "gzip" },
  });
  // Keys sort by time: keep the newest.
  const listed = await env.FILES.list({ prefix: BACKUP_PREFIX });
  const old = listed.objects
    .map((o) => o.key)
    .sort()
    .slice(0, -BACKUPS_KEPT);
  if (old.length) await env.FILES.delete(old);
  return key;
}

/** The Worker's `scheduled` handler (wrangler.jsonc `triggers.crons`). */
export async function scheduled(env: Env, now = new Date()): Promise<void> {
  await backupD1(env, now);
  await pruneRateLimits(env.DB, now.getTime());
  // Expired sessions and used/expired invite links pile up otherwise.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?1").bind(now.getTime()),
    env.DB.prepare("DELETE FROM invites WHERE expires_at <= ?1").bind(
      now.getTime() - 30 * 24 * 60 * 60 * 1000,
    ),
  ]);
}
