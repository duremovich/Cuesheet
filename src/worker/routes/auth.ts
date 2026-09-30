import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { MeResponse, SessionResponse } from "../../shared/api";
import { clearSessionCookie, readSessionToken, serializeSessionCookie } from "../auth/cookie";
import { hashPassword, needsRehash, verifyPassword } from "../auth/password";
import {
  createSession,
  deleteSession,
  getSessionUser,
  normalizeEmail,
  toUserDTO,
} from "../auth/session";
import { schema } from "../db/d1/client";
import type { AppEnv } from "../types";
import { isHttps, readJsonObject, str } from "./util";

// Verifying against a throwaway hash when the email is unknown keeps response timing
// from revealing which emails have accounts.
let dummyHash: Promise<string> | undefined;

export const authRoutes = new Hono<AppEnv>()
  .post("/auth/login", async (c) => {
    const body = await readJsonObject(c);
    const email = normalizeEmail(str(body?.email));
    const password = str(body?.password);
    if (!email || !password) return c.json({ error: "Email and password are required" }, 400);
    // TODO(M5): rate-limit login attempts per email and per IP (e.g. a counter DO or the
    // Workers Rate Limiting binding) before doing the password check.

    const user = await c.var.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .get();
    if (!user) {
      dummyHash ??= hashPassword("not-a-real-password");
      await verifyPassword(password, await dummyHash);
      return c.json({ error: "Wrong email or password" }, 401);
    }
    if (!(await verifyPassword(password, user.passwordHash))) {
      return c.json({ error: "Wrong email or password" }, 401);
    }
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
    if (token) await deleteSession(c.var.db, token);
    c.header("Set-Cookie", clearSessionCookie({ secure: isHttps(c) }));
    return c.json({ ok: true });
  })
  // "Who am I?" is answered for everyone: signed out is `{ user: null }`, not an error, so
  // signed-out pages don't log 401s. Protected routes still use `requireAuth`.
  .get("/me", async (c) => {
    const token = readSessionToken(c.req.header("Cookie"));
    const user = token ? await getSessionUser(c.var.db, token) : null;
    return c.json({ user } satisfies SessionResponse);
  });
