// Sessions live in D1. The cookie carries a random token; D1 stores only its SHA-256.
import { and, eq, gt } from "drizzle-orm";
import type { UserDTO } from "../../shared/api";
import type { D1Db } from "../db/d1/client";
import { schema } from "../db/d1/client";
import { randomToken, sha256Hex } from "./bytes";
import { SESSION_TTL_MS } from "./cookie";

export async function createSession(db: D1Db, userId: string): Promise<string> {
  const token = randomToken();
  await db.insert(schema.sessions).values({
    id: await sha256Hex(token),
    userId,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  return token;
}

export async function getSessionUser(db: D1Db, token: string): Promise<UserDTO | null> {
  const row = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
      isAdmin: schema.users.isAdmin,
    })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(
      and(
        eq(schema.sessions.id, await sha256Hex(token)),
        gt(schema.sessions.expiresAt, Date.now()),
      ),
    )
    .get();
  return row ?? null;
}

export async function deleteSession(db: D1Db, token: string): Promise<void> {
  await db.delete(schema.sessions).where(eq(schema.sessions.id, await sha256Hex(token)));
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
