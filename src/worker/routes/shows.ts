import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import {
  type CreateShowRequest,
  MAX_NAME_LENGTH,
  type Role,
  type ShowResponse,
  type ShowSummaryDTO,
  type ShowsResponse,
} from "../../shared/api";
import { requireAuth } from "../auth/middleware";
import { schema } from "../db/d1/client";
import { USER_ID_HEADER } from "../do/ShowDO";
import type { AppEnv } from "../types";
import { readJsonObject, str } from "./util";

function showStub(env: Env, showId: string) {
  return env.SHOW.get(env.SHOW.idFromName(showId));
}

type ShowEnv = AppEnv & {
  Variables: AppEnv["Variables"] & { show: { id: string; name: string }; role: Role };
};

/** 404 unless the show exists and the signed-in user is a member of it. */
const requireMembership = createMiddleware<ShowEnv>(async (c, next) => {
  const showId = c.req.param("id") ?? "";
  const row = await c.var.db
    .select({ id: schema.shows.id, name: schema.shows.name, role: schema.memberships.role })
    .from(schema.shows)
    .innerJoin(schema.memberships, eq(schema.memberships.showId, schema.shows.id))
    .where(and(eq(schema.shows.id, showId), eq(schema.memberships.userId, c.var.user.id)))
    .get();
  // Same response for "no such show" and "not a member": don't leak show IDs.
  if (!row) return c.json({ error: "Show not found" }, 404);
  c.set("show", { id: row.id, name: row.name });
  c.set("role", row.role);
  await next();
});

export const showRoutes = new Hono<ShowEnv>()
  .use("/shows", requireAuth)
  .use("/shows/*", requireAuth)
  .get("/shows", async (c) => {
    const rows = await c.var.db
      .select({
        id: schema.shows.id,
        name: schema.shows.name,
        createdAt: schema.shows.createdAt,
        role: schema.memberships.role,
      })
      .from(schema.memberships)
      .innerJoin(schema.shows, eq(schema.shows.id, schema.memberships.showId))
      .where(eq(schema.memberships.userId, c.var.user.id))
      .orderBy(desc(schema.shows.createdAt));
    return c.json({ shows: rows satisfies ShowSummaryDTO[] } satisfies ShowsResponse);
  })
  .post("/shows", async (c) => {
    const body = (await readJsonObject(c)) as Partial<CreateShowRequest> | null;
    const name = str(body?.name).trim();
    if (!name || name.length > MAX_NAME_LENGTH) {
      return c.json({ error: `Show name must be 1–${MAX_NAME_LENGTH} characters` }, 400);
    }
    const id = crypto.randomUUID();
    const createdAt = Date.now();
    await c.var.db.batch([
      c.var.db.insert(schema.shows).values({ id, name, createdBy: c.var.user.id, createdAt }),
      c.var.db
        .insert(schema.memberships)
        .values({ showId: id, userId: c.var.user.id, role: "editor", createdAt }),
    ]);
    await showStub(c.env, id).sync(id, name);
    const show: ShowSummaryDTO = { id, name, role: "editor", createdAt };
    return c.json({ show }, 201);
  })
  .get("/shows/:id", requireMembership, async (c) => {
    // D1 `shows.name` is the source of truth; opening a show refreshes the DO's cached copy
    // (and creates it if the DO init failed after the D1 insert).
    const meta = await showStub(c.env, c.var.show.id).sync(c.var.show.id, c.var.show.name);
    return c.json({ show: meta, role: c.var.role } satisfies ShowResponse);
  })
  .get("/shows/:id/ws", requireMembership, async (c) => {
    if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
      return c.json({ error: "Expected a WebSocket upgrade" }, 426);
    }
    const headers = new Headers(c.req.raw.headers);
    headers.set(USER_ID_HEADER, c.var.user.id);
    return showStub(c.env, c.var.show.id).fetch(new Request(c.req.raw, { headers }));
  });
