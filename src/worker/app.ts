// The Hono app: every /api route. Pages are served by src/worker/index.ts from the static
// assets (with security headers); see `assets` in wrangler.jsonc.
import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { seedAdmin } from "./auth/middleware";
import { getDb } from "./db/d1/client";
import { authRoutes } from "./routes/auth";
import { inviteRoutes } from "./routes/invites";
import { shareRoutes } from "./routes/share";
import { showRoutes } from "./routes/shows";
import { baseSecurityHeaders, logError, redactTokens } from "./security";
import type { AppEnv } from "./types";

export const app = new Hono<AppEnv>().basePath("/api");

app.use(async (c, next) => {
  await next();
  // Not on WebSocket upgrades (101), whose headers can't change.
  if (c.res.status === 101) return;
  try {
    baseSecurityHeaders(c.res.headers, new URL(c.req.url).protocol === "https:");
  } catch {
    // A response passed through with immutable headers: leave it as it is.
  }
});

/**
 * Health first: no auth. Checks that D1 answers and that a Durable Object (a fixed probe
 * object, never a show) starts and runs SQL. 503 with the failing part otherwise.
 */
app.get("/health", async (c) => {
  const checks = { d1: false, do: false };
  try {
    await c.env.DB.prepare("SELECT 1").first();
    checks.d1 = true;
  } catch (e) {
    logError("health: D1", e);
  }
  try {
    await c.env.SHOW.get(c.env.SHOW.idFromName("__health__")).ping();
    checks.do = true;
  } catch (e) {
    logError("health: DO", e);
  }
  const ok = checks.d1 && checks.do;
  c.header("Cache-Control", "no-store");
  return c.json({ ok, ...checks }, ok ? 200 : 503);
});

/**
 * CSP violation reports (report-uri / report-to): logged, token-redacted, 204. Before the
 * CSRF check: browsers send them cross-context with their own content types.
 */
app.post("/csp-report", async (c) => {
  const len = Number(c.req.header("Content-Length") ?? "0");
  if (len > 0 && len <= 16 * 1024) {
    const body = await c.req.text().catch(() => "");
    console.warn("csp-report", redactTokens(body.slice(0, 16 * 1024)));
  }
  return c.body(null, 204);
});

// Reject cross-origin form posts (SameSite=Lax already blocks most CSRF; this is belt and braces).
app.use(csrf());
app.use(async (c, next) => {
  c.set("db", getDb(c.env));
  await next();
});
app.use(seedAdmin);

app.route("/", authRoutes);
app.route("/", showRoutes);
app.route("/", shareRoutes);
app.route("/", inviteRoutes);

app.notFound((c) => c.json({ error: "Not found" }, 404));
app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message || "Request rejected" }, err.status);
  }
  logError(`${c.req.method} ${new URL(c.req.url).pathname}`, err);
  return c.json({ error: "Internal error" }, 500);
});
