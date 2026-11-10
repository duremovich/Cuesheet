// Moving a show between instances (docs/deploy.md, "Moving a show between instances").
// Instance-admin only. `scripts/migrate-show.ts` drives these routes on both sides.
//
// Source (read):  GET  /api/admin/users
//                 GET  /api/admin/shows/:id/transfer              manifest (also the target's status)
//                 GET  /api/admin/shows/:id/transfer/rows         ?table=&after= → {rows, next}
//                 GET  /api/admin/shows/:id/transfer/files        every R2 object under shows/<id>/
//                 GET  /api/admin/shows/:id/transfer/file         ?key= → the raw bytes
//                 GET  /api/admin/shows/:id/transfer/file-hash    ?key= → {key, size, sha256}
// Target (write): POST /api/admin/shows/:id/transfer/begin        {migrations, overwrite?}
//                 POST /api/admin/shows/:id/transfer/rows         {table, rows} (staged)
//                 PUT  /api/admin/shows/:id/transfer/file         ?key= (bytes; SHA-256 checked)
//                 POST /api/admin/shows/:id/transfer/finish       {counts, sequences, show, …}
//
// An import goes only into a show id that doesn't exist (no D1 row, an empty Durable
// Object), or, with `overwrite`, one a previous import created (the DO's marker) and that
// nobody has edited since. The D1 rows (show, memberships, share links) are written last,
// so the show appears in no one's list until everything else is in.

import type { Context } from "hono";
import { Hono } from "hono";
import {
  MAX_TRANSFER_BODY_BYTES,
  MAX_TRANSFER_FILE_BYTES,
  R2_METADATA_HEADER,
  SHA256_HEADER,
  TRANSFER_FORMAT,
  TRANSFER_VERSION,
  type TransferFile,
  type TransferFinishResponse,
  type TransferManifest,
  type TransferValue,
} from "../../shared/show-transfer";
import { requireAdmin, requireAuth } from "../auth/middleware";
import { schema } from "../db/d1/client";
import type { TransferResult } from "../do/ShowDO";
import type { AppEnv } from "../types";
import { showStub } from "./shows";
import { readJsonObjectLimited } from "./util";

/** Rows per page on the source side, by JSON size. */
const ROWS_PAGE_BYTES = 4 * 1024 * 1024;
/** Show ids are UUIDs; also keeps `__health__` and path tricks out. */
const SHOW_ID = /^[0-9A-Za-z-]{8,64}$/;

type Row = Record<string, TransferValue>;

const filePrefix = (showId: string) => `shows/${showId}/`;

function showIdOf(c: Context<AppEnv>): string | null {
  const id = c.req.param("id") ?? "";
  return SHOW_ID.test(id) ? id : null;
}

function keyOf(c: Context<AppEnv>, showId: string): string | null {
  const key = c.req.query("key") ?? "";
  return key.startsWith(filePrefix(showId)) && !key.includes("..") ? key : null;
}

function failed(c: Context<AppEnv>, r: TransferResult<object>) {
  return c.json({ error: r.ok ? "" : r.error }, r.ok ? 200 : r.status);
}

async function d1Rows(env: Env, sql: string, ...args: unknown[]): Promise<Row[]> {
  return (
    await env.DB.prepare(sql)
      .bind(...args)
      .all<Row>()
  ).results;
}

async function d1Columns(env: Env, table: string): Promise<Set<string>> {
  const rows = (await env.DB.prepare(`PRAGMA table_info("${table}")`).all<{ name: string }>())
    .results;
  return new Set(rows.map((r) => r.name));
}

function insertStmt(env: Env, table: string, row: Row, known: Set<string>): D1PreparedStatement {
  const cols = Object.keys(row);
  const unknown = cols.filter((k) => !known.has(k));
  if (unknown.length) throw new Error(`${table}: unknown columns ${unknown.join(", ")}`);
  return env.DB.prepare(
    `INSERT INTO "${table}" (${cols.map((k) => `"${k}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
  ).bind(...cols.map((k) => row[k] ?? null));
}

function stringFields(o: object | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o ?? {})) if (typeof v === "string") out[k] = v;
  return out;
}

