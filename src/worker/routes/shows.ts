import { and, eq, exists, inArray, isNull, ne, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { type Context, Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { ImportMapping } from "../../shared/airtable-columns";
import {
  type AddShowPeopleResponse,
  type CreateShowRequest,
  GRANTABLE_ROLES,
  INVITE_POLICIES,
  type InvitePolicy,
  MAX_NAME_LENGTH,
  MAX_SESSION_LENGTH,
  type MemberDTO,
  type MembersResponse,
  type PendingInvitesResponse,
  type Role,
  type ShowInfoDTO,
  type ShowResponse,
  type ShowSummaryDTO,
  type ShowsResponse,
  type TeamRole,
  type TransferOwnershipRequest,
  type UpdateShowResponse,
} from "../../shared/api";
import type {
  HistoryResponse,
  ImportResponse,
  MutateError,
  MutateResponse,
} from "../../shared/ops";
import {
  accessibleShows,
  canGrant,
  canInviteToShow,
  canManageShowMember,
  isTeamEditor,
  isTeamManager,
  refreshAccess,
  resolveRole,
  showAccess,
  teamMemberIds,
  teamRoleOf,
} from "../access";
import { sha256Hex } from "../auth/bytes";
import { requireAuth } from "../auth/middleware";
import { isPlausibleEmail, normalizeEmail } from "../auth/session";
import { requireAuthOrShare, shareResourceGuard } from "../auth/share-auth";
import { type D1Db, schema } from "../db/d1/client";
import { RESERVED_KEYS } from "../do/ops-engine";
import {
  INTERNAL_HEADER,
  INTERNAL_MARKER,
  NAME_HEADER,
  ROLE_HEADER,
  SESSION_ID_HEADER,
  SHARE_SCOPE_HEADER,
  USER_ID_HEADER,
} from "../do/ShowDO";
import { addedEmail, appOrigin, sendEmail } from "../email";
import { buildAirtableImport, type CsvFile } from "../import/airtable";
import type { AppEnv } from "../types";
import * as attachments from "./attachments";
import { exportShow } from "./backup";
import * as clone from "./clone";
import {
  countInvite,
  createInvite,
  emailInvite,
  endInvites,
  endInvitesWithoutAccess,
  type InviteRole,
  inviteLimited,
  pendingInvites,
} from "./invites";
import * as script from "./script";
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
    show: {
      id: string;
      name: string;
      currentSession: string | null;
      teamId: string | null;
      teamName: string | null;
      invitePolicy: InvitePolicy;
    };
    /** Effective role (src/worker/access.ts): the highest of the direct and the team one. */
    role: Role;
    /** The caller's direct membership role (null: access only through the show's team). */
    directRole: Role | null;
    /** The caller's role in the show's team (null: none, or a personal show). */
    teamRole: TeamRole | null;
  };
};

/**
 * 404 unless the show exists and the signed-in user has access to it (a direct member,
 * or a member of the show's team; src/worker/access.ts), or the request is a share link's
 * viewer for this show (`c.var.share`; role viewer; routes/share.ts).
 */
