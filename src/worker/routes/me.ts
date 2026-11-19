// Your own account: the display name and the login email.
//
// - `PATCH /api/me {name}`: rename yourself (the invite-accept rule: trimmed, 1–200). Names
//   are read from D1 wherever they're shown, except show presence, which keeps each socket's
//   name: open sockets are told (`ShowDO.notifyName`).
// - Changing the login email: `POST /api/me/email {newEmail, currentPassword}` checks the
//   password (rate-limited on the same per-account key as a password change), refuses your
//   own address (400) and one another account uses (409), and emails a one-time link
//   (`/confirm-email/<token>`, 24 h) to the NEW address. The link is stored hashed in
//   `invites` (kind "email", `user_id`), never returned or logged, so only whoever reads
//   that mailbox can confirm. A new request (or `…/resend`) revokes the earlier link;
//   `DELETE /api/me/email` cancels. Every send counts toward `emailChangeLimits`.
// - Confirming (`GET`/`POST /api/email-changes/:token`) needs no session (the password was
//   proven at request time; opening the link proves the new address). The unique index on
//   `users.email` is the re-check that the address is still free (409 on a race), and the
//   old address is told. Bad tokens are rate-limited per IP.
import { and, eq, exists, gt, isNull, sql } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import {
  type ChangeEmailResponse,
  type ConfirmEmailChangeResponse,
  EMAIL_CHANGE_TTL_MS,
  type EmailChangeInfoResponse,
  type PendingEmailChange,
} from "../../shared/account";
import type { MeResponse } from "../../shared/api";
import { randomToken, sha256Hex } from "../auth/bytes";
import { requireAuth } from "../auth/middleware";
import { verifyPassword } from "../auth/password";
import {
  clientIp,
  emailChangeLimits,
  recordFailure,
  retryAfter,
  tooMany,
} from "../auth/rate-limit";
import {
  cleanName,
  isPlausibleEmail,
  normalizeEmail,
  toUserDTO,
  userShowIds,
} from "../auth/session";
import { type D1Db, schema } from "../db/d1/client";
import { appOrigin, emailChangedEmail, emailChangeEmail, sendEmail } from "../email";
import type { AppEnv } from "../types";
import { showStub } from "./shows";
import { readJsonObject, str } from "./util";

const inv = schema.invites;
const BAD_LINK = "This confirmation link is invalid, expired or has been used";
const TAKEN = "Another account already uses that email";

/** An email-change link that can still be confirmed (by id), or a user's (by userId). */
function openChange(by: { id: string } | { userId: string }) {
  return and(
    "id" in by ? eq(inv.id, by.id) : eq(inv.userId, by.userId),
    eq(inv.kind, "email"),
    isNull(inv.acceptedAt),
    isNull(inv.revokedAt),
    gt(inv.expiresAt, Date.now()),
  );
}

/** The user's pending login-email change, if any (GET /api/me/access). */
export async function pendingEmailChange(
  db: D1Db,
  userId: string,
): Promise<PendingEmailChange | null> {
  const row = await db
    .select({ email: inv.email, expiresAt: inv.expiresAt })
    .from(inv)
    .where(openChange({ userId }))
    .orderBy(inv.createdAt)
    .get();
  return row ?? null;
}

async function revokeChanges(db: D1Db, userId: string): Promise<void> {
  await db
    .update(inv)
    .set({ revokedAt: Date.now() })
    .where(
      and(
        eq(inv.userId, userId),
        eq(inv.kind, "email"),
        isNull(inv.acceptedAt),
        isNull(inv.revokedAt),
      ),
    );
}

/**
 * Revoke the user's earlier link, make a new one for `newEmail` and email it there. Every
 * send counts toward the account's limit. The link is only in the email.
 */
async function sendChangeLink(c: Context<AppEnv>, newEmail: string): Promise<ChangeEmailResponse> {
  const db = c.var.db;
  const user = c.var.user;
  await revokeChanges(db, user.id);
  const token = randomToken();
  const id = await sha256Hex(token);
  const expiresAt = Date.now() + EMAIL_CHANGE_TTL_MS;
  await db.insert(inv).values({
    id,
    email: newEmail,
    invitedBy: user.id,
    userId: user.id,
    kind: "email",
    expiresAt,
  });
  await recordFailure(c.env.DB, [emailChangeLimits(user.id)], Date.now());
  const emailed = await sendEmail(
    c.env,
    emailChangeEmail({
      to: newEmail,
      name: user.name,
      oldEmail: user.email,
      refId: id,
      link: `${appOrigin(c.env, c.req.url)}/confirm-email/${token}`,
      expiresAt,
    }),
  );
  const pending = { email: newEmail, expiresAt };
  if (emailed) return { pending, emailed };
  return {
    pending,
    emailed,
    message: (c.env as { RESEND_API_KEY?: string }).RESEND_API_KEY
      ? "The confirmation email couldn't be sent. Try Resend in a few minutes, or ask your admin."
      : "Email isn't set up on this Cuesheet, so no confirmation was sent and the change can't be confirmed. Ask your admin to set up email.",
  };
}

/** 429 when the account has triggered too many confirmation emails, else null. */
async function sendLimited(c: Context<AppEnv>): Promise<Response | null> {
  const wait = await retryAfter(c.env.DB, [emailChangeLimits(c.var.user.id)], Date.now());
  return wait > 0 ? tooMany(c, wait, "confirmation emails") : null;
}

