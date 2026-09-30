// Sign-in and account security (R24).
//
// - Login is rate-limited per email and per IP (auth/rate-limit.ts: failed attempts, 10 a
//   minute and 50 an hour; 429 + Retry-After, the same message whatever the account).
// - Sessions last 30 days and slide (auth/session.ts); "Sign out everywhere" deletes all
//   of the user's sessions and closes all of their show sockets.
// - Password change (current + new, ≥ 10 characters) signs out the user's other sessions.
// - Admins make one-time reset links (`/reset/<token>`, a day), stored in `invites` with
//   kind "reset"; completing one sets the password and signs out everywhere else.
import { and, eq, gt, isNull } from "drizzle-orm";
import { Hono } from "hono";
import type {
  ChangePasswordRequest,
  CreateResetLinkResponse,
  ResetLinkInfoResponse,
} from "../../shared/account";
import { RESET_TTL_MS } from "../../shared/account";
import { type MeResponse, MIN_PASSWORD_LENGTH, type SessionResponse } from "../../shared/api";
import { randomToken, sha256Hex } from "../auth/bytes";
import { clearSessionCookie, readSessionToken, serializeSessionCookie } from "../auth/cookie";
import { requireAdmin, requireAuth } from "../auth/middleware";
import { hashPassword, needsRehash, verifyPassword } from "../auth/password";
import { clearKey, clientIp, recordFailure, retryAfter, tooMany } from "../auth/rate-limit";
import {
  createSession,
  deleteSession,
  deleteUserSessions,
  getSessionUser,
  normalizeEmail,
  toUserDTO,
  userShowIds,
} from "../auth/session";
import { type D1Db, schema } from "../db/d1/client";
import type { AppEnv } from "../types";
import { showStub } from "./shows";
import { isHttps, readJsonObject, str } from "./util";

/**
 * Close the show sockets that some of a user's sessions opened (that browser signed out,
 * or its session was revoked). Sockets are tagged with their session, so the user's other
 * browsers and devices stay connected: the client treats `revoked` as terminal.
 */
async function disconnectSessions(env: Env, db: D1Db, userId: string, sessionIds: string[]) {
  if (sessionIds.length === 0) return;
  const shows = await userShowIds(db, userId);
  await Promise.all(
    shows.flatMap((showId) => sessionIds.map((id) => showStub(env, showId).disconnectSession(id))),
  );
}

/** Close every show socket of a user (signed out everywhere, password reset). */
async function disconnectUser(env: Env, db: D1Db, userId: string) {
  const shows = await userShowIds(db, userId);
  await Promise.all(shows.map((showId) => showStub(env, showId).disconnectUser(userId)));
}

// Verifying against a throwaway hash when the email is unknown keeps response timing
// from revealing which emails have accounts.
let dummyHash: Promise<string> | undefined;

const WRONG_LOGIN = "Wrong email or password";
const BAD_RESET = "This reset link is invalid or has been used";

function openReset(id: string) {
  return and(
    eq(schema.invites.id, id),
    eq(schema.invites.kind, "reset"),
    isNull(schema.invites.acceptedAt),
    gt(schema.invites.expiresAt, Date.now()),
  );
}

