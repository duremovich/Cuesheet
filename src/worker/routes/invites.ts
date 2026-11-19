// Invite-only sign-up. An invite is a one-time link for an email that sets up an account
// and joins a show (`show_id` + `role`) or a team (`team_id` + `team_role`), or neither (an
// admin's plain sign-up). Who may invite where follows decision 4 (src/worker/access.ts):
// admins anyone anywhere; otherwise whoever may add people to that show or team, up to
// their own role. `POST /invites` answers the same 200 whether or not the email has an
// account (no account oracle; accepting one for an existing account is refused). The
// one-step "add people" routes (POST /shows/:id/people, /teams/:id/people) use the
// helpers below and email the invite when email is configured (src/worker/email.ts).
//
// Invites are revoked (`revoked_at`), never deleted, by their inviter, the show's owner or
// the team's owner/admins; a reissue revokes the old row and makes a new one (the id is
// the token's hash, so a new token is a new row). Leaving or being removed from a show or
// team ends the invites you made into it; a show transfer ends the old owner's.
// Non-admins may create 30 invites an hour, 100 a day (`inviteLimits`). Bad tokens are
// rate-limited per IP (auth/rate-limit.ts).
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { Context } from "hono";
import { Hono } from "hono";
import {
  type CreateInviteResponse,
  GRANTABLE_ROLES,
  GRANTABLE_TEAM_ROLES,
  type InviteInfoResponse,
  MAX_NAME_LENGTH,
  type MeResponse,
  MIN_PASSWORD_LENGTH,
  type PendingInviteDTO,
  type ReissueInviteResponse,
  type Role,
  type TeamRole,
} from "../../shared/api";
import {
  canGrant,
  canInviteToShow,
  canInviteToTeam,
  isTeamManager,
  showAccess,
  teamRoleOf,
} from "../access";
import { randomToken, sha256Hex } from "../auth/bytes";
import { serializeSessionCookie } from "../auth/cookie";
import { requireAuth } from "../auth/middleware";
import { hashPassword } from "../auth/password";
import { clientIp, inviteLimits, recordFailure, retryAfter, tooMany } from "../auth/rate-limit";
import { createSession, isPlausibleEmail, normalizeEmail } from "../auth/session";
import { type D1Db, schema } from "../db/d1/client";
import { appOrigin, inviteEmail, sendEmail } from "../email";
import type { AppEnv } from "../types";
import { isHttps, readJsonObject, str } from "./util";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Expired invites stay in the pending lists (to reissue) this long. */
const LISTED_AFTER_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;
const BAD_INVITE = "This invite link is invalid or has been used";

const inv = schema.invites;

/** A sign-up invite that can still be accepted. */
function openInvite(id: string) {
  return and(
    eq(inv.id, id),
    eq(inv.kind, "signup"),
    isNull(inv.acceptedAt),
    isNull(inv.revokedAt),
    gt(inv.expiresAt, Date.now()),
  );
}

/** A sign-up invite still pending (not accepted, not revoked), expired or not. */
function pendingInvite(id: string) {
  return and(eq(inv.id, id), eq(inv.kind, "signup"), isNull(inv.acceptedAt), isNull(inv.revokedAt));
}

export type InviteRole = "editor" | "commenter" | "viewer";

export function isInviteRole(r: unknown): r is InviteRole {
  return typeof r === "string" && (GRANTABLE_ROLES as readonly string[]).includes(r);
}

export function isTeamInviteRole(r: unknown): r is TeamRole {
  return typeof r === "string" && (GRANTABLE_TEAM_ROLES as readonly string[]).includes(r);
}

export interface NewInvite {
  email: string;
  invitedBy: string;
  show?: { id: string; role: InviteRole };
  team?: { id: string; role: TeamRole };
}

export interface MadeInvite {
  id: string;
  path: string;
  expiresAt: number;
}

