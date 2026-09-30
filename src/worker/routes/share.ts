// Read-only share links (R23). Editors and the owner create a link to one table (a view
// of it) or a print layout (Show settings → Sharing); anyone with `/s/<token>` sees it
// without signing in. A link shows its whole table, not just the view's filtered rows
// (the view only shapes the rendering). Tokens are shown once; "Regenerate" revokes a link
// and makes a new one with the same settings.
//
// How a viewer gets in: the page calls `GET /api/share/:token`, which answers what the
// link shows and sets an HttpOnly cookie `cs_share=<token>` scoped to
// `Path=/api/shows/<showId>`. The show's own GET routes the page needs (show info,
// snapshot, WebSocket, attachment files, script text) then admit that cookie as a *share
// principal* (`requireAuthOrShare`, before `requireMembership`), with role viewer and
// `c.var.share` = the link's scope; every other route answers 401 for it (and 404 for
// another show). The snapshot and the socket's ops are cut down to the scope in the DO
// (src/worker/share-filter.ts); attachment files only for rows of the link's table.
// Revoking closes the link's sockets; its page then shows "revoked" (410).
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import {
  type CreateShareLinkResponse,
  isSharePreset,
  MAX_SHARE_LABEL,
  type ShareInfoResponse,
  type ShareKind,
  type ShareLinkDTO,
  type ShareLinksResponse,
  type ShareOptions,
  sharePath,
} from "../../shared/share";
import { DATA_TABLES, type DataTableName } from "../../shared/tables";
import { randomToken, sha256Hex } from "../auth/bytes";
import { clientIp, recordFailure, retryAfter, tooMany } from "../auth/rate-limit";
import { isLive, type LinkRow, linkByToken, SHARE_COOKIE } from "../auth/share-auth";
import { schema } from "../db/d1/client";
import { requireMembership, type ShowEnv, showStub } from "./shows";
import { isHttps, readJsonObject, str } from "./util";

const SHARE_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function parseOptions(json: string | null): ShareOptions {
  if (!json) return {};
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    const out: ShareOptions = {};
    if (typeof o.session === "string") out.session = o.session;
    if (o.orient === "landscape" || o.orient === "portrait") out.orient = o.orient;
    return out;
  } catch {
    return {};
  }
}

function toDTO(l: LinkRow): ShareLinkDTO {
  return {
    id: l.id,
    kind: l.kind,
    table: l.table as DataTableName,
    viewId: l.viewId,
    preset: isSharePreset(l.preset) ? l.preset : null,
    options: parseOptions(l.options),
    label: l.label,
    createdBy: l.createdBy,
    createdAt: l.createdAt,
    expiresAt: l.expiresAt,
    revokedAt: l.revokedAt,
    lastUsedAt: l.lastUsedAt,
  };
}

/** Editors and the owner manage share links. */
const requireEditor = createMiddleware<ShowEnv>(async (c, next) => {
  if (c.var.share || (c.var.role !== "owner" && c.var.role !== "editor")) {
    return c.json({ error: "Only editors can manage share links" }, 403);
  }
  await next();
});

