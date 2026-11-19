// Teams: a set of people with a team role, owning any number of shows (`shows.team_id`).
// Team members get a role on every show of the team (src/worker/access.ts), so every
// change here that can move someone's access ends with `refreshAccess` on the team's shows.
//
// - Any signed-in user can create a team (they're its owner). A team is visible to its
//   members only: 404 otherwise, like shows.
// - Owner and admins rename it and set its invite policy; only the owner deletes it, and
//   only once it has no shows (409; `shows.team_id` would block it anyway).
// - Adding people: owner and admins always, editors too unless the invite policy is
//   `owner`; nobody grants above their own role or grants owner (that's a transfer).
// - Managing members: owner and admins manage everyone but the owner (admins other admins
//   too); an editor who may add people manages the people they added (`invited_by`),
//   within their own role. Removal (or leaving) ends that person's open invites into the
//   team.
// - `POST /teams/:id/people`: one step, an account joins now, an unknown email gets an
//   invite (routes/invites.ts); `GET /teams/:id/invites`: pending invites (managers all,
//   others their own).
// - Transfer (owner): that member becomes the owner, the old owner an admin, in one D1
//   batch that re-checks both sides (`transferTeam`), so a team always has one owner.
import { and, eq, exists, ne, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import {
  type AddTeamMemberRequest,
  type AddTeamPeopleResponse,
  type CreateTeamRequest,
  GRANTABLE_TEAM_ROLES,
  INVITE_POLICIES,
  type InvitePolicy,
  MAX_NAME_LENGTH,
  type PendingInvitesResponse,
  type TeamDTO,
  type TeamMemberDTO,
  type TeamMembersResponse,
  type TeamResponse,
  type TeamRole,
  type TeamShowsResponse,
  type TeamsResponse,
  type TransferTeamRequest,
  type UpdateTeamRequest,
} from "../../shared/api";
import {
  accessibleShows,
  canGrant,
  canInviteToTeam,
  canManageTeamMember,
  isTeamManager,
  refreshAccess,
  teamShowIds,
} from "../access";
import { requireAuth } from "../auth/middleware";
import { isPlausibleEmail, normalizeEmail } from "../auth/session";
import { type D1Db, schema } from "../db/d1/client";
import { addedEmail, appOrigin, sendEmail } from "../email";
import type { AppEnv } from "../types";
import {
  countInvite,
  createInvite,
  emailInvite,
  endInvites,
  inviteLimited,
  pendingInvites,
} from "./invites";
import { readJsonObject, str } from "./util";

type TeamEnv = AppEnv & {
  Variables: AppEnv["Variables"] & {
    /** The team, with the caller's role in it (`requireTeamMember`). */
    team: TeamDTO;
  };
};

const tm = schema.teamMemberships;
const inviter = alias(schema.users, "inviter");

/** 404 unless the team exists and the caller is a member; sets `c.var.team`. */
const requireTeamMember = createMiddleware<TeamEnv>(async (c, next) => {
  const team = await c.var.db
    .select({
      id: schema.teams.id,
      name: schema.teams.name,
      role: tm.role,
      invitePolicy: schema.teams.invitePolicy,
      createdAt: schema.teams.createdAt,
    })
    .from(schema.teams)
    .innerJoin(tm, and(eq(tm.teamId, schema.teams.id), eq(tm.userId, c.var.user.id)))
    .where(eq(schema.teams.id, c.req.param("id") ?? ""))
    .get();
  // Same answer for "no such team" and "not a member".
  if (!team) return c.json({ error: "Team not found" }, 404);
  c.set("team", team);
  await next();
});

const requireTeamManager = createMiddleware<TeamEnv>(async (c, next) => {
  if (!isTeamManager(c.var.team.role)) {
    return c.json({ error: "Only the team's owner and admins can do that" }, 403);
  }
  await next();
});

const requireTeamOwner = createMiddleware<TeamEnv>(async (c, next) => {
  if (c.var.team.role !== "owner") {
    return c.json({ error: "Only the team's owner can do that" }, 403);
  }
  await next();
});

function isGrantableTeamRole(role: unknown): role is TeamRole {
  return typeof role === "string" && (GRANTABLE_TEAM_ROLES as readonly string[]).includes(role);
}

function isInvitePolicy(p: unknown): p is InvitePolicy {
  return typeof p === "string" && (INVITE_POLICIES as readonly string[]).includes(p);
}

function teamName(raw: unknown): string | null {
  const name = str(raw).trim();
  return name && name.length <= MAX_NAME_LENGTH ? name : null;
}

const BAD_NAME = `Team name must be 1–${MAX_NAME_LENGTH} characters`;
const BAD_ROLE = `role must be one of ${GRANTABLE_TEAM_ROLES.join(", ")}`;

/** A team's members (TeamMemberDTO); `userId` narrows it to one. */
async function teamMembers(db: D1Db, teamId: string, userId?: string): Promise<TeamMemberDTO[]> {
  const u = schema.users;
  const rows = await db
    .select({
      userId: u.id,
      name: u.name,
      email: u.email,
      role: tm.role,
      joinedAt: tm.createdAt,
      lastActiveAt: u.lastActiveAt,
      invitedById: inviter.id,
      invitedByName: inviter.name,
    })
    .from(tm)
    .innerJoin(u, eq(u.id, tm.userId))
    .leftJoin(inviter, eq(inviter.id, tm.invitedBy))
    .where(and(eq(tm.teamId, teamId), userId ? eq(tm.userId, userId) : undefined))
    .orderBy(u.name);
  return rows.map(({ invitedById, invitedByName, ...r }) => ({
    ...r,
    invitedBy: invitedById ? { id: invitedById, name: invitedByName ?? "" } : null,
  }));
}

/** Whether the caller may change or remove `target` (decision 4; access.ts). */
function canManage(
  team: TeamDTO,
  actorId: string,
  target: { role: TeamRole; invitedBy: string | null },
): boolean {
  return canManageTeamMember({ id: actorId, role: team.role }, team.invitePolicy, target);
}

/** 403 unless the caller may add people to the team with `role`. */
function grantRefusal(team: TeamDTO, role: TeamRole): string | null {
  if (!canInviteToTeam(team.role, team.invitePolicy)) return "You can't add people to this team";
  if (!canGrant(team.role, role)) return "You can't give a role above your own";
  return null;
}

/** Add an existing account to the team, invited by `invitedBy`; null when already in it. */
async function addTeamMember(
  env: Pick<Env, "SHOW">,
  db: D1Db,
  teamId: string,
  userId: string,
  role: TeamRole,
  invitedBy: string,
): Promise<TeamMemberDTO | null> {
  const inserted = await db
    .insert(tm)
    .values({ teamId, userId, role, invitedBy })
    .onConflictDoNothing()
    .returning({ userId: tm.userId });
  if (inserted.length === 0) return null;
  // They reach the team's shows at once (and may have some open as a guest).
  await refreshAccess(env, db, { showIds: await teamShowIds(db, teamId), userIds: [userId] });
  const [member] = await teamMembers(db, teamId, userId);
  return member ?? null;
}

async function memberRow(db: D1Db, teamId: string, userId: string) {
  return db
    .select({ role: tm.role, invitedBy: tm.invitedBy })
    .from(tm)
    .where(and(eq(tm.teamId, teamId), eq(tm.userId, userId)))
    .get();
}

/**
 * Makes `to` the team's owner and `from` (the owner) an admin, in one D1 batch that
 * re-checks both sides, so the team always has exactly one owner: if `from` is no longer
 * the owner or `to` no longer a member, nothing changes and this returns false.
 */
export async function transferTeam(
  db: D1Db,
  teamId: string,
  from: string,
  to: string,
): Promise<boolean> {
  const holds = (userId: string, role: TeamRole) =>
    db
      .select({ one: sql`1` })
      .from(tm)
      .where(and(eq(tm.teamId, teamId), eq(tm.userId, userId), eq(tm.role, role)));
  const [promoted] = await db.batch([
    db
      .update(tm)
      .set({ role: "owner" })
      .where(and(eq(tm.teamId, teamId), eq(tm.userId, to), exists(holds(from, "owner"))))
      .returning({ userId: tm.userId }),
    // Only once `to` really is the owner (so never zero owners).
    db
      .update(tm)
      .set({ role: "admin" })
      .where(
        and(
          eq(tm.teamId, teamId),
          eq(tm.userId, from),
          eq(tm.role, "owner"),
          exists(holds(to, "owner")),
        ),
      ),
  ]);
  return promoted.length > 0;
}

export const teamRoutes = new Hono<TeamEnv>()
  .use("/teams", requireAuth)
  .use("/teams/*", requireAuth)
  .get("/teams", async (c) => {
    const teams = await c.var.db
      .select({
        id: schema.teams.id,
        name: schema.teams.name,
        role: tm.role,
        invitePolicy: schema.teams.invitePolicy,
        createdAt: schema.teams.createdAt,
      })
      .from(tm)
      .innerJoin(schema.teams, eq(schema.teams.id, tm.teamId))
      .where(eq(tm.userId, c.var.user.id))
      .orderBy(schema.teams.name);
    return c.json({ teams } satisfies TeamsResponse);
  })
  .post("/teams", async (c) => {
    const body = (await readJsonObject(c)) as Partial<CreateTeamRequest> | null;
    const name = teamName(body?.name);
    if (!name) return c.json({ error: BAD_NAME }, 400);
    const id = crypto.randomUUID();
    const createdAt = Date.now();
    await c.var.db.batch([
      c.var.db.insert(schema.teams).values({ id, name, createdBy: c.var.user.id, createdAt }),
      c.var.db.insert(tm).values({ teamId: id, userId: c.var.user.id, role: "owner", createdAt }),
    ]);
    const team: TeamDTO = { id, name, role: "owner", invitePolicy: "editors", createdAt };
    return c.json({ team } satisfies TeamResponse, 201);
  })
  .get("/teams/:id", requireTeamMember, (c) => c.json({ team: c.var.team } satisfies TeamResponse))
  .patch("/teams/:id", requireTeamMember, requireTeamManager, async (c) => {
    const body = (await readJsonObject(c)) as Partial<UpdateTeamRequest> | null;
    if (!body) return c.json({ error: "Expected a JSON object" }, 400);
    const set: { name?: string; invitePolicy?: InvitePolicy } = {};
    if ("name" in body) {
      const name = teamName(body.name);
      if (!name) return c.json({ error: BAD_NAME }, 400);
      set.name = name;
    }
    if ("invitePolicy" in body) {
      if (!isInvitePolicy(body.invitePolicy)) {
        return c.json({ error: `invitePolicy must be one of ${INVITE_POLICIES.join(", ")}` }, 400);
      }
      set.invitePolicy = body.invitePolicy;
    }
    if (Object.keys(set).length === 0) {
      return c.json({ error: "Nothing to change (name, invitePolicy)" }, 400);
    }
    await c.var.db.update(schema.teams).set(set).where(eq(schema.teams.id, c.var.team.id));
    return c.json({ team: { ...c.var.team, ...set } } satisfies TeamResponse);
  })
  // Only an empty team (no shows). Its pending invites go with it; memberships cascade.
  .delete("/teams/:id", requireTeamMember, requireTeamOwner, async (c) => {
    const db = c.var.db;
    const teamId = c.var.team.id;
    const empty = notExists(
      db.select({ one: sql`1` }).from(schema.shows).where(eq(schema.shows.teamId, teamId)),
    );
    const [, deleted] = await db.batch([
      db.delete(schema.invites).where(and(eq(schema.invites.teamId, teamId), empty)),
      db
        .delete(schema.teams)
        .where(and(eq(schema.teams.id, teamId), empty))
        .returning({ id: schema.teams.id }),
    ]);
    if (deleted.length === 0) {
      return c.json({ error: "Move the team's shows out (or delete them) first" }, 409);
    }
    return c.json({ ok: true });
  })

  // ---- members ----
  .get("/teams/:id/members", requireTeamMember, async (c) => {
    const members = await teamMembers(c.var.db, c.var.team.id);
    return c.json({ members } satisfies TeamMembersResponse);
  })
  // Add someone who has an account (no account: 404, invite them).
  .post("/teams/:id/members", requireTeamMember, async (c) => {
    const team = c.var.team;
    const body = (await readJsonObject(c)) as Partial<AddTeamMemberRequest> | null;
    const role = body?.role;
    if (!isGrantableTeamRole(role)) return c.json({ error: BAD_ROLE }, 400);
    const refused = grantRefusal(team, role);
    if (refused) return c.json({ error: refused }, 403);
    const user = await c.var.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, normalizeEmail(str(body?.email))))
      .get();
    if (!user) return c.json({ error: "No account with that email; invite them first" }, 404);
    const member = await addTeamMember(c.env, c.var.db, team.id, user.id, role, c.var.user.id);
    if (!member) return c.json({ error: "Already a member of this team" }, 409);
    return c.json({ member }, 201);
  })
  // One step: an account joins now ("you were added" email), an unknown email gets an
  // invite (invite email; counts toward the inviter's limit).
  .post("/teams/:id/people", requireTeamMember, async (c) => {
    const team = c.var.team;
    const body = await readJsonObject(c);
    const role = body?.role;
    if (!isGrantableTeamRole(role)) return c.json({ error: BAD_ROLE }, 400);
    const refused = grantRefusal(team, role);
    if (refused) return c.json({ error: refused }, 403);
    const email = normalizeEmail(str(body?.email));
    if (!isPlausibleEmail(email)) return c.json({ error: "Enter a valid email address" }, 400);
    const user = await c.var.db
      .select({ id: schema.users.id, email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .get();
    if (user) {
      const member = await addTeamMember(c.env, c.var.db, team.id, user.id, role, c.var.user.id);
      if (!member) return c.json({ error: "Already a member of this team" }, 409);
      const emailed = await sendEmail(
        c.env,
        addedEmail({
          to: user.email,
          inviterName: c.var.user.name,
          inviterEmail: c.var.user.email,
          targetName: team.name,
          targetKind: "team",
          role,
          link: `${appOrigin(c.env, c.req.url)}/teams/${team.id}`,
        }),
      );
      return c.json({ added: member, emailed } satisfies AddTeamPeopleResponse, 201);
    }
    const limited = await inviteLimited(c);
    if (limited) return limited;
    const made = await createInvite(c.var.db, {
      email,
      invitedBy: c.var.user.id,
      team: { id: team.id, role },
    });
    await countInvite(c);
    const emailed = await emailInvite(c, email, { kind: "team", name: team.name, role }, made);
    const invited = { id: made.id, email, role, path: made.path, expiresAt: made.expiresAt };
    return c.json({ invited, emailed } satisfies AddTeamPeopleResponse, 201);
  })
  // Pending invites into the team: owner and admins see all, everyone else their own.
  .get("/teams/:id/invites", requireTeamMember, async (c) => {
    const team = c.var.team;
    const invites = await pendingInvites(
      c.var.db,
      { teamId: team.id },
      isTeamManager(team.role) ? undefined : c.var.user.id,
    );
    return c.json({ invites } satisfies PendingInvitesResponse);
  })
  .patch("/teams/:id/members/:userId", requireTeamMember, async (c) => {
    const team = c.var.team;
    const userId = c.req.param("userId");
    const body = await readJsonObject(c);
    const role = body?.role;
    if (!isGrantableTeamRole(role)) return c.json({ error: BAD_ROLE }, 400);
    if (userId === c.var.user.id) return c.json({ error: "You can't change your own role" }, 400);
    const target = await memberRow(c.var.db, team.id, userId);
    if (!target) return c.json({ error: "Not a member of this team" }, 404);
    if (target.role === "owner") {
      return c.json({ error: "The team's owner can't change; transfer the team instead" }, 400);
    }
    if (!canManage(team, c.var.user.id, target)) {
      return c.json({ error: "You can only manage the people you added" }, 403);
    }
    if (!canGrant(team.role, role)) {
      return c.json({ error: "You can't give a role above your own" }, 403);
    }
    // Never touches an owner (a transfer may have made them one meanwhile).
    const updated = await c.var.db
      .update(tm)
      .set({ role })
      .where(and(eq(tm.teamId, team.id), eq(tm.userId, userId), ne(tm.role, "owner")))
      .returning({ userId: tm.userId });
    if (updated.length === 0) {
      return c.json({ error: "The team's members changed meanwhile; reload and try again" }, 409);
    }
    await refreshAccess(c.env, c.var.db, {
      showIds: await teamShowIds(c.var.db, team.id),
      userIds: [userId],
    });
    return c.json({ ok: true });
  })
  .delete("/teams/:id/members/:userId", requireTeamMember, async (c) => {
    const team = c.var.team;
    const userId = c.req.param("userId");
    if (userId === c.var.user.id) return c.json({ error: "Leave the team instead" }, 400);
    const target = await memberRow(c.var.db, team.id, userId);
    if (!target) return c.json({ error: "Not a member of this team" }, 404);
    if (target.role === "owner") {
      return c.json({ error: "The team's owner can't be removed; transfer the team first" }, 400);
    }
    if (!canManage(team, c.var.user.id, target)) {
      return c.json({ error: "You can only manage the people you added" }, 403);
    }
    const removed = await c.var.db
      .delete(tm)
      .where(and(eq(tm.teamId, team.id), eq(tm.userId, userId), ne(tm.role, "owner")))
      .returning({ userId: tm.userId });
    if (removed.length === 0) {
      return c.json({ error: "The team's members changed meanwhile; reload and try again" }, 409);
    }
    await endInvites(c.var.db, { teamId: team.id }, userId);
    // Their tabs in the team's shows close, unless they're also direct members there.
    await refreshAccess(c.env, c.var.db, {
      showIds: await teamShowIds(c.var.db, team.id),
      userIds: [userId],
    });
    return c.json({ ok: true });
  })
  .post("/teams/:id/leave", requireTeamMember, async (c) => {
    const team = c.var.team;
    if (team.role === "owner") {
      return c.json({ error: "Transfer the team to someone else before leaving" }, 400);
    }
    await c.var.db.delete(tm).where(and(eq(tm.teamId, team.id), eq(tm.userId, c.var.user.id)));
    await endInvites(c.var.db, { teamId: team.id }, c.var.user.id);
    await refreshAccess(c.env, c.var.db, {
      showIds: await teamShowIds(c.var.db, team.id),
      userIds: [c.var.user.id],
    });
    return c.json({ ok: true });
  })
  // Hand the team to another member (owner only): they become the owner, you an admin.
  .post("/teams/:id/transfer", requireTeamMember, requireTeamOwner, async (c) => {
    const team = c.var.team;
    const body = (await readJsonObject(c)) as Partial<TransferTeamRequest> | null;
    let userId = str(body?.userId);
    const email = normalizeEmail(str(body?.email));
    if (!userId && email) {
      const byEmail = await c.var.db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.email, email))
        .get();
      if (!byEmail) return c.json({ error: "No account with that email is in this team" }, 404);
      userId = byEmail.id;
    }
    if (!userId) {
      return c.json({ error: "Send the userId or email of the member to make the owner" }, 400);
    }
    if (userId === c.var.user.id) return c.json({ error: "You're already the owner" }, 400);
    if (!(await memberRow(c.var.db, team.id, userId))) {
      return c.json({ error: "Not a member of this team; add them first" }, 404);
    }
    if (!(await transferTeam(c.var.db, team.id, c.var.user.id, userId))) {
      return c.json({ error: "The team's members changed meanwhile; reload and try again" }, 409);
    }
    await refreshAccess(c.env, c.var.db, {
      showIds: await teamShowIds(c.var.db, team.id),
      userIds: [userId, c.var.user.id],
    });
    return c.json({ ok: true });
  })

  // ---- shows ----
  .get("/teams/:id/shows", requireTeamMember, async (c) => {
    const shows = await accessibleShows(c.var.db, c.var.user.id, { teamId: c.var.team.id });
    return c.json({ shows } satisfies TeamShowsResponse);
  });
