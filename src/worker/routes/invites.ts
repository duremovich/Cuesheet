// Invite-only sign-up: an admin (anyone), or a show's owner (to that show), creates an
// invite for an email and shares the one-time link out of band (no email sending).
// Accepting sets name + password, signs in, and joins the invite's show with its role.
// Bad tokens are rate-limited per IP (auth/rate-limit.ts).
import { and, eq, gt, isNull } from "drizzle-orm";
import { Hono } from "hono";
import {
  type CreateInviteResponse,
  GRANTABLE_ROLES,
  type InviteInfoResponse,
  MAX_NAME_LENGTH,
  type MeResponse,
  MIN_PASSWORD_LENGTH,
  type Role,
} from "../../shared/api";
import { randomToken, sha256Hex } from "../auth/bytes";
import { serializeSessionCookie } from "../auth/cookie";
import { requireAuth } from "../auth/middleware";
import { hashPassword } from "../auth/password";
import { clientIp, recordFailure, retryAfter, tooMany } from "../auth/rate-limit";
import { createSession, isPlausibleEmail, normalizeEmail } from "../auth/session";
import { schema } from "../db/d1/client";
import type { AppEnv } from "../types";
import { isHttps, readJsonObject, str } from "./util";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const BAD_INVITE = "This invite link is invalid or has been used";

function openInvite(id: string) {
  return and(
    eq(schema.invites.id, id),
    eq(schema.invites.kind, "signup"),
    isNull(schema.invites.acceptedAt),
    gt(schema.invites.expiresAt, Date.now()),
  );
}

type InviteRole = "editor" | "commenter" | "viewer";

function isInviteRole(r: unknown): r is InviteRole {
  return typeof r === "string" && (GRANTABLE_ROLES as readonly string[]).includes(r);
}

export const inviteRoutes = new Hono<AppEnv>()
  .post("/invites", requireAuth, async (c) => {
    const body = await readJsonObject(c);
    const email = normalizeEmail(str(body?.email));
    const showId = body?.showId ? str(body.showId) : null;
    const role = body?.role ?? (showId ? "editor" : null);
    if (role !== null && !isInviteRole(role)) {
      return c.json({ error: `role must be one of ${GRANTABLE_ROLES.join(", ")}` }, 400);
    }
    // Admins invite anyone; a show's owner may invite people to that show.
    if (!c.var.user.isAdmin) {
      const own = showId
        ? await c.var.db
            .select({ role: schema.memberships.role })
            .from(schema.memberships)
            .where(
              and(
                eq(schema.memberships.showId, showId),
                eq(schema.memberships.userId, c.var.user.id),
              ),
            )
            .get()
        : undefined;
      if (own?.role !== "owner") {
        return c.json({ error: "Only admins, or a show's owner for their show, can invite" }, 403);
      }
    } else if (showId) {
      const show = await c.var.db
        .select({ id: schema.shows.id })
        .from(schema.shows)
        .where(eq(schema.shows.id, showId))
        .get();
      if (!show) return c.json({ error: "Show not found" }, 404);
    }
    if (!isPlausibleEmail(email)) return c.json({ error: "Enter a valid email address" }, 400);
    const existing = await c.var.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .get();
    if (existing) return c.json({ error: "That email already has an account" }, 409);

    const token = randomToken();
    const expiresAt = Date.now() + INVITE_TTL_MS;
    await c.var.db.insert(schema.invites).values({
      id: await sha256Hex(token),
      email,
      invitedBy: c.var.user.id,
      expiresAt,
      kind: "signup",
      showId,
      role: showId ? (role as InviteRole) : null,
    });
    return c.json(
      { email, path: `/invite/${token}`, expiresAt } satisfies CreateInviteResponse,
      201,
    );
  })
  .get("/invites/:token", async (c) => {
    const now = Date.now();
    const keys = [`invite:ip:${clientIp(c)}`];
    const wait = await retryAfter(c.env.DB, keys, now);
    if (wait > 0) return tooMany(c, wait);
    const invite = await c.var.db
      .select({
        email: schema.invites.email,
        role: schema.invites.role,
        showName: schema.shows.name,
      })
      .from(schema.invites)
      .leftJoin(schema.shows, eq(schema.shows.id, schema.invites.showId))
      .where(openInvite(await sha256Hex(c.req.param("token"))))
      .get();
    if (!invite) {
      await recordFailure(c.env.DB, keys, now);
      return c.json({ error: BAD_INVITE }, 404);
    }
    return c.json({
      email: invite.email,
      showName: invite.showName,
      role: invite.showName ? (invite.role as Role | null) : null,
    } satisfies InviteInfoResponse);
  })
  .post("/invites/:token/accept", async (c) => {
    const body = await readJsonObject(c);
    const name = str(body?.name).trim();
    const password = str(body?.password);
    if (!name || name.length > MAX_NAME_LENGTH) return c.json({ error: "Enter your name" }, 400);
    if (password.length < MIN_PASSWORD_LENGTH) {
      return c.json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` }, 400);
    }
    const now = Date.now();
    const keys = [`invite:ip:${clientIp(c)}`];
    const wait = await retryAfter(c.env.DB, keys, now);
    if (wait > 0) return tooMany(c, wait);
    const inviteId = await sha256Hex(c.req.param("token"));
    const passwordHash = await hashPassword(password);

    // Claim the invite atomically so a link can only be used once.
    const [claimed] = await c.var.db
      .update(schema.invites)
      .set({ acceptedAt: now })
      .where(openInvite(inviteId))
      .returning({
        email: schema.invites.email,
        showId: schema.invites.showId,
        role: schema.invites.role,
      });
    if (!claimed) {
      await recordFailure(c.env.DB, keys, now);
      return c.json({ error: BAD_INVITE }, 404);
    }

    const user = {
      id: crypto.randomUUID(),
      email: normalizeEmail(claimed.email),
      name,
      passwordHash,
      isAdmin: false,
    };
    const inserted = await c.var.db
      .insert(schema.users)
      .values(user)
      .onConflictDoNothing()
      .returning({ id: schema.users.id });
    if (inserted.length === 0) return c.json({ error: "That email already has an account" }, 409);
    if (claimed.showId) {
      // The show may have gone since; then there's nothing to join.
      const show = await c.var.db
        .select({ id: schema.shows.id })
        .from(schema.shows)
        .where(eq(schema.shows.id, claimed.showId))
        .get();
      if (show) {
        await c.var.db
          .insert(schema.memberships)
          .values({ showId: show.id, userId: user.id, role: claimed.role ?? "editor" })
          .onConflictDoNothing();
      }
    }

    const token = await createSession(c.var.db, user.id);
    c.header("Set-Cookie", serializeSessionCookie(token, { secure: isHttps(c) }));
    return c.json(
      { user: { id: user.id, email: user.email, name, isAdmin: false } } satisfies MeResponse,
      201,
    );
  });