async function sha256Hex(stream: ReadableStream<Uint8Array>): Promise<string> {
  const digest = new crypto.DigestStream("SHA-256");
  await stream.pipeTo(digest);
  return [...new Uint8Array(await digest.digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const isRow = (v: unknown): v is Row => !!v && typeof v === "object" && !Array.isArray(v);

export const transferRoutes = new Hono<AppEnv>()
  .use("/admin/shows/*", requireAuth, requireAdmin)
  .get("/admin/users", requireAuth, requireAdmin, async (c) => {
    const users = await c.var.db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        name: schema.users.name,
        isAdmin: schema.users.isAdmin,
      })
      .from(schema.users);
    return c.json({ users });
  })

  // ---- read (source; the manifest is also the target's status) ----

  .get("/admin/shows/:id/transfer", async (c) => {
    const showId = showIdOf(c);
    if (!showId) return c.json({ error: "Bad show id" }, 400);
    const [show, memberships, shareLinks, info] = await Promise.all([
      c.env.DB.prepare("SELECT * FROM shows WHERE id = ?").bind(showId).first<Row>(),
      d1Rows(c.env, "SELECT * FROM memberships WHERE show_id = ? ORDER BY user_id", showId),
      d1Rows(c.env, "SELECT * FROM share_links WHERE show_id = ? ORDER BY id", showId),
      showStub(c.env, showId).transferInfo(),
    ]);
    const manifest: TransferManifest = {
      format: TRANSFER_FORMAT,
      version: TRANSFER_VERSION,
      showId,
      d1: { show: show ?? null, memberships, shareLinks },
      do: info,
    };
    c.header("Cache-Control", "no-store");
    return c.json(manifest);
  })
  .get("/admin/shows/:id/transfer/rows", async (c) => {
    const showId = showIdOf(c);
    if (!showId) return c.json({ error: "Bad show id" }, 400);
    const after = Number(c.req.query("after") ?? "0");
    if (!Number.isSafeInteger(after)) return c.json({ error: "Bad cursor" }, 400);
    const r = await showStub(c.env, showId).transferRows(
      c.req.query("table") ?? "",
      after,
      ROWS_PAGE_BYTES,
    );
    if (!r.ok) return failed(c, r);
    return c.body(r.json, 200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  })
  .get("/admin/shows/:id/transfer/files", async (c) => {
    const showId = showIdOf(c);
    if (!showId) return c.json({ error: "Bad show id" }, 400);
    const files: TransferFile[] = [];
    let cursor: string | undefined;
    do {
      const page = await c.env.FILES.list({
        prefix: filePrefix(showId),
        include: ["httpMetadata", "customMetadata"],
        ...(cursor ? { cursor } : {}),
      });
      for (const o of page.objects) {
        files.push({
          key: o.key,
          size: o.size,
          httpMetadata: stringFields(o.httpMetadata),
          customMetadata: stringFields(o.customMetadata),
        });
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    files.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    c.header("Cache-Control", "no-store");
    return c.json({ files });
  })
  .get("/admin/shows/:id/transfer/file", async (c) => {
    const showId = showIdOf(c);
    const key = showId && keyOf(c, showId);
    if (!key) return c.json({ error: "Bad key" }, 400);
    const obj = await c.env.FILES.get(key);
    if (!obj) return c.json({ error: "No such object" }, 404);
    // Raw bytes: octet-stream and no Content-Encoding, whatever the object's metadata says
    // (the gzipped script texts must not be decoded on the way).
    return new Response(obj.body, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(obj.size),
        "Cache-Control": "no-store",
      },
    });
  })
  .get("/admin/shows/:id/transfer/file-hash", async (c) => {
    const showId = showIdOf(c);
    const key = showId && keyOf(c, showId);
    if (!key) return c.json({ error: "Bad key" }, 400);
    const obj = await c.env.FILES.get(key);
    if (!obj) return c.json({ error: "No such object" }, 404);
    return c.json({ key, size: obj.size, sha256: await sha256Hex(obj.body) });
  })

  // ---- write (target) ----

  .post("/admin/shows/:id/transfer/begin", async (c) => {
    const showId = showIdOf(c);
    if (!showId) return c.json({ error: "Bad show id" }, 400);
    const body = await readJsonObjectLimited(c);
    if (!body || body === "too-large") return c.json({ error: "Expected a JSON object" }, 400);
    const stub = showStub(c.env, showId);
    const info = await stub.transferInfo();
    const migrations = Array.isArray(body.migrations) ? body.migrations : null;
    if (!migrations || migrations.join("\n") !== info.migrations.join("\n")) {
      return c.json(
        {
          error: `Schema mismatch: the source has ${migrations?.length ?? "?"} show migrations, this instance ${info.migrations.length}. Run the same Cuesheet version on both.`,
        },
        409,
      );
    }
    const show = await c.env.DB.prepare("SELECT id FROM shows WHERE id = ?").bind(showId).first();
    const marker = info.transfer;
    if (!marker) {
      if (show || info.hasMeta || info.hasData || info.version > 0) {
        return c.json({ error: "That show already exists here; refusing to overwrite it" }, 409);
      }
    } else {
      if (body.overwrite !== true) {
        return c.json(
          {
            error: `A previous import of this show is here (${marker.state}); pass overwrite to replace it`,
          },
          409,
        );
      }
      if (marker.state === "imported" && info.version !== marker.version) {
        return c.json(
          { error: "The imported show has been edited since; refusing to overwrite it" },
          409,
        );
      }
      // Out of everyone's list until the new import finishes (memberships and share links
      // go with it: ON DELETE CASCADE).
      if (show) await c.env.DB.prepare("DELETE FROM shows WHERE id = ?").bind(showId).run();
    }
    await stub.transferBegin();
    return c.json({ ok: true });
  })
  .post("/admin/shows/:id/transfer/rows", async (c) => {
    const showId = showIdOf(c);
    if (!showId) return c.json({ error: "Bad show id" }, 400);
    const body = await readJsonObjectLimited(c, MAX_TRANSFER_BODY_BYTES);
    if (body === "too-large") return c.json({ error: "Too large; send smaller chunks" }, 413);
    if (!body || typeof body.table !== "string" || !Array.isArray(body.rows)) {
      return c.json({ error: "Expected {table, rows}" }, 400);
    }
    const r = await showStub(c.env, showId).transferStage(body.table, JSON.stringify(body.rows));
    if (!r.ok) return failed(c, r);
    return c.json({ ok: true, staged: r.staged });
  })
  .put("/admin/shows/:id/transfer/file", async (c) => {
    const showId = showIdOf(c);
    const key = showId && keyOf(c, showId);
    if (!showId || !key) return c.json({ error: "Bad key" }, 400);
    if ((await showStub(c.env, showId).transferState())?.state !== "importing") {
      return c.json({ error: "No import in progress" }, 409);
    }
    const size = Number(c.req.header("Content-Length") ?? "");
    if (!Number.isSafeInteger(size) || size < 0) return c.json({ error: "Length required" }, 411);
    if (size > MAX_TRANSFER_FILE_BYTES) return c.json({ error: "File too large" }, 413);
    const sha256 = c.req.header(SHA256_HEADER) ?? "";
    if (!/^[0-9a-f]{64}$/.test(sha256)) return c.json({ error: `${SHA256_HEADER} required` }, 400);
    let meta: { httpMetadata?: object; customMetadata?: object } = {};
    try {
      meta = JSON.parse(c.req.header(R2_METADATA_HEADER) ?? "{}");
    } catch {
      return c.json({ error: `Bad ${R2_METADATA_HEADER}` }, 400);
    }
    const body =
      size === 0 || !c.req.raw.body
        ? new Uint8Array(0)
        : c.req.raw.body.pipeThrough(new FixedLengthStream(size));
    try {
      await c.env.FILES.put(key, body, {
        httpMetadata: stringFields(meta.httpMetadata),
        customMetadata: stringFields(meta.customMetadata),
        sha256,
      });
    } catch (e) {
      await c.env.FILES.delete(key).catch(() => undefined);
      return c.json({ error: `Not stored: ${e instanceof Error ? e.message : String(e)}` }, 400);
    }
    // R2 checks the SHA-256 on put; read it back as well (cheap insurance).
    const stored = await c.env.FILES.get(key);
    const got = stored ? await sha256Hex(stored.body) : "";
    if (got !== sha256) {
      await c.env.FILES.delete(key);
      return c.json({ error: "Checksum mismatch; not stored" }, 400);
    }
    return c.json({ ok: true, key, size });
  })
  .post("/admin/shows/:id/transfer/finish", async (c) => {
    const showId = showIdOf(c);
    if (!showId) return c.json({ error: "Bad show id" }, 400);
    const body = await readJsonObjectLimited(c, MAX_TRANSFER_BODY_BYTES);
    if (!body || body === "too-large") return c.json({ error: "Expected a JSON object" }, 400);
    const { counts, sequences, show } = body;
    const memberships = Array.isArray(body.memberships) ? body.memberships.filter(isRow) : [];
    const shareLinks = Array.isArray(body.shareLinks) ? body.shareLinks.filter(isRow) : [];
    if (!isRow(counts) || !isRow(sequences) || !isRow(show) || show.id !== showId) {
      return c.json({ error: "Expected {counts, sequences, show, memberships, shareLinks}" }, 400);
    }
    // Check the D1 side before touching the show, so a refusal leaves the import resumable.
    const users = new Set((await d1Rows(c.env, "SELECT id FROM users")).map((u) => String(u.id)));
    if (!users.has(String(show.created_by))) {
      return c.json({ error: `show.created_by ${show.created_by} is not a user here` }, 400);
    }
    const skipped = { memberships: [] as string[], shareLinks: [] as string[] };
    const keepMembers = memberships.filter((m) => {
      const ok = m.show_id === showId && users.has(String(m.user_id));
      if (!ok) skipped.memberships.push(String(m.user_id));
      return ok;
    });
    const keepLinks = shareLinks.filter((l) => {
      const ok = l.show_id === showId && users.has(String(l.created_by));
      if (!ok) skipped.shareLinks.push(String(l.id));
      return ok;
    });
    let statements: D1PreparedStatement[];
    try {
      const [showCols, memberCols, linkCols] = await Promise.all([
        d1Columns(c.env, "shows"),
        d1Columns(c.env, "memberships"),
        d1Columns(c.env, "share_links"),
      ]);
      statements = [
        c.env.DB.prepare("DELETE FROM shows WHERE id = ?").bind(showId),
        insertStmt(c.env, "shows", show, showCols),
        ...keepMembers.map((m) => insertStmt(c.env, "memberships", m, memberCols)),
        ...keepLinks.map((l) => insertStmt(c.env, "share_links", l, linkCols)),
      ];
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
    const r = await showStub(c.env, showId).transferFinish(
      counts as Record<string, number>,
      sequences as Record<string, number>,
    );
    if (!r.ok) return failed(c, r);
    await c.env.DB.batch(statements);
    return c.json({ ok: true, version: r.version, skipped } satisfies TransferFinishResponse);
  });
