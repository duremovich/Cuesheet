import { and, desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import {
  type CreateShowRequest,
  GRANTABLE_ROLES,
  MAX_NAME_LENGTH,
  MAX_SESSION_LENGTH,
  type MemberDTO,
  type MembersResponse,
  type Role,
  type ShowResponse,
  type ShowSummaryDTO,
  type ShowsResponse,
  type UpdateShowResponse,
} from "../../shared/api";
import type {
  HistoryResponse,
  ImportResponse,
  MutateError,
  MutateResponse,
} from "../../shared/ops";
import { sha256Hex } from "../auth/bytes";
import { requireAuth } from "../auth/middleware";
import { normalizeEmail } from "../auth/session";
import { schema } from "../db/d1/client";
import { RESERVED_KEYS } from "../do/ops-engine";
import { SESSION_ID_HEADER, USER_ID_HEADER } from "../do/ShowDO";
import { buildAirtableImport, type CsvFile } from "../import/airtable";
import type { AppEnv } from "../types";
import * as attachments from "./attachments";
import {
  declaredTooLarge,
  jsonBody,
  MAX_BODY_BYTES,
  readJsonObject,
  readJsonObjectLimited,
  str,
} from "./util";

/** Largest batch accepted by POST /mutate (import goes straight to the DO). */
export const MAX_OPS_PER_REQUEST = 1000;

export function showStub(env: Env, showId: string) {
  return env.SHOW.get(env.SHOW.idFromName(showId));
}

export type ShowEnv = AppEnv & {
  Variables: AppEnv["Variables"] & {
    show: { id: string; name: string; currentSession: string | null };
    role: Role;
  };
};

/** 404 unless the show exists and the signed-in user is a member of it. */
export const requireMembership = createMiddleware<ShowEnv>(async (c, next) => {
  const showId = c.req.param("id") ?? "";
  const row = await c.var.db
    .select({
      id: schema.shows.id,
      name: schema.shows.name,
      currentSession: schema.shows.currentSession,
      role: schema.memberships.role,
    })
    .from(schema.shows)
    .innerJoin(schema.memberships, eq(schema.memberships.showId, schema.shows.id))
    .where(and(eq(schema.shows.id, showId), eq(schema.memberships.userId, c.var.user.id)))
    .get();
  // Same response for "no such show" and "not a member": don't leak show IDs.
  if (!row) return c.json({ error: "Show not found" }, 404);
  c.set("show", { id: row.id, name: row.name, currentSession: row.currentSession });
  c.set("role", row.role);
  await next();
});

const requireOwner = createMiddleware<ShowEnv>(async (c, next) => {
  if (c.var.role !== "owner") return c.json({ error: "Only the show's owner can do that" }, 403);
  await next();
});

/**
 * WebSocket upgrades are exempt from CORS, and SameSite=Lax cookies are sent on them, so a
 * foreign page could otherwise open a socket as the user (cross-site WebSocket hijacking).
 * Browsers always send Origin on WebSocket handshakes; require it to be ours.
 */
const requireSameOriginUpgrade = createMiddleware<ShowEnv>(async (c, next) => {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    return c.json({ error: "Expected a WebSocket upgrade" }, 426);
  }
  if (c.req.header("Origin") !== new URL(c.req.url).origin) {
    return c.json({ error: "Cross-origin WebSocket refused" }, 403);
  }
  await next();
});

/**
 * True if a create/update op's `fields.custom` has a key that could pollute prototypes when
 * merged. Checked here, before the DO RPC (the op engine checks again).
 */
function hasReservedCustomKey(op: unknown): boolean {
  if (!op || typeof op !== "object") return false;
  const fields = (op as { fields?: unknown }).fields;
  if (!fields || typeof fields !== "object") return false;
  const custom = (fields as { custom?: unknown }).custom;
  if (!custom || typeof custom !== "object") return false;
  return Object.keys(custom).some((k) => RESERVED_KEYS.has(k));
}

