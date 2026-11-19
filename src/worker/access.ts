// Who may do what in a show or team: the one place show roles are resolved.
//
// A show's effective role for a user is the highest of their direct membership's role
// (`memberships`) and the role their team membership gives them on the show's team
// (`team_memberships`, through `shows.team_id`): team owner/admin → editor, otherwise the
// same name. No direct row and no team row: no access. Team owner/admins never become a
// show's owner (a show has exactly one owner, a direct member).
//
// After anything that can move someone's access (team membership added/changed/removed,
// a show moved into or out of a team, a team transfer, a direct membership removed),
// call `refreshAccess` so open sockets follow: a new role is announced (`notifyRole`), no
// role closes them (`disconnectUser`). The ShowDO still receives the role from the
// Worker on every request; it never resolves roles itself.
import { and, desc, eq, inArray, or } from "drizzle-orm";
import type { InvitePolicy, Role, ShowSummaryDTO, TeamRole } from "../shared/api";
import { showRoleFromTeamRole } from "../shared/roles";
import { type D1Db, schema } from "./db/d1/client";

// The grant / invite / manage rules are pure and shared with the web client (which renders
// only the controls they allow): src/shared/roles.ts is their one home, re-exported here
// so Worker code keeps importing them from access.ts.
export {
  canGrant,
  canInviteToShow,
  canInviteToTeam,
  canManageShowMember,
  canManageTeamMember,
  isTeamEditor,
  isTeamManager,
  type ManagedMember,
  showRoleFromTeamRole,
} from "../shared/roles";

/** Show roles, highest first. */
const SHOW_RANK: Record<Role, number> = { owner: 4, editor: 3, commenter: 2, viewer: 1 };

/** The higher of two show roles (null: none). */
export function maxRole(a: Role | null | undefined, b: Role | null | undefined): Role | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return SHOW_RANK[a] >= SHOW_RANK[b] ? a : b;
}

/** Effective show role from a direct role and a team role (either may be missing). */
export function resolveRole(
  direct: Role | null | undefined,
  team: TeamRole | null | undefined,
): Role | null {
  return maxRole(direct, team ? showRoleFromTeamRole(team) : null);
}

export interface ShowAccess {
  show: {
    id: string;
    name: string;
    currentSession: string | null;
    teamId: string | null;
    teamName: string | null;
    invitePolicy: InvitePolicy;
  };
  /** Effective role; null when the user has no access (the show exists). */
  role: Role | null;
  direct: Role | null;
  teamRole: TeamRole | null;
}

/** The show and the user's access to it in one query; null when the show doesn't exist. */
export async function showAccess(
  db: D1Db,
  showId: string,
  userId: string,
): Promise<ShowAccess | null> {
  const s = schema.shows;
  const m = schema.memberships;
  const tm = schema.teamMemberships;
  const row = await db
    .select({
      id: s.id,
      name: s.name,
      currentSession: s.currentSession,
      teamId: s.teamId,
      teamName: schema.teams.name,
      invitePolicy: s.invitePolicy,
      direct: m.role,
      teamRole: tm.role,
    })
    .from(s)
    .leftJoin(m, and(eq(m.showId, s.id), eq(m.userId, userId)))
    .leftJoin(tm, and(eq(tm.teamId, s.teamId), eq(tm.userId, userId)))
    .leftJoin(schema.teams, eq(schema.teams.id, s.teamId))
    .where(eq(s.id, showId))
    .get();
  if (!row) return null;
  const { direct, teamRole, ...show } = row;
  return { show, role: resolveRole(direct, teamRole), direct, teamRole };
}

/** A user's effective role in a show (null: no access, or no such show). */
export async function effectiveRole(
  db: D1Db,
  showId: string,
  userId: string,
): Promise<Role | null> {
  return (await showAccess(db, showId, userId))?.role ?? null;
}

/** A user's role in a team (null: not a member, or no such team). */
export async function teamRoleOf(
  db: D1Db,
  teamId: string,
  userId: string,
): Promise<TeamRole | null> {
  const tm = schema.teamMemberships;
  const row = await db
    .select({ role: tm.role })
    .from(tm)
    .where(and(eq(tm.teamId, teamId), eq(tm.userId, userId)))
    .get();
  return row?.role ?? null;
}

/**
 * Every show the user can open (directly or through a team), newest first, with the
 * effective role and the team. `teamId` narrows it to one team's shows.
 */
export async function accessibleShows(
  db: D1Db,
  userId: string,
  opts: { teamId?: string } = {},
): Promise<ShowSummaryDTO[]> {
  return (await accessibleShowRows(db, userId, opts)).map(({ direct: _d, ...show }) => show);
}

