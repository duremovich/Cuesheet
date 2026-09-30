// Share principals (R23; routes/share.ts has the whole story): `requireAuthOrShare`
// replaces `requireAuth` on /api/shows/*, admitting a live share link's cookie on the few
// GET routes a share viewer needs. Kept apart from routes/ so routes/shows.ts can use it
// without an import cycle.
import { createMiddleware } from "hono/factory";
import type { UserDTO } from "../../shared/api";
import { parseShareOptions, type ShareKind, type ShareScope, shareScope } from "../../shared/share";
import type { schema } from "../db/d1/client";
import type { ShowEnv } from "../routes/shows";
import type { AppEnv } from "../types";
import { sha256Hex } from "./bytes";
import { parseCookies } from "./cookie";
import { sessionOf } from "./middleware";

export const SHARE_COOKIE = "cs_share";

/**
 * The show routes a share principal may use (all GET, relative to /api). Anything else is
 * 401 without a session, like before.
 */
const SHARE_ROUTES = [
  /^\/api\/shows\/([^/]+)$/,
  /^\/api\/shows\/([^/]+)\/(?:snapshot|ws)$/,
  /^\/api\/shows\/([^/]+)\/attachments\/[^/]+(?:\/thumb)?$/,
  /^\/api\/shows\/([^/]+)\/script\/versions\/[^/]+\/text$/,
];

/** The show a request under /api/shows/<id>/… is for, and whether a share viewer may make it. */
function showRoute(method: string, path: string): { showId: string; allowed: boolean } | null {
  const m = /^\/api\/shows\/([^/]+)(?:\/|$)/.exec(path);
  if (!m?.[1]) return null;
  let showId: string;
  try {
    showId = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  return { showId, allowed: method === "GET" && SHARE_ROUTES.some((re) => re.test(path)) };
}

export type LinkRow = typeof schema.shareLinks.$inferSelect;

export function isLive(link: LinkRow, now = Date.now()): boolean {
  return link.revokedAt === null && (link.expiresAt === null || link.expiresAt > now);
}

export async function linkByToken(env: Env, token: string): Promise<LinkRow | null> {
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) return null;
  const row = await env.DB.prepare("SELECT * FROM share_links WHERE token_hash = ?1")
    .bind(await sha256Hex(token))
    .first<Record<string, unknown>>();
  return row ? fromSql(row) : null;
}

export function fromSql(r: Record<string, unknown>): LinkRow {
  return {
    id: r.id as string,
    showId: r.show_id as string,
    tokenHash: r.token_hash as string,
    kind: r.kind as ShareKind,
    table: r.table as string,
    viewId: (r.view_id as string | null) ?? null,
    preset: (r.preset as string | null) ?? null,
    options: (r.options as string | null) ?? null,
    label: (r.label as string | null) ?? null,
    createdBy: r.created_by as string,
    createdAt: r.created_at as number,
    expiresAt: (r.expires_at as number | null) ?? null,
    revokedAt: (r.revoked_at as number | null) ?? null,
    lastUsedAt: (r.last_used_at as number | null) ?? null,
  };
}

/** Stand-in `user` for a share principal (no personal views, never a member). */
function shareUser(scope: ShareScope): UserDTO {
  return { id: `share:${scope.linkId}`, email: "", name: "Share link", isAdmin: false };
}

/**
 * Replaces `requireAuth` on /shows/*: a valid session sets `user` as before; a
 * `cs_share` cookie for a live link of this show, on a route in SHARE_ROUTES, sets
 * `share` (and a stand-in `user`); on any other route of that show it's 403 (links are
 * read-only). A member's session wins; a signed-in non-member with a share cookie is
 * treated as the share viewer (`requireMembership`).
 */
export const requireAuthOrShare = createMiddleware<AppEnv>(async (c, next) => {
  const session = await sessionOf(c);
  const route = showRoute(c.req.method, new URL(c.req.url).pathname);
  const token = route ? parseCookies(c.req.header("Cookie")).get(SHARE_COOKIE) : undefined;
  if (route && token) {
    const link = await linkByToken(c.env, token);
    if (link && link.showId === route.showId && isLive(link)) {
      if (!route.allowed) {
        if (!session) return c.json({ error: "Share links are read-only" }, 403);
      } else {
        const scope = shareScope({ ...link, options: parseShareOptions(link.options) });
        c.set("share", scope);
        if (!session) {
          c.set("user", shareUser(scope));
          c.set("sessionToken", "");
        }
      }
    }
  }
  if (!session && !c.var.share) return c.json({ error: "Not signed in" }, 401);
  await next();
});

/**
 * On attachment and script-text routes: a share principal may only read files of rows of
 * its link's table (404 otherwise, like a missing file), and script text only through a
 * calling-script link.
 */
export const shareResourceGuard = createMiddleware<ShowEnv>(async (c, next) => {
  const scope = c.var.share;
  if (!scope) return next();
  const aid = c.req.param("aid");
  if (aid) {
    const file = await c.env.SHOW.get(c.env.SHOW.idFromName(c.var.show.id)).attachment(aid);
    if (!file || !(scope.attachmentTables as readonly string[]).includes(file.table)) {
      return c.json({ error: "Not found" }, 404);
    }
  } else if (!scope.tables.includes("script_versions")) {
    return c.json({ error: "Not found" }, 404);
  }
  await next();
});
