// The Hono app: every /api route. Static assets (the SPA) are served by the platform
// before the Worker runs; see `assets` in wrangler.jsonc.
import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { seedAdmin } from "./auth/middleware";
import { getDb } from "./db/d1/client";
import { authRoutes } from "./routes/auth";
import { inviteRoutes } from "./routes/invites";
import { showRoutes } from "./routes/shows";
import type { AppEnv } from "./types";

export const app = new Hono<AppEnv>().basePath("/api");

// Health first: no DB, no auth.
app.get("/health", (c) => c.json({ ok: true }));

// Reject cross-origin form posts (SameSite=Lax already blocks most CSRF; this is belt and braces).
app.use(csrf());
app.use(async (c, next) => {
  c.set("db", getDb(c.env));
  await next();
});
app.use(seedAdmin);

app.route("/", authRoutes);
app.route("/", showRoutes);
app.route("/", inviteRoutes);

app.notFound((c) => c.json({ error: "Not found" }, 404));
app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message || "Request rejected" }, err.status);
  }
  console.error(err);
  return c.json({ error: "Internal error" }, 500);
});
