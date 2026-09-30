// Sessions live in D1. The cookie carries a random token; D1 stores only its SHA-256.
// Sessions last 30 days and slide: a session used more than a day after it was last
// extended gets a fresh 30 days (and a fresh cookie; `requireAuth`).
import { and, eq, gt, ne } from "drizzle-orm";
import type { UserDTO } from "../../shared/api";
import type { D1Db } from "../db/d1/client";
import { schema } from "../db/d1/client";
import { randomToken, sha256Hex } from "./bytes";
import { SESSION_TTL_MS } from "./cookie";

/** Extend a session once it's this old since its last extension. */
export const SESSION_REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;

export async function createSession(db: D1Db, userId: string, now = Date.now()): Promise<string> {
  const token = randomToken();
  await db.insert(schema.sessions).values({
    id: await sha256Hex(token),
    userId,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  });
  return token;
}

export interface SessionInfo {
  /** SHA-256 of the token (the row id; WebSocket tag `session:<id>`). */
  id: string;
  user: UserDTO;
  expiresAt: number;
}

export async function getSession(
  db: D1Db,
  token: string,
  now = Date.now(),
): Promise<SessionInfo | null> {
  const id = await sha256Hex(token);
  const row = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
      isAdmin: schema.users.isAdmin,
      expiresAt: schema.sessions.expiresAt,
    })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(and(eq(schema.sessions.id, id), gt(schema.sessions.expiresAt, now)))
    .get();
  if (!row) return null;
  const { expiresAt, ...user } = row;
  return { id, user, expiresAt };
}

export async function getSessionUser(db: D1Db, token: string): Promise<UserDTO | null> {
  return (await getSession(db, token))?.user ?? null;
}

/**
 * Slide the session's expiry to 30 days from `now` if it was last extended over a day ago.
 * Returns true when it did (the caller re-sends the cookie with a fresh Max-Age).
 */
export async function maybeExtendSession(
  db: D1Db,
  session: SessionInfo,
  now = Date.now(),
): Promise<boolean> {
  if (session.expiresAt - now > SESSION_TTL_MS - SESSION_REFRESH_AFTER_MS) return false;
  await db
    .update(schema.sessions)
    .set({ expiresAt: now + SESSION_TTL_MS })
    .where(eq(schema.sessions.id, session.id));
  return true;
}

export async function deleteSession(db: D1Db, token: string): Promise<void> {
  await db.delete(schema.sessions).where(eq(schema.sessions.id, await sha256Hex(token)));
}

/**
 * Delete a user's sessions (all, or all but `keepId`). Returns the deleted session ids, so
 * the caller can close the sockets they opened.
 */
export async function deleteUserSessions(
  db: D1Db,
  userId: string,
  keepId?: string,
): Promise<string[]> {
  const rows = await db
    .delete(schema.sessions)
    .where(
      keepId
        ? and(eq(schema.sessions.userId, userId), ne(schema.sessions.id, keepId))
        : eq(schema.sessions.userId, userId),
    )
    .returning({ id: schema.sessions.id });
  return rows.map((r) => r.id);
}

/** The ids of the shows a user is a member of. */
export async function userShowIds(db: D1Db, userId: string): Promise<string[]> {
  const rows = await db
    .select({ showId: schema.memberships.showId })
    .from(schema.memberships)
    .where(eq(schema.memberships.userId, userId));
  return rows.map((r) => r.showId);
}

export function toUserDTO(row: typeof schema.users.$inferSelect): UserDTO {
  return { id: row.id, email: row.email, name: row.name, isAdmin: row.isAdmin };
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isPlausibleEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}