/** Insert a sign-up invite; the token only exists in the returned path. */
export async function createInvite(db: D1Db, invite: NewInvite): Promise<MadeInvite> {
  const token = randomToken();
  const id = await sha256Hex(token);
  const expiresAt = Date.now() + INVITE_TTL_MS;
  await db.insert(inv).values({
    id,
    email: invite.email,
    invitedBy: invite.invitedBy,
    expiresAt,
    kind: "signup",
    showId: invite.show?.id ?? null,
    role: invite.show?.role ?? null,
    teamId: invite.team?.id ?? null,
    teamRole: invite.team?.role ?? null,
  });
  return { id, path: `/invite/${token}`, expiresAt };
}

/**
 * Non-admins: 429 when over the per-inviter limit, else null. Call `countInvite` after
 * each invite made.
 */
export async function inviteLimited<E extends AppEnv>(c: Context<E>): Promise<Response | null> {
  if (c.var.user.isAdmin) return null;
  const wait = await retryAfter(c.env.DB, [inviteLimits(c.var.user.id)], Date.now());
  return wait > 0 ? tooMany(c, wait, "invites") : null;
}

export async function countInvite<E extends AppEnv>(c: Context<E>): Promise<void> {
  if (c.var.user.isAdmin) return;
  await recordFailure(c.env.DB, [inviteLimits(c.var.user.id)], Date.now());
}

/** Email an invite (when email is configured); true when it went out. */
export async function emailInvite<E extends AppEnv>(
  c: Context<E>,
  to: string,
  target: { kind: "show" | "team"; name: string; role: string },
  made: MadeInvite,
): Promise<boolean> {
  return sendEmail(
    c.env,
    inviteEmail({
      to,
      inviterName: c.var.user.name,
      inviterEmail: c.var.user.email,
      inviteId: made.id,
      targetName: target.name,
      targetKind: target.kind,
      role: target.role,
      link: `${appOrigin(c.env, c.req.url)}${made.path}`,
      expiresAt: made.expiresAt,
    }),
  );
}

/** End (revoke) the open invites `invitedBy` made into a show or a team. */
export async function endInvites(
  db: D1Db,
  target: { showId: string } | { teamId: string },
  invitedBy: string,
): Promise<void> {
  await db
    .update(inv)
    .set({ revokedAt: Date.now() })
    .where(
      and(
        "showId" in target ? eq(inv.showId, target.showId) : eq(inv.teamId, target.teamId),
        eq(inv.invitedBy, invitedBy),
        eq(inv.kind, "signup"),
        isNull(inv.acceptedAt),
        isNull(inv.revokedAt),
      ),
    );
}

const inviter = alias(schema.users, "inviter");

/**
 * The pending invites into a show or team (PendingInviteDTO), newest first: all of them,
 * or (`invitedBy`) one person's. Expired ones for 30 days after expiry.
 */
export async function pendingInvites(
  db: D1Db,
  target: { showId: string } | { teamId: string },
  invitedBy?: string,
): Promise<PendingInviteDTO[]> {
  const now = Date.now();
  const rows = await db
    .select({
      id: inv.id,
      email: inv.email,
      role: inv.role,
      teamRole: inv.teamRole,
      createdAt: inv.createdAt,
      expiresAt: inv.expiresAt,
      inviterId: inviter.id,
      inviterName: inviter.name,
    })
    .from(inv)
    .leftJoin(inviter, eq(inviter.id, inv.invitedBy))
    .where(
      and(
        "showId" in target ? eq(inv.showId, target.showId) : eq(inv.teamId, target.teamId),
        eq(inv.kind, "signup"),
        isNull(inv.acceptedAt),
        isNull(inv.revokedAt),
        gt(inv.expiresAt, now - LISTED_AFTER_EXPIRY_MS),
        invitedBy ? eq(inv.invitedBy, invitedBy) : undefined,
      ),
    )
    .orderBy(desc(inv.createdAt));
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    role: ("showId" in target ? r.role : r.teamRole) ?? "editor",
    invitedBy: r.inviterId ? { id: r.inviterId, name: r.inviterName ?? "" } : null,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    expired: r.expiresAt <= now,
  }));
}

type InviteRow = typeof inv.$inferSelect;