function isGrantable(role: unknown): role is Role {
  return typeof role === "string" && (GRANTABLE_ROLES as readonly string[]).includes(role);
}

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
        .values({ showId: id, userId: c.var.user.id, role: "owner", createdAt }),
    ]);
    await showStub(c.env, id).sync(id, name);
    const show: ShowSummaryDTO = { id, name, role: "owner", createdAt };
    return c.json({ show }, 201);
  })
  .get("/shows/:id", requireMembership, async (c) => {
    // D1 `shows.name` is the source of truth; opening a show refreshes the DO's cached copy
    // (and creates it if the DO init failed after the D1 insert).
    const meta = await showStub(c.env, c.var.show.id).sync(c.var.show.id, c.var.show.name);
    return c.json({
      show: { ...meta, currentSession: c.var.show.currentSession },
      role: c.var.role,
    } satisfies ShowResponse);
  })
  // Rename (owner) and the current session label (editors and the owner). D1 is the source
  // of truth; the DO only relays the change to open sockets.
  .patch("/shows/:id", requireMembership, async (c) => {
    const body = await readJsonObject(c);
    if (!body) return c.json({ error: "Expected a JSON object" }, 400);
    const canEdit = c.var.role === "owner" || c.var.role === "editor";
    const set: { name?: string; currentSession?: string | null } = {};
    if ("name" in body) {
      if (c.var.role !== "owner") {
        return c.json({ error: "Only the show's owner can rename it" }, 403);
      }
      const name = str(body.name).trim();
      if (!name || name.length > MAX_NAME_LENGTH) {
        return c.json({ error: `Show name must be 1–${MAX_NAME_LENGTH} characters` }, 400);
      }
      set.name = name;
    }
    if ("current_session" in body) {
      if (!canEdit) return c.json({ error: "Only editors can set the session" }, 403);
      const raw = body.current_session;
      if (raw !== null && typeof raw !== "string") {
        return c.json({ error: "current_session must be a string or null" }, 400);
      }
      const session = (raw ?? "").trim();
      if (session.length > MAX_SESSION_LENGTH) {
        return c.json({ error: `Session must be at most ${MAX_SESSION_LENGTH} characters` }, 400);
      }
      set.currentSession = session || null;
    }
    if (Object.keys(set).length === 0) {
      return c.json({ error: "Nothing to change (name, current_session)" }, 400);
    }
    const updated = await c.var.db
      .update(schema.shows)
      .set(set)
      .where(eq(schema.shows.id, c.var.show.id))
      .returning({
        id: schema.shows.id,
        name: schema.shows.name,
        currentSession: schema.shows.currentSession,
      })
      .get();
    if (!updated) return c.json({ error: "Show not found" }, 404);
    await showStub(c.env, c.var.show.id).notifyShow({
      name: updated.name,
      currentSession: updated.currentSession,
    });
    return c.json({ show: updated } satisfies UpdateShowResponse);
  })
  .get("/shows/:id/ws", requireSameOriginUpgrade, requireMembership, async (c) => {
    const headers = new Headers(c.req.raw.headers);
    headers.set(USER_ID_HEADER, c.var.user.id);
    // So logout can close exactly this browser's sockets (ShowDO.disconnectSession).
    headers.set(SESSION_ID_HEADER, await sha256Hex(c.var.sessionToken));
    return showStub(c.env, c.var.show.id).fetch(new Request(c.req.raw, { headers }));
  })

  // ---- show data ----
  .get("/shows/:id/snapshot", requireMembership, async (c) => {
    const snap = await showStub(c.env, c.var.show.id).snapshotJson(c.var.user.id);
    return c.body(snap, 200, { "Content-Type": "application/json" });
  })
  .post("/shows/:id/mutate", requireMembership, async (c) => {
    const body = await readJsonObjectLimited(c);
    if (body === "too-large") {
      return c.json({ error: `Request body over ${MAX_BODY_BYTES / 1024 / 1024} MB` }, 413);
    }
    const ops = body?.ops;
    const clientId = str(body?.clientId);
    if (!Array.isArray(ops))
      return c.json({ error: "ops must be an array" } satisfies MutateError, 400);
    if (clientId.length > 64) return c.json({ error: "clientId is too long" }, 400);
    if (ops.length > MAX_OPS_PER_REQUEST) {
      return c.json({ error: `At most ${MAX_OPS_PER_REQUEST} ops per request` }, 400);
    }
    const reserved = ops.findIndex(hasReservedCustomKey);
    if (reserved >= 0) {
      return c.json(
        {
          error: "custom field keys __proto__, constructor and prototype are not allowed",
          opIndex: reserved,
        } satisfies MutateError,
        400,
      );
    }
    // Viewers get through to the DO: they may manage their own personal views, and the op
    // engine refuses everything else per op (403).
    const res = await showStub(c.env, c.var.show.id).mutate(
      { userId: c.var.user.id, role: c.var.role, clientId: clientId || null },
      ops,
    );
    if (!res.ok) {
      const err: MutateError = { error: res.error };
      if (res.opIndex !== undefined) err.opIndex = res.opIndex;
      return c.json(err, res.status);
    }
    const { ok: _ok, ...out } = res;
    return jsonBody<MutateResponse>(c, out);
  })
  .get("/shows/:id/history", requireMembership, async (c) => {
    const limit = Number.parseInt(c.req.query("limit") ?? "", 10);
    const changes = await showStub(c.env, c.var.show.id).history(
      {
        table: c.req.query("table") || undefined,
        id: c.req.query("id") || undefined,
        limit: Number.isFinite(limit) ? limit : undefined,
      },
      c.var.user.id,
    );
    const ids = [...new Set(changes.map((ch) => ch.userId))];
    const users = ids.length
      ? await c.var.db
          .select({ id: schema.users.id, name: schema.users.name })
          .from(schema.users)
          .where(inArray(schema.users.id, ids))
      : [];
    const names = new Map(users.map((u) => [u.id, u.name]));
    return c.json({
      changes: changes.map((ch) => ({ ...ch, userName: names.get(ch.userId) ?? null })),
    } satisfies HistoryResponse);
  })
  .post("/shows/:id/import/airtable", requireMembership, async (c) => {
    if (c.var.role !== "owner" && c.var.role !== "editor") {
      return c.json({ error: "Only editors can import" }, 403);
    }
    const tooLarge = () =>
      c.json({ error: `Request body over ${MAX_BODY_BYTES / 1024 / 1024} MB` }, 413);
    if (declaredTooLarge(c)) return tooLarge();
    const stub = showStub(c.env, c.var.show.id);
    // Importing twice would duplicate everything: only into an empty show, unless the
    // caller explicitly asks to append.
    if (c.req.query("append") !== "1" && (await stub.hasData())) {
      return c.json({ error: "Show already has data" }, 409);
    }
    let form: Record<string, string | File | (string | File)[]>;
    try {
      form = await c.req.parseBody({ all: true });
    } catch {
      return c.json({ error: "Expected multipart/form-data with CSV files" }, 400);
    }
    const files: CsvFile[] = [];
    let bytes = 0;
    for (const value of Object.values(form).flat()) {
      if (typeof value === "string") continue;
      bytes += value.size;
      if (bytes > MAX_BODY_BYTES) return tooLarge();
      files.push({ name: value.name, text: await value.text() });
    }
    if (files.length === 0) return c.json({ error: "Attach one or more CSV files" }, 400);
    const clientId = typeof form.clientId === "string" ? form.clientId.slice(0, 64) : "";

    const fieldOptions = await stub.fieldOptions();
    const plan = buildAirtableImport(files, fieldOptions);
    const res = await stub.mutate(
      { userId: c.var.user.id, role: c.var.role, clientId: clientId || null, allowCreatedAt: true },
      plan.ops,
    );
    if (!res.ok) {
      // A bug in the importer, not the user's fault; report which op failed.
      return c.json({ error: `Import failed: ${res.error}`, opIndex: res.opIndex }, 400);
    }
    return c.json({ created: plan.created, warnings: plan.warnings } satisfies ImportResponse);
  })

  // ---- attachments (routes/attachments.ts) ----
  .post("/shows/:id/attachments/upload-url", requireMembership, attachments.uploadUrl)
  .put("/shows/:id/attachments/:aid", requireMembership, attachments.upload)
  .get("/shows/:id/attachments/:aid", requireMembership, attachments.download)
  .get("/shows/:id/attachments/:aid/thumb", requireMembership, attachments.thumbnail)
  .get("/shows/:id/storage", requireMembership, attachments.storage)

  // ---- members ----
  .get("/shows/:id/members", requireMembership, async (c) => {
    const rows = await c.var.db
      .select({
        userId: schema.users.id,
        email: schema.users.email,
        name: schema.users.name,
        role: schema.memberships.role,
      })
      .from(schema.memberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .where(eq(schema.memberships.showId, c.var.show.id))
      .orderBy(schema.users.name);
    return c.json({ members: rows satisfies MemberDTO[] } satisfies MembersResponse);
  })
  .post("/shows/:id/members", requireMembership, requireOwner, async (c) => {
    const body = await readJsonObject(c);
    const email = normalizeEmail(str(body?.email));
    const role = body?.role;
    if (!isGrantable(role)) {
      return c.json({ error: `role must be one of ${GRANTABLE_ROLES.join(", ")}` }, 400);
    }
    const user = await c.var.db
      .select({ id: schema.users.id, email: schema.users.email, name: schema.users.name })
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .get();
    // Accounts are created through invites; adding a member never creates one.
    if (!user) return c.json({ error: "No account with that email; invite them first" }, 404);
    const inserted = await c.var.db
      .insert(schema.memberships)
      .values({ showId: c.var.show.id, userId: user.id, role })
      .onConflictDoNothing()
      .returning({ userId: schema.memberships.userId });
    if (inserted.length === 0) return c.json({ error: "Already a member of this show" }, 409);
    const member: MemberDTO = { userId: user.id, email: user.email, name: user.name, role };
    return c.json({ member }, 201);
  })
  .patch("/shows/:id/members/:userId", requireMembership, requireOwner, async (c) => {
    const body = await readJsonObject(c);
    const role = body?.role;
    if (!isGrantable(role)) {
      return c.json({ error: `role must be one of ${GRANTABLE_ROLES.join(", ")}` }, 400);
    }
    const userId = c.req.param("userId");
    if (userId === c.var.user.id) return c.json({ error: "The owner's role can't change" }, 400);
    const updated = await c.var.db
      .update(schema.memberships)
      .set({ role })
      .where(
        and(eq(schema.memberships.showId, c.var.show.id), eq(schema.memberships.userId, userId)),
      )
      .returning({ userId: schema.memberships.userId });
    if (updated.length === 0) return c.json({ error: "Not a member of this show" }, 404);
    // Every mutate re-checks the role in D1; tell the user's open tabs so their UI follows.
    await showStub(c.env, c.var.show.id).notifyRole(userId, role);
    return c.json({ ok: true });
  })
  .delete("/shows/:id/members/:userId", requireMembership, requireOwner, async (c) => {
    const userId = c.req.param("userId");
    if (userId === c.var.user.id) return c.json({ error: "The owner can't be removed" }, 400);
    const removed = await c.var.db
      .delete(schema.memberships)
      .where(
        and(eq(schema.memberships.showId, c.var.show.id), eq(schema.memberships.userId, userId)),
      )
      .returning({ userId: schema.memberships.userId });
    if (removed.length === 0) return c.json({ error: "Not a member of this show" }, 404);
    await showStub(c.env, c.var.show.id).disconnectUser(userId);
    return c.json({ ok: true });
  });