export const requireMembership = createMiddleware<ShowEnv>(async (c, next) => {
  const showId = c.req.param("id") ?? "";
  const share = c.var.share;
  // A share viewer's stand-in user (`share:<linkId>`) has no memberships: role null.
  const access = await showAccess(c.var.db, showId, c.var.user.id);
  if (access?.role) {
    // A member's own access wins over a share cookie they may also carry.
    c.set("share", undefined);
    c.set("show", access.show);
    c.set("role", access.role);
    c.set("directRole", access.direct);
    c.set("teamRole", access.teamRole);
    return next();
  }
  if (access && share && share.showId === showId) {
    c.set("show", access.show);
    c.set("role", "viewer");
    c.set("directRole", null);
    c.set("teamRole", null);
    return next();
  }
  // Same response for "no such show" and "not a member": don't leak show IDs.
  return c.json({ error: "Show not found" }, 404);
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

/**
 * Makes `to` the show's owner and `from` (the owner) an editor, in one D1 transaction that
 * re-checks both sides, so the show always has exactly one owner: if `from` is no longer
 * the owner (a concurrent transfer won) or `to` is no longer a member, nothing changes and
 * this returns false. The old owner's open invites into the show are revoked with it.
 */
export async function transferOwnership(
  db: D1Db,
  showId: string,
  from: string,
  to: string,
): Promise<boolean> {
  const m = schema.memberships;
  const holds = (userId: string, role: Role) =>
    db
      .select({ one: sql`1` })
      .from(m)
      .where(and(eq(m.showId, showId), eq(m.userId, userId), eq(m.role, role)));
  const [promoted] = await db.batch([
    db
      .update(m)
      .set({ role: "owner" })
      .where(and(eq(m.showId, showId), eq(m.userId, to), exists(holds(from, "owner"))))
      .returning({ userId: m.userId }),
    // Only once `to` really is the owner (so never zero owners).
    db
      .update(m)
      .set({ role: "editor" })
      .where(
        and(
          eq(m.showId, showId),
          eq(m.userId, from),
          eq(m.role, "owner"),
          exists(holds(to, "owner")),
        ),
      ),
    db
      .update(schema.invites)
      .set({ revokedAt: Date.now() })
      .where(
        and(
          eq(schema.invites.showId, showId),
          eq(schema.invites.invitedBy, from),
          isNull(schema.invites.acceptedAt),
          isNull(schema.invites.revokedAt),
          exists(holds(to, "owner")),
          notExists(holds(from, "owner")),
        ),
      ),
  ]);
  return promoted.length > 0;
}

function isGrantable(role: unknown): role is InviteRole {
  return typeof role === "string" && (GRANTABLE_ROLES as readonly string[]).includes(role);
}

const inviter = alias(schema.users, "inviter");

/**
 * A show's members (MemberDTO), by name: its direct members and (for a team show) the
 * team's members without a direct membership. `userId` narrows it to one person.
 */
async function showMembers(
  db: D1Db,
  show: { id: string; teamId: string | null },
  userId?: string,
): Promise<MemberDTO[]> {
  const m = schema.memberships;
  const tm = schema.teamMemberships;
  const u = schema.users;
  const [direct, team] = await Promise.all([
    db
      .select({
        userId: u.id,
        email: u.email,
        name: u.name,
        lastActiveAt: u.lastActiveAt,
        directRole: m.role,
        teamRole: tm.role,
        joinedAt: m.createdAt,
        invitedById: inviter.id,
        invitedByName: inviter.name,
      })
      .from(m)
      .innerJoin(u, eq(u.id, m.userId))
      // No team: "" matches no team (ids are UUIDs), so teamRole stays null.
      .leftJoin(tm, and(eq(tm.teamId, show.teamId ?? ""), eq(tm.userId, m.userId)))
      .leftJoin(inviter, eq(inviter.id, m.invitedBy))
      .where(and(eq(m.showId, show.id), userId ? eq(m.userId, userId) : undefined)),
    show.teamId
      ? db
          .select({
            userId: u.id,
            email: u.email,
            name: u.name,
            lastActiveAt: u.lastActiveAt,
            teamRole: tm.role,
            joinedAt: tm.createdAt,
            invitedById: inviter.id,
            invitedByName: inviter.name,
          })
          .from(tm)
          .innerJoin(u, eq(u.id, tm.userId))
          .leftJoin(inviter, eq(inviter.id, tm.invitedBy))
          .where(
            and(
              eq(tm.teamId, show.teamId),
              userId ? eq(tm.userId, userId) : undefined,
              notExists(
                db
                  .select({ one: sql`1` })
                  .from(m)
                  .where(and(eq(m.showId, show.id), eq(m.userId, tm.userId))),
              ),
            ),
          )
      : Promise.resolve([]),
  ]);
  const by = (r: { invitedById: string | null; invitedByName: string | null }) =>
    r.invitedById ? { id: r.invitedById, name: r.invitedByName ?? "" } : null;
  const members: MemberDTO[] = [
    ...direct.map((r) => ({
      userId: r.userId,
      email: r.email,
      name: r.name,
      role: resolveRole(r.directRole, r.teamRole) ?? r.directRole,
      source: "direct" as const,
      directRole: r.directRole,
      teamRole: r.teamRole,
      invitedBy: by(r),
      joinedAt: r.joinedAt,
      lastActiveAt: r.lastActiveAt,
    })),
    ...team.map((r) => ({
      userId: r.userId,
      email: r.email,
      name: r.name,
      role: resolveRole(null, r.teamRole) ?? "viewer",
      source: "team" as const,
      directRole: null,
      teamRole: r.teamRole,
      invitedBy: by(r),
      joinedAt: r.joinedAt,
      lastActiveAt: r.lastActiveAt,
    })),
  ];
  // By name in byte order, like SQL's ORDER BY.
  return members.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

const TEAM_ONLY = "Manage this person in the team";

/** 403 unless the caller may add people to the show with `role` (decision 4). */
function grantRefusal(c: Context<ShowEnv>, role: Role): Response | null {
  if (!canInviteToShow(c.var.role, c.var.show.invitePolicy)) {
    return c.json({ error: "You can't add people to this show" }, 403);
  }
  if (!canGrant(c.var.role, role)) {
    return c.json({ error: "You can't give a role above your own" }, 403);
  }
  return null;
}

async function userByEmail(db: D1Db, email: string) {
  return db
    .select({ id: schema.users.id, email: schema.users.email, name: schema.users.name })
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .get();
}

async function directMember(db: D1Db, showId: string, userId: string) {
  const m = schema.memberships;
  return db
    .select({ role: m.role, invitedBy: m.invitedBy })
    .from(m)
    .where(and(eq(m.showId, showId), eq(m.userId, userId)))
    .get();
}

/**
 * Add a direct member, invited by the caller; null when they already are one. A team
 * member may also be added directly (a guest role above their team one).
 */
async function addDirectMember(
  c: Context<ShowEnv>,
  userId: string,
  role: Role,
): Promise<MemberDTO | null> {
  const inserted = await c.var.db
    .insert(schema.memberships)
    .values({ showId: c.var.show.id, userId, role, invitedBy: c.var.user.id })
    .onConflictDoNothing()
    .returning({ userId: schema.memberships.userId });
  if (inserted.length === 0) return null;
  if (c.var.show.teamId) {
    // They may already have the show open through the team.
    await refreshAccess(c.env, c.var.db, { showIds: [c.var.show.id], userIds: [userId] });
  }
  const [member] = await showMembers(c.var.db, c.var.show, userId);
  return member ?? null;
}

/** 409 for someone who only has access through the show's team, else 404. */
async function notADirectMember(c: Context<ShowEnv>, userId: string): Promise<Response> {
  const teamId = c.var.show.teamId;
  if (teamId && (await teamRoleOf(c.var.db, teamId, userId))) {
    return c.json({ error: TEAM_ONLY }, 409);
  }
  return c.json({ error: "Not a member of this show" }, 404);
}

async function teamById(db: D1Db, teamId: string) {
  return (
    (await db
      .select({ id: schema.teams.id, name: schema.teams.name })
      .from(schema.teams)
      .where(eq(schema.teams.id, teamId))
      .get()) ?? null
  );
}

/**
 * PATCH /shows/:id `teamId`: who may move the show. Into a team (or from one team to
 * another): the show's owner, who must be an editor (or up) of the target team. Out of
 * its team (`null`): the owner, or the team's owner/admins. Returns the new team id, or
 * the error response.
 */
async function checkTeamMove(c: Context<ShowEnv>, raw: unknown): Promise<string | null | Response> {
  if (raw !== null && typeof raw !== "string") {
    return c.json({ error: "teamId must be a string or null" }, 400);
  }
  const isOwner = c.var.role === "owner";
  if (raw === null || raw === "") {
    const current = c.var.show.teamId;
    if (isOwner) return null;
    if (current && isTeamManager(await teamRoleOf(c.var.db, current, c.var.user.id))) return null;
    return c.json({ error: "Only the show's owner or the team's admins can do that" }, 403);
  }
  if (!isOwner) return c.json({ error: "Only the show's owner can move it into a team" }, 403);
  const role = await teamRoleOf(c.var.db, raw, c.var.user.id);
  if (!role) return c.json({ error: "Team not found" }, 404);
  if (!isTeamEditor(role)) {
    return c.json({ error: "Only the team's editors can add shows to it" }, 403);
  }
  return raw;
}

export const showRoutes = new Hono<ShowEnv>()
  .use("/shows", requireAuth)
  // Share links' viewers get through on a few GET routes (auth/share-auth.ts).
  .use("/shows/*", requireAuthOrShare)
  // Direct and team shows, with the effective role and the team.
  .get("/shows", async (c) => {
    const shows = await accessibleShows(c.var.db, c.var.user.id);
    return c.json({ shows } satisfies ShowsResponse);
  })
  .post("/shows", async (c) => {
    const body = (await readJsonObject(c)) as Partial<CreateShowRequest> | null;
    const name = str(body?.name).trim();
    if (!name || name.length > MAX_NAME_LENGTH) {
      return c.json({ error: `Show name must be 1–${MAX_NAME_LENGTH} characters` }, 400);
    }
    const teamId = body?.teamId ?? null;
    if (teamId !== null && typeof teamId !== "string") {
      return c.json({ error: "teamId must be a string or null" }, 400);
    }
    let team: { id: string; name: string } | null = null;
    if (teamId) {
      // In a team: the creator must be one of its editors (or up).
      const role = await teamRoleOf(c.var.db, teamId, c.var.user.id);
      if (!role) return c.json({ error: "Team not found" }, 404);
      if (!isTeamEditor(role)) {
        return c.json({ error: "Only the team's editors can add shows to it" }, 403);
      }
      team = await teamById(c.var.db, teamId);
      if (!team) return c.json({ error: "Team not found" }, 404);
    }
    const id = crypto.randomUUID();
    const createdAt = Date.now();
    await c.var.db.batch([
      c.var.db.insert(schema.shows).values({
        id,
        name,
        createdBy: c.var.user.id,
        createdAt,
        teamId: team?.id ?? null,
      }),
      c.var.db
        .insert(schema.memberships)
        .values({ showId: id, userId: c.var.user.id, role: "owner", createdAt }),
    ]);
    await showStub(c.env, id).sync(id, name);
    const show: ShowSummaryDTO = {
      id,
      name,
      role: "owner",
      createdAt,
      teamId: team?.id ?? null,
      teamName: team?.name ?? null,
    };
    return c.json({ show }, 201);
  })
  .get("/shows/:id", requireMembership, async (c) => {
    // D1 `shows.name` is the source of truth; opening a show refreshes the DO's cached copy
    // (and creates it if the DO init failed after the D1 insert).
    const meta = await showStub(c.env, c.var.show.id).sync(c.var.show.id, c.var.show.name);
    return c.json({
      // A share link's viewer isn't a member: nothing about the team or who may invite
      // (ShowInfoDTO documents the three as absent then; the share page never reads them).
      show: c.var.share
        ? ({ ...meta, currentSession: c.var.show.currentSession } as unknown as ShowInfoDTO)
        : {
            ...meta,
            currentSession: c.var.show.currentSession,
            teamId: c.var.show.teamId,
            teamName: c.var.show.teamName,
            invitePolicy: c.var.show.invitePolicy,
          },
      role: c.var.role,
    } satisfies ShowResponse);
  })
  // Rename (owner), the current session label (editors and the owner), the show's team
  // (`teamId`: see checkTeamMove) and its invite policy (owner). D1 is the source of truth;
  // the DO only relays the change to open sockets.
  .patch("/shows/:id", requireMembership, async (c) => {
    const body = await readJsonObject(c);
    if (!body) return c.json({ error: "Expected a JSON object" }, 400);
    const canEdit = c.var.role === "owner" || c.var.role === "editor";
    const set: {
      name?: string;
      currentSession?: string | null;
      teamId?: string | null;
      invitePolicy?: InvitePolicy;
    } = {};
    if ("invitePolicy" in body) {
      if (c.var.role !== "owner") {
        return c.json({ error: "Only the show's owner can change who may invite" }, 403);
      }
      const policy = body.invitePolicy;
      if (typeof policy !== "string" || !(INVITE_POLICIES as readonly string[]).includes(policy)) {
        return c.json({ error: `invitePolicy must be one of ${INVITE_POLICIES.join(", ")}` }, 400);
      }
      set.invitePolicy = policy as InvitePolicy;
    }
    if ("teamId" in body) {
      const checked = await checkTeamMove(c, body.teamId);
      if (checked instanceof Response) return checked;
      set.teamId = checked;
    }
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
      return c.json(
        { error: "Nothing to change (name, current_session, teamId, invitePolicy)" },
        400,
      );
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
    if ("name" in set || "currentSession" in set) {
      await showStub(c.env, c.var.show.id).notifyShow({
        name: updated.name,
        currentSession: updated.currentSession,
      });
    }
    if ("teamId" in set && set.teamId !== c.var.show.teamId) {
      // The old team's members may have lost access, the new team's gained it.
      const before = c.var.show.teamId ? await teamMemberIds(c.var.db, c.var.show.teamId) : [];
      const after = set.teamId ? await teamMemberIds(c.var.db, set.teamId) : [];
      // Whoever lost access also loses the invites they made into the show.
      await endInvitesWithoutAccess(c.var.db, [c.var.show.id], before);
      await refreshAccess(c.env, c.var.db, {
        showIds: [c.var.show.id],
        userIds: [...before, ...after],
      });
    }
    return c.json({ show: updated } satisfies UpdateShowResponse);
  })
  .get("/shows/:id/ws", requireSameOriginUpgrade, requireMembership, async (c) => {
    // A fresh set of headers: nothing the client sent reaches the DO (it could otherwise
    // forge X-Cuesheet-* identity headers). The runtime completes the handshake with the
    // client from the original request.
    const headers = new Headers({ Upgrade: "websocket", [INTERNAL_HEADER]: INTERNAL_MARKER });
    if (c.var.share) {
      // A share link's viewer: its ops are filtered to the link's scope in the DO.
      headers.set(SHARE_SCOPE_HEADER, JSON.stringify(c.var.share));
    } else {
      headers.set(USER_ID_HEADER, c.var.user.id);
      headers.set(ROLE_HEADER, c.var.role);
      headers.set(NAME_HEADER, encodeURIComponent(c.var.user.name));
      // So logout can close exactly this browser's sockets (ShowDO.disconnectSession).
      headers.set(SESSION_ID_HEADER, await sha256Hex(c.var.sessionToken));
    }
    return showStub(c.env, c.var.show.id).fetch(
      new Request(`https://do/shows/${c.var.show.id}/ws`, { headers }),
    );
  })

  // ---- show data ----
  .get("/shows/:id/snapshot", requireMembership, async (c) => {
    const stub = showStub(c.env, c.var.show.id);
    const snap = c.var.share
      ? await stub.snapshotForShare(c.var.share)
      : await stub.snapshotJson(c.var.user.id);
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

    let mapping: ImportMapping | undefined;
    if (typeof form.mapping === "string" && form.mapping) {
      try {
        mapping = JSON.parse(form.mapping) as ImportMapping;
      } catch {
        return c.json({ error: "mapping must be JSON" }, 400);
      }
      if (typeof mapping !== "object" || mapping === null) {
        return c.json({ error: "mapping must be an object" }, 400);
      }
    }
    const [fieldOptions, existingFields, customTableCount] = await Promise.all([
      stub.fieldOptions(),
      stub.customFields(),
      stub.customTableCount(),
    ]);
    const plan = buildAirtableImport(files, fieldOptions, {
      ...(mapping ? { mapping } : {}),
      existingFields,
      customTableCount,
    });
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

  // ---- templates (routes/clone.ts) ----
  .post("/shows/:id/clone", requireMembership, clone.cloneShow)

  // ---- attachments (routes/attachments.ts) ----
  .post("/shows/:id/attachments/upload-url", requireMembership, attachments.uploadUrl)
  .put("/shows/:id/attachments/:aid", requireMembership, attachments.upload)
  .get("/shows/:id/attachments/:aid", requireMembership, shareResourceGuard, attachments.download)
  .get(
    "/shows/:id/attachments/:aid/thumb",
    requireMembership,
    shareResourceGuard,
    attachments.thumbnail,
  )
  .get("/shows/:id/storage", requireMembership, attachments.storage)

  // ---- script (routes/script.ts) ----
  .post("/shows/:id/script/versions", requireMembership, script.createVersion)
  .get(
    "/shows/:id/script/versions/:vid/text",
    requireMembership,
    shareResourceGuard,
    script.versionText,
  )
  .post("/shows/:id/script/versions/:vid/reanchor", requireMembership, script.reanchorVersion)

  // ---- backup (routes/backup.ts): the owner's JSON export of everything ----
  .get("/shows/:id/export.json", requireMembership, requireOwner, exportShow)

  // ---- members ----
  // Direct members and (for a team show) the team's members, each once.
  .get("/shows/:id/members", requireMembership, async (c) => {
    const members = await showMembers(c.var.db, c.var.show);
    return c.json({ members } satisfies MembersResponse);
  })
  // Add someone who has an account (decision 4: the owner, or editors unless the invite
  // policy is `owner`; up to your own role).
  .post("/shows/:id/members", requireMembership, async (c) => {
    const body = await readJsonObject(c);
    const email = normalizeEmail(str(body?.email));
    const role = body?.role;
    if (!isGrantable(role)) {
      return c.json({ error: `role must be one of ${GRANTABLE_ROLES.join(", ")}` }, 400);
    }
    const refused = grantRefusal(c, role);
    if (refused) return refused;
    const user = await userByEmail(c.var.db, email);
    // Accounts are created through invites; adding a member never creates one.
    if (!user) return c.json({ error: "No account with that email; invite them first" }, 404);
    if (user.id === c.var.user.id) return c.json({ error: "That's you" }, 400);
    const member = await addDirectMember(c, user.id, role);
    if (!member) return c.json({ error: "Already a member of this show" }, 409);
    return c.json({ member }, 201);
  })
  // One step: an account is added now ("you were added" email), an unknown email gets an
  // invite (invite email). Same rules as adding members; invites count toward the
  // inviter's limit.
  .post("/shows/:id/people", requireMembership, async (c) => {
    const body = await readJsonObject(c);
    const role = body?.role;
    if (!isGrantable(role)) {
      return c.json({ error: `role must be one of ${GRANTABLE_ROLES.join(", ")}` }, 400);
    }
    const refused = grantRefusal(c, role);
    if (refused) return refused;
    const email = normalizeEmail(str(body?.email));
    if (!isPlausibleEmail(email)) return c.json({ error: "Enter a valid email address" }, 400);
    const show = c.var.show;
    const user = await userByEmail(c.var.db, email);
    if (user?.id === c.var.user.id) return c.json({ error: "That's you" }, 400);
    if (user) {
      const member = await addDirectMember(c, user.id, role);
      if (!member) return c.json({ error: "Already a member of this show" }, 409);
      const emailed = await sendEmail(
        c.env,
        addedEmail({
          to: user.email,
          inviterName: c.var.user.name,
          inviterEmail: c.var.user.email,
          targetName: show.name,
          targetKind: "show",
          role,
          link: `${appOrigin(c.env, c.req.url)}/shows/${show.id}`,
        }),
      );
      return c.json({ added: member, emailed } satisfies AddShowPeopleResponse, 201);
    }
    const limited = await inviteLimited(c);
    if (limited) return limited;
    const made = await createInvite(c.var.db, {
      email,
      invitedBy: c.var.user.id,
      show: { id: show.id, role },
    });
    await countInvite(c);
    const emailed = await emailInvite(c, email, { kind: "show", name: show.name, role }, made);
    const invited = { id: made.id, email, role, path: made.path, expiresAt: made.expiresAt };
    return c.json({ invited, emailed } satisfies AddShowPeopleResponse, 201);
  })
  // Pending invites into the show: the owner and the show's team owner/admins see all,
  // everyone else their own.
  .get("/shows/:id/invites", requireMembership, async (c) => {
    const manager = c.var.role === "owner" || isTeamManager(c.var.teamRole);
    const invites = await pendingInvites(
      c.var.db,
      { showId: c.var.show.id },
      manager ? undefined : c.var.user.id,
    );
    return c.json({ invites } satisfies PendingInvitesResponse);
  })
  // Change a direct member's role: the owner anyone's, an inviter their invitees' (decision 4).
  .patch("/shows/:id/members/:userId", requireMembership, async (c) => {
    const body = await readJsonObject(c);
    const role = body?.role;
    if (!isGrantable(role)) {
      return c.json({ error: `role must be one of ${GRANTABLE_ROLES.join(", ")}` }, 400);
    }
    const userId = c.req.param("userId");
    if (userId === c.var.user.id) {
      const error =
        c.var.role === "owner" ? "The owner's role can't change" : "You can't change your own role";
      return c.json({ error }, 400);
    }
    const target = await directMember(c.var.db, c.var.show.id, userId);
    if (!target) return notADirectMember(c, userId);
    if (target.role === "owner") {
      return c.json({ error: "The owner's role can't change; transfer the show instead" }, 400);
    }
    const actor = { id: c.var.user.id, role: c.var.role, teamRole: c.var.teamRole };
    if (!canManageShowMember(actor, c.var.show.invitePolicy, target)) {
      return c.json({ error: "You can only manage the people you added" }, 403);
    }
    if (!canGrant(c.var.role, role)) {
      return c.json({ error: "You can't give a role above your own" }, 403);
    }
    // Only the row as checked above: a concurrent change (a transfer making them owner,
    // another role change) makes this a 409.
    const m = schema.memberships;
    const updated = await c.var.db
      .update(m)
      .set({ role })
      .where(
        and(
          eq(m.showId, c.var.show.id),
          eq(m.userId, userId),
          eq(m.role, target.role),
          target.invitedBy === null ? isNull(m.invitedBy) : eq(m.invitedBy, target.invitedBy),
        ),
      )
      .returning({ userId: schema.memberships.userId });
    if (updated.length === 0) {
      return c.json({ error: "The show's members changed meanwhile; reload and try again" }, 409);
    }
    // Every mutate re-checks the role in D1; tell the user's open tabs so their UI follows
    // (with the effective role: a team role above the new one still counts).
    await refreshAccess(c.env, c.var.db, { showIds: [c.var.show.id], userIds: [userId] });
    return c.json({ ok: true });
  })
  // Remove a direct member (same rules); their open invites into the show end with it.
  .delete("/shows/:id/members/:userId", requireMembership, async (c) => {
    const userId = c.req.param("userId");
    if (userId === c.var.user.id) {
      const error =
        c.var.role === "owner" ? "The owner can't be removed" : "Leave the show instead";
      return c.json({ error }, 400);
    }
    const target = await directMember(c.var.db, c.var.show.id, userId);
    if (!target) return notADirectMember(c, userId);
    if (target.role === "owner") return c.json({ error: "The owner can't be removed" }, 400);
    const actor = { id: c.var.user.id, role: c.var.role, teamRole: c.var.teamRole };
    if (!canManageShowMember(actor, c.var.show.invitePolicy, target)) {
      return c.json({ error: "You can only manage the people you added" }, 403);
    }
    const removed = await c.var.db
      .delete(schema.memberships)
      .where(
        and(
          eq(schema.memberships.showId, c.var.show.id),
          eq(schema.memberships.userId, userId),
          ne(schema.memberships.role, "owner"),
        ),
      )
      .returning({ userId: schema.memberships.userId });
    if (removed.length === 0) {
      return c.json({ error: "The show's members changed meanwhile; reload and try again" }, 409);
    }
    await endInvites(c.var.db, { showId: c.var.show.id }, userId);
    // Still in the show's team: they keep that role (notified); otherwise disconnected.
    await refreshAccess(c.env, c.var.db, { showIds: [c.var.show.id], userIds: [userId] });
    return c.json({ ok: true });
  })
  // Hand the show to another member (owner only): they become the owner, you an editor.
  // `{userId}` or `{email}` (scripts and agent accounts know emails).
  .post("/shows/:id/transfer", requireMembership, requireOwner, async (c) => {
    const body = (await readJsonObject(c)) as Partial<TransferOwnershipRequest> | null;
    const showId = c.var.show.id;
    let userId = str(body?.userId);
    const email = normalizeEmail(str(body?.email));
    if (!userId && email) {
      const byEmail = await c.var.db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.email, email))
        .get();
      if (!byEmail)
        return c.json({ error: "No account with that email is a member of this show" }, 404);
      userId = byEmail.id;
    }
    if (!userId) {
      return c.json({ error: "Send the userId or email of the member to make the owner" }, 400);
    }
    if (userId === c.var.user.id) return c.json({ error: "You're already the owner" }, 400);
    const target = await c.var.db
      .select({ role: schema.memberships.role })
      .from(schema.memberships)
      .where(and(eq(schema.memberships.showId, showId), eq(schema.memberships.userId, userId)))
      .get();
    if (!target) {
      return c.json({ error: "Not a member of this show; add them as a member first" }, 404);
    }
    if (!(await transferOwnership(c.var.db, showId, c.var.user.id, userId))) {
      // Another request changed the members since this one checked (a second transfer, a removal).
      return c.json({ error: "The show's members changed meanwhile; reload and try again" }, 409);
    }
    const stub = showStub(c.env, showId);
    await stub.notifyRole(userId, "owner");
    await stub.notifyRole(c.var.user.id, "editor");
    return c.json({ ok: true });
  })
  // Leave a show (anyone but the owner, who transfers ownership first).
  .post("/shows/:id/leave", requireMembership, async (c) => {
    if (c.var.share) return c.json({ error: "Not signed in" }, 401);
    if (c.var.role === "owner") {
      return c.json({ error: "Transfer ownership to someone else before leaving" }, 400);
    }
    if (!c.var.directRole) {
      return c.json({ error: "You have access through the show's team; leave the team" }, 400);
    }
    // Never the owner (a transfer may have made them one meanwhile); a concurrent leave or
    // removal leaves nothing to delete.
    const left = await c.var.db
      .delete(schema.memberships)
      .where(
        and(
          eq(schema.memberships.showId, c.var.show.id),
          eq(schema.memberships.userId, c.var.user.id),
          ne(schema.memberships.role, "owner"),
        ),
      )
      .returning({ userId: schema.memberships.userId });
    if (left.length === 0) {
      return c.json({ error: "The show's members changed meanwhile; reload and try again" }, 409);
    }
    await endInvites(c.var.db, { showId: c.var.show.id }, c.var.user.id);
    // Still in the show's team: their tabs stay open with the team role.
    await refreshAccess(c.env, c.var.db, { showIds: [c.var.show.id], userIds: [c.var.user.id] });
    return c.json({ ok: true });
  });
