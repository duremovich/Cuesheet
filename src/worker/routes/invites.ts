// Invite-only sign-up: an admin creates an invite for an email and shares the one-time
// link out of band (no email sending in M0). Accepting sets name + password and signs in.
import { and, eq, gt, isNull } from "drizzle-orm";
import { Hono } from "hono";
import {
  type CreateInviteResponse,
  type InviteInfoResponse,
  MAX_NAME_LENGTH,
  type MeResponse,
  MIN_PASSWORD_LENGTH,
} from "../../shared/api";
import { randomToken, sha256Hex } from "../auth/bytes";
import { serializeSessionCookie } from "../auth/cookie";
import { requireAdmin, requireAuth } from "../auth/middleware";
import { hashPassword } from "../auth/password";
import { createSession, isPlausibleEmail, normalizeEmail } from "../auth/session";
import { schema } from "../db/d1/client";
import type { AppEnv } from "../types";
import { isHttps, readJsonObject, str } from "./util";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function openInvite(id: string) {
  return and(
    eq(schema.invites.id, id),
    isNull(schema.invites.acceptedAt),
    gt(schema.invites.expiresAt, Date.now()),
  );
}

export const inviteRoutes = new Hono<AppEnv>()
  .post("/invites", requireAuth, requireAdmin, async (c) => {
    const body = await readJsonObject(c);
    const email = normalizeEmail(str(body?.email));
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
    });
    return c.json(
      { email, path: `/invite/${token}`, expiresAt } satisfies CreateInviteResponse,
      201,
    );
  })
  .get("/invites/:token", async (c) => {
    const invite = await c.var.db
      .select({ email: schema.invites.email })
      .from(schema.invites)
      .where(openInvite(await sha256Hex(c.req.param("token"))))
      .get();
    if (!invite) return c.json({ error: "This invite link is invalid or has been used" }, 404);
    return c.json({ email: invite.email } satisfies InviteInfoResponse);
  })
  .post("/invites/:tokeREDACTEDccept", async (c) => {
    const body = await readJsonObject(c);
    const name = str(body?.name).trim();
    const password = str(body?.password);
    if (!name || name.length > MAX_NAME_LENGTH) return c.json({ error: "Enter your name" }, 400);
    if (password.length < MIN_PASSWORD_LENGTH) {
      return c.json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` }, 400);
    }
    const inviteId = await sha256Hex(c.req.param("token"));
    const passwordHash = await hashPassword(password);

    // Claim the invite atomically so a link can only be used once.
    const [claimed] = await c.var.db
      .update(schema.invites)
      .set({ acceptedAt: Date.now() })
      .where(openInvite(inviteId))
      .returning({ email: schema.invites.email });
    if (!claimed) return c.json({ error: "This invite link is invalid or has been used" }, 404);

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

    const token = await createSession(c.var.db, user.id);
    c.header("Set-Cookie", serializeSessionCookie(token, { secure: isHttps(c) }));
    return c.json(
      { user: { id: user.id, email: user.email, name, isAdmin: false } } satisfies MeResponse,
      201,
    );
  });