export const authRoutes = new Hono<AppEnv>()
  .post("/auth/login", async (c) => {
    const body = await readJsonObject(c);
    const email = normalizeEmail(str(body?.email));
    const password = str(body?.password);
    if (!email || !password) return c.json({ error: "Email and password are required" }, 400);

    const now = Date.now();
    const emailKey = `login:email:${email}`;
    const keys = [emailKey, `login:ip:${clientIp(c)}`];
    const wait = await retryAfter(c.env.DB, keys, now);
    if (wait > 0) return tooMany(c, wait);

    const user = await c.var.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .get();
    if (!user) {
      dummyHash ??= hashPassword("not-a-real-password");
      await verifyPassword(password, await dummyHash);
      await recordFailure(c.env.DB, keys, now);
      return c.json({ error: WRONG_LOGIN }, 401);
    }
    if (!(await verifyPassword(password, user.passwordHash))) {
      await recordFailure(c.env.DB, keys, now);
      return c.json({ error: WRONG_LOGIN }, 401);
    }
    // A typo or two before getting it right shouldn't count against the account later.
    await clearKey(c.env.DB, emailKey);
    if (needsRehash(user.passwordHash)) {
      // Upgrade to the current hashing parameters while we have the plaintext.
      await c.var.db
        .update(schema.users)
        .set({ passwordHash: await hashPassword(password) })
        .where(eq(schema.users.id, user.id));
    }
    const token = await createSession(c.var.db, user.id);
    c.header("Set-Cookie", serializeSessionCookie(token, { secure: isHttps(c) }));
    return c.json({ user: toUserDTO(user) } satisfies MeResponse);
  })
  .post("/auth/logout", async (c) => {
    // Logout works (and clears the cookie) even if the session is already gone.
    const token = readSessionToken(c.req.header("Cookie"));
    if (token) {
      const user = await getSessionUser(c.var.db, token);
      await deleteSession(c.var.db, token);
      if (user) await disconnectSessions(c.env, c.var.db, user.id, [await sha256Hex(token)]);
    }
    c.header("Set-Cookie", clearSessionCookie({ secure: isHttps(c) }));
    return c.json({ ok: true });
  })
  // Sign out everywhere: every session of this user, and every show socket they have open.
  .post("/auth/logout-all", requireAuth, async (c) => {
    const ids = await deleteUserSessions(c.var.db, c.var.user.id);
    await disconnectUser(c.env, c.var.db, c.var.user.id);
    c.header("Set-Cookie", clearSessionCookie({ secure: isHttps(c) }));
    return c.json({ ok: true, sessions: ids.length });
  })
  .post("/auth/password", requireAuth, async (c) => {
    const body = (await readJsonObject(c)) as Partial<ChangePasswordRequest> | null;
    const current = str(body?.currentPassword);
    const next = str(body?.newPassword);
    if (next.length < MIN_PASSWORD_LENGTH) {
      return c.json(
        { error: `The new password must be at least ${MIN_PASSWORD_LENGTH} characters` },
        400,
      );
    }
    const now = Date.now();
    const keys = [`password:user:${c.var.user.id}`];
    const wait = await retryAfter(c.env.DB, keys, now);
    if (wait > 0) return tooMany(c, wait);
    const row = await c.var.db
      .select({ hash: schema.users.passwordHash })
      .from(schema.users)
      .where(eq(schema.users.id, c.var.user.id))
      .get();
    if (!row || !(await verifyPassword(current, row.hash))) {
      await recordFailure(c.env.DB, keys, now);
      return c.json({ error: "The current password is wrong" }, 400);
    }
    await c.var.db
      .update(schema.users)
      .set({ passwordHash: await hashPassword(next) })
      .where(eq(schema.users.id, c.var.user.id));
    // Everyone else holding a session of this account is signed out; this browser stays.
    const keep = await sha256Hex(c.var.sessionToken);
    const ended = await deleteUserSessions(c.var.db, c.var.user.id, keep);
    await disconnectSessions(c.env, c.var.db, c.var.user.id, ended);
    return c.json({ ok: true, sessionsEnded: ended.length });
  })
  // "Who am I?" is answered for everyone: signed out is `{ user: null }`, not an error, so
  // signed-out pages don't log 401s. Protected routes still use `requireAuth`.
  .get("/me", async (c) => {
    const token = readSessionToken(c.req.header("Cookie"));
    const user = token ? await getSessionUser(c.var.db, token) : null;
    return c.json({ user } satisfies SessionResponse);
  })

  // ---- admin password reset links ----
  .post("/admin/password-resets", requireAuth, requireAdmin, async (c) => {
    const body = await readJsonObject(c);
    const email = normalizeEmail(str(body?.email));
    const user = await c.var.db
      .select({ id: schema.users.id, email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .get();
    if (!user) return c.json({ error: "No account with that email" }, 404);
    const token = randomToken();
    const expiresAt = Date.now() + RESET_TTL_MS;
    await c.var.db.insert(schema.invites).values({
      id: await sha256Hex(token),
      email: user.email,
      invitedBy: c.var.user.id,
      expiresAt,
      kind: "reset",
      userId: user.id,
    });
    return c.json(
      { email: user.email, path: `/reset/${token}`, expiresAt } satisfies CreateResetLinkResponse,
      201,
    );
  })
  .get("/password-resets/:token", async (c) => {
    const now = Date.now();
    const keys = [`reset:ip:${clientIp(c)}`];
    const wait = await retryAfter(c.env.DB, keys, now);
    if (wait > 0) return tooMany(c, wait);
    const link = await c.var.db
      .select({ email: schema.invites.email })
      .from(schema.invites)
      .where(openReset(await sha256Hex(c.req.param("token"))))
      .get();
    if (!link) {
      await recordFailure(c.env.DB, keys, now);
      return c.json({ error: BAD_RESET }, 404);
    }
    return c.json({ email: link.email } satisfies ResetLinkInfoResponse);
  })
  .post("/password-resets/:token", async (c) => {
    const body = await readJsonObject(c);
    const password = str(body?.password);
    if (password.length < MIN_PASSWORD_LENGTH) {
      return c.json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` }, 400);
    }
    const now = Date.now();
    const keys = [`reset:ip:${clientIp(c)}`];
    const wait = await retryAfter(c.env.DB, keys, now);
    if (wait > 0) return tooMany(c, wait);
    const passwordHash = await hashPassword(password);
    // Claim it atomically so a link works once.
    const [claimed] = await c.var.db
      .update(schema.invites)
      .set({ acceptedAt: now })
      .where(openReset(await sha256Hex(c.req.param("token"))))
      .returning({ userId: schema.invites.userId });
    const user = claimed?.userId
      ? await c.var.db
          .update(schema.users)
          .set({ passwordHash })
          .where(eq(schema.users.id, claimed.userId))
          .returning()
          .get()
      : undefined;
    if (!user) {
      await recordFailure(c.env.DB, keys, now);
      return c.json({ error: BAD_RESET }, 404);
    }
    await deleteUserSessions(c.var.db, user.id);
    await disconnectUser(c.env, c.var.db, user.id);
    await clearKey(c.env.DB, `login:email:${user.email}`);
    const token = await createSession(c.var.db, user.id);
    c.header("Set-Cookie", serializeSessionCookie(token, { secure: isHttps(c) }));
    return c.json({ user: toUserDTO(user) } satisfies MeResponse);
  });
