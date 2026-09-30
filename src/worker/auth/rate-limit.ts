// Sliding-window rate limiting (R24) over the D1 table `rate_limit_events`: one row per
// counted event under a key (`login:email:<email>`, `login:ip:<ip>`, `share:ip:<ip>`, …).
// A key is over its limit when a window holds `max` events already; the caller answers
// 429 with `Retry-After` (seconds until the oldest event in the full window leaves it).
//
// Only *failures* are counted (a wrong password, an unknown invite / reset / share token),
// so a team signing in all day behind one office IP never trips it, and a locked key frees
// itself as its failures age out. Every check takes `now`, so tests move time freely.
import type { Context } from "hono";

export interface Window {
  /** Window length in ms. */
  ms: number;
  /** Events allowed per window. */
  max: number;
}

/** 10 a minute and 50 an hour (per key). */
export const DEFAULT_WINDOWS: readonly Window[] = [
  { ms: 60_000, max: 10 },
  { ms: 3_600_000, max: 50 },
];

/** A key and its windows; a bare string key uses DEFAULT_WINDOWS. */
export type Limit = string | { key: string; windows: readonly Window[] };

const keyOf = (l: Limit) => (typeof l === "string" ? l : l.key);
const windowsOf = (l: Limit) => (typeof l === "string" ? DEFAULT_WINDOWS : l.windows);

/** The longest window any key uses (rows older than this are never needed). */
export const LONGEST_WINDOW_MS = 3_600_000;
const LONGEST = (windows: readonly Window[]) => Math.max(...windows.map((w) => w.ms));

/**
 * Sign-in limits (R24): tight per email *and* IP (10 a minute, 50 an hour), so one attacker
 * can't lock someone out from elsewhere; looser per email alone (100 an hour, a spread-out
 * guessing attack) and per IP alone (50 an hour across emails).
 */
export function loginLimits(email: string, ip: string): Limit[] {
  return [
    `login:emailip:${email}|${ip}`,
    { key: `login:email:${email}`, windows: [{ ms: 3_600_000, max: 100 }] },
    { key: `login:ip:${ip}`, windows: [{ ms: 3_600_000, max: 50 }] },
  ];
}

/** Seconds to wait before `limits` may try again, or 0 if none is over a limit. */
export async function retryAfter(
  db: D1Database,
  limits: readonly Limit[],
  now: number,
): Promise<number> {
  let wait = 0;
  for (const limit of limits) {
    const key = keyOf(limit);
    for (const w of windowsOf(limit)) {
      // The `max`-th newest event inside the window: while it's in there, the window is full.
      const row = await db
        .prepare(
          "SELECT at FROM rate_limit_events WHERE key = ?1 AND at > ?2 ORDER BY at DESC LIMIT 1 OFFSET ?3",
        )
        .bind(key, now - w.ms, w.max - 1)
        .first<{ at: number }>();
      if (row) wait = Math.max(wait, Math.ceil((row.at + w.ms - now) / 1000));
    }
  }
  return wait;
}

/** Count one event for each key (and prune what's older than its longest window). */
export async function recordFailure(
  db: D1Database,
  limits: readonly Limit[],
  now: number,
): Promise<void> {
  await db.batch(
    limits.flatMap((limit) => {
      const key = keyOf(limit);
      const cutoff = now - LONGEST(windowsOf(limit));
      return [
        db.prepare("DELETE FROM rate_limit_events WHERE key = ?1 AND at <= ?2").bind(key, cutoff),
        db.prepare("INSERT INTO rate_limit_events (key, at) VALUES (?1, ?2)").bind(key, now),
      ];
    }),
  );
}

/**
 * Count a failure against `limits` at most once per `marker` per hour (a revoked share link
 * reopened by its rightful viewers shouldn't lock their office's IP out).
 */
export async function recordFailureOnce(
  db: D1Database,
  marker: string,
  limits: readonly Limit[],
  now: number,
): Promise<void> {
  const seen = await db
    .prepare("SELECT 1 AS x FROM rate_limit_events WHERE key = ?1 AND at > ?2 LIMIT 1")
    .bind(marker, now - 3_600_000)
    .first();
  if (seen) return;
  await recordFailure(db, [...limits, { key: marker, windows: [{ ms: 3_600_000, max: 1 }] }], now);
}

/** Forget a key's events (e.g. an email after a successful sign-in). */
export async function clearKey(db: D1Database, key: string): Promise<void> {
  await db.prepare("DELETE FROM rate_limit_events WHERE key = ?1").bind(key).run();
}

/** Drop every event older than the longest window (the scheduled handler). */
export async function pruneRateLimits(db: D1Database, now: number): Promise<void> {
  await db
    .prepare("DELETE FROM rate_limit_events WHERE at <= ?1")
    .bind(now - LONGEST_WINDOW_MS)
    .run();
}

/** The client's IP as Cloudflare reports it ("unknown" locally without the header). */
export function clientIp(c: Context): string {
  return c.req.header("CF-Connecting-IP") ?? "unknown";
}

/** A 429 with `Retry-After` and a message that says nothing about the account. */
export function tooMany(c: Context, seconds: number): Response {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  c.header("Retry-After", String(Math.max(1, seconds)));
  return c.json(
    {
      error: `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
    },
    429,
  );
}