function shareCookie(c: Parameters<typeof isHttps>[0], showId: string, token: string, ms: number) {
  const parts = [
    `${SHARE_COOKIE}=${token}`,
    `Path=/api/shows/${encodeURIComponent(showId)}`,
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor(ms / 1000))}`,
  ];
  if (isHttps(c)) parts.push("Secure");
  return parts.join("; ");
}

export const shareRoutes = new Hono<ShowEnv>()
  // ---- public: resolve a link ----
  .get("/share/:token", async (c) => {
    c.header("X-Robots-Tag", "noindex, nofollow");
    c.header("Cache-Control", "no-store");
    const now = Date.now();
    const keys = [`share:ip:${clientIp(c)}`];
    const wait = await retryAfter(c.env.DB, keys, now);
    if (wait > 0) return tooMany(c, wait);
    const link = await linkByToken(c.env, c.req.param("token"));
    const show = link
      ? await c.var.db
          .select({
            id: schema.shows.id,
            name: schema.shows.name,
            currentSession: schema.shows.currentSession,
          })
          .from(schema.shows)
          .where(eq(schema.shows.id, link.showId))
          .get()
      : undefined;
    if (!link || !show) {
      await recordFailure(c.env.DB, keys, now);
      return c.json({ error: "This link doesn't exist" }, 404);
    }
    if (!isLive(link, now)) {
      await recordFailure(c.env.DB, keys, now);
      return c.json({ error: "This link has been revoked or has expired" }, 410);
    }
    await c.var.db
      .update(schema.shareLinks)
      .set({ lastUsedAt: now })
      .where(eq(schema.shareLinks.id, link.id));
    const lifetime = Math.min(SHARE_COOKIE_MAX_AGE_MS, (link.expiresAt ?? Infinity) - now);
    c.header("Set-Cookie", shareCookie(c, show.id, c.req.param("token"), lifetime));
    const dto = toDTO(link);
    return c.json({
      link: {
        id: dto.id,
        kind: dto.kind,
        table: dto.table,
        viewId: dto.viewId,
        preset: dto.preset,
        options: dto.options,
        label: dto.label,
      },
      show,
    } satisfies ShareInfoResponse);
  })

  // ---- the owner's links (Show settings → Sharing) ----
  .get("/shows/:id/share-links", requireMembership, requireEditor, async (c) => {
    const rows = await c.var.db
      .select()
      .from(schema.shareLinks)
      .where(eq(schema.shareLinks.showId, c.var.show.id))
      .orderBy(desc(schema.shareLinks.createdAt));
    return c.json({ links: rows.map(toDTO) } satisfies ShareLinksResponse);
  })
  .post("/shows/:id/share-links", requireMembership, requireEditor, async (c) => {
    const body = await readJsonObject(c);
    if (!body) return c.json({ error: "Expected a JSON object" }, 400);
    const kind = body.kind;
    if (kind !== "view" && kind !== "print") {
      return c.json({ error: "kind must be view or print" }, 400);
    }
    const preset = body.preset ?? null;
    if (preset !== null && !isSharePreset(preset)) {
      return c.json({ error: "Unknown layout" }, 400);
    }
    if (preset !== null && kind !== "print") {
      return c.json({ error: "Built-in layouts are print links" }, 400);
    }
    const table = str(body.table);
    if (!(DATA_TABLES as readonly string[]).includes(table)) {
      return c.json({ error: "Unknown table" }, 400);
    }
    const label = str(body.label).trim().slice(0, MAX_SHARE_LABEL) || null;
    const expiresAt = body.expiresAt ?? null;
    if (
      expiresAt !== null &&
      (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt <= Date.now())
    ) {
      return c.json({ error: "The expiry must be in the future" }, 400);
    }
    const options: ShareOptions = {};
    const rawOpts = (body.options ?? {}) as Record<string, unknown>;
    if (typeof rawOpts.session === "string" && rawOpts.session.trim()) {
      options.session = rawOpts.session.trim().slice(0, 100);
    }
    if (rawOpts.orient === "landscape" || rawOpts.orient === "portrait") {
      options.orient = rawOpts.orient;
    }
    // A view link shows a shared view of the table: the one asked for, else its default.
    let viewId: string | null = null;
    if (preset === null) {
      const asked = body.viewId === undefined || body.viewId === null ? null : str(body.viewId);
      viewId = await showStub(c.env, c.var.show.id).sharedViewId(table as DataTableName, asked);
      if (asked !== null && viewId === null) {
        return c.json({ error: "Pick a shared view of that table" }, 400);
      }
    }
    const token = randomToken();
    const row = {
      id: crypto.randomUUID(),
      showId: c.var.show.id,
      tokenHash: await sha256Hex(token),
      kind: kind as ShareKind,
      table: preset === null ? table : table,
      viewId,
      preset,
      options: Object.keys(options).length ? JSON.stringify(options) : null,
      label,
      createdBy: c.var.user.id,
      createdAt: Date.now(),
      expiresAt: expiresAt as number | null,
      revokedAt: null,
      lastUsedAt: null,
    } satisfies LinkRow;
    await c.var.db.insert(schema.shareLinks).values(row);
    return c.json(
      { link: toDTO(row), path: sharePath(token) } satisfies CreateShareLinkResponse,
      201,
    );
  })
  .delete("/shows/:id/share-links/:linkId", requireMembership, requireEditor, async (c) => {
    const linkId = c.req.param("linkId");
    const [revoked] = await c.var.db
      .update(schema.shareLinks)
      .set({ revokedAt: Date.now() })
      .where(and(eq(schema.shareLinks.id, linkId), eq(schema.shareLinks.showId, c.var.show.id)))
      .returning({ id: schema.shareLinks.id });
    if (!revoked) return c.json({ error: "No such link" }, 404);
    await showStub(c.env, c.var.show.id).disconnectShare(linkId);
    return c.json({ ok: true });
  })
  // A new token for a live link (the old one lost, or leaked): revokes it and makes a link
  // with the same target, options, label and expiry.
  .post(
    "/shows/:id/share-links/:linkId/regenerate",
    requireMembership,
    requireEditor,
    async (c) => {
      const old = await c.var.db
        .select()
        .from(schema.shareLinks)
        .where(
          and(
            eq(schema.shareLinks.id, c.req.param("linkId")),
            eq(schema.shareLinks.showId, c.var.show.id),
          ),
        )
        .get();
      if (!old) return c.json({ error: "No such link" }, 404);
      if (!isLive(old)) {
        return c.json({ error: "That link is revoked or expired; create a new one" }, 400);
      }
      const token = randomToken();
      const now = Date.now();
      const row = {
        ...old,
        id: crypto.randomUUID(),
        tokenHash: await sha256Hex(token),
        createdBy: c.var.user.id,
        createdAt: now,
        revokedAt: null,
        lastUsedAt: null,
      } satisfies LinkRow;
      await c.var.db.batch([
        c.var.db
          .update(schema.shareLinks)
          .set({ revokedAt: now })
          .where(eq(schema.shareLinks.id, old.id)),
        c.var.db.insert(schema.shareLinks).values(row),
      ]);
      await showStub(c.env, c.var.show.id).disconnectShare(old.id);
      return c.json(
        { link: toDTO(row), path: sharePath(token) } satisfies CreateShareLinkResponse,
        201,
      );
    },
  );