/** `accessibleShows` plus the direct membership's role (null: through the team only). */
export async function accessibleShowRows(
  db: D1Db,
  userId: string,
  opts: { teamId?: string } = {},
): Promise<(ShowSummaryDTO & { direct: Role | null })[]> {
  const s = schema.shows;
  const m = schema.memberships;
  const tm = schema.teamMemberships;
  const mine = or(
    inArray(s.id, db.select({ id: m.showId }).from(m).where(eq(m.userId, userId))),
    inArray(s.teamId, db.select({ id: tm.teamId }).from(tm).where(eq(tm.userId, userId))),
  );
  const rows = await db
    .select({
      id: s.id,
      name: s.name,
      createdAt: s.createdAt,
      isTemplate: s.isTemplate,
      teamId: s.teamId,
      teamName: schema.teams.name,
      direct: m.role,
      teamRole: tm.role,
    })
    .from(s)
    .leftJoin(m, and(eq(m.showId, s.id), eq(m.userId, userId)))
    .leftJoin(tm, and(eq(tm.teamId, s.teamId), eq(tm.userId, userId)))
    .leftJoin(schema.teams, eq(schema.teams.id, s.teamId))
    .where(opts.teamId ? and(mine, eq(s.teamId, opts.teamId)) : mine)
    .orderBy(desc(s.createdAt));
  const out: (ShowSummaryDTO & { direct: Role | null })[] = [];
  for (const { teamRole, ...show } of rows) {
    const role = resolveRole(show.direct, teamRole);
    if (role) out.push({ ...show, role });
  }
  return out;
}

/** The ids of every show a user can open (logout-all closes their sockets in each). */
export async function accessibleShowIds(db: D1Db, userId: string): Promise<string[]> {
  return (await accessibleShows(db, userId)).map((s) => s.id);
}

/** The ids of a team's shows. */
export async function teamShowIds(db: D1Db, teamId: string): Promise<string[]> {
  const rows = await db
    .select({ id: schema.shows.id })
    .from(schema.shows)
    .where(eq(schema.shows.teamId, teamId));
  return rows.map((r) => r.id);
}

/** The user ids of a team's members. */
export async function teamMemberIds(db: D1Db, teamId: string): Promise<string[]> {
  const tm = schema.teamMemberships;
  const rows = await db.select({ id: tm.userId }).from(tm).where(eq(tm.teamId, teamId));
  return rows.map((r) => r.id);
}

/** D1 allows 100 bound parameters per query. */
const CHUNK = 90;

/** Effective roles of `userIds` in one show (users without access are absent). */
async function effectiveRoles(
  db: D1Db,
  showId: string,
  userIds: string[],
): Promise<Map<string, Role>> {
  const out = new Map<string, Role>();
  const show = await db
    .select({ teamId: schema.shows.teamId })
    .from(schema.shows)
    .where(eq(schema.shows.id, showId))
    .get();
  if (!show) return out;
  const m = schema.memberships;
  const tm = schema.teamMemberships;
  for (let i = 0; i < userIds.length; i += CHUNK) {
    const chunk = userIds.slice(i, i + CHUNK);
    const [direct, team] = await Promise.all([
      db
        .select({ userId: m.userId, role: m.role })
        .from(m)
        .where(and(eq(m.showId, showId), inArray(m.userId, chunk))),
      show.teamId
        ? db
            .select({ userId: tm.userId, role: tm.role })
            .from(tm)
            .where(and(eq(tm.teamId, show.teamId), inArray(tm.userId, chunk)))
        : Promise.resolve([]),
    ]);
    const teamRoles = new Map(team.map((r) => [r.userId, r.role]));
    const directRoles = new Map(direct.map((r) => [r.userId, r.role]));
    for (const userId of chunk) {
      const role = resolveRole(directRoles.get(userId), teamRoles.get(userId));
      if (role) out.set(userId, role);
    }
  }
  return out;
}

/**
 * Bring open sockets in line with D1 after an access change: for every (show, user) pair,
 * announce the user's effective role, or close their sockets when they have none left.
 */
export async function refreshAccess(
  env: Pick<Env, "SHOW">,
  db: D1Db,
  pairs: { showIds: Iterable<string>; userIds: Iterable<string> },
): Promise<void> {
  const showIds = [...new Set(pairs.showIds)];
  const userIds = [...new Set(pairs.userIds)];
  if (showIds.length === 0 || userIds.length === 0) return;
  await Promise.all(
    showIds.map(async (showId) => {
      const roles = await effectiveRoles(db, showId, userIds);
      const stub = env.SHOW.get(env.SHOW.idFromName(showId));
      await Promise.all(
        userIds.map((userId) => {
          const role = roles.get(userId);
          return role ? stub.notifyRole(userId, role) : stub.disconnectUser(userId);
        }),
      );
    }),
  );
}