function isUniqueViolation(e: unknown): boolean {
  const text = e instanceof Error ? `${e.message} ${String(e.cause ?? "")}` : String(e);
  return /UNIQUE constraint failed/i.test(text);
}

export const meRoutes = new Hono<AppEnv>()
  .patch("/me", requireAuth, async (c) => {
    const body = await readJsonObject(c);
    const name = cleanName(body?.name);
    if (!name) return c.json({ error: "Enter your name" }, 400);
    const row = await c.var.db
      .update(schema.users)
      .set({ name })
      .where(eq(schema.users.id, c.var.user.id))
      .returning()
      .get();
    if (!row) return c.json({ error: "Not signed in" }, 401);
    const shows = await userShowIds(c.var.db, row.id);
    await Promise.all(shows.map((showId) => showStub(c.env, showId).notifyName(row.id, name)));
    return c.json({ user: toUserDTO(row) } satisfies MeResponse);
  })
  .post("/me/email", requireAuth, async (c) => {
    const body = await readJsonObject(c);
    const newEmail = normalizeEmail(str(body?.newEmail));
    if (!isPlausibleEmail(newEmail)) return c.json({ error: "Enter a valid email address" }, 400);
    const now = Date.now();
    // The same key as a password change: both are guesses at this account's password.
    const keys = [`password:user:${c.var.user.id}`];
    const wait = await retryAfter(c.env.DB, keys, now);
    if (wait > 0) return tooMany(c, wait);
    const row = await c.var.db
      .select({ hash: schema.users.passwordHash, email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, c.var.user.id))
      .get();
    if (!row || !(await verifyPassword(str(body?.currentPassword), row.hash))) {
      await recordFailure(c.env.DB, keys, now);
      return c.json({ error: "The current password is wrong" }, 400);
    }
    if (newEmail === row.email) return c.json({ error: "That's already your login email" }, 400);
    const taken = await c.var.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, newEmail))
      .get();
    if (taken) return c.json({ error: TAKEN }, 409);
    const limited = await sendLimited(c);
    if (limited) return limited;
    return c.json(await sendChangeLink(c, newEmail));
  })
  // A new link to the pending address (the old one dies); the password was proven already.
  .post("/me/email/resend", requireAuth, async (c) => {
    const pending = await pendingEmailChange(c.var.db, c.var.user.id);
    if (!pending) return c.json({ error: "No email change is waiting" }, 404);
    const limited = await sendLimited(c);
    if (limited) return limited;
    return c.json(await sendChangeLink(c, pending.email));
  })
  .delete("/me/email", requireAuth, async (c) => {
    await revokeChanges(c.var.db, c.var.user.id);
    return c.json({ ok: true });
  })
  .get("/email-changes/:token", async (c) => {
    const now = Date.now();
    const keys = [`email-change:ip:${clientIp(c)}`];
    const wait = await retryAfter(c.env.DB, keys, now);
    if (wait > 0) return tooMany(c, wait);
    const link = await c.var.db
      .select({ email: inv.email })
      .from(inv)
      .where(openChange({ id: await sha256Hex(c.req.param("token")) }))
      .get();
    if (!link) {
      await recordFailure(c.env.DB, keys, now);
      return c.json({ error: BAD_LINK }, 404);
    }
    return c.json({ email: link.email } satisfies EmailChangeInfoResponse);
  })
  .post("/email-changes/:token", async (c) => {
    const now = Date.now();
    const keys = [`email-change:ip:${clientIp(c)}`];
    const wait = await retryAfter(c.env.DB, keys, now);
    if (wait > 0) return tooMany(c, wait);
    const id = await sha256Hex(c.req.param("token"));
    const db = c.var.db;
    const link = await db
      .select({ userId: inv.userId, email: inv.email })
      .from(inv)
      .where(openChange({ id }))
      .get();
    const user = link?.userId
      ? await db.select().from(schema.users).where(eq(schema.users.id, link.userId)).get()
      : undefined;
    if (!link || !user) {
      await recordFailure(c.env.DB, keys, now);
      return c.json({ error: BAD_LINK }, 404);
    }
    // One transaction: the email moves only while the link is still open, and the link is
    // used only if it did. The unique index on users.email refuses an address someone
    // took meanwhile (the whole batch rolls back; the link stays pending).
    let changed: { email: string }[];
    try {
      const [moved] = await db.batch([
        db
          .update(schema.users)
          .set({ email: link.email })
          .where(
            and(
              eq(schema.users.id, user.id),
              eq(schema.users.email, user.email),
              exists(db.select({ one: sql`1` }).from(inv).where(openChange({ id }))),
            ),
          )
          .returning({ email: schema.users.email }),
        db.update(inv).set({ acceptedAt: now }).where(openChange({ id })),
      ]);
      changed = moved;
    } catch (e) {
      if (isUniqueViolation(e)) return c.json({ error: TAKEN }, 409);
      throw e;
    }
    if (changed.length === 0) {
      await recordFailure(c.env.DB, keys, now);
      return c.json({ error: BAD_LINK }, 404);
    }
    await sendEmail(
      c.env,
      emailChangedEmail({
        to: user.email,
        name: user.name,
        newEmail: link.email,
        link: `${appOrigin(c.env, c.req.url)}/login`,
      }),
    );
    return c.json({ email: link.email } satisfies ConfirmEmailChangeResponse);
  });
