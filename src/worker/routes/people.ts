// People you work with, and your own access.
//
// - `GET /api/people`: everyone who is a direct member of a show you can open (directly or
//   through a team), or in one of your teams; not you. For the "add people" autocomplete.
// - `GET /api/me/access`: your teams (role, how many shows) and every show you can open
//   (effective role; `direct` when you're a member of the show itself, `team` otherwise),
//   and a login-email change waiting for its link (`pendingEmail`; routes/me.ts).
import { and, count, eq, inArray, ne, or } from "drizzle-orm";
import { Hono } from "hono";
import type { MyAccessResponse, PeopleResponse } from "../../shared/api";
import { accessibleShowRows } from "../access";
import { requireAuth } from "../auth/middleware";
import { schema } from "../db/d1/client";
import type { AppEnv } from "../types";
import { pendingEmailChange } from "./me";

export const peopleRoutes = new Hono<AppEnv>()
  .get("/people", requireAuth, async (c) => {
    const db = c.var.db;
    const me = c.var.user.id;
    const m = schema.memberships;
    const tm = schema.teamMemberships;
    const s = schema.shows;
    // Shows I can open: my direct ones and my teams' ones.
    const myTeams = db.select({ id: tm.teamId }).from(tm).where(eq(tm.userId, me));
    const myShows = db
      .select({ id: s.id })
      .from(s)
      .where(
        or(
          inArray(s.id, db.select({ id: m.showId }).from(m).where(eq(m.userId, me))),
          inArray(s.teamId, myTeams),
        ),
      );
    const u = schema.users;
    const people = await db
      .select({ id: u.id, name: u.name, email: u.email })
      .from(u)
      .where(
        and(
          ne(u.id, me),
          or(
            inArray(u.id, db.select({ id: m.userId }).from(m).where(inArray(m.showId, myShows))),
            inArray(u.id, db.select({ id: tm.userId }).from(tm).where(inArray(tm.teamId, myTeams))),
          ),
        ),
      )
      .orderBy(u.name);
    return c.json({ people } satisfies PeopleResponse);
  })
  .get("/me/access", requireAuth, async (c) => {
    const db = c.var.db;
    const tm = schema.teamMemberships;
    const showCount = db
      .select({ teamId: schema.shows.teamId, n: count().as("n") })
      .from(schema.shows)
      .groupBy(schema.shows.teamId)
      .as("show_count");
    const [teams, shows, pendingEmail] = await Promise.all([
      db
        .select({
          id: schema.teams.id,
          name: schema.teams.name,
          role: tm.role,
          showCount: showCount.n,
        })
        .from(tm)
        .innerJoin(schema.teams, eq(schema.teams.id, tm.teamId))
        .leftJoin(showCount, eq(showCount.teamId, tm.teamId))
        .where(eq(tm.userId, c.var.user.id))
        .orderBy(schema.teams.name),
      accessibleShowRows(db, c.var.user.id),
      pendingEmailChange(db, c.var.user.id),
    ]);
    return c.json({
      teams: teams.map((t) => ({ ...t, showCount: t.showCount ?? 0 })),
      shows: shows.map((show) => ({
        id: show.id,
        name: show.name,
        role: show.role,
        source: show.direct ? ("direct" as const) : ("team" as const),
        teamId: show.teamId,
        teamName: show.teamName,
      })),
      pendingEmail,
    } satisfies MyAccessResponse);
  });