/**
 * Whether the caller may revoke or reissue an invite: its inviter, the show's owner, the
 * team's owner/admins. `hidden` when they can't see the show or team at all (404).
 */
async function inviteControl<E extends AppEnv>(
  c: Context<E>,
  invite: InviteRow,
): Promise<"allowed" | "forbidden" | "hidden"> {
  const me = c.var.user.id;
  if (invite.invitedBy === me) return "allowed";
  if (invite.showId) {
    const role = (await showAccess(c.var.db, invite.showId, me))?.role;
    if (role === "owner") return "allowed";
    return role ? "forbidden" : "hidden";
  }
  if (invite.teamId) {
    const role = await teamRoleOf(c.var.db, invite.teamId, me);
    if (isTeamManager(role)) return "allowed";
    return role ? "forbidden" : "hidden";
  }
  return "hidden";
}

/** The pending invite named in the path, if the caller may manage it; else the error. */
async function managedInvite<E extends AppEnv>(c: Context<E>): Promise<InviteRow | Response> {
  const invite = await c.var.db
    .select()
    .from(inv)
    .where(pendingInvite(c.req.param("id") ?? ""))
    .get();
  const control = invite ? await inviteControl(c, invite) : "hidden";
  if (!invite || control === "hidden") return c.json({ error: "Invite not found" }, 404);
  if (control === "forbidden") {
    return c.json({ error: "Only whoever sent it or a manager can do that" }, 403);
  }
  return invite;
}

/** The show or team an invite joins (for its email); null for none or gone. */
async function targetOf(db: D1Db, invite: InviteRow) {
  if (invite.showId) {
    const show = await db
      .select({ name: schema.shows.name })
      .from(schema.shows)
      .where(eq(schema.shows.id, invite.showId))
      .get();
    return show ? { kind: "show" as const, name: show.name, role: invite.role ?? "editor" } : null;
  }
  if (invite.teamId) {
    const team = await db
      .select({ name: schema.teams.name })
      .from(schema.teams)
      .where(eq(schema.teams.id, invite.teamId))
      .get();
    return team
      ? { kind: "team" as const, name: team.name, role: invite.teamRole ?? "editor" }
      : null;
  }
  return null;
}

/** May the (non-admin) caller invite into this show / team with this role? */
async function mayInvite<E extends AppEnv>(
  c: Context<E>,
  target: { showId: string; role: InviteRole } | { teamId: string; role: TeamRole },
): Promise<boolean> {
  const db = c.var.db;
  if ("showId" in target) {
    const access = await showAccess(db, target.showId, c.var.user.id);
    return (
      !!access?.role &&
      canInviteToShow(access.role, access.show.invitePolicy) &&
      canGrant(access.role, target.role)
    );
  }
  const row = await db
    .select({ role: schema.teamMemberships.role, policy: schema.teams.invitePolicy })
    .from(schema.teamMemberships)
    .innerJoin(schema.teams, eq(schema.teams.id, schema.teamMemberships.teamId))
    .where(
      and(
        eq(schema.teamMemberships.teamId, target.teamId),
        eq(schema.teamMemberships.userId, c.var.user.id),
      ),
    )
    .get();
  return !!row && canInviteToTeam(row.role, row.policy) && canGrant(row.role, target.role);
}

