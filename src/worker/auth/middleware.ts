import { count } from "drizzle-orm";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { schema } from "../db/d1/client";
import { isHttps } from "../routes/util";
import type { AppEnv } from "../types";
import { readSessionToken, serializeSessionCookie } from "./cookie";
import { hashPassword } from "./password";
import { getSession, maybeExtendSession, normalizeEmail, type SessionInfo } from "./session";

/**
 * The request's session, if its cookie is valid; slides the session's expiry (30 days
 * from now, at most once a day) and re-sends the cookie when it does.
 */
export async function sessionOf(c: Context<AppEnv>): Promise<SessionInfo | null> {
  const token = readSessionToken(c.req.header("Cookie"));
  const session = token ? await getSession(c.var.db, token) : null;
  if (!token || !session) return null;
  c.set("user", session.user);
  c.set("sessionToken", token);
  if (await maybeExtendSession(c.var.db, session)) {
    c.header("Set-Cookie", serializeSessionCookie(token, { secure: isHttps(c) }), {
      append: true,
    });
  }
  return session;
}

/** 401 unless the request carries a valid session cookie. Sets `user` and `sessionToken`. */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  if (!(await sessionOf(c))) return c.json({ error: "Not signed in" }, 401);
  await next();
});

export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.var.user?.isAdmin) return c.json({ error: "Admins only" }, 403);
  await next();
});

let seeded = false;

/**
 * Bootstrap: if the users table is empty and ADMIN_EMAIL / ADMIN_PASSWORD are set
 * (.dev.vars locally, secrets in production), create that admin. Runs at most once
 * per isolate; the unique email index makes concurrent attempts harmless.
 */
export const seedAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (!seeded) {
    const email = c.env.ADMIN_EMAIL ? normalizeEmail(c.env.ADMIN_EMAIL) : "";
    const password = c.env.ADMIN_PASSWORD ?? "";
    if (email && password) {
      const [row] = await c.var.db.select({ n: count() }).from(schema.users);
      if ((row?.n ?? 0) === 0) {
        await c.var.db
          .insert(schema.users)
          .values({
            id: crypto.randomUUID(),
            email,
            name: "Admin",
            passwordHash: await hashPassword(password),
            isAdmin: true,
          })
          .onConflictDoNothing();
      }
    }
    seeded = true;
  }
  await next();
});