export const inviteRoutes = new Hono<AppEnv>()
  .post("/invites", requireAuth, async (c) => {
    const body = await readJsonObject(c);
    const email = normalizeEmail(str(body?.email));
    const showId = body?.showId ? str(body.showId) : null;
    const teamId = body?.teamId ? str(body.teamId) : null;
    if (showId && teamId) {
      return c.json({ error: "An invite joins a show or a team, not both" }, 400);
    }
    const role = body?.role ?? (showId ? "editor" : null);
    if (role !== null && !isInviteRole(role)) {
      return c.json({ error: `role must be one of ${GRANTABLE_ROLES.join(", ")}` }, 400);
    }
    const teamRole = teamId ? (body?.teamRole ?? "editor") : null;
    if (teamRole !== null && !isTeamInviteRole(teamRole)) {
      return c.json({ error: `teamRole must be one of ${GRANTABLE_TEAM_ROLES.join(", ")}` }, 400);
    }
    const show = showId && role ? { showId, role } : null;
    const team = teamId && teamRole ? { teamId, role: teamRole } : null;
    const db = c.var.db;
    if (!c.var.user.isAdmin) {
      const target = show ?? team;
      if (!target || !(await mayInvite(c, target))) {
        return c.json(
          { error: "Only admins, or people who may add people to that show or team, can invite" },
          403,
        );
      }
    } else if (show) {
      const row = await db
        .select({ id: schema.shows.id })
        .from(schema.shows)
        .where(eq(schema.shows.id, show.showId))
        .get();
      if (!row) return c.json({ error: "Show not found" }, 404);
    } else if (team) {
      const row = await db
        .select({ id: schema.teams.id })
        .from(schema.teams)
        .where(eq(schema.teams.id, team.teamId))
        .get();
      if (!row) return c.json({ error: "Team not found" }, 404);
    }
    if (!isPlausibleEmail(email)) return c.json({ error: "Enter a valid email address" }, 400);
    const limited = await inviteLimited(c);
    if (limited) return limited;
    // No "already has an account" answer (that would tell anyone who may invite which
    // emails have accounts): the invite is made either way; accepting it for an existing
    // account is refused then, to the invitee, who can simply sign in.
    const made = await createInvite(db, {
      email,
      invitedBy: c.var.user.id,
      ...(show ? { show: { id: show.showId, role: show.role } } : {}),
      ...(team ? { team: { id: team.teamId, role: team.role } } : {}),
    });
    await countInvite(c);
    return c.json(
      {
        id: made.id,
        email,
        path: made.path,
        expiresAt: made.expiresAt,
      } satisfies CreateInviteResponse,
      200,
    );
  })
  // Revoke (inviter, show owner, team owner/admins): the link stops working.
  .delete("/invites/:id", requireAuth, async (c) => {
    const invite = await managedInvite(c);
    if (invite instanceof Response) return invite;
    const revoked = await c.var.db
      .update(inv)
      .set({ revokedAt: Date.now() })
      .where(pendingInvite(invite.id))
      .returning({ id: inv.id });
    if (revoked.length === 0) return c.json({ error: "Invite not found" }, 404);
    return c.json({ ok: true });
  })
  // A new link (and 7 days) for a pending invite, expired or not; the old link dies. The
  // invite keeps its inviter (and so who manages it). Re-sends the email.
  .post("/invites/:id/reissue", requireAuth, async (c) => {
    const invite = await managedInvite(c);
    if (invite instanceof Response) return invite;
    const limited = await inviteLimited(c);
    if (limited) return limited;
    const db = c.var.db;
    const revoked = await db
      .update(inv)
      .set({ revokedAt: Date.now() })
      .where(pendingInvite(invite.id))
      .returning({ id: inv.id });
    if (revoked.length === 0) return c.json({ error: "Invite not found" }, 404);
    const made = await createInvite(db, {
      email: invite.email,
      invitedBy: invite.invitedBy,
      ...(invite.showId ? { show: { id: invite.showId, role: invite.role ?? "editor" } } : {}),
      ...(invite.teamId ? { team: { id: invite.teamId, role: invite.teamRole ?? "editor" } } : {}),
    });
    await countInvite(c);
    const target = await targetOf(db, invite);
    const emailed = target ? await emailInvite(c, invite.email, target, made) : false;
    return c.json({
      id: made.id,
      path: made.path,
      expiresAt: made.expiresAt,
      emailed,
    } satisfies ReissueInviteResponse);
  })
  .get("/invites/:token", async (c) => {
    const now = Date.now();
    const keys = [`invite:ip:${clientIp(c)}`];
    const wait = await retryAfter(c.env.DB, keys, now);
    if (wait > 0) return tooMany(c, wait);
    const invite = await c.var.db
      .select({
        email: inv.email,
        role: inv.role,
        showName: schema.shows.name,
        teamId: inv.teamId,
        teamRole: inv.teamRole,
        teamName: schema.teams.name,
      })
      .from(inv)
      .leftJoin(schema.shows, eq(schema.shows.id, inv.showId))
      .leftJoin(schema.teams, eq(schema.teams.id, inv.teamId))
      .where(openInvite(await sha256Hex(c.req.param("token"))))
      .get();
    if (!invite) {
      await recordFailure(c.env.DB, keys, now);
      return c.json({ error: BAD_INVITE }, 404);
    }
    return c.json({
      email: invite.email,
      showName: invite.showName,
      role: invite.showName ? (invite.role as Role | null) : null,
      // Team fields only on team invites (show invites keep their old shape).
      ...(invite.teamId
        ? { teamName: invite.teamName, teamRole: invite.teamName ? invite.teamRole : null }
        : {}),
    } satisfies InviteInfoResponse);
  })
  .post("/invites/:token/accept", async (c) => {
    const body = await readJsonObject(c);
    const name = str(body?.name).trim();
    const password = str(body?.password);
    if (!name || name.length > MAX_NAME_LENGTH) return c.json({ error: "Enter your name" }, 400);
    if (password.length < MIN_PASSWORD_LENGTH) {
      return c.json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` }, 400);
    }
    const now = Date.now();
    const keys = [`invite:ip:${clientIp(c)}`];
    const wait = await retryAfter(c.env.DB, keys, now);
    if (wait > 0) return tooMany(c, wait);
    const inviteId = await sha256Hex(c.req.param("token"));
    const passwordHash = await hashPassword(password);

    // Claim the invite atomically so a link can only be used once.
    const [claimed] = await c.var.db
      .update(inv)
      .set({ acceptedAt: now })
      .where(openInvite(inviteId))
      .returning({
        email: inv.email,
        invitedBy: inv.invitedBy,
        showId: inv.showId,
        role: inv.role,
        teamId: inv.teamId,
        teamRole: inv.teamRole,
      });
    if (!claimed) {
      await recordFailure(c.env.DB, keys, now);
      return c.json({ error: BAD_INVITE }, 404);
    }

    const user = {
      id: crypto.randomUUID(),
      email: normalizeEmail(claimed.email),
      name,
      passwordHash,
      isAdmin: false,
    };
    const inserted = await c.var.db
      .insert(schema.users)
      .values(user)
      .onConflictDoNothing()
      .returning({ id: schema.users.id });
    if (inserted.length === 0) return c.json({ error: "That email already has an account" }, 409);
    // Joins with the invite's inviter as `invited_by` (so they manage the new member). The
    // show or team may have gone since; then there's nothing to join.
    if (claimed.showId) {
      const show = await c.var.db
        .select({ id: schema.shows.id })
        .from(schema.shows)
        .where(eq(schema.shows.id, claimed.showId))
        .get();
      if (show) {
        await c.var.db
          .insert(schema.memberships)
          .values({
            showId: show.id,
            userId: user.id,
            role: claimed.role ?? "editor",
            invitedBy: claimed.invitedBy,
          })
          .onConflictDoNothing();
      }
    } else if (claimed.teamId) {
      const team = await c.var.db
        .select({ id: schema.teams.id })
        .from(schema.teams)
        .where(eq(schema.teams.id, claimed.teamId))
        .get();
      if (team) {
        // Never a second owner (invites can't grant it; belt and braces).
        const role = claimed.teamRole && claimed.teamRole !== "owner" ? claimed.teamRole : "editor";
        await c.var.db
          .insert(schema.teamMemberships)
          .values({ teamId: team.id, userId: user.id, role, invitedBy: claimed.invitedBy })
          .onConflictDoNothing();
      }
    }

    const token = await createSession(c.var.db, user.id);
    c.header("Set-Cookie", serializeSessionCookie(token, { secure: isHttps(c) }));
    return c.json(
      { user: { id: user.id, email: user.email, name, isAdmin: false } } satisfies MeResponse,
      201,
    );
  });
